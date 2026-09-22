// ── SOCIAL MEDIA AUTOPILOT (X) ────────────────
// Per X channel: plan N posts per day inside a time window, and for each slot
//   1. search X for recent, well-performing posts with an image on one of the
//      channel's topics (rotating, least-posted topic first),
//   2. let Claude pick the best candidate and write an ORIGINAL post about it,
//   3. redraw the image in the channel's house style via Higgsfield,
//   4. queue it as a community task — the existing worker publishes it.
// State (daily plan, used sources) lives in data/community/autopilot-state.json.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULTS = {
  enabled: false,
  mode: "auto",            // auto = post straight away, review = land as draft
  posts_per_day: 8,
  window_start: "08:00",
  window_end: "23:00",
  topics: [],              // lines: "Label: X search query" or just a query
  min_likes: 20,
  search_depth: 50,        // posts read per search (X bills per post read)
  max_age_hours: 36,
  language: "English",
  voice: "",               // optional description of the account's voice
  style_prompt: "",        // house style for images; empty = derived from brand
  style_refs: [],          // /media/... images that show the house style
};

const MODEL = process.env.SOCIAL_AUTOPILOT_MODEL || "claude-sonnet-5";
const MAX_CANDIDATES = 6;
const LATE_LIMIT_MS = 90 * 60 * 1000;   // a slot this late (server was down) is skipped
const RETRY_DELAY_MS = 10 * 60 * 1000;
const MAX_TRIES = 3;
const X_IMAGE_MAX = 5 * 1024 * 1024;
const PROMO_RE = /\b(giveaways?|airdrops?|presales?|pre-sale|whitelist|free mint|claim (now|your)|dm me|link in (bio|comments)|join (my|our)|telegram group|whatsapp|discord\.gg|referral|use (my )?code|promo code|sign ?up bonus|\d{3,}x|next (gem|100x)|to the moon)\b/i;
const IMAGE_ASPECTS = { "16:9": 16 / 9, "3:2": 3 / 2, "4:3": 4 / 3, "1:1": 1, "4:5": 4 / 5 };

// ── pure helpers (exported for tests) ─────────
function config(channel) {
  const c = { ...DEFAULTS, ...(channel && channel.autopilot || {}) };
  c.posts_per_day = Math.min(24, Math.max(1, Number(c.posts_per_day) || DEFAULTS.posts_per_day));
  c.min_likes = Math.max(0, Number(c.min_likes) || 0);
  c.search_depth = Math.min(100, Math.max(10, Number(c.search_depth) || DEFAULTS.search_depth));
  c.max_age_hours = Math.min(168, Math.max(1, Number(c.max_age_hours) || DEFAULTS.max_age_hours));
  if (!/^\d{2}:\d{2}$/.test(c.window_start)) c.window_start = DEFAULTS.window_start;
  if (!/^\d{2}:\d{2}$/.test(c.window_end)) c.window_end = DEFAULTS.window_end;
  if (!Array.isArray(c.topics)) c.topics = String(c.topics || "").split("\n");
  c.topics = c.topics.map(t => String(t).trim()).filter(Boolean);
  if (!Array.isArray(c.style_refs)) c.style_refs = [];
  return c;
}

