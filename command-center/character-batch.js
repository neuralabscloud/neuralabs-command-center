// Weekly character video batch: Claude writes 7 concepts for the coming week
// (one per day), the Designer renders a start frame per day with Nano Banana
// (face reference + rotating outfit reference) and Seedance 2.5 turns every
// frame into an 8 s vertical clip with audio.
//
// Everything about the character itself (face, style, outfits, forbidden names)
// comes from the schedule payload; this file only holds the generic rules.
// Pure helpers live here so they can be tested without network; the
// orchestration (Claude, Nano Banana, Higgsfield, Telegram) is in api-server.js
// (runCharacterBatch).

const MODEL = process.env.CHARACTER_BATCH_MODEL || "claude-opus-5-5";
const SLOTS = 7;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const SCENE_TYPES = ["transformation", "phone_location", "other"];

// The fixed sentences every prompt carries. A payload can override any of
// them under `rules` (for example for a character who is not a man).
const DEFAULT_RULES = {
  still_prefix: "Use the first reference image for the man's exact face and identity, and the second reference image for his outfit.",
  outfit_phrase: "wearing exactly the outfit from the second reference",
  still_suffix: "Photorealistic cinematic still. No readable text, no readable numbers, no logos.",
  laptop: "Exactly one laptop in the entire image. The display is only on the inner side of the lid facing him; the outer back of the lid is plain matte aluminium with no screen, no light and no logo.",
  phone: "The screen faces his eyes; the back of the phone with its camera lenses faces away from him. There is only one screen, on the side he is looking at.",
  monitors: "All monitors face him.",
  screens: "Screens show dark-mode trading software with no readable numbers.",
  objects: "Only the objects already in the scene exist.",
  no_text: "No text on screen.",
  text: "At second 2, clean minimal white sans-serif text fades in at the lower third of the frame, perfectly legible, reading exactly: {line}. The text stays until the end.",
  audio: "Audio: {music}, {sfx}. No speech, no voices. No other text, no readable numbers, no logos.",
};

const DEFAULTS = {
  max_text: 2,
  min_transformation: 2,
  min_phone_location: 2,
  city_weeks: 4,
  duration: 8,
  resolution: "720p",
  aspect_ratio: "9:16",
};

function rulesFor(payload) {
  return { ...DEFAULT_RULES, ...((payload && payload.rules) || {}) };
}

// ── time ──
// Wall-clock parts of `date` in a time zone (DST included, via Intl).
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    day: String(p.weekday || "").slice(0, 3).toLowerCase(),
  };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday to Sunday of the coming week, seen from `now` in `tz`. Run on a
// Sunday that is tomorrow; run on a Monday it is next Monday.
function comingWeek(now, tz) {
  const today = localParts(now, tz).date;
  const dow = new Date(today + "T12:00:00Z").getUTCDay(); // 0 = Sunday
  const monday = addDays(today, ((8 - dow) % 7) || 7);
  return Array.from({ length: SLOTS }, (_, i) => {
    const date = addDays(monday, i);
    const key = DAY_KEYS[new Date(date + "T12:00:00Z").getUTCDay()];
    return { slot: i + 1, date, day: DAY_NAMES[key] };
  });
}

// ISO 8601 week of a date: "2026-W42".
function isoWeek(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - new Date(Date.UTC(year, 0, 1))) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function batchId(prefix, weekStart) {
  const p = String(prefix || "batch").trim().replace(/[^\w-]+/g, "-") || "batch";
  return `${p}-${isoWeek(weekStart)}`;
}

// Should a schedule with an optional time zone and catch-up window fire now?
// Without `tz` it behaves exactly like the old UTC-only loop.
function scheduleDue(sched, now) {
  if (!sched || !sched.enabled) return false;
  const tz = sched.tz || "UTC";
  const local = localParts(now, tz);
  if (sched.days && sched.days.length && !sched.days.includes(local.day)) return false;
  const nowMin = local.hour * 60 + local.minute;
  const at = (Number(sched.hour) || 0) * 60 + (Number(sched.minute) || 0);
  const window = Math.max(0, Number(sched.catchup_min) || 0);
  if (nowMin < at || nowMin > at + window) return false;
  if (sched.last_run && localParts(new Date(sched.last_run), tz).date === local.date) return false;
  return true;
}

