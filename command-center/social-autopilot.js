// ── SOCIAL MEDIA AUTOPILOT (X) ────────────────
// Per X channel: plan N posts per day inside a time window, and for each slot
//   1. search X for recent, well-performing posts with an image: first from the
//      channel's curated accounts (if any), then on its topics (rotating,
//      least-posted topic first),
//   2. let Claude pick the best candidate and write an ORIGINAL post about it,
//   3. redraw the image in the channel's house style via Higgsfield,
//   4. queue it as a community task — the existing worker publishes it.
// State (daily plan, used sources) lives in data/community/autopilot-state.json.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const cardTemplate = require("./card-template");

const DEFAULTS = {
  enabled: false,
  mode: "auto",            // auto = post straight away, review = land as draft
  posts_per_day: 8,
  window_start: "08:00",
  window_end: "23:00",
  topics: [],              // lines: "Label: X search query" or just a query
  min_likes: 20,
  accounts: [],            // curated X handles; searched before the topics
  min_followers: 1000,     // shill/bot accounts are mostly small; 0 = off
  search_depth: 20,        // posts read per search (X bills per post read)
  max_age_hours: 36,
  language: "English",
  voice: "",               // optional description of the account's voice
  style_prompt: "",        // house style for images; empty = derived from brand
  style_refs: [],          // /media/... images that show the house style
  image_mode: "ai",        // ai = Higgsfield redraw; template = source photo in a fixed template (card-template.js)
  template_mark: "",       // small wordmark at the bottom of the template
  template_hue: 43,        // accent colour of the template (hsl hue)
  // Daily promo: N of the day's slots promote your own product instead of reacting to X.
  promo_enabled: false,
  promo_per_day: 1,
  promo_product: "",       // product name
  promo_facts: "",         // what it is / does / offers; the ONLY claims the post may make
  promo_link: "",          // landing page, appended to the post by code
  promo_images: [],        // /media/... product visuals, rotated (least used first)
};

const MODEL = process.env.SOCIAL_AUTOPILOT_MODEL || "claude-sonnet-5-5";
const MAX_CANDIDATES = 6;
const PER_TOPIC = 3;        // one noisy topic may not fill the whole shortlist
const TOPICS_PER_ROUND = 2; // topics searched before Claude picks
const MAX_SEARCHES = 4;     // per run; a rejected shortlist triggers the next topics
const LATE_LIMIT_MS = 90 * 60 * 1000;   // a slot this late (server was down) is skipped
const RETRY_DELAY_MS = 10 * 60 * 1000;
const MAX_TRIES = 3;
const X_IMAGE_MAX = 5 * 1024 * 1024;
const PROMO_RE = /\b(giveaways?|airdrops?|presales?|pre-sale|whitelist|free mint|claim (now|your)|dm me|link in (bio|comments)|join (my|our)|telegram group|whatsapp|discord\.gg|referral|use (my )?code|promo code|sign ?up bonus|\d{3,}x|next (gem|100x)|to the moon|mint(ing)? (is )?(live|now)|stealth launch|fair launch|just launched|ape in|tag \d+ friends|like (and|&) (rt|retweet)|rt (and|&) follow)\b/i;
// A contract address in the text is the clearest sign of a token shill.
const CA_RE = /\b(CA\s*[:：]|0x[a-fA-F0-9]{40}\b|[1-9A-HJ-NP-Za-km-z]{32,44}(pump|bonk)?\b)/;
const QUERY_MAX = 512;       // X search query length limit
const MAX_ACCOUNTS = 100;
const IMAGE_ASPECTS = { "16:9": 16 / 9, "3:2": 3 / 2, "4:3": 4 / 3, "1:1": 1, "4:5": 4 / 5 };

// ── pure helpers (exported for tests) ─────────
function config(channel) {
  const c = { ...DEFAULTS, ...(channel && channel.autopilot || {}) };
  c.posts_per_day = Math.min(24, Math.max(1, Number(c.posts_per_day) || DEFAULTS.posts_per_day));
  c.min_likes = Math.max(0, Number(c.min_likes) || 0);
  c.min_followers = Math.max(0, Number(c.min_followers ?? DEFAULTS.min_followers) || 0);
  c.search_depth = Math.min(100, Math.max(10, Number(c.search_depth) || DEFAULTS.search_depth));
  c.max_age_hours = Math.min(168, Math.max(1, Number(c.max_age_hours) || DEFAULTS.max_age_hours));
  if (!/^\d{2}:\d{2}$/.test(c.window_start)) c.window_start = DEFAULTS.window_start;
  if (!/^\d{2}:\d{2}$/.test(c.window_end)) c.window_end = DEFAULTS.window_end;
  if (!Array.isArray(c.topics)) c.topics = String(c.topics || "").split("\n");
  c.topics = c.topics.map(t => String(t).trim()).filter(Boolean);
  c.image_mode = c.image_mode === "template" ? "template" : "ai";
  c.template_mark = String(c.template_mark || "").slice(0, 30);
  c.template_hue = Number.isFinite(Number(c.template_hue)) ? Number(c.template_hue) % 360 : DEFAULTS.template_hue;
  c.accounts = parseAccounts(c.accounts);
  if (!Array.isArray(c.style_refs)) c.style_refs = [];
  c.promo_per_day = Math.min(c.posts_per_day, Math.max(1, Number(c.promo_per_day) || 1));
  c.promo_product = String(c.promo_product || "").trim().slice(0, 80);
  c.promo_facts = String(c.promo_facts || "").trim().slice(0, 4000);
  c.promo_link = /^https?:\/\/\S+$/.test(String(c.promo_link || "").trim()) ? String(c.promo_link).trim() : "";
  if (!Array.isArray(c.promo_images)) c.promo_images = [];
  c.promo_images = c.promo_images.map(String).filter(x => /^\/media\/[\w./-]+$/.test(x) && !x.includes(".."));
  // A promo without a product or facts would make Claude invent claims.
  c.promo_enabled = !!c.promo_enabled && !!c.promo_product && !!c.promo_facts;
  return c;
}