// "Bitcoin: (bitcoin OR $BTC)" → { label, query }. Search operators like
// has:images have no space after the colon, so they never look like a label.
function parseTopics(lines) {
  return (lines || []).map(line => {
    const m = String(line).match(/^([^():"]{1,40}):\s+(.+)$/);
    return m ? { label: m[1].trim(), query: m[2].trim() } : { label: String(line).trim(), query: String(line).trim() };
  }).filter(t => t.query);
}

function buildQuery(query, ownUsername) {
  return `(${query}) has:images -is:retweet -is:reply -is:quote lang:en${ownUsername ? ` -from:${ownUsername}` : ""}`;
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
  if ((s.match(/\$[A-Za-z]{2,10}\b/g) || []).length > 4) return true;
  if ((s.match(/#\w+/g) || []).length > 5) return true;
  return false;
}

// Turn a search response into ranked candidates, dropping everything we can't
// or shouldn't use.
function rankCandidates(resp, { nowMs, minLikes, maxAgeHours, usedSources = [], usedAuthors = [] }) {
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

// Never em/en dashes in post text (house rule); plus no links or stray quotes.
function cleanPostText(text) {
  return String(text || "")
    .replace(/\s*[\u2014\u2013]\s*(\S)?/g, (_, c) => ". " + (c ? c.toUpperCase() : ""))
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\.\s*\./g, ".")
    .replace(/[ \t]+\n/g, "\n")
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
    const key = `${day}|${cfg.posts_per_day}|${cfg.window_start}|${cfg.window_end}`;
    if (st.plan_key === key) return false;
    if (st.day !== day) { st.authors_today = []; st.topic_counts = {}; }
    const keep = st.day === day ? (st.slots || []).filter(s => s.status !== "pending") : [];
    const produced = keep.filter(s => s.status === "done" || s.status === "running").length;
    const start = zonedTime(day, cfg.window_start, tz).getTime();
    let end = zonedTime(day, cfg.window_end, tz).getTime();
    if (end <= start) end = zonedTime(day, "23:59", tz).getTime();
    const from = Math.max(start, now.getTime() + 2 * 60 * 1000);
    const fresh = planSlots(Math.max(0, cfg.posts_per_day - produced), from, end)
      .map(at => ({ at, status: "pending" }));
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
        const { task } = await produce(c, { mode: config(c).mode, trigger: "schedule" });
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
        if (final) notify(`𝕏 Autopilot failed (${escHtml(c.name)})`, escHtml(String(e.message).slice(0, 300)), "danger");
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
      "user.fields": "username",
    });
    const resp = await twitterApi("GET", `https://api.x.com/2/tweets/search/recent?${params}`, creds);
    return rankCandidates(resp, {
      nowMs: Date.now(), minLikes: cfg.min_likes, maxAgeHours: cfg.max_age_hours,
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
      input_schema: {
        type: "object",
        properties: {
          choice: { type: "integer", description: "Index of the chosen candidate, or -1 if none is suitable." },
          post_text: { type: "string", description: "The post, max 260 characters." },
          image_prompt: { type: "string", description: "Description of the NEW image to generate: what it shows and how it is composed." },
          image_headline: { type: "string", description: "Short headline (max 8 words) to render in the image in our own words, or empty for no text." },
          reason: { type: "string", description: "One sentence: why this candidate." },
        },
        required: ["choice", "post_text", "image_prompt", "image_headline", "reason"],
      },
    };
    const content = [{
      type: "text",
      text: `You write posts for an X account. Voice: ${voice}
Below are ${candidates.length} recent posts that are performing well on X. Pick the ONE best suited to inspire our next post, then write an ORIGINAL post in ${cfg.language} about the same subject.

Rules for the post:
- Your own words and angle. Never copy phrases from the candidate. Never mention or tag its author. No links.
- Hook in the first line. 1 to 4 short lines, plain text, max 260 characters.
- At most 2 hashtags/cashtags in total, at most 2 emojis.
- NEVER use em dashes or en dashes. Use periods, colons or line breaks.
- Only state numbers, prices or facts that are visible in the candidate text or image. Never invent figures, timeframes or history (no "for weeks", "first time since" unless the source says so). When unsure, frame it as a take or a question.
- No financial advice, no return promises.
- Skip candidates that shill small tokens, run giveaways, look like scams, are political, or whose image shows identifiable real people (our image generator refuses those). Return choice -1 if none fit.
- Do not repeat the angle of our recent posts.

Rules for the image:
- image_prompt describes a NEW image that conveys the same idea as the candidate image (you may borrow the composition), without logos, watermarks, usernames or real people's faces.
- If the candidate image is a chart or data graphic, say so in image_prompt and describe its shape and key values precisely, so the redraw stays faithful to the data.
- If the candidate image carries text, write image_headline in our own words (max 8 words); otherwise leave it empty.
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
      const msg = await anthropic.messages.create({
        model: MODEL, max_tokens: 1500, tools: [tool],
        tool_choice: { type: "tool", name: "submit_post" }, messages,
      });
      const use = msg.content.find(b => b.type === "tool_use");
      if (!use) throw new Error("Claude returned no post");
      const out = use.input || {};
      if (!(out.choice >= 0 && out.choice < candidates.length)) {
        throw new Error(`No suitable candidate: ${out.reason || "all rejected"}`);
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

  async function renderImage(cfg, cand, post, id) {
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

  async function produce(channel, { mode, trigger }) {
    if (busy) throw new Error(`Autopilot is busy (${busy.step})`);
    busy = { channel_id: channel.id, step: "searching X", started_at: new Date().toISOString(), trigger };
    const record = patch => mutate(channel.id, st => { st.last_run = { ...(st.last_run || {}), ...patch }; });
    record({ at: busy.started_at, trigger, mode, status: "running", error: null, task_id: null });
    try {
      const cfg = config(channel);
      const topics = parseTopics(cfg.topics);
      if (!topics.length) throw new Error("No topics configured");
      const creds = twitterCredsFor(channel);
      const me = await ownUsername(channel, creds);
      const st = loadState()[channel.id] || {};
      const counts = st.topic_counts || {};
      const order = topics.map(t => ({ t, n: counts[t.label] || 0, r: Math.random() })).sort((a, b) => a.n - b.n || a.r - b.r).map(x => x.t);

      let candidates = [];
      for (const topic of order.slice(0, 3)) {
        candidates.push(...await searchTopic(creds, topic, cfg, me, st));
        if (candidates.length >= 3) break;
      }
      const seen = new Set();
      candidates = candidates.filter(c => !seen.has(c.tweet_id) && seen.add(c.tweet_id)).sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
      if (!candidates.length) throw new Error("No usable posts found (try lower min likes or broader topics)");

      step("writing post");
      const post = await writePost(channel, cfg, candidates);
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
  function runNow(channel, mode) {
    if (busy) throw new Error(`Autopilot is busy (${busy.step})`);
    produce(channel, { mode: mode === "review" ? "review" : "auto", trigger: "manual" })
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
  createAutopilot, DEFAULTS,
  config, parseTopics, buildQuery, scoreTweet, isPromo, rankCandidates, cleanPostText,
  nearestAspect, tzOffsetMin, localDay, zonedTime, planSlots,
};
