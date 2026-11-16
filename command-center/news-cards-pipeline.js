// gh0stlayer news cards: daily pipeline (sources -> pick -> LLM card -> images -> render -> publish),
// manifests in data/news-cards/sets/, publish worker, metrics at 24 h / 72 h and weekly reweight.
// Platform calls (LLM, Nano Banana, Instagram, Buffer, X tasks, gallery) are injected by api-server.js.
const fs = require("fs");
const path = require("path");
const nc = require("./news-cards");
const sources = require("./sources");
const xPairs = require("./x-pairs");
const buffer = require("./buffer");

const DIR = process.env.NEWS_CARDS_DIR || path.join(__dirname, "data", "news-cards"); // override = tests only
const SETS_DIR = path.join(DIR, "sets");
const CONFIG_FILE = path.join(DIR, "config.json");
const STATE_FILE = path.join(DIR, "state.json");
const MEDIA_DIR = path.join(__dirname, "public", "media", "news-cards");
const DRY_DIR = path.join(DIR, "dry-run");

// Cadence per platform: every_days (1 = daily) and the local post time. Override in data/news-cards/config.json.
const DEFAULTS = {
  enabled: true,
  channel_id: "mud1u9q9bqh1",
  sets_per_day: 1,
  tz: "Europe/Madrid",
  min_score: 50,
  persona_rotation_days: 14,
  platforms: {
    instagram: { enabled: true, every_days: 1, time: "18:30" },
    tiktok: { enabled: true, every_days: 1, time: "19:00", buffer_channel: "6ac0da6cea19ca0bde626191" },
    x: { enabled: true, every_days: 1, time: "17:00" },
  },
};
const PLATFORMS = ["instagram", "tiktok", "x"];

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function config() {
  const c = readJson(CONFIG_FILE, {});
  const out = { ...DEFAULTS, ...c, platforms: {} };
  for (const p of PLATFORMS) out.platforms[p] = { ...DEFAULTS.platforms[p], ...((c.platforms || {})[p] || {}) };
  out.sets_per_day = Math.min(3, Math.max(1, Number(out.sets_per_day) || 1));
  return out;
}

// ---------- manifests ----------
function setFile(id) { return path.join(SETS_DIR, `${String(id).replace(/[^\w-]/g, "")}.json`); }
function loadSet(id) { return readJson(setFile(id), null); }
function saveSet(m) { m.updated_at = new Date().toISOString(); writeJson(setFile(m.id), m); return m; }
function listSets({ limit = 30, includeDry = false } = {}) {
  let files = [];
  try { files = fs.readdirSync(SETS_DIR).filter(f => f.endsWith(".json")); } catch { return []; }
  return files.map(f => readJson(path.join(SETS_DIR, f), null)).filter(Boolean)
    .filter(m => includeDry || !m.dry_run)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}
function history() {
  return listSets({ limit: 500 }).filter(m => m.status !== "skipped" && m.status !== "failed")
    .map(m => ({ created_at: m.created_at, layout: m.layout, pill: m.pill, dedup_key: m.item?.dedup_key, persona_still: m.images?.persona_task_id }));
}
function loadState() { return readJson(STATE_FILE, {}); }
function saveState(s) { writeJson(STATE_FILE, s); }