// Which of the fresh slots become promo slots: spread over the day, never the first
// slot when there is a choice (open the day with regular content).
function pickPromoSlots(nFresh, nPromo, rand = Math.random) {
  if (nPromo <= 0 || nFresh <= 0) return [];
  nPromo = Math.min(nPromo, nFresh);
  const out = [];
  for (let i = 0; i < nPromo; i++) {
    const lo = Math.floor(i * nFresh / nPromo), hi = Math.floor((i + 1) * nFresh / nPromo) - 1;
    const from = lo === 0 && hi > 0 ? 1 : lo;
    out.push(from + Math.floor(rand() * (hi - from + 1)));
  }
  return out;
}

// Least used first, ties random.
function pickLeastUsed(items, counts = {}, rand = Math.random) {
  if (!items.length) return null;
  return items.map(x => ({ x, n: counts[x] || 0, r: rand() })).sort((a, b) => a.n - b.n || a.r - b.r)[0].x;
}

// "Bitcoin: (bitcoin OR $BTC)" → { label, query }. Search operators like
// has:images have no space after the colon, so they never look like a label.
function parseTopics(lines) {
  return (lines || []).map(line => {
    const m = String(line).match(/^([^():"]{1,40}):\s+(.+)$/);
    return m ? { label: m[1].trim(), query: m[2].trim() } : { label: String(line).trim(), query: String(line).trim() };
  }).filter(t => t.query);
}

// "@WatcherGuru, https://x.com/glassnode" → ["WatcherGuru", "glassnode"]
function parseAccounts(input) {
  const raw = Array.isArray(input) ? input.join("\n") : String(input || "");
  const seen = new Set();
  const out = [];
  for (let tok of raw.split(/[\s,;]+/)) {
    tok = tok.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
    if (!/^[A-Za-z0-9_]{1,15}$/.test(tok) || seen.has(tok.toLowerCase())) continue;
    seen.add(tok.toLowerCase());
    out.push(tok);
  }
  return out.slice(0, MAX_ACCOUNTS);
}

// Curated accounts as search "topics": as many from: clauses per query as fit
// X's query length limit. The followers filter is off: these are hand-picked.
function accountTopics(accounts, ownUsername) {
  const groups = [];
  let cur = [];
  const fits = list => buildQuery(list.map(a => `from:${a}`).join(" OR "), ownUsername).length <= QUERY_MAX;
  for (const a of accounts) {
    if (cur.length && !fits([...cur, a])) { groups.push(cur); cur = []; }
    cur.push(a);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => ({
    label: groups.length > 1 ? `Curated ${i + 1}` : "Curated",
    query: g.map(a => `from:${a}`).join(" OR "),
    curated: true,
  }));
}

function buildQuery(query, ownUsername) {
  return `(${query}) has:images -is:retweet -is:reply -is:quote -is:nullcast lang:en -giveaway -airdrop -presale -whitelist -"free mint"${ownUsername ? ` -from:${ownUsername}` : ""}`;
}

function scoreTweet(t, nowMs) {
  const m = t.public_metrics || {};
  const eng = (m.like_count || 0) + 2 * (m.retweet_count || 0) + 2 * (m.quote_count || 0) + 0.5 * (m.reply_count || 0) + (m.bookmark_count || 0);
  const ageH = Math.max(0.25, (nowMs - Date.parse(t.created_at || 0)) / 3.6e6);
  const velocity = eng / Math.pow(ageH + 1, 1.3);
  const ratio = m.impression_count > 0 ? eng / m.impression_count : 0;
  return velocity * (1 + Math.min(ratio * 20, 1));
}

function isPromo(text) {
  const s = String(text || "");
  if (PROMO_RE.test(s)) return true;
  if (CA_RE.test(s)) return true;
  if ((s.match(/\$[A-Za-z]{2,10}\b/g) || []).length > 4) return true;
  if ((s.match(/#\w+/g) || []).length > 5) return true;
  return false;
}

// Turn a search response into ranked candidates, dropping everything we can't
// or shouldn't use.
function rankCandidates(resp, { nowMs, minLikes, maxAgeHours, minFollowers = 0, usedSources = [], usedAuthors = [] }) {
  const media = new Map((resp.includes?.media || []).map(m => [m.media_key, m]));
  const users = new Map((resp.includes?.users || []).map(u => [u.id, u]));
  const used = new Set(usedSources.map(String));
  const authorsUsed = new Set(usedAuthors.map(a => String(a).toLowerCase()));
  const out = [];
  for (const t of resp.data || []) {
    if (used.has(String(t.id))) continue;
    if (t.possibly_sensitive) continue;
    const photo = (t.attachments?.media_keys || []).map(k => media.get(k)).find(m => m && m.type === "photo" && m.url);
    if (!photo) continue;
    const user = users.get(t.author_id) || {};
    const author = user.username || "";
    if (author && authorsUsed.has(author.toLowerCase())) continue;
    if ((t.public_metrics?.like_count || 0) < minLikes) continue;
    const followers = user.public_metrics?.followers_count;
    if (minFollowers && followers != null && followers < minFollowers) continue;
    if (nowMs - Date.parse(t.created_at || 0) > maxAgeHours * 3.6e6) continue;
    if (isPromo(t.text)) continue;
    out.push({
      tweet_id: String(t.id),
      author,
      text: t.text || "",
      created_at: t.created_at,
      metrics: t.public_metrics || {},
      image: photo.url,
      width: photo.width || 0,
      height: photo.height || 0,
      score: scoreTweet(t, nowMs),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Shortlist for Claude: best first, but at most perTopic per topic so one
// noisy topic (full of shills) can't crowd out the others.
function pickCandidates(pool, max = MAX_CANDIDATES, perTopic = PER_TOPIC) {
  const seen = new Set();
  const perT = {};
  const out = [];
  for (const c of [...pool].sort((a, b) => b.score - a.score)) {
    if (seen.has(c.tweet_id)) continue;
    if ((perT[c.topic] || 0) >= perTopic) continue;
    seen.add(c.tweet_id);
    perT[c.topic] = (perT[c.topic] || 0) + 1;
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

// Never em/en dashes in post text (house rule); plus no links or stray quotes.
function cleanPostText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s*[\u2014\u2013]\s*(\S)?/g, (_, c) => ". " + (c ? c.toUpperCase() : ""))
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\.\s*\./g, ".")
    .replace(/[ \t]+\n/g, "\n")
    // Elke regel is een eigen alinea: op X en Instagram plakken losse regels anders aan elkaar.
    .replace(/([^\n])\n(?=[^\n])/g, "$1\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function nearestAspect(w, h) {
  if (!w || !h) return "16:9";
  const r = w / h;
  return Object.entries(IMAGE_ASPECTS).sort((a, b) => Math.abs(Math.log(a[1] / r)) - Math.abs(Math.log(b[1] / r)))[0][0];
}

// Minutes the zone is ahead of UTC at that instant.
function tzOffsetMin(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}
function localDay(date, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
// Wall-clock time on a local day → UTC instant (DST-safe).
function zonedTime(day, hhmm, tz) {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMin(new Date(guess), tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMin(new Date(t), tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

// n slots spread evenly over [fromMs, toMs], each jittered inside its own segment.
function planSlots(n, fromMs, toMs, rand = Math.random) {
  if (n <= 0 || toMs <= fromMs) return [];
  const seg = (toMs - fromMs) / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(new Date(fromMs + seg * i + seg * (0.1 + 0.8 * rand())).toISOString());
  return out;
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ── the autopilot itself ──────────────────────
function createAutopilot(deps) {
  const {
    dataDir, mediaDir, tz = "Europe/Amsterdam",
    readChannels, updateChannel, readTasks, addTask,
    twitterApi, twitterCredsFor, twitterVerify, twitterWeightedLength,
    higgsfield, anthropic, brand, notify,
    brandKnowledge = () => "",
    log = (...a) => console.log("[AUTOPILOT]", ...a),
  } = deps;
  const STATE_FILE = path.join(dataDir, "community", "autopilot-state.json");
  let busy = null; // { channel_id, step, started_at }

  function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
  }
  function saveState(s) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  }
  // Read-modify-write in one synchronous step so concurrent async work
  // never overwrites each other's changes.
  function mutate(channelId, fn) {
    const s = loadState();
    s[channelId] = s[channelId] || {};
    const r = fn(s[channelId]);
    saveState(s);
    return r;
  }

  // A crash mid-run leaves slots on "running"; give them another go.
  {
    const s = loadState();
    for (const st of Object.values(s)) for (const sl of st.slots || []) if (sl.status === "running") sl.status = "pending";
    saveState(s);
  }

  function ensurePlan(channel, st, now) {
    const cfg = config(channel);
    const day = localDay(now, tz);
    const key = `${day}|${cfg.posts_per_day}|${cfg.window_start}|${cfg.window_end}|${cfg.promo_enabled ? cfg.promo_per_day : 0}`;
    if (st.plan_key === key) return false;
    if (st.day !== day) { st.authors_today = []; st.topic_counts = {}; st.topic_rejects = {}; }
    const keep = st.day === day ? (st.slots || []).filter(s => s.status !== "pending") : [];
    const produced = keep.filter(s => s.status === "done" || s.status === "running").length;
    const start = zonedTime(day, cfg.window_start, tz).getTime();
    let end = zonedTime(day, cfg.window_end, tz).getTime();
    if (end <= start) end = zonedTime(day, "23:59", tz).getTime();
    const from = Math.max(start, now.getTime() + 2 * 60 * 1000);
    const fresh = planSlots(Math.max(0, cfg.posts_per_day - produced), from, end)
      .map(at => ({ at, status: "pending" }));
    if (cfg.promo_enabled) {
      const promosKept = keep.filter(s => s.kind === "promo" && s.status !== "skipped").length;
      for (const i of pickPromoSlots(fresh.length, cfg.promo_per_day - promosKept)) fresh[i].kind = "promo";
    }
    st.day = day;
    st.plan_key = key;
    st.slots = [...keep, ...fresh].sort((a, b) => a.at.localeCompare(b.at));
    return true;
  }

  function activeChannels() {
    return readChannels().filter(c => c.platform === "twitter" && c.enabled !== false && c.autopilot && c.autopilot.enabled);
  }

  async function tick() {
    if (busy) return;
    const now = new Date();
    const channels = activeChannels();
    const s = loadState();
    let changed = false;
    // A paused channel gets a fresh plan (from "now") once it is switched back on.
    const activeIds = new Set(channels.map(c => c.id));
    for (const [id, st] of Object.entries(s)) {
      if (!activeIds.has(id) && st.plan_key) { st.plan_key = null; changed = true; }
    }
    for (const c of channels) {
      s[c.id] = s[c.id] || {};
      if (ensurePlan(c, s[c.id], now)) changed = true;
    }
    if (changed) saveState(s);

    for (const c of channels) {
      const slots = s[c.id].slots || [];
      const due = slots.find(sl => sl.status === "pending" && Date.parse(sl.at) <= now.getTime());
      if (!due) continue;
      const slotAt = due.at;
      if (now.getTime() - Date.parse(slotAt) > LATE_LIMIT_MS) {
        mutate(c.id, st => { const sl = (st.slots || []).find(x => x.at === slotAt); if (sl) { sl.status = "skipped"; sl.error = "Missed (server was offline)"; } });
        continue;
      }
      mutate(c.id, st => { const sl = (st.slots || []).find(x => x.at === slotAt); if (sl) sl.status = "running"; });
      try {
        const { task } = await produce(c, { mode: config(c).mode, trigger: "schedule", kind: due.kind });
        mutate(c.id, st => { const sl = (st.slots || []).find(x => x.at === slotAt); if (sl) Object.assign(sl, { status: "done", task_id: task.id, error: null }); });
      } catch (e) {
        const final = mutate(c.id, st => {
          const sl = (st.slots || []).find(x => x.at === slotAt);
          if (!sl) return false;
          sl.tries = (sl.tries || 0) + 1;
          sl.error = String(e.message).slice(0, 300);
          if (sl.tries < MAX_TRIES) { sl.status = "pending"; sl.at = new Date(Date.now() + RETRY_DELAY_MS).toISOString(); return false; }
          sl.status = "failed";
          return true;
        });
        log(`${c.name}: slot failed: ${e.message}`);
        if (final) notify(`𝕏 Autopilot ${due.kind === "promo" ? "promo " : ""}failed (${escHtml(c.name)})`, escHtml(String(e.message).slice(0, 300)), "danger");
      }
      return; // one post per tick
    }
  }

  function step(name) { if (busy) busy.step = name; }

  async function ownUsername(channel, creds) {
    const cached = loadState()[channel.id]?.username;
    if (cached && cached.creds === creds.fingerprint) return cached.name;
    const me = await twitterVerify(creds);
    mutate(channel.id, st => { st.username = { name: me.username, creds: creds.fingerprint }; });
    return me.username;
  }

  async function searchTopic(creds, topic, cfg, me, st) {
    const params = new URLSearchParams({
      query: buildQuery(topic.query, me),
      max_results: String(cfg.search_depth),
      sort_order: "relevancy",
      // Without a start_time, relevancy digs through the whole 7-day window and
      // almost nothing it returns is fresh enough to use.
      start_time: new Date(Date.now() - cfg.max_age_hours * 3.6e6).toISOString().replace(/\.\d+Z$/, "Z"),
      expansions: "attachments.media_keys,author_id",
      "media.fields": "url,type,width,height",
      "tweet.fields": "public_metrics,created_at,possibly_sensitive",
      "user.fields": "username,public_metrics",
    });
    const resp = await twitterApi("GET", `https://api.x.com/2/tweets/search/recent?${params}`, creds);
    return rankCandidates(resp, {
      nowMs: Date.now(), minLikes: cfg.min_likes, maxAgeHours: cfg.max_age_hours, minFollowers: topic.curated ? 0 : cfg.min_followers,
      usedSources: st.used_sources || [], usedAuthors: st.authors_today || [],
    }).map(c => ({ ...c, topic: topic.label }));
  }

  function recentPosts(channelId) {
    return readTasks()
      .filter(t => t.channel_id === channelId && t.text && ["published", "scheduled", "draft"].includes(t.status))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 15).map(t => t.text);
  }

  async function writePost(channel, cfg, candidates) {
    const brandName = (brand() || {}).company_name || "";
    const voice = cfg.voice || (brandName ? `The account of ${brandName}: sharp, knowledgeable crypto and markets commentary.` : "Sharp, knowledgeable crypto and markets commentary.");
    const recent = recentPosts(channel.id);
    const tool = {
      name: "submit_post",
      description: "Submit the chosen candidate and the original post written about it.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          choice: { type: "integer", description: "Index of the chosen candidate, or -1 if none is suitable." },
          post_text: { type: "string", description: "The post, max 260 characters." },
          image_prompt: { type: "string", description: "Description of the NEW image to generate: what it shows and how it is composed." },
          image_headline: { type: "string", description: "Short headline (max 8 words) to render in the image in our own words, or empty for no text." },
          instagram_ok: { type: "boolean", description: "True only if the post stands on its own for a reader who never saw the candidate AND is clearly about this account's niche/topics." },
          reason: { type: "string", description: "One sentence: why this candidate." },
        },
        required: ["choice", "post_text", "image_prompt", "image_headline", "instagram_ok", "reason"],
        additionalProperties: false,
      },
    };
    const content = [{
      type: "text",
      text: `You write posts for an X account. Voice: ${voice}
${brandKnowledge(channel)}

Below are ${candidates.length} recent posts that are performing well on X. Pick the ONE best suited to inspire our next post, then write an ORIGINAL post in ${cfg.language} about the same subject. Always answer by calling the submit_post tool (choice -1 if none fit).

Rules for the post:
- Your own words and angle. Never copy phrases from the candidate. Never mention or tag its author. No links.
- Hook in the first line. 1 to 4 short lines, plain text, max 260 characters. Put a blank line between lines (each line its own paragraph), never a wall of text.
- At most 2 hashtags/cashtags in total, at most 2 emojis.
- NEVER use em dashes or en dashes. Use periods, colons or line breaks.
- Only state numbers, prices or facts that are visible in the candidate text or image. Never invent figures, timeframes or history (no "for weeks", "first time since" unless the source says so). When unsure, frame it as a take or a question.
- No financial advice, no return promises.
- Skip candidates that shill small tokens, run giveaways, look like scams, are political, or whose image shows identifiable real people (our image generator refuses those). A candidate that merely mentions a token or project is fine when it carries real market news, data or a chart: our post takes a neutral angle on the subject and never promotes it. Return choice -1 only if none fit.
- Do not repeat the angle of our recent posts.
- instagram_ok: the post is also copied to Instagram, where nobody sees the candidate. Set false when the post reacts to the candidate (refers to "this", "that pull", "this card", "here", a question about the candidate, anything that only makes sense next to it), or when the subject is outside this account's niche/topics (${parseTopics(cfg.topics).map(t => t.label).join(", ") || "the topics above"}). Set true only for a self-contained post about our niche.

${cfg.image_mode === "template" ? `Rules for the image (template mode):
- The candidate's own photo is shown as-is inside our template, so only pick a candidate whose image clearly shows the subject of the post (the card, slab or product), not a meme, screenshot of text, collage of unrelated items or a person.
- image_headline is REQUIRED: a punchy headline of max 7 words in our own words, plain English, that states the key fact or hook of the post (for example "Same Venusaur. $75 to $1,086."). No hashtags, no emojis, no dashes. Only facts that are in the candidate.
- image_prompt: one short sentence describing what the photo shows.` : `Rules for the image:
- image_prompt describes a NEW image that conveys the same idea as the candidate image (you may borrow the composition), without logos, watermarks, usernames or real people's faces.
- If the candidate image is a chart or data graphic, say so in image_prompt and describe its shape and key values precisely, so the redraw stays faithful to the data.
- If the candidate image carries text, write image_headline in our own words (max 8 words); otherwise leave it empty.`}
${recent.length ? `\nOur recent posts (do not repeat):\n${recent.map(t => "- " + t.replace(/\s+/g, " ").slice(0, 200)).join("\n")}` : ""}`,
    }];
    candidates.forEach((c, i) => {
      const m = c.metrics;
      const ageH = ((Date.now() - Date.parse(c.created_at)) / 3.6e6).toFixed(1);
      content.push({ type: "text", text: `Candidate ${i} [topic: ${c.topic}] @${c.author} · ${m.like_count || 0} likes, ${m.retweet_count || 0} reposts, ${m.impression_count || 0} views, ${ageH}h old\n${c.text}` });
      content.push({ type: "image", source: { type: "url", url: `${c.image}?name=small` } });
    });

    const messages = [{ role: "user", content }];
    for (let attempt = 0; attempt < 2; attempt++) {
      // Geforceerde tool_choice ("tool"/"any") geeft een 400 op claude-sonnet-5-5 en nieuwer:
      // auto + strict schema, en bij een antwoord zonder tool-call één keer aansporen.
      const msg = await anthropic.messages.create({
        model: MODEL, max_tokens: 8000, tools: [tool],
        tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages,
      });
      const use = msg.content.find(b => b.type === "tool_use");
      if (!use) {
        if (attempt === 0 && msg.stop_reason !== "refusal") {
          messages.push({ role: "assistant", content: msg.content });
          messages.push({ role: "user", content: "Answer only by calling the submit_post tool." });
          continue;
        }
        throw new Error("Claude returned no post");
      }
      const out = use.input || {};
      if (!(out.choice >= 0 && out.choice < candidates.length)) {
        const err = new Error(`No suitable candidate: ${out.reason || "all rejected"}`);
        err.noCandidate = true;
        throw err;
      }
      out.post_text = cleanPostText(out.post_text);
      const len = twitterWeightedLength(out.post_text);
      if (out.post_text && len <= 280) return out;
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: `The post is ${len} characters. Resubmit with post_text under 260 characters.`, is_error: true }] });
    }
    throw new Error("Post stayed over 280 characters");
  }

  function stylePrompt(cfg) {
    if (cfg.style_prompt) return cfg.style_prompt;
    const hue = Number((brand() || {}).primary_hue) || 264;
    return `Premium, modern social media visual on a deep dark background with hsl(${hue} 65% 50%) as the main accent color, subtle glow, clean and high contrast, sleek sans-serif typography.`;
  }

  async function hfJob(endpoint, params) {
    const r = await fetch(higgsfield.base + endpoint, { method: "POST", headers: higgsfield.headers(), body: JSON.stringify({ params }) });
    const d = await r.json().catch(() => ({}));
    const id = d.id || d.job_set_id || "";
    if (!r.ok || !id) throw new Error("Higgsfield submit: " + JSON.stringify(d.detail || d).slice(0, 200));
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 6000));
      const s = await fetch(higgsfield.base + higgsfield.endpoints.jobSet(id), { headers: higgsfield.headers() }).then(x => x.json()).catch(() => ({}));
      const job = (Array.isArray(s.jobs) && s.jobs[0]) || s;
      const st = String(job.status || "").toLowerCase();
      if (st === "completed" || st === "success") {
        const res = job.results || {};
        const url = res.raw?.url || res.min?.url || job.result_url || "";
        if (!url) throw new Error("Higgsfield: completed without an image");
        return url;
      }
      if (["failed", "nsfw", "error", "canceled"].includes(st)) throw new Error(`Higgsfield: ${st}`);
    }
    throw new Error("Higgsfield: timed out");
  }

  // Template mode: the source photo (borders trimmed) in card-template.js, headline as real text.
  async function renderTemplate(cfg, cand, post, id) {
    const r = await fetch(`${cand.image}?name=large`);
    if (!r.ok) throw new Error(`source image download ${r.status}`);
    let buf = Buffer.from(await r.arrayBuffer());
    try {
      const trimmed = execFileSync("convert", ["-", "-fuzz", "8%", "-trim", "+repage", "jpg:-"], { input: buf, maxBuffer: 50 * 1024 * 1024 });
      if (trimmed.length > 1000) buf = trimmed;
    } catch (e) { log(`template trim skipped: ${e.message}`); }
    fs.mkdirSync(mediaDir, { recursive: true });
    const name = `autopilot-${id}.png`;
    await cardTemplate.render({ imageBuf: buf, headline: post.image_headline, mark: cfg.template_mark, hue: cfg.template_hue }, path.join(mediaDir, name));
    if (fs.statSync(path.join(mediaDir, name)).size > X_IMAGE_MAX) {
      const jpg = `autopilot-${id}.jpg`;
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(mediaDir, name), "-q:v", "3", path.join(mediaDir, jpg)]);
      fs.unlinkSync(path.join(mediaDir, name));
      return { path: `/media/${jpg}`, method: "template" };
    }
    return { path: `/media/${name}`, method: "template" };
  }

  async function renderImage(cfg, cand, post, id) {
    if (cfg.image_mode === "template") return renderTemplate(cfg, cand, post, id);
    const aspect = nearestAspect(cand.width, cand.height);
    const styleUrls = [];
    for (const ref of cfg.style_refs.slice(0, 2)) {
      try {
        const file = path.join(mediaDir, path.basename(ref));
        if (fs.existsSync(file)) styleUrls.push(await higgsfield.upload(file));
      } catch (e) { log(`style ref ${ref} upload failed: ${e.message}`); }
    }
    const textRule = post.image_headline
      ? `The only text in the image is this headline: "${post.image_headline}". Replace any other text.`
      : "The image contains no text.";
    const base = `${post.image_prompt}\n\nVisual style: ${stylePrompt(cfg)}\n${textRule}\nFill the entire frame edge to edge: no white or blank borders, bars or margins. If there is a chart, keep its line shape, axis values and data points exactly as in the reference: restyle, never redraw the data. Never invent placeholder labels (like "Protocol A"), duplicate labels or extra charts that are not in the reference: an element without a real label gets no label. No logos, watermarks, usernames, handles or signatures. No real people's faces.`;
    const attempts = [
      { label: "restyle", endpoint: higgsfield.endpoints.imageEdit, params: {
        prompt: `${base}\nThe first image is only a composition reference${styleUrls.length ? "; the other images show the target visual style" : ""}.`.slice(0, 2000),
        input_images: [cand.image, ...styleUrls].map(u => ({ type: "image_url", image_url: u })), aspect_ratio: aspect } },
    ];
    if (styleUrls.length) attempts.push({ label: "style-only", endpoint: higgsfield.endpoints.imageEdit, params: {
      prompt: `${base}\nThe images show the target visual style; create a new image, do not copy their content.`.slice(0, 2000),
      input_images: styleUrls.map(u => ({ type: "image_url", image_url: u })), aspect_ratio: aspect } });
    attempts.push({ label: "text-only", endpoint: higgsfield.endpoints.text2image, params: {
      prompt: base.slice(0, 2000), width_and_height: higgsfield.size(aspect), quality: "1080p", enhance_prompt: true } });

    let lastErr;
    for (const a of attempts) {
      try {
        const url = await hfJob(a.endpoint, a.params);
        const r = await fetch(url);
        if (!r.ok) throw new Error(`download ${r.status}`);
        const ext = /jpe?g/.test(r.headers.get("content-type") || "") ? "jpg" : /webp/.test(r.headers.get("content-type") || "") ? "webp" : "png";
        fs.mkdirSync(mediaDir, { recursive: true });
        let name = `autopilot-${id}.${ext}`;
        fs.writeFileSync(path.join(mediaDir, name), Buffer.from(await r.arrayBuffer()));
        if (fs.statSync(path.join(mediaDir, name)).size > X_IMAGE_MAX) {
          const jpg = `autopilot-${id}.jpg`;
          execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(mediaDir, name), "-q:v", "3", path.join(mediaDir, jpg + ".tmp.jpg")]);
          fs.renameSync(path.join(mediaDir, jpg + ".tmp.jpg"), path.join(mediaDir, jpg));
          if (jpg !== name) fs.unlinkSync(path.join(mediaDir, name));
          name = jpg;
        }
        return { path: `/media/${name}`, method: a.label };
      } catch (e) {
        lastErr = e;
        log(`image ${a.label} failed: ${e.message}`);
      }
    }
    throw new Error(`Image generation failed: ${lastErr && lastErr.message}`);
  }

  function recentPromos(channelId) {
    return readTasks()
      .filter(t => t.channel_id === channelId && t.promo && t.text && ["published", "scheduled", "draft"].includes(t.status))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 12).map(t => t.text);
  }

  async function writePromo(channel, cfg) {
    const recent = recentPromos(channel.id);
    const linkLen = cfg.promo_link ? 25 : 0; // X counts any link as 23, plus the blank line
    const maxText = 270 - linkLen;
    const tool = {
      name: "submit_promo",
      description: "Submit the promo post.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          angle: { type: "string", description: "The angle in a few words (e.g. 'review your trades without memory')." },
          post_text: { type: "string", description: `The post without the link, max ${maxText - 20} characters.` },
          image_headline: { type: "string", description: "Headline for the image, max 7 words." },
        },
        required: ["angle", "post_text", "image_headline"],
        additionalProperties: false,
      },
    };
    const messages = [{ role: "user", content: `You write posts for an X account. Voice: ${cfg.voice || "a knowledgeable account in its niche"}
${brandKnowledge(channel)}

This post is the account's daily promo for ${cfg.promo_product}. Write it in ${cfg.language}. Always answer by calling the submit_promo tool.

Everything we may say about ${cfg.promo_product} (the ONLY claims allowed, never add features, numbers or promises that are not here):
"""
${cfg.promo_facts}
"""

Rules:
- Lead with a real situation or pain point from this account's niche (one specific moment your audience recognises), then show how ${cfg.promo_product} helps. Sound like a person from the community, not an ad.
- Name ${cfg.promo_product} once. A short call to action at the end is fine (the link is added below the post automatically; do not write a URL or "link below").
- 2 to 5 short lines, plain text, max ${maxText - 20} characters. Put a blank line between lines (each line its own paragraph). At most 1 hashtag and 2 emojis.
- NEVER use em dashes or en dashes. Use periods, colons or line breaks.
- No financial advice, no price predictions, no "guaranteed", no claims about profit or value going up.
- Pick a different angle than the recent promos below (feature, pain point, free trial, a question to the audience, a common myth in the niche).
- image_headline: max 7 words, plain, no hashtags, emojis or dashes.
${recent.length ? `\nRecent promo posts (use a different angle and different wording):\n${recent.map(t => "- " + t.replace(/\s+/g, " ").slice(0, 220)).join("\n")}` : ""}` }];

    for (let attempt = 0; attempt < 3; attempt++) {
      const msg = await anthropic.messages.create({
        model: MODEL, max_tokens: 4000, tools: [tool],
        tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages,
      });
      const use = msg.content.find(b => b.type === "tool_use");
      if (!use) {
        if (attempt === 0 && msg.stop_reason !== "refusal") {
          messages.push({ role: "assistant", content: msg.content });
          messages.push({ role: "user", content: "Answer only by calling the submit_promo tool." });
          continue;
        }
        throw new Error("Claude returned no promo post");
      }
      const out = use.input || {};
      out.post_text = cleanPostText(String(out.post_text || "").replace(/https?:\/\/\S+/g, "").trim());
      const full = cfg.promo_link ? `${out.post_text}\n\n${cfg.promo_link}` : out.post_text;
      const len = twitterWeightedLength(full);
      if (out.post_text && len <= 280) return { ...out, post_text: full };
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: `Too long (${len} of 280 with the link). Resubmit with a shorter post_text.`, is_error: true }] });
    }
    throw new Error("Promo post stayed over 280 characters");
  }

  async function producePromo(channel, cfg, mode, record) {
    step("writing promo");
    const post = await writePromo(channel, cfg);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let image = null;
    const st = loadState()[channel.id] || {};
    const pick = pickLeastUsed(cfg.promo_images.filter(p => fs.existsSync(path.join(mediaDir, p.replace(/^\/media\//, "")))), st.promo_image_counts || {});
    if (pick) {
      step("rendering promo image");
      const buf = fs.readFileSync(path.join(mediaDir, pick.replace(/^\/media\//, "")));
      const name = `autopilot-${id}.png`;
      await cardTemplate.render({ imageBuf: buf, headline: post.image_headline, mark: cfg.template_mark, hue: cfg.template_hue }, path.join(mediaDir, name));
      image = { path: `/media/${name}`, method: "promo-template" };
    }
    const now = new Date().toISOString();
    const task = {
      id, channel_id: channel.id,
      status: mode === "review" ? "draft" : "scheduled",
      created_at: now, updated_at: now, scheduled_at: now, scheduled_local: null,
      archetype: `Autopilot · Promo`, trigger_word: null,
      media_path: image ? image.path : null, media_paths: image ? [image.path] : [],
      text: post.post_text, published_at: null, message_id: null, attempts: 0, error: null,
      autopilot: true, promo: true,
      topic: "Promo", angle: post.angle, image_method: image ? image.method : "none",
      reason: `Daily promo for ${cfg.promo_product}: ${post.angle}`,
      promo_image: pick || null,
    };
    addTask(task);
    mutate(channel.id, s2 => {
      if (pick) s2.promo_image_counts = { ...(s2.promo_image_counts || {}), [pick]: ((s2.promo_image_counts || {})[pick] || 0) + 1 };
    });
    record({ status: "done", task_id: task.id, finished_at: new Date().toISOString() });
    log(`${channel.name}: queued promo ${task.id} (${post.angle}, image ${pick || "none"})`);
    return { task };
  }

  async function produce(channel, { mode, trigger, kind }) {
    if (busy) throw new Error(`Autopilot is busy (${busy.step})`);
    busy = { channel_id: channel.id, step: kind === "promo" ? "writing promo" : "searching X", started_at: new Date().toISOString(), trigger };
    const record = patch => mutate(channel.id, st => { st.last_run = { ...(st.last_run || {}), ...patch }; });
    record({ at: busy.started_at, trigger, mode, status: "running", error: null, task_id: null });
    try {
      const cfg = config(channel);
      if (kind === "promo") {
        if (!cfg.promo_enabled) throw new Error("Promo is off or has no product/facts");
        return await producePromo(channel, cfg, mode, record);
      }
      const topics = parseTopics(cfg.topics);
      if (!topics.length && !cfg.accounts.length) throw new Error("No topics or curated accounts configured");
      const creds = twitterCredsFor(channel);
      const me = await ownUsername(channel, creds);
      const st = loadState()[channel.id] || {};
      const counts = st.topic_counts || {};
      const rejects = st.topic_rejects || {};
      // Least posted first; a topic whose shortlist Claude rejected today goes back in the queue.
      const order = list => list.map(t => ({ t, n: (counts[t.label] || 0) + (rejects[t.label] || 0), r: Math.random() }))
        .sort((a, b) => a.n - b.n || a.r - b.r).map(x => x.t);
      // Curated accounts first; the topic searches are the fallback.
      const queue = [...order(accountTopics(cfg.accounts, me)), ...order(topics)];

      // Search in rounds: a couple of topics, let Claude pick, and if the whole
      // shortlist is rejected move on to the next topics instead of giving up.
      let pool = [], post = null, candidates = [], searches = 0, lastReject = "";
      const shown = new Set();
      for (let round = 0; !post && round < 3; round++) {
        let roundSearches = 0;
        while (queue.length && searches < MAX_SEARCHES && (roundSearches < TOPICS_PER_ROUND || pool.length < 3)) {
          const topic = queue.shift();
          searches++; roundSearches++;
          step(`searching X (${topic.label})`);
          pool.push(...(await searchTopic(creds, topic, cfg, me, st)).filter(c => !shown.has(c.tweet_id)));
        }
        candidates = pickCandidates(pool);
        if (!candidates.length) break;
        candidates.forEach(c => shown.add(c.tweet_id));
        pool = pool.filter(c => !shown.has(c.tweet_id));
        step("writing post");
        try {
          post = await writePost(channel, cfg, candidates);
        } catch (e) {
          if (!e.noCandidate) throw e;
          lastReject = e.message;
          log(`${channel.name}: shortlist rejected (${[...new Set(candidates.map(c => c.topic))].join(", ")}): ${e.message}`);
          const ids = candidates.map(c => c.tweet_id);
          const labels = [...new Set(candidates.map(c => c.topic))];
          mutate(channel.id, s2 => {
            s2.used_sources = [...(s2.used_sources || []), ...ids].slice(-1000);
            s2.topic_rejects = { ...(s2.topic_rejects || {}) };
            for (const l of labels) s2.topic_rejects[l] = (s2.topic_rejects[l] || 0) + 1;
          });
          // Leftovers from a rejected topic would mostly be more of the same.
          pool = pool.filter(c => !labels.includes(c.topic));
          if ((!queue.length || searches >= MAX_SEARCHES) && !pool.length) break;
        }
      }
      if (!post) {
        if (lastReject) throw new Error(`${lastReject} (after ${searches} searches)`);
        throw new Error("No usable posts found (try lower min likes/followers or broader topics)");
      }
      const cand = candidates[post.choice];

      step("generating image");
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const image = await renderImage(cfg, cand, post, id);

      const now = new Date().toISOString();
      const task = {
        id, channel_id: channel.id,
        status: mode === "review" ? "draft" : "scheduled",
        created_at: now, updated_at: now, scheduled_at: now, scheduled_local: null,
        archetype: `Autopilot · ${cand.topic}`, trigger_word: null,
        media_path: image.path, media_paths: [image.path],
        text: post.post_text, published_at: null, message_id: null, attempts: 0, error: null,
        autopilot: true,
        topic: cand.topic,
        image_method: image.method,
        reason: post.reason,
        instagram_ok: post.instagram_ok !== false,
        source: {
          tweet_id: cand.tweet_id, author: cand.author,
          url: `https://x.com/${cand.author || "i"}/status/${cand.tweet_id}`,
          text: cand.text.slice(0, 400), image: cand.image, metrics: cand.metrics,
        },
      };
      addTask(task);
      mutate(channel.id, s2 => {
        s2.used_sources = [...(s2.used_sources || []), cand.tweet_id].slice(-1000);
        if (cand.author) s2.authors_today = [...(s2.authors_today || []), cand.author];
        s2.topic_counts = { ...(s2.topic_counts || {}), [cand.topic]: ((s2.topic_counts || {})[cand.topic] || 0) + 1 };
      });
      record({ status: "done", task_id: task.id, finished_at: new Date().toISOString() });
      log(`${channel.name}: queued ${task.id} (${cand.topic}, source @${cand.author}, image ${image.method})`);
      return { task };
    } catch (e) {
      record({ status: "failed", error: String(e.message).slice(0, 300), finished_at: new Date().toISOString() });
      throw e;
    } finally {
      busy = null;
    }
  }

  // Manual "run once" from the UI; resolves immediately, work continues in the background.
  function runNow(channel, mode, kind) {
    if (busy) throw new Error(`Autopilot is busy (${busy.step})`);
    if (kind === "promo" && !config(channel).promo_enabled) throw new Error("Turn on the daily promo and fill in product + facts first");
    produce(channel, { mode: mode === "review" ? "review" : "auto", trigger: "manual", kind: kind === "promo" ? "promo" : undefined })
      .catch(e => log(`${channel.name}: manual run failed: ${e.message}`));
  }

  function status(channel) {
    const s = loadState()[channel.id] || {};
    return {
      config: config(channel),
      day: s.day || null,
      slots: s.slots || [],
      last_run: s.last_run || null,
      username: s.username?.name || null,
      running: busy && busy.channel_id === channel.id ? busy : null,
      topic_counts: s.topic_counts || {},
    };
  }

  return { tick, runNow, status, busy: () => busy };
}

module.exports = {
  createAutopilot, DEFAULTS, MODEL,
  config, parseTopics, parseAccounts, accountTopics, buildQuery, scoreTweet, isPromo, rankCandidates, pickCandidates, cleanPostText,
  nearestAspect, tzOffsetMin, localDay, zonedTime, planSlots, pickPromoSlots, pickLeastUsed,
};
