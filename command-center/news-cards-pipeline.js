// News cards: one pipeline per account (accounts/<name>.yaml), one code path.
// sources -> pick -> LLM card -> images -> render -> publish (Instagram Graph carousel + X task, direct APIs),
// manifests per account in <data_dir>/sets/, publish worker, metrics at 24 h / 72 h and weekly reweight.
// Platform calls (LLM, Nano Banana, Instagram, X tasks, gallery) are injected by api-server.js. No Buffer here.
const fs = require("fs");
const path = require("path");
const nc = require("./news-cards");
const accounts = require("./accounts");
const xPairs = require("./x-pairs");
const policy = require("./images/policy");
const ncSource = require("./sources/tcg/nc");

const ROOT = __dirname;
const PLATFORMS = ["instagram", "x"];
const PAIR_PROFILES = path.join(ROOT, "data", "x-pair-profiles.json");

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
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

// persona (gh0stlayer): a gh0st still from the gallery, three-quarter view preferred, not reused within N days.
function pickPersonaStill(stills, hist, now, days = 14, rand = Math.random) {
  const recent = new Set(hist.filter(h => h.persona_still && now - Date.parse(h.created_at) < days * 864e5).map(h => h.persona_still));
  const free = stills.filter(s => !recent.has(s.id));
  const pool = free.length ? free : stills;
  const pref = pool.filter(s => /three[- ]quarter|3\/4/i.test(s.prompt || ""));
  const list = pref.length ? pref : pool;
  return list.length ? list[Math.floor(rand() * list.length)] : null;
}