function localDay(date, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function newSetId(now) {
  const d = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  return `${d}-${Math.random().toString(36).slice(2, 6)}`;
}
function log(m, msg) {
  m.log = m.log || [];
  m.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  console.log(`[NEWS-CARDS] ${m.id}: ${msg}`);
}

// ---------- picking ----------
// Pills that fit the item; the learned weights pick among them (15% exploration in weightedPick).
function pillOptions(item, layout) {
  const ents = (item.entities || []).map(e => String(e).toLowerCase());
  const text = `${item.title} ${item.summary || ""}`.toLowerCase();
  const out = ["signal", "did you know"];
  if (layout === "versus") out.push("then vs now");
  if (layout === "persona") out.push("trader's take");
  if (ents.includes("miners") || /hashrate|on-?chain|block|mempool|halving|difficulty/.test(text)) out.push("on-chain");
  if (ents.some(e => ["defi", "stablecoins", "hyperliquid"].includes(e)) || /\btvl\b|defi|stablecoin|funding|open interest/.test(text)) out.push("defi");
  if (ents.some(e => ["etf", "sec"].includes(e)) || /\b(fed|rates?|inflation|etf|sec|treasury|macro)\b/.test(text)) out.push("macro");
  if (/\b(ai|artificial intelligence|agent)\b/.test(text)) out.push("ai");
  if (item.kind === "metric") out.push("trader's take");
  return [...new Set(out)].filter(p => nc.PILLS.includes(p));
}
function pickPill(item, layout, weights = {}, rand = Math.random) {
  return xPairs.weightedPick(pillOptions(item, layout), weights.pill || {}, rand) || "signal";
}

// Best item per requested layout (dry-run: one set per layout, evergreen fills the gaps).
function planLayouts(items, hist, layouts, now) {
  const scored = items.map(item => ({ item, score: nc.scoreItem(item, now) }))
    .filter(c => !c.score.reject).sort((a, b) => b.score.total - a.score.total);
  const used = new Set();
  return layouts.map(layout => {
    const c = scored.find(c => !used.has(c) && nc.compatibleLayouts(c.item).includes(layout));
    if (!c) return null;
    used.add(c);
    return { ...c, layout };
  }).filter(Boolean);
}

// persona: a gh0st still from the gallery, three-quarter view preferred, not reused within N days.
function pickPersonaStill(stills, hist, now, days = 14, rand = Math.random) {
  const recent = new Set(hist.filter(h => h.persona_still && now - Date.parse(h.created_at) < days * 864e5).map(h => h.persona_still));
  const free = stills.filter(s => !recent.has(s.id));
  const pool = free.length ? free : stills;
  const pref = pool.filter(s => /three[- ]quarter|3\/4/i.test(s.prompt || ""));
  const list = pref.length ? pref : pool;
  return list.length ? list[Math.floor(rand() * list.length)] : null;
}

// ---------- one set ----------
async function buildSet({ deps, plan, setId, dryRun, now, weights, hist }) {
  const m = {
    id: setId, created_at: new Date(now).toISOString(), dry_run: !!dryRun, status: "generating",
    item: { kind: plan.item.kind, source: plan.item.source, url: plan.item.url, title: plan.item.title, published_at: plan.item.published_at, dedup_key: nc.dedupKey(plan.item) },
    score: plan.score, layout: plan.layout, pill: null, card: null, attempts: [], images: {}, slides: [], posts: {}, metrics: {}, log: [],
  };
  const pill = pickPill(plan.item, plan.layout, weights);
  log(m, `item "${String(plan.item.title).slice(0, 80)}" (${plan.item.source}, score ${plan.score.total}), layout ${plan.layout}, pill ${pill}`);
  if (!dryRun) saveSet(m);

  const gen = await nc.generateCard({ llm: deps.llm, item: plan.item, layout: plan.layout, pill, maxAttempts: 3, log: s => log(m, s) });
  m.attempts = gen.attempts;
  if (!gen.ok) {
    m.status = "skipped"; m.reason = `validator: ${gen.reason}`;
    log(m, `overgeslagen na ${gen.attempts.length} pogingen: ${gen.reason}`);
    return dryRun ? m : saveSet(m);
  }
  const card = gen.card;
  card.pill = pill;                    // the weighted pick, not the model's own choice
  m.card = card; m.pill = pill;
  m.validator = { ok: true, errors: [] };

  // Images for the image zone.
  const images = {};
  try {
    if (plan.layout === "signal" && deps.genImage) {
      const r = await deps.genImage({ prompt: nc.imagePrompt(card.image_brief), aspect: "4:5", setId, label: "signal" });
      images.hook = nc.dataUri(r.file); m.images.hook = r;
    } else if (plan.layout === "versus" && deps.genImage) {
      for (const side of ["left", "right"]) {
        const label = card.versus?.[side]?.label || side;
        const r = await deps.genImage({ prompt: nc.imagePrompt(`${card.image_brief}. This frame shows: ${label}`), aspect: "1:1", setId, label: `versus ${side}` });
        images[side] = nc.dataUri(r.file); m.images[side] = r;
      }
    } else if (plan.layout === "persona" && deps.personaStills) {
      const still = pickPersonaStill(deps.personaStills(), hist, now, config().persona_rotation_days);
      if (still) { images.hook = nc.dataUri(still.file); m.images.persona_task_id = still.id; m.images.hook = { url: still.url, task_id: still.id }; }
      else log(m, "geen gh0st still gevonden; persona zonder beeld");
    }
  } catch (e) {
    log(m, `beeld mislukt: ${e.message.slice(0, 200)}; render zonder beeld`);
    m.images.error = e.message.slice(0, 300);
  }

  const outDir = dryRun ? DRY_DIR : MEDIA_DIR;
  const slides = await nc.renderSet(card, { setId, outDir, images });
  m.slides = slides.map(s => ({ ...s, rel: dryRun ? null : `/media/news-cards/${path.basename(s.path)}` }));
  log(m, `${slides.length} slides gerenderd`);
  if (!dryRun && deps.gallery) {
    for (const s of m.slides) {
      try { s.gallery_task_id = deps.gallery({ setId, slide: s.slide, layout: s.layout, pill, url: s.rel, headline: nc.stripMarks(card.headline), source: card.source }); }
      catch (e) { log(m, `gallery slide ${s.slide}: ${e.message}`); }
    }
  }
  m.status = "rendered";
  return dryRun ? m : saveSet(m);
}

// ---------- publish ----------
function dueAt(day, hhmm, tz, nowMs) {
  const t = buffer.zonedTime(day, hhmm, tz).getTime();
  return new Date(Math.max(t, nowMs + 5 * 60000));
}
// Cadence: skip a platform when the last set on it was posted less than every_days ago.
function cadenceAllows(platform, cfg, nowMs, exceptId) {
  const every = Math.max(1, Number(cfg.platforms[platform].every_days) || 1);
  const last = listSets({ limit: 50 }).filter(m => m.id !== exceptId && m.posts?.[platform] && !["failed", "skipped"].includes(m.posts[platform].status))
    .map(m => Date.parse(m.posts[platform].due_at || m.created_at)).sort((a, b) => b - a)[0];
  return !last || nowMs - last >= (every - 0.25) * 864e5;
}

// mode auto: schedule on every enabled platform. Other modes: X draft + IG/TikTok wait for approval in the dashboard.
async function schedulePublish({ deps, m, only = null, immediate = false, nowMs = Date.now() }) {
  const cfg = config();
  const channel = deps.channel(cfg.channel_id);
  if (!channel) throw new Error(`kanaal ${cfg.channel_id} niet gevonden`);
  const mode = (channel.autopilot && channel.autopilot.mode) || "auto";
  const auto = mode === "auto";
  const day = localDay(new Date(nowMs), cfg.tz);
  m.publish_mode = mode;
  for (const p of PLATFORMS) {
    const pc = cfg.platforms[p];
    if (only && !only.includes(p)) continue;
    if (!pc.enabled) { m.posts[p] = { status: "off" }; continue; }
    if (!only && !cadenceAllows(p, cfg, nowMs, m.id)) { m.posts[p] = { status: "skipped", reason: "cadence" }; continue; }
    const due = immediate ? new Date(nowMs) : dueAt(day, pc.time, cfg.tz, nowMs);
    m.posts[p] = { status: auto ? "scheduled" : "awaiting_approval", due_at: due.toISOString() };
  }
  if (m.posts.x && ["scheduled", "awaiting_approval"].includes(m.posts.x.status)) {
    const task = deps.addXTask({
      channel_id: channel.id, status: auto ? "scheduled" : "draft", scheduled_at: m.posts.x.due_at,
      text: m.card.x_hook, media_path: m.slides[0].rel, media_paths: [m.slides[0].rel],
      topic: nc.stripMarks(m.card.headline).slice(0, 80), format: "news_card", news_set_id: m.id,
      pair: { hook: m.card.x_hook, replies: [m.card.x_reply], formula: "news_card", pillar: m.layout, pillar_label: m.pill,
        premium: false, has_media: true, has_link: false, brand_mention: false, media_kind: "news_card",
        facts_used: [m.item.url], fallback: false, validator: m.validator, metrics: {}, score: null, created_at: new Date().toISOString() },
    });
    m.posts.x.task_id = task.id;
  }
  if (auto && m.posts.tiktok?.status === "scheduled") await publishTikTok({ deps, m, cfg });
  m.status = "scheduled";
  saveSet(m);
}

async function publishTikTok({ deps, m, cfg }) {
  const post = m.posts.tiktok;
  try {
    const urls = await deps.shareUrls(m);
    const res = await deps.bufferPost(buffer.imagePostInput({
      channelId: cfg.platforms.tiktok.buffer_channel, service: "tiktok", text: m.card.caption, imageUrls: urls,
      altTexts: m.slides.map((s, i) => i === 0 ? nc.stripMarks(m.card.headline) : (i === 1 ? nc.stripMarks(m.card.payload?.title) : nc.stripMarks(m.card.closer?.line))),
      title: nc.stripMarks(m.card.headline), dueAt: new Date(post.due_at),
    }));
    Object.assign(post, { status: "queued", buffer_post_id: res.id, buffer_status: res.status || null });
    log(m, `TikTok via Buffer ingepland (${res.id}) voor ${post.due_at}`);
  } catch (e) {
    Object.assign(post, { status: "failed", error: e.message.slice(0, 300) });
    log(m, `TikTok via Buffer mislukt: ${e.message.slice(0, 200)}`);
    deps.notify?.("gh0stlayer news cards: TikTok mislukt", e.message.slice(0, 300), "danger");
  }
}

async function publishInstagram({ deps, m }) {
  const post = m.posts.instagram;
  try {
    const r = await deps.igCarousel(m);
    Object.assign(post, { status: "published", media_id: r.media_id, permalink: r.permalink, published_at: new Date().toISOString(), error: null });
    log(m, `Instagram carousel gepubliceerd: ${r.permalink || r.media_id}`);
    deps.notify?.("gh0stlayer news cards: Instagram", r.permalink || r.media_id, "info");
  } catch (e) {
    post.attempts = (post.attempts || 0) + 1;
    post.error = e.message.slice(0, 300);
    if (post.attempts >= 3) { post.status = "failed"; deps.notify?.("gh0stlayer news cards: Instagram mislukt", post.error, "danger"); }
    else post.next_at = new Date(Date.now() + post.attempts * 10 * 60000).toISOString();
    log(m, `Instagram poging ${post.attempts} mislukt: ${post.error}`);
  }
}

// Approve a set that waits (non-auto mode): IG/TikTok get scheduled, the X draft is scheduled.
async function approve(deps, id) {
  const m = loadSet(id);
  if (!m) throw new Error("set niet gevonden");
  const cfg = config();
  for (const p of PLATFORMS) if (m.posts[p]?.status === "awaiting_approval") m.posts[p].status = "scheduled";
  if (m.posts.x?.task_id) deps.updateXTask(m.posts.x.task_id, t => { if (t.status === "draft") t.status = "scheduled"; });
  if (m.posts.tiktok?.status === "scheduled") await publishTikTok({ deps, m, cfg });
  m.approved_at = new Date().toISOString();
  return saveSet(m);
}

// ---------- run ----------
let running = false;
async function run({ deps, dryRun = false, layouts = null, count = null, only = null, immediate = false, reason = "manual", now = Date.now() } = {}) {
  if (running) throw new Error("news cards draaien al");
  running = true;
  const t0 = Date.now();
  try {
    const cfg = config();
    const src = await sources.fetchAll({ now, log: s => console.log(`[NEWS-CARDS] ${s}`) });
    const hist = history();
    const weights = loadState().weights || {};
    const plans = layouts
      ? planLayouts(src.items, hist, layouts, now)
      : nc.planDay(src.items, hist, { count: count || cfg.sets_per_day, weights, now, minScore: cfg.min_score });
    const sets = [];
    for (const plan of plans) {
      let m;
      try {
        m = await buildSet({ deps, plan, setId: newSetId(now), dryRun, now, weights, hist });
        if (!dryRun && m.status === "rendered") await schedulePublish({ deps, m, only, immediate, nowMs: Date.now() });
      } catch (e) {
        m = m || { id: "?", layout: plan.layout };
        m.status = "failed"; m.error = e.message.slice(0, 300);
        console.error(`[NEWS-CARDS] set ${m.id} mislukt: ${e.stack || e.message}`);
        if (!dryRun && m.id !== "?") saveSet(m);
      }
      sets.push(m);
      hist.push({ created_at: new Date(now).toISOString(), layout: plan.layout, dedup_key: nc.dedupKey(plan.item), persona_still: m.images?.persona_task_id });
    }
    await nc.closeBrowser();
    const summary = { reason, dry_run: dryRun, sources: src.status, candidates: src.items.length, planned: plans.length, sets: sets.map(s => ({ id: s.id, status: s.status, layout: s.layout, pill: s.pill, reason: s.reason || s.error || null })), ms: Date.now() - t0 };
    if (!dryRun) {
      const st = loadState(); st.last_run = { at: new Date().toISOString(), ...summary }; saveState(st);
      const ok = sets.filter(s => ["scheduled", "rendered"].includes(s.status));
      if (!plans.length) deps.notify?.("gh0stlayer news cards", "geen geschikt item vandaag (alles afgewezen of al gebruikt)", "warning");
      else if (!ok.length) deps.notify?.("gh0stlayer news cards mislukt", sets.map(s => s.reason || s.error).join("; ").slice(0, 400), "danger");
      else deps.notify?.("gh0stlayer news cards klaar", ok.map(s => `${s.layout} · ${nc.stripMarks(s.card?.headline || "")}`).join("\n"), "info");
    }
    return { ...summary, manifests: sets };
  } finally {
    running = false;
  }
}

// ---------- worker: due IG posts, X status sync, metrics, weekly reweight ----------
let ticking = false;
async function tick(deps, nowMs = Date.now()) {
  if (ticking) return;
  ticking = true;
  try {
    for (const m of listSets({ limit: 60 })) {
      let changed = false;
      const ig = m.posts?.instagram;
      if (ig && ig.status === "scheduled" && Date.parse(ig.due_at) <= nowMs && (!ig.next_at || Date.parse(ig.next_at) <= nowMs)) {
        await publishInstagram({ deps, m }); changed = true;
      }
      const x = m.posts?.x;
      if (x?.task_id && !["published", "failed"].includes(x.status)) {
        const t = deps.getXTask(x.task_id);
        if (t && t.status === "published") Object.assign(x, { status: "published", hook_id: t.pair?.hook_id || t.message_id, reply_ids: t.pair?.reply_ids || [], published_at: t.published_at }), changed = true;
        else if (t && t.status === "failed") Object.assign(x, { status: "failed", error: String(t.error || "").slice(0, 300) }), changed = true;
        else if (!t) Object.assign(x, { status: "failed", error: "X taak verwijderd" }), changed = true;
      }
      if (await collectMetrics(deps, m, nowMs)) changed = true;
      if (changed) saveSet(m);
    }
    maybeReweight(nowMs);
  } finally { ticking = false; }
}

function metricWindow(at, nowMs) {
  const age = nowMs - Date.parse(at);
  if (age >= 24 * 3.6e6 && age < 60 * 3.6e6) return "h24";
  if (age >= 72 * 3.6e6 && age < 14 * 864e5) return "h72";
  return null;
}
async function collectMetrics(deps, m, nowMs) {
  let changed = false;
  m.metrics = m.metrics || {};
  const ig = m.posts?.instagram;
  if (ig?.status === "published" && ig.media_id) {
    const w = metricWindow(ig.published_at, nowMs);
    if (w && !m.metrics.instagram?.[w]) {
      try { m.metrics.instagram = { ...(m.metrics.instagram || {}), [w]: { at: new Date(nowMs).toISOString(), ...(await deps.igMetrics(ig.media_id)) } }; }
      catch (e) { m.metrics.instagram = { ...(m.metrics.instagram || {}), [w]: { at: new Date(nowMs).toISOString(), error: e.message.slice(0, 200) } }; }
      changed = true;
    }
  }
  const x = m.posts?.x;
  if (x?.task_id && x.status === "published") {
    const t = deps.getXTask(x.task_id);
    const pm = t?.pair?.metrics || {};
    for (const w of ["h24", "h72"]) if (pm[w] && !m.metrics.x?.[w]) {
      const h = pm[w].hook || {}, r = pm[w].reply || null;
      m.metrics.x = { ...(m.metrics.x || {}), [w]: { at: pm[w].at, impressions: h.impression_count, likes: h.like_count, replies: h.reply_count, reposts: h.retweet_count, bookmarks: h.bookmark_count,
        reply_depth: h.impression_count ? Math.round((r?.impression_count || 0) / h.impression_count * 1000) / 1000 : null }, score: t.pair.score || null };
      changed = true;
    }
  }
  const tt = m.posts?.tiktok;
  if (tt?.status === "queued" && !m.metrics.tiktok && metricWindow(tt.due_at, nowMs)) { m.metrics.tiktok = { note: "geen metrics via Buffer API" }; changed = true; }
  if (changed) m.score = { ...(m.score || {}), perf: setScore(m) };
  return changed;
}

// Engagement score per set: IG (likes + 2 comments + 3 saves + 3 shares) / reach and X pair score, averaged.
function setScore(m) {
  const parts = [];
  const ig = m.metrics?.instagram?.h72 || m.metrics?.instagram?.h24;
  if (ig && ig.reach) parts.push(((ig.likes || 0) + 2 * (ig.comments || 0) + 3 * (ig.saved || 0) + 3 * (ig.shares || 0)) / ig.reach * 10);
  const xs = m.metrics?.x?.score?.score;
  if (Number.isFinite(xs)) parts.push(xs);
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length * 1e4) / 1e4 : null;
}