// ── history (earlier manifests) ──
// Cities used in the `weeks` weeks before `weekStart`.
function recentCities(manifests, weekStart, weeks = DEFAULTS.city_weeks) {
  const from = addDays(weekStart, -7 * weeks);
  const out = new Set();
  for (const m of manifests || []) {
    if (!m || m.dry_run || !m.week_start) continue;
    if (m.week_start < from || m.week_start >= weekStart) continue;
    for (const s of m.slots || []) if (s.city) out.add(String(s.city).trim());
  }
  return [...out];
}

// Where the outfit rotation continues: right after the last real batch.
function nextOutfitStart(manifests, count) {
  if (!count) return 0;
  const last = (manifests || []).filter(m => m && !m.dry_run && Number.isInteger(m.next_outfit))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  return last ? ((last.next_outfit % count) + count) % count : 0;
}

function outfitFor(slotIndex, start, count) {
  return count ? (start + slotIndex) % count : 0;
}

// ── text hygiene ──
const DASHES = /[‐-―−-]/;

function stripDashes(s) {
  return String(s || "")
    .replace(/\s*[‐-―−]\s*/g, " ")
    .replace(/(\w)-(\w)/g, "$1 $2")
    .replace(/\s+-+\s+|^-+\s*|\s*-+$/gm, " ")
    .replace(/-/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function sentence(s) {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : t + ".";
}

function normalizeHashtags(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags || "").split(/[\s,]+/))
    .map(t => String(t).toLowerCase().replace(/[^#\w]/g, "").replace(/^#*/, ""))
    .filter(Boolean);
  return [...new Set(list)].slice(0, 4).map(t => "#" + t);
}

function words(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

// ── prompts for Claude ──
function systemPrompt(payload = {}) {
  const c = payload.character || {};
  const forbidden = (payload.forbidden_names || []).filter(Boolean);
  const r = rulesFor(payload);
  return [
    "You are the creative director of a weekly series of short vertical videos (9:16, 8 seconds, no speech) starring one recurring character.",
    c.name ? `Character: ${c.name}.` : "",
    c.description ? `Who he is: ${c.description}` : "",
    c.face ? `His face (repeated in every still prompt by the system): ${c.face}` : "",
    payload.style ? `Style direction:\n${payload.style}` : "",
    "",
    "Creative rules (hard):",
    "- No humor, no jokes, no silly dances. Cinematic but realistic: full-frame camera look, a chosen lens, shallow depth of field, motivated light, real skin texture, subtle film grain. Never flat light, never HDR or 3D render look.",
    `- At least ${DEFAULTS.min_transformation} scenes of scene_type "transformation": his smartphone transforms into a trading setup on location (multi-monitor office, high-end studio).`,
    `- At least ${DEFAULTS.min_phone_location} scenes of scene_type "phone_location": trading on his phone in a beautiful place somewhere in the world.`,
    "- Never trading while driving. No car interiors with him at the wheel.",
    `- On-screen text is the exception: at most ${DEFAULTS.max_text} of the 7 videos get an onscreen_text line, the rest leave it empty.`,
    "- Every scene keeps his face clearly visible in three-quarter view (except macro detail shots), no wide-angle selfie distortion.",
    "- Devices: list every device in shot under `devices` (phone, laptop, monitors). Prefer over-the-shoulder or from-above angles so screens face him and are visible to the camera. Screens show realistic dark-mode trading software (candlesticks, order book, depth chart, heatmap) with tiny unreadable text.",
    "- Never describe mimed actions (air guitar and the like): the video model turns them into real objects. Nothing may appear out of nowhere: every object in the beats already exists in the still.",
    forbidden.length ? `- These names never appear anywhere in a scene, prompt or on-screen text: ${forbidden.join(", ")}.` : "",
    "- Captions: lowercase English, no dashes or hyphens of any kind. caption_line is a short trading line of at most 6 words; question is one reflective question that invites comments; hashtags are exactly 4.",
    "- No readable numbers, prices or PnL anywhere.",
    "",
    "The system adds the fixed sentences itself (reference instructions, face description, device rules, text and audio lines), so do NOT write those: describe only the scene, camera, light, beats, music and sound effects.",
    `For reference, the outfit sentence the system inserts is: "${r.outfit_phrase}".`,
    "",
    "Answer with ONLY one JSON object, no prose before or after:",
    '{"concepts":[{"slot":1,"day":"Monday","city":"...","scene_type":"transformation|phone_location|other","devices":["phone"],',
    '"still_scene":"one paragraph: where he is, pose, framing, lens, light, background, what the screens show",',
    '"camera_move":"slow push-in","light":"blue hour neon reflections",',
    '"beats":{"0-2":"...","2-5":"...","5-8":"..."},',
    '"onscreen_text":"","caption_line":"...","question":"...?","hashtags":["#trading","#bitcoin","#defi","#tradinglifestyle"],',
    '"music":"deep electronic pulse","sfx":"soft keyboard clicks, distant traffic"}]}',
  ].filter(s => s !== "").join("\n");
}

function userPrompt({ week, outfits = [], outfitStart = 0, recent = [], context = "", errors = [] } = {}) {
  const lines = [
    "Write the 7 concepts for this week, one per day:",
    ...week.map((w, i) => {
      const o = outfits.length ? outfits[outfitFor(i, outfitStart, outfits.length)] : null;
      return `- slot ${w.slot}: ${w.day} ${w.date}${o ? ` · outfit ${o.label || outfitFor(i, outfitStart, outfits.length) + 1}${o.description ? ` (${o.description})` : ""}` : ""}`;
    }),
    recent.length ? `\nDo not use any of these cities (used in the last ${DEFAULTS.city_weeks} weeks): ${recent.join(", ")}.` : "",
    context ? `\nContext for this week: ${context}` : "",
  ];
  if (errors.length) {
    lines.push("", "Your previous answer was rejected for these reasons. Fix all of them and answer with the full JSON again:", ...errors.map(e => "- " + e));
  }
  return lines.filter(s => s !== "").join("\n");
}

// A neutral rewrite request after a moderation flag on a video prompt.
function neutralRewritePrompt(prompt, reason) {
  return [
    "A video model flagged this prompt" + (reason ? ` (${reason})` : "") + ".",
    "Rewrite it more neutrally: same scene, same structure and the same fixed sentences word for word,",
    "but remove anything that could read as a real person, a brand, intellectual property, risky behaviour or sensitive content.",
    "Answer with ONLY the rewritten prompt.",
    "",
    prompt,
  ].join("\n");
}

// ── parsing ──
function textOf(content) {
  return (content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

// Last balanced {...} with a concepts array; Claude sometimes thinks out loud first.
function extractJson(text) {
  const s = String(text || "").replace(/```(?:json)?/g, "");
  let best = null;
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { const o = JSON.parse(s.slice(start, i + 1)); if (o && Array.isArray(o.concepts)) best = o; } catch {}
        break;
      }
    }
    if (best) break;
  }
  if (!best) throw new Error("No concepts JSON in the answer");
  return best;
}

// ── assembling the prompts ──
const DEVICE_PATTERNS = {
  phone: /\b(smart)?phones?\b|\biphone\b/i,
  laptop: /\blaptops?\b|\bmacbook\b|\bnotebook computer\b/i,
  monitors: /\bmonitors?\b|\bscreens? (setup|wall|array)\b|\bmulti.?monitor\b|\bdisplays\b/i,
};

function devicesOf(c) {
  const listed = (Array.isArray(c.devices) ? c.devices : []).map(d => String(d).toLowerCase());
  const text = [c.still_scene, ...Object.values(c.beats || {})].join(" ");
  const out = [];
  for (const [k, re] of Object.entries(DEVICE_PATTERNS)) {
    if (listed.some(d => d.startsWith(k.replace(/s$/, ""))) || re.test(text)) out.push(k);
  }
  return out;
}

function deviceRules(devices, r) {
  const out = [];
  if (devices.includes("laptop")) out.push(r.laptop);
  if (devices.includes("phone")) out.push(r.phone);
  if (devices.includes("monitors")) out.push(r.monitors);
  if (devices.length) out.push(r.screens);
  return out;
}

function buildStillPrompt(c, payload) {
  const r = rulesFor(payload);
  const face = (payload.character && payload.character.face) || "";
  return [
    r.still_prefix,
    face ? sentence(`He has ${face.replace(/^he has\s+/i, "").replace(/\.$/, "")}, ${r.outfit_phrase}`) : sentence(`He is ${r.outfit_phrase}`),
    sentence(c.still_scene),
    ...deviceRules(devicesOf(c), r),
    r.still_suffix,
  ].filter(Boolean).join(" ");
}

function buildVideoPrompt(c, payload) {
  const r = rulesFor(payload);
  const b = c.beats || {};
  const beat = (k) => sentence(b[k] || b[k.replace("-", "–")] || "");
  const textLine = String(c.onscreen_text || "").trim();
  return [
    `Cinematic but realistic footage, ${String(c.camera_move || "slow push-in").replace(/\.$/, "")}, ${String(c.light || "natural motivated light").replace(/\.$/, "")}, subtle film grain.`,
    `0 to 2 s: ${beat("0-2")}`,
    `2 to 5 s: ${beat("2-5")}`,
    `5 to 8 s: ${beat("5-8")}`,
    ...deviceRules(devicesOf(c), r),
    r.objects,
    textLine ? r.text.replace("{line}", textLine.replace(/[.]+$/, "")) : r.no_text,
    r.audio.replace("{music}", String(c.music || "ambient synth").replace(/\.$/, "")).replace("{sfx}", String(c.sfx || "soft room tone").replace(/\.$/, "")),
  ].join(" ");
}

function buildCaption(c) {
  return [c.caption_line, c.question, normalizeHashtags(c.hashtags).join(" ")].join("\n");
}

// Claude's raw concept → the stored concept with every prompt assembled.
function normalizeConcept(raw, i, { week, outfits = [], outfitStart = 0, payload = {} }) {
  const w = week[i] || {};
  const c = {
    slot: w.slot || i + 1,
    date: w.date || null,
    day: w.day || String(raw.day || ""),
    city: String(raw.city || "").trim(),
    scene_type: SCENE_TYPES.includes(raw.scene_type) ? raw.scene_type : "other",
    devices: [],
    still_scene: String(raw.still_scene || "").trim(),
    camera_move: String(raw.camera_move || "").trim(),
    light: String(raw.light || "").trim(),
    beats: {
      "0-2": String((raw.beats || {})["0-2"] || "").trim(),
      "2-5": String((raw.beats || {})["2-5"] || "").trim(),
      "5-8": String((raw.beats || {})["5-8"] || "").trim(),
    },
    onscreen_text: stripDashes(raw.onscreen_text || "").replace(/["“”]/g, ""),
    caption_line: stripDashes(String(raw.caption_line || "").toLowerCase()).replace(/[.]+$/, ""),
    question: stripDashes(String(raw.question || "").toLowerCase()),
    hashtags: normalizeHashtags(raw.hashtags),
    music: String(raw.music || "").trim(),
    sfx: String(raw.sfx || "").trim(),
  };
  if (c.question && !c.question.endsWith("?")) c.question = c.question.replace(/[.!]+$/, "") + "?";
  c.devices = devicesOf(c);
  c.outfit_index = outfitFor(i, outfitStart, outfits.length);
  c.outfit = outfits.length ? (outfits[c.outfit_index].label || String(c.outfit_index + 1)) : null;
  c.start_frame_prompt = buildStillPrompt(c, payload);
  c.video_prompt = buildVideoPrompt(c, payload);
  c.caption = buildCaption(c);
  c.music_sfx = [c.music, c.sfx].filter(Boolean).join(" · ");
  return c;
}

// ── validation ──
const DRIVING = /\b(driving|drives|behind the wheel|steering wheel|at the wheel)\b/i;

function validateConcepts(concepts, { recent = [], forbidden = [], payload = {} } = {}) {
  const errors = [];
  const r = rulesFor(payload);
  if (!Array.isArray(concepts) || concepts.length !== SLOTS) {
    errors.push(`Expected exactly ${SLOTS} concepts, got ${Array.isArray(concepts) ? concepts.length : 0}.`);
    return errors;
  }
  const withText = concepts.filter(c => c.onscreen_text);
  if (withText.length > DEFAULTS.max_text) errors.push(`${withText.length} videos have on-screen text; at most ${DEFAULTS.max_text} may.`);
  const n = (t) => concepts.filter(c => c.scene_type === t).length;
  if (n("transformation") < DEFAULTS.min_transformation) errors.push(`Only ${n("transformation")} transformation scenes; need at least ${DEFAULTS.min_transformation}.`);
  if (n("phone_location") < DEFAULTS.min_phone_location) errors.push(`Only ${n("phone_location")} phone-trading scenes in beautiful places; need at least ${DEFAULTS.min_phone_location}.`);
  const recentLc = new Set(recent.map(s => String(s).toLowerCase()));
  const forbiddenRe = forbidden.filter(Boolean).map(f => new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  for (const c of concepts) {
    const tag = `Slot ${c.slot} (${c.day})`;
    if (!c.city) errors.push(`${tag}: city is missing.`);
    else if (recentLc.has(c.city.toLowerCase())) errors.push(`${tag}: ${c.city} was used in the last ${DEFAULTS.city_weeks} weeks.`);
    if (!c.still_scene) errors.push(`${tag}: still_scene is missing.`);
    if (!c.beats["0-2"] || !c.beats["2-5"] || !c.beats["5-8"]) errors.push(`${tag}: all three beats (0-2, 2-5, 5-8) are required.`);
    if (!c.camera_move || !c.light) errors.push(`${tag}: camera_move and light are required.`);
    if (!c.music || !c.sfx) errors.push(`${tag}: music and sfx are required.`);
    if (DRIVING.test([c.still_scene, ...Object.values(c.beats)].join(" "))) errors.push(`${tag}: no trading while driving.`);
    if (!c.caption_line) errors.push(`${tag}: caption_line is missing.`);
    else if (words(c.caption_line) > 6) errors.push(`${tag}: caption_line has ${words(c.caption_line)} words; max 6.`);
    if (!c.question || !c.question.endsWith("?")) errors.push(`${tag}: the second caption line must be a question.`);
    if (c.hashtags.length !== 4) errors.push(`${tag}: exactly 4 hashtags are required (got ${c.hashtags.length}).`);
    for (const [k, v] of Object.entries({ caption: c.caption, onscreen_text: c.onscreen_text })) {
      if (DASHES.test(v)) errors.push(`${tag}: ${k} contains a dash.`);
    }
    if (c.caption !== c.caption.toLowerCase()) errors.push(`${tag}: caption must be lowercase.`);
    if (/\d/.test(c.onscreen_text)) errors.push(`${tag}: on-screen text may not contain numbers.`);
    const all = [c.start_frame_prompt, c.video_prompt, c.caption, c.onscreen_text].join(" ");
    for (const re of forbiddenRe) if (re.test(all)) errors.push(`${tag}: contains the forbidden name "${re.source.replace(/\\/g, "")}".`);
    if (!c.start_frame_prompt.startsWith(r.still_prefix) || !c.start_frame_prompt.endsWith(r.still_suffix) || !c.start_frame_prompt.includes(r.outfit_phrase)) {
      errors.push(`${tag}: start frame prompt is missing a fixed sentence.`);
    }
    if (!c.video_prompt.startsWith("Cinematic but realistic footage,") || !c.video_prompt.includes(r.objects)) errors.push(`${tag}: video prompt is missing a fixed sentence.`);
  }
  return errors;
}

// ── error classes for the media APIs ──
function isInsufficientBalance(msg) {
  return /insufficient|not enough (credit|balance|fund)|out of credits|no credits|balance (is )?too low|payment required|\b402\b|top.?up|exceeds? (your )?(balance|credit)/i.test(String(msg || ""));
}
function isModeration(msg) {
  return /nsfw|moderat|ip_detected|\bip detected\b|sensitive|safety|content policy|flagged|violat|prohibited|not allowed content/i.test(String(msg || ""));
}
function isTransient(msg) {
  return /\b(408|425|429|500|502|503|504)\b|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|socket hang up|rate.?limit|temporar|overloaded|try again/i.test(String(msg || ""));
}

// Higgsfield tops itself up automatically, but not instantly: a batch that hits
// "balance too low" waits and retries the missing videos. Payload knobs (minutes):
// balance_retry_every_min (default 10), balance_retry_max_min (default 60, 0 = off).
function balanceRetry(payload = {}) {
  const num = (v, d) => { const n = Number(v); return v === undefined || v === null || v === "" || !Number.isFinite(n) || n < 0 ? d : n; };
  const every = Math.max(1, num(payload.balance_retry_every_min, 10));
  const max = num(payload.balance_retry_max_min, 60);
  return { everyMs: every * 60000, maxMs: max * 60000, rounds: max > 0 ? Math.floor(max / every) : 0 };
}

// Retry an async function on transient errors with exponential backoff.
async function withBackoff(fn, { tries = 3, base = 5000, sleep = (ms) => new Promise(r => setTimeout(r, ms)), onRetry } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (i === tries - 1 || !isTransient(e && e.message)) throw e;
      const wait = base * 2 ** i;
      if (onRetry) onRetry(e, i + 1, wait);
      await sleep(wait);
    }
  }
  throw last;
}

// ── manifest + report ──
function totalCost(manifest) {
  let usd = 0, priced = true;
  for (const s of (manifest && manifest.slots) || []) {
    for (const part of [s.still_cost, s.video_cost]) {
      if (!part) continue;
      usd += Number(part.usd) || 0;
      if (part.priced === false) priced = false;
    }
  }
  if (manifest && manifest.concepts_cost) usd += Number(manifest.concepts_cost.usd) || 0;
  return { usd: Math.round(usd * 100) / 100, priced };
}

function escTg(s) {
  return String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

const STATUS_ICON = { done: "✅", video_failed: "❌", still_failed: "❌", skipped_balance: "💸", skipped: "⏭", pending: "⏳" };

function telegramSummary(m, origin = "") {
  const base = String(origin || "").replace(/\/+$/, "");
  const head = `🎬 <b>${escTg(m.title || "Weekly video batch")}</b> · ${escTg(m.batch_id)}${m.dry_run ? " · DRY RUN" : ""}\n${escTg(m.week_start)} to ${escTg(m.week_end)}`;
  const rows = (m.slots || []).map(s => {
    const icon = STATUS_ICON[s.status] || "•";
    const link = s.video_url ? (base && s.video_url.startsWith("/") ? base + s.video_url : s.video_url) : "";
    const day = String(s.day || "").slice(0, 3);
    return `${icon} ${escTg(day)} · ${escTg(s.city || "?")}${s.onscreen_text ? " · 🅣" : ""} · ${link ? `<a href="${escTg(link)}">video</a>` : escTg(s.status || "")}`;
  });
  const fails = (m.slots || []).filter(s => s.error).map(s => `slot ${s.slot}: ${escTg(String(s.error).slice(0, 160))}`);
  const cost = totalCost(m);
  return [
    head, "", ...rows,
    fails.length ? "\n<b>Failures</b>\n" + fails.join("\n") : "",
    m.stopped ? `\n⚠️ ${escTg(m.stopped)}` : "",
    m.buffer ? `\n📅 Buffer: ${m.buffer.scheduled} post(s) scheduled at ${escTg(m.buffer.time)}${m.buffer.errors?.length ? ` · ${m.buffer.errors.length} error(s)` : ""}` : "",
    `\n💰 Total cost: $${cost.usd.toFixed(2)}${cost.priced ? "" : " (+ items without a rate)"}`,
  ].filter(Boolean).join("\n").slice(0, 4000);
}

module.exports = {
  MODEL, SLOTS, DEFAULT_RULES, DEFAULTS, SCENE_TYPES,
  rulesFor, localParts, addDays, comingWeek, isoWeek, batchId, scheduleDue,
  recentCities, nextOutfitStart, outfitFor,
  stripDashes, normalizeHashtags, words,
  systemPrompt, userPrompt, neutralRewritePrompt, textOf, extractJson,
  devicesOf, buildStillPrompt, buildVideoPrompt, buildCaption, normalizeConcept, validateConcepts,
  isInsufficientBalance, isModeration, isTransient, withBackoff, balanceRetry,
  totalCost, telegramSummary,
};