// ---------- own photo gallery (image_policy.kind: gallery) ----------
// <gallery_dir>/tags.json: [{file, card, set, grade, kind: slab|in_hand|desk, generic?}]. Only our own photos.
function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function galleryPhotos(dir) {
  const list = readJson(path.join(dir, "tags.json"), []);
  return (Array.isArray(list) ? list : []).filter(p => p && p.file && !/[\\/]/.test(p.file) && /\.(png|jpe?g|webp)$/i.test(p.file))
    .map(p => ({ ...p, path: path.join(dir, p.file) })).filter(p => fs.existsSync(p.path));
}
// Match the item's card or set name to the photo tags; then a generic slab shot; null = pattern fallback.
function pickGalleryPhoto(photos, text, { kinds = ["slab"], exclude = [], recent = [] } = {}) {
  const t = ` ${norm(text)} `;
  const pool = photos.filter(p => kinds.includes(p.kind || "slab") && !exclude.includes(p.file));
  const score = p => (p.card && t.includes(` ${norm(p.card)} `) ? 2 : 0) + (p.set && t.includes(` ${norm(p.set)} `) ? 1 : 0);
  const ranked = pool.map(p => ({ p, s: score(p) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || recent.indexOf(a.p.file) - recent.indexOf(b.p.file));
  if (ranked.length) return { photo: ranked[0].p, match: ranked[0].s >= 2 ? "card" : "set" };
  const generic = pool.filter(p => p.generic || (!p.card && !p.set));
  const g = (generic.length ? generic : pool).sort((a, b) => recent.indexOf(a.file) - recent.indexOf(b.file))[0];
  return g ? { photo: g, match: "generic" } : null;
}

function pairProfile(channelId) { return (readJson(PAIR_PROFILES, {}) || {})[channelId] || {}; }

function createPipeline(accountId) {
  const A = nc.account(accountId);
  const P = A.profile;
  const isGh = A.id === "gh0stlayer";
  // NEWS_CARDS_DIR overrides the data root (tests only): gh0stlayer uses it as is, other accounts get a subfolder.
  const DIR = process.env.NEWS_CARDS_DIR ? (isGh ? process.env.NEWS_CARDS_DIR : path.join(process.env.NEWS_CARDS_DIR, A.id)) : path.join(ROOT, P.data_dir || `data/news-cards/${A.id}`);
  const SETS_DIR = path.join(DIR, "sets");
  const CONFIG_FILE = path.join(DIR, "config.json");
  const STATE_FILE = path.join(DIR, "state.json");
  const MEDIA_PATH = String(P.media_path || `media/cards/${A.id}`).replace(/^\/+|\/+$/g, "");
  const MEDIA_DIR = path.join(ROOT, "public", MEDIA_PATH);
  const MEDIA_REL = `/${MEDIA_PATH}`;
  const DRY_DIR = path.join(DIR, "dry-run");
  const IP = P.image_policy || {};
  const GALLERY_DIR = IP.gallery_dir ? path.join(ROOT, IP.gallery_dir) : null;

  // Several runs per day possible (one news_cards schedule entry per run, payload {account}). Each platform posts
  // delay_min after the run, at most max_per_day per local day and min_gap_hours apart. Override in <data_dir>/config.json.
  const pp = (P.publish || {}).platforms || {};
  const DEFAULTS = {
    enabled: true,
    channel_id: P.channel_id,
    sets_per_run: (P.schedule || {}).sets_per_run || 1,
    tz: (P.schedule || {}).tz || "Europe/Madrid",
    min_score: A.minScore,
    persona_rotation_days: IP.persona_rotation_days || 14,
    platforms: {
      instagram: { enabled: true, delay_min: 45, max_per_day: 3, min_gap_hours: 3, ...(pp.instagram || {}) },
      x: { enabled: true, delay_min: 20, max_per_day: 3, min_gap_hours: 3, ...(pp.x || {}) },
    },
  };

  function config() {
    const c = readJson(CONFIG_FILE, {});
    const out = { ...DEFAULTS, ...c, platforms: {} };
    for (const p of PLATFORMS) out.platforms[p] = { ...DEFAULTS.platforms[p], ...((c.platforms || {})[p] || {}) };
    out.sets_per_run = Math.min(3, Math.max(1, Number(out.sets_per_run) || 1));
    out.account = A.id;
    return out;
  }

  // ---------- manifests ----------
  function setFile(id) { return path.join(SETS_DIR, `${String(id).replace(/[^\w-]/g, "")}.json`); }
  function loadSet(id) { return readJson(setFile(id), null); }
  function saveSet(m) { m.updated_at = new Date().toISOString(); m.account = A.id; writeJson(setFile(m.id), m); return m; }
  function listSets({ limit = 30, includeDry = false } = {}) {
    let files = [];
    try { files = fs.readdirSync(SETS_DIR).filter(f => f.endsWith(".json")); } catch { return []; }
    return files.map(f => readJson(path.join(SETS_DIR, f), null)).filter(Boolean)
      .filter(m => includeDry || !m.dry_run)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
  }
  function history() {
    return listSets({ limit: 500 }).filter(m => m.status !== "skipped" && m.status !== "failed")
      .map(m => ({ created_at: m.created_at, layout: m.layout, pill: m.pill, dedup_key: m.item?.dedup_key, persona_still: m.images?.persona_task_id, photos: m.images?.photos || [] }));
  }
  function loadState() { return readJson(STATE_FILE, {}); }
  function saveState(s) { writeJson(STATE_FILE, s); }

  // ---------- picking ----------
  // Pills that fit the item (profile pill_rules); the learned weights pick among them (15% exploration in weightedPick).
  function pillOptions(item, layout) {
    const R = A.pillRules || {};
    // Optional per account: a layout with a fixed pill (Slabhaus: versus = then vs now, persona = haus take),
    // and source hints (item.pill_hint, e.g. NC pop data = pop report). gh0stlayer sets neither.
    const fixed = ((R.fixed_by_layout || {})[layout] || []).filter(p => A.pills.includes(p));
    if (fixed.length) return fixed;
    if (R.use_hints && item.pill_hint && A.pills.includes(item.pill_hint)) return [item.pill_hint];
    const ents = (item.entities || []).map(e => String(e).toLowerCase());
    const text = `${item.title} ${item.summary || ""}`.toLowerCase();
    const out = [...(R.base || [])];
    out.push(...((R.by_layout || {})[layout] || []));
    for (const r of R.match || []) {
      if ((r.entities || []).some(e => ents.includes(e)) || (r.text && new RegExp(r.text).test(text))) out.push(r.pill);
    }
    out.push(...((R.by_kind || {})[item.kind] || []));
    return [...new Set(out)].filter(p => A.pills.includes(p));
  }
  function pickPill(item, layout, weights = {}, rand = Math.random) {
    return xPairs.weightedPick(pillOptions(item, layout), weights.pill || {}, rand) || A.pills[0];
  }

  // Best item per requested layout (dry-run: one set per layout, evergreen fills the gaps).
  function planLayouts(items, hist, layouts, now) {
    const scored = items.map(item => ({ item, score: nc.scoreItem(item, now, A) }))
      .filter(c => !c.score.reject).sort((a, b) => b.score.total - a.score.total);
    const used = new Set();
    return layouts.filter(l => (A.weeklyMix[l] || 0) > 0).map(layout => {
      const c = scored.find(c => !used.has(c) && nc.compatibleLayouts(c.item).includes(layout));
      if (!c) return null;
      used.add(c);
      return { ...c, layout };
    }).filter(Boolean);
  }

  // ---------- images ----------
  // Image policy (images/policy.js, same for every account). Per slot: own matching photo, official press image,
  // card database scan in a slab frame, generic own photo, then own SVG chart / Nano Banana neutral scene / pattern.
  // Persona takes own images only (tier 3); number and payload have no image. Every choice lands in m.images.
  async function imagesFor({ deps, m, card, plan, setId, hist, now }) {
    const images = {};
    const L = plan.layout;
    const item = plan.item;
    if (!(policy.LAYOUT_TIERS[L] || []).length) { m.images.source = "none"; return images; }
    const gallery = IP.kind === "gallery";
    const photos = gallery && GALLERY_DIR ? galleryPhotos(GALLERY_DIR) : [];
    const recent = hist.filter(h => now - Date.parse(h.created_at) < 14 * 864e5).flatMap(h => h.photos || []);
    const text = [card.image_brief, nc.stripMarks(card.headline), item.title, (item.entities || []).join(" ")].join(" ");
    const series = Array.isArray(item.series) && item.series.length >= 2 ? item.series : null;
    const used = [];
    m.images.photos = [];
    const own = hit => ({ file: hit.photo.path, record: { source: "gallery", file: hit.photo.file, match: hit.match } });
    const cardImage = deps.cardImage || (c => ncSource.cardImage({ base: (P.sources || {}).nc_api, key: process.env[(P.credentials || {}).nc_api_key_env || "NC_API_KEY"], card: c }));
    const slots = L === "versus" ? ["left", "right"] : ["hook"];
    for (const slot of slots) {
      const slotText = slot === "hook" ? text : `${card.versus?.[slot]?.label || ""} ${text}`;
      const kinds = L === "persona" ? ["in_hand", "desk"] : ["slab"];
      const ctx = {
        used, cardImage, log: s => log(m, s),
        async galleryMatch() {
          if (L === "persona" && !gallery) {
            if (!deps.personaStills) return null;
            const still = pickPersonaStill(deps.personaStills(), hist, now, config().persona_rotation_days);
            if (!still) return null;
            m.images.persona_task_id = still.id;
            return { file: still.file, record: { source: "persona_still", url: still.url, task_id: still.id, match: "persona" } };
          }
          const hit = gallery ? pickGalleryPhoto(photos, slotText, { kinds, recent, exclude: m.images.photos }) : null;
          return hit && (hit.match !== "generic" || L === "persona") ? own(hit) : null;
        },
        async galleryGeneric() {
          const hit = gallery ? pickGalleryPhoto(photos, slotText, { kinds, recent, exclude: m.images.photos }) : null;
          return hit ? own(hit) : null;
        },
        async tier4() {
          if (series) return { chart: series, record: { source: "svg_chart" } };
          if (!deps.genImage) return null;
          const aspect = slot === "hook" ? "4:5" : "1:1";
          if (gallery) {
            if (!(IP.neutral_scenes || []).length) return null;
            const scene = IP.neutral_scenes[Math.floor(Math.random() * IP.neutral_scenes.length)];
            const r = await deps.genImage({ prompt: `${scene} ${A.imageRules}`, aspect, setId, label: `${L} ${slot} scene`, account: A.id });
            return { file: r.file, record: { ...r, source: "nano_banana_neutral", scene } };
          }
          const brief = slot === "hook" ? card.image_brief : `${card.image_brief}. This frame shows: ${card.versus?.[slot]?.label || slot}`;
          const r = await deps.genImage({ prompt: nc.imagePrompt(brief, A), aspect, setId, label: slot === "hook" ? L : `versus ${slot}`, account: A.id });
          return { file: r.file, record: { ...r, source: "nano_banana_neutral" } };
        },
      };
      const r = await policy.resolve({ A, item, layout: L, slot, setId, dataDir: DIR, ctx, io: deps.imageIo || {} });
      m.images[slot] = r.record;
      if (r.record.source === "gallery") m.images.photos.push(r.record.file);
      if (r.file) images[slot] = nc.dataUri(r.file);
      else if (r.chart) images[`${slot}_series`] = r.chart;
      log(m, `beeld ${slot}: ${r.record.policy_tier ? `tier ${r.record.policy_tier} ` : ""}${r.record.source}`);
    }
    if (L === "persona" && !images.hook) log(m, "geen eigen beeld voor de persona; render zonder beeld");
    // Caption credit when a downloaded image (tier 1 or 2) is used.
    const credit = policy.creditLine(slots.map(s => m.images[s]));
    if (credit && card.caption && !card.caption.includes(credit)) { card.caption = `${card.caption.trimEnd()}\n${credit}`; m.images.credit = credit; }
    return images;
  }

  // ---------- one set ----------
  async function buildSet({ deps, plan, setId, dryRun, now, weights, hist }) {
    const m = {
      id: setId, account: A.id, created_at: new Date(now).toISOString(), dry_run: !!dryRun, status: "generating",
      item: { kind: plan.item.kind, source: plan.item.source, url: plan.item.url, title: plan.item.title, published_at: plan.item.published_at, dedup_key: nc.dedupKey(plan.item), data_fetched_at: plan.item.data_fetched_at || null, trend: plan.item.trend || null },
      score: plan.score, layout: plan.layout, pill: null, card: null, attempts: [], images: {}, slides: [], posts: {}, metrics: {}, log: [],
    };
    const pill = pickPill(plan.item, plan.layout, weights);
    log(m, `item "${String(plan.item.title).slice(0, 80)}" (${plan.item.source}, score ${plan.score.total}), layout ${plan.layout}, pill ${pill}`);
    if (!dryRun) saveSet(m);

    const gen = await nc.generateCard({ llm: deps.llm, item: plan.item, layout: plan.layout, pill, maxAttempts: 3, log: s => log(m, s), account: A });
    m.attempts = gen.attempts;
    if (!gen.ok) {
      m.status = "skipped"; m.reason = `validator: ${gen.reason}`;
      log(m, `overgeslagen na ${gen.attempts.length} pogingen: ${gen.reason}`);
      return dryRun ? m : saveSet(m);
    }
    const card = gen.card;
    card.pill = pill;                    // the weighted pick, not the model's own choice
    if (plan.layout === "number" && plan.item.pop) card.pop = plan.item.pop;   // bar chart from real pop data only
    m.card = card; m.pill = pill;
    m.validator = { ok: true, errors: [] };

    let images = {};
    try { images = await imagesFor({ deps, m, card, plan, setId, hist, now }); }
    catch (e) {
      log(m, `beeld mislukt: ${e.message.slice(0, 200)}; render zonder beeld`);
      m.images.error = e.message.slice(0, 300);
    }

    const outDir = dryRun ? DRY_DIR : MEDIA_DIR;
    const slides = await nc.renderSet(card, { setId, outDir, images, account: A });
    m.slides = slides.map(s => ({ ...s, rel: dryRun ? null : `${MEDIA_REL}/${path.basename(s.path)}` }));
    log(m, `${slides.length} slides gerenderd`);
    if (!dryRun && deps.gallery) {
      for (const s of m.slides) {
        try { s.gallery_task_id = deps.gallery({ setId, slide: s.slide, layout: s.layout, pill, url: s.rel, headline: nc.stripMarks(card.headline), source: card.source, account: A.id }); }
        catch (e) { log(m, `gallery slide ${s.slide}: ${e.message}`); }
      }
    }
    m.status = "rendered";
    return dryRun ? m : saveSet(m);
  }

  // ---------- publish ----------
  // Cadence: at most max_per_day posts per local day on a platform, and min_gap_hours between two posts.
  function cadenceAllows(platform, cfg, dueMs, exceptId) {
    const pc = cfg.platforms[platform];
    const max = Math.max(1, Number(pc.max_per_day) || 1);
    const gap = Math.max(0, Number(pc.min_gap_hours) || 0) * 3.6e6;
    const day = localDay(new Date(dueMs), cfg.tz);
    const times = listSets({ limit: 100 }).filter(m => m.id !== exceptId && m.posts?.[platform] && !["failed", "skipped", "off"].includes(m.posts[platform].status))
      .map(m => Date.parse(m.posts[platform].due_at || m.created_at)).filter(Number.isFinite);
    if (times.filter(t => localDay(new Date(t), cfg.tz) === day).length >= max) return { ok: false, reason: `max ${max} per dag` };
    if (times.some(t => Math.abs(dueMs - t) < gap)) return { ok: false, reason: `minder dan ${pc.min_gap_hours} uur na vorige post` };
    return { ok: true };
  }

  function xPremium(channelId) {
    const v = (P.publish || {}).x_premium;
    return v === "pair_profile" ? pairProfile(channelId).premium === true : v === true;
  }
  // Marketplace link in the X reply: at most 1 in every 3 sets (x_link_ratio), URLs from the pair profile.
  function xReplyLink(channelId, exceptId) {
    const pub = P.publish || {};
    if (pub.x_links_from !== "pair_profile") return null;
    const urls = ((pairProfile(channelId).link || {}).urls || []).filter(u => u && u.url && u.enabled !== false && /^https:\/\//.test(u.url));
    if (!urls.length) return null;
    const every = Math.max(1, Math.round(1 / (Number(pub.x_link_ratio) || 1 / 3)));
    const last = listSets({ limit: 20 }).filter(m => m.id !== exceptId && m.posts?.x?.task_id).slice(0, every - 1);
    if (last.some(m => m.posts.x.link)) return null;
    return urls[listSets({ limit: 500 }).filter(m => m.posts?.x?.link).length % urls.length];
  }

  // mode auto: schedule on every enabled platform. Other modes: X draft + IG waits for approval in the dashboard.
  async function schedulePublish({ deps, m, only = null, immediate = false, nowMs = Date.now() }) {
    const cfg = config();
    const channel = deps.channel(cfg.channel_id);
    if (!channel) throw new Error(`kanaal ${cfg.channel_id} niet gevonden`);
    const mode = (channel.autopilot && channel.autopilot.mode) || "auto";
    const auto = mode === "auto";
    m.publish_mode = mode;
    const xCreds = deps.xCredsOk ? deps.xCredsOk(channel.id, A.id) : true;
    for (const p of PLATFORMS) {
      const pc = cfg.platforms[p];
      if (only && !only.includes(p)) continue;
      if (!pc.enabled) { m.posts[p] = { status: "off" }; continue; }
      if (p === "x" && !xCreds) { m.posts[p] = { status: "off", reason: "geen X-credentials voor dit kanaal" }; log(m, "X uit: geen credentials"); continue; }
      const due = new Date(immediate ? nowMs : nowMs + Math.max(5, Number(pc.delay_min) || 0) * 60000);
      const cad = only ? { ok: true } : cadenceAllows(p, cfg, due.getTime(), m.id);
      if (!cad.ok) { m.posts[p] = { status: "skipped", reason: `cadence: ${cad.reason}` }; continue; }
      m.posts[p] = { status: auto ? "scheduled" : "awaiting_approval", due_at: due.toISOString() };
    }
    if (m.posts.x && ["scheduled", "awaiting_approval"].includes(m.posts.x.status)) {
      let reply = m.card.x_reply;
      const link = xReplyLink(channel.id, m.id);
      if (link && xPairs.weightedLength(`${reply}\n${link.url}`) <= 280) { reply = `${reply}\n${link.url}`; m.posts.x.link = link.url; }
      const task = deps.addXTask({
        channel_id: channel.id, status: auto ? "scheduled" : "draft", scheduled_at: m.posts.x.due_at,
        text: m.card.x_hook, media_path: m.slides[0].rel, media_paths: [m.slides[0].rel],
        topic: nc.stripMarks(m.card.headline).slice(0, 80), format: "news_card", news_set_id: m.id, news_account: A.id,
        pair: { hook: m.card.x_hook, replies: [reply], formula: "news_card", pillar: m.layout, pillar_label: m.pill,
          premium: xPremium(channel.id), has_media: true, has_link: !!m.posts.x.link, brand_mention: false, media_kind: "news_card",
          facts_used: [m.item.url].filter(Boolean), fallback: false, validator: m.validator, metrics: {}, score: null, created_at: new Date().toISOString() },
      });
      m.posts.x.task_id = task.id;
    }
    m.status = "scheduled";
    saveSet(m);
  }

  async function publishInstagram({ deps, m }) {
    const post = m.posts.instagram;
    try {
      const r = await deps.igCarousel(m, A);
      Object.assign(post, { status: "published", media_id: r.media_id, permalink: r.permalink, published_at: new Date().toISOString(), error: null });
      log(m, `Instagram carousel gepubliceerd: ${r.permalink || r.media_id}`);
      deps.notify?.(`${A.label}: Instagram`, r.permalink || r.media_id, "info");
    } catch (e) {
      post.attempts = (post.attempts || 0) + 1;
      post.error = e.message.slice(0, 300);
      if (post.attempts >= 3) { post.status = "failed"; deps.notify?.(`${A.label}: Instagram mislukt`, post.error, "danger"); }
      else post.next_at = new Date(Date.now() + post.attempts * 10 * 60000).toISOString();
      log(m, `Instagram poging ${post.attempts} mislukt: ${post.error}`);
    }
  }

  // Approve a set that waits (non-auto mode): IG gets scheduled (direct Graph API in tick), the X draft is scheduled.
  async function approve(deps, id) {
    const m = loadSet(id);
    if (!m) throw new Error("set niet gevonden");
    for (const p of PLATFORMS) if (m.posts[p]?.status === "awaiting_approval") m.posts[p].status = "scheduled";
    if (m.posts.x?.task_id) deps.updateXTask(m.posts.x.task_id, t => { if (t.status === "draft") t.status = "scheduled"; });
    m.approved_at = new Date().toISOString();
    return saveSet(m);
  }

  // ---------- run ----------
  let running = false;
  function fetchSources(opts) {
    const pack = (P.sources || {}).pack || "crypto";
    return pack === "tcg" ? require("./sources/tcg").fetchAll({ ...opts, account: P }) : require("./sources").fetchAll(opts);
  }
  async function run({ deps, dryRun = false, layouts = null, count = null, only = null, immediate = false, reason = "manual", now = Date.now(), items = null } = {}) {
    if (running) throw new Error(`${A.label} draaien al`);
    running = true;
    const t0 = Date.now();
    try {
      const cfg = config();
      const src = items ? { items, status: { injected: items.length } } : await fetchSources({ now, log: s => console.log(`[NEWS-CARDS ${A.id}] ${s}`) });
      const hist = history();
      const weights = loadState().weights || {};
      const plans = layouts
        ? planLayouts(src.items, hist, layouts, now)
        : nc.planDay(src.items, hist, { count: count || cfg.sets_per_run, weights, now, minScore: cfg.min_score, account: A });
      const sets = [];
      for (const plan of plans) {
        let m;
        try {
          m = await buildSet({ deps, plan, setId: newSetId(now), dryRun, now, weights, hist });
          if (!dryRun && m.status === "rendered") await schedulePublish({ deps, m, only, immediate, nowMs: Date.now() });
        } catch (e) {
          m = m || { id: "?", layout: plan.layout };
          m.status = "failed"; m.error = e.message.slice(0, 300);
          console.error(`[NEWS-CARDS ${A.id}] set ${m.id} mislukt: ${e.stack || e.message}`);
          if (!dryRun && m.id !== "?") saveSet(m);
        }
        sets.push(m);
        hist.push({ created_at: new Date(now).toISOString(), layout: plan.layout, dedup_key: nc.dedupKey(plan.item), persona_still: m.images?.persona_task_id, photos: m.images?.photos || [] });
      }
      await nc.closeBrowser();
      const summary = { account: A.id, reason, dry_run: dryRun, sources: src.status, candidates: src.items.length, planned: plans.length, sets: sets.map(s => ({ id: s.id, status: s.status, layout: s.layout, pill: s.pill, reason: s.reason || s.error || null })), ms: Date.now() - t0 };
      if (!dryRun) {
        const st = loadState(); st.last_run = { at: new Date().toISOString(), ...summary }; saveState(st);
        const ok = sets.filter(s => ["scheduled", "rendered"].includes(s.status));
        if (!plans.length) deps.notify?.(A.label, "geen geschikt item vandaag (alles afgewezen of al gebruikt)", "warning");
        else if (!ok.length) deps.notify?.(`${A.label} mislukt`, sets.map(s => s.reason || s.error).join("; ").slice(0, 400), "danger");
        else deps.notify?.(`${A.label} klaar`, ok.map(s => `${s.layout} · ${nc.stripMarks(s.card?.headline || "")}`).join("\n"), "info");
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

  async function collectMetrics(deps, m, nowMs) {
    let changed = false;
    m.metrics = m.metrics || {};
    const ig = m.posts?.instagram;
    if (ig?.status === "published" && ig.media_id) {
      const w = metricWindow(ig.published_at, nowMs);
      if (w && !m.metrics.instagram?.[w]) {
        try { m.metrics.instagram = { ...(m.metrics.instagram || {}), [w]: { at: new Date(nowMs).toISOString(), ...(await deps.igMetrics(ig.media_id, A)) } }; }
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
    if (changed) m.score = { ...(m.score || {}), perf: setScore(m) };
    return changed;
  }

  // Engagement score per set with the account's metric weights: IG weighted engagement / reach and X pair score, averaged.
  function setScore(m) {
    const W = { ig_likes: 1, ig_comments: 2, ig_saved: 3, ig_shares: 3, x: 1, ...((P.metrics || {}).weights || {}) };
    const parts = [];
    const ig = m.metrics?.instagram?.h72 || m.metrics?.instagram?.h24;
    if (ig && ig.reach) parts.push((W.ig_likes * (ig.likes || 0) + W.ig_comments * (ig.comments || 0) + W.ig_saved * (ig.saved || 0) + W.ig_shares * (ig.shares || 0)) / ig.reach * 10);
    const xs = m.metrics?.x?.score?.score;
    if (Number.isFinite(xs)) parts.push(W.x * xs);
    return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length * 1e4) / 1e4 : null;
  }

  function maybeReweight(nowMs = Date.now(), force = false) {
    const st = loadState();
    if (!force && nowMs - Date.parse(st.reweighted_at || 0) < 7 * 864e5) return st.weights || null;
    const cutoff = nowMs - 56 * 864e5;
    const scored = listSets({ limit: 500 }).filter(m => Date.parse(m.created_at) >= cutoff && Number.isFinite(m.score?.perf))
      .map(m => ({ layout: m.layout, pill: m.pill, score: { score: m.score.perf } }));
    st.weights = { layout: xPairs.reweight(scored, "layout", nc.LAYOUTS), pill: xPairs.reweight(scored, "pill", A.pills), based_on: scored.length, exploration: xPairs.EXPLORATION };
    st.reweighted_at = new Date(nowMs).toISOString();
    saveState(st);
    console.log(`[NEWS-CARDS ${A.id}] reweight op ${scored.length} sets`);
    return st.weights;
  }

  // Panel rows: last N sets with slide 1, layout, pill, source, post links and metrics.
  function panel(limit = 30) {
    return listSets({ limit }).map(m => ({
      id: m.id, account: A.id, created_at: m.created_at, status: m.status, reason: m.reason || m.error || null, layout: m.layout, layout_label: nc.layoutLabel(m.layout, A), pill: m.pill,
      headline: nc.stripMarks(m.card?.headline || m.item?.title || ""), source: m.card?.source || { name: m.item?.source, url: m.item?.url },
      thumb: m.slides?.[0]?.rel || null, slides: (m.slides || []).map(s => s.rel).filter(Boolean),
      posts: Object.fromEntries(Object.entries(m.posts || {}).filter(([p]) => PLATFORMS.includes(p)).map(([p, v]) => [p, { status: v.status, due_at: v.due_at, permalink: v.permalink || null, hook_id: v.hook_id || null, error: v.error || v.reason || null }])),
      metrics: m.metrics || {}, perf: m.score?.perf ?? null, mode: m.publish_mode || null,
    }));
  }

  function status() {
    const st = loadState();
    return { account: A.id, label: A.label, running, config: config(), last_run: st.last_run || null, weights: st.weights || null, reweighted_at: st.reweighted_at || null, sets: listSets({ limit: 500 }).length };
  }

  return {
    account: A, id: A.id, label: A.label, DIR, SETS_DIR, MEDIA_DIR, MEDIA_REL, DRY_DIR, GALLERY_DIR, DEFAULTS, PLATFORMS,
    config, loadSet, saveSet, listSets, history, localDay,
    pillOptions, pickPill, planLayouts, pickPersonaStill, imagesFor, buildSet, schedulePublish, publishInstagram, approve, xReplyLink, xPremium,
    run, tick, collectMetrics, setScore, maybeReweight, panel, status, isRunning: () => running,
  };
}

function metricWindow(at, nowMs) {
  const age = nowMs - Date.parse(at);
  if (age >= 24 * 3.6e6 && age < 60 * 3.6e6) return "h24";
  if (age >= 72 * 3.6e6 && age < 14 * 864e5) return "h72";
  return null;
}

const _pipes = new Map();
function forAccount(id = "gh0stlayer") {
  const key = String(id || "gh0stlayer").toLowerCase();
  if (!_pipes.has(key)) _pipes.set(key, createPipeline(key));
  return _pipes.get(key);
}
function accountIds() { return accounts.list(); }

// Backwards compatible: the module itself is the gh0stlayer pipeline.
module.exports = { ...forAccount("gh0stlayer"), createPipeline, forAccount, accountIds, galleryPhotos, pickGalleryPhoto, metricWindow };