function maybeReweight(nowMs = Date.now(), force = false) {
  const st = loadState();
  if (!force && nowMs - Date.parse(st.reweighted_at || 0) < 7 * 864e5) return st.weights || null;
  const cutoff = nowMs - 56 * 864e5;
  const scored = listSets({ limit: 500 }).filter(m => Date.parse(m.created_at) >= cutoff && Number.isFinite(m.score?.perf))
    .map(m => ({ layout: m.layout, pill: m.pill, score: { score: m.score.perf } }));
  st.weights = { layout: xPairs.reweight(scored, "layout", nc.LAYOUTS), pill: xPairs.reweight(scored, "pill", nc.PILLS), based_on: scored.length, exploration: xPairs.EXPLORATION };
  st.reweighted_at = new Date(nowMs).toISOString();
  saveState(st);
  console.log(`[NEWS-CARDS] reweight op ${scored.length} sets`);
  return st.weights;
}

// Panel rows: last N sets with slide 1, layout, pill, source, post links and metrics.
function panel(limit = 30) {
  return listSets({ limit }).map(m => ({
    id: m.id, created_at: m.created_at, status: m.status, reason: m.reason || m.error || null, layout: m.layout, pill: m.pill,
    headline: nc.stripMarks(m.card?.headline || m.item?.title || ""), source: m.card?.source || { name: m.item?.source, url: m.item?.url },
    thumb: m.slides?.[0]?.rel || null, slides: (m.slides || []).map(s => s.rel).filter(Boolean),
    posts: Object.fromEntries(Object.entries(m.posts || {}).map(([p, v]) => [p, { status: v.status, due_at: v.due_at, permalink: v.permalink || null, hook_id: v.hook_id || null, error: v.error || null }])),
    metrics: m.metrics || {}, perf: m.score?.perf ?? null, mode: m.publish_mode || null,
  }));
}

function status() {
  const st = loadState();
  return { running, config: config(), last_run: st.last_run || null, weights: st.weights || null, reweighted_at: st.reweighted_at || null, sets: listSets({ limit: 500 }).length };
}

module.exports = {
  DIR, SETS_DIR, MEDIA_DIR, DRY_DIR, DEFAULTS, PLATFORMS, config, loadSet, saveSet, listSets, history, localDay,
  pillOptions, pickPill, planLayouts, pickPersonaStill, buildSet, schedulePublish, publishInstagram, approve,
  run, tick, collectMetrics, setScore, maybeReweight, panel, status, isRunning: () => running,
};
