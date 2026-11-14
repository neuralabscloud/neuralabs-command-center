// X hook + reply pairs for the Social Media Manager autopilot.
// A pair = a short hook post (curiosity gap, ends with a pointer line + 👇) and a reply
// that delivers what the hook promised (one long post on Premium accounts, a chain of
// up to 4 replies otherwise). Account profiles live in data/x-pair-profiles.json.
// Pair slots are part of the existing autopilot day plan; the normal publisher posts them.
const fs = require("fs");
const path = require("path");

const FORMULAS = {
  numbered_promise: "Hook promises a specific count (\"3 checks I run before ...\"). The payload is a numbered list with exactly that many items.",
  contrarian: "Hook challenges a common belief in the niche. The payload explains why, with the reasoning and what to do instead.",
  confession: "Hook admits a mistake or lesson from our own experience. The payload tells what happened and what changed.",
  observation: "Hook points at a pattern most people miss. The payload shows the pattern and why it matters.",
  warning: "Hook flags a risk or trap. The payload explains how it works and how to avoid it.",
  before_after: "Hook contrasts how we did it before and how we do it now. The payload walks through the difference.",
};

const CAPS_ALLOW = ["PSA", "CGC", "BGS", "TAG", "BTC", "ETH", "SOL", "DeFi", "LP", "PnL", "OPSEC", "AI", "API", "EV", "IL"];
const SUPERLATIVES = [/\binsane(ly)?\b/i, /\bgame[\s-]?changers?\b/i, /\bthe best ever\b/i, /\byou won'?t believe\b/i];
const BAIT = [/\blike\s*(and|&|\+|n)\s*(rt|retweet|repost)\b/i, /\bfollow (me )?for more\b/i, /\bcomment\s+["'“]?yes\b/i];
const COUNT_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const POINTER = "👇";
const HISTORY_DAYS = 30;
const SIMILARITY_MAX = 0.45;
const MAX_REGENERATIONS = 2;
const EXPLORATION = 0.15;

// ---------- pure helpers ----------

function weightedLength(text) {
  const urlRe = /https?:\/\/\S+/g;
  let len = 0, last = 0, m;
  const s = String(text || "");
  while ((m = urlRe.exec(s))) { len += [...s.slice(last, m.index)].length + 23; last = m.index + m[0].length; }
  return len + [...s.slice(last)].length;
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
function emojis(text) { return String(text || "").match(EMOJI_RE) || []; }
function links(text) { return String(text || "").match(/https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(com|io|xyz|cloud|net|org|gg|app)(\/\S*)?\b/gi) || []; }
function hashtags(text) { return String(text || "").match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []; }
function mentions(text) { return String(text || "").match(/(^|[^\w])@\w{1,15}/g) || []; }

function lines(text) { return String(text || "").split("\n").map(l => l.trim()).filter(Boolean); }

function capsViolations(text, extra = []) {
  const allow = new Set([...CAPS_ALLOW, ...extra].map(s => s.toUpperCase()));
  const out = [];
  const re = /\$?[A-Za-z][A-Za-z0-9'’]*/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const w = m[0];
    if (w.startsWith("$")) continue; // cashtag = ticker
    const letters = w.replace(/[^A-Za-z]/g, "");
    if (letters.length < 2 || letters !== letters.toUpperCase()) continue;
    if (allow.has(letters.toUpperCase()) || allow.has(w.toUpperCase())) continue;
    out.push(w);
  }
  return [...new Set(out)];
}

// The number a hook promises ("3 checks", "five mistakes"), or null.
function hookCount(hook) {
  const m = String(hook || "").match(/\b([2-9]|1[0-2]|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[\p{L}'’-]+\s+){0,3}?(things|mistakes|rules|signs|lessons|ways|reasons|steps|checks|flags|questions|habits|tips|traps|errors|myths|tells|details|numbers|moves|filters|habits|truths|facts|patterns|setups|tools|red flags)\b/iu);
  if (!m) return null;
  const n = COUNT_WORDS[m[1].toLowerCase()] || Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Numbered items in the payload: lines starting with "1." / "2)" / "3/" etc.
function payloadCount(replies) {
  const nums = [];
  for (const r of replies) for (const l of lines(r)) {
    const m = l.match(/^(\d{1,2})[.)/:]\s+\S/);
    if (m) nums.push(Number(m[1]));
  }
  return nums.length ? Math.max(...nums) === nums.length ? nums.length : -nums.length : 0;
}

function trigrams(text) {
  const s = String(text || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const words = s.split(" ").filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 2 < words.length; i++) set.add(words.slice(i, i + 3).join(" "));
  if (!set.size && words.length) set.add(words.join(" "));
  return set;
}
function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Numbers that need a source: prices, percentages, pop counts and anything >= 13.
function claimNumbers(text) {
  const out = [];
  const re = /(\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%|\d[\d,]*(?:\.\d+)?\s?x\b|\b\d[\d,]*(?:\.\d+)?\b)/gi;
  let m;
  const s = String(text || "")
    .replace(/^\s*\d{1,2}[.)/:]\s+/gm, " ")                                   // list numbers are not claims
    .replace(/\b\d{1,3}\s?(?:-\s?)?(?:days?|weeks?|months?|hours?|h|d)\b/gi, " "); // time windows ("30 days") are not claims
  while ((m = re.exec(s))) {
    const raw = m[0];
    const n = Number(raw.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(n)) continue;
    const marked = /[$%x]/i.test(raw);
    if (!marked && n < 13) continue;
    if (!marked && n >= 1990 && n <= 2035) continue; // a year
    out.push({ raw: raw.trim(), n });
  }
  return out;
}
function factNumbers(facts) {
  const set = new Set();
  const walk = v => {
    if (v == null) return;
    if (typeof v === "number") {
      for (const x of [v, Math.round(v), Math.round(v * 10) / 10, Math.round(v * 100) / 100, Math.floor(v), Math.ceil(v)]) set.add(String(x));
      if (Math.abs(v) < 10) for (const x of [Math.round(v * 100), Math.round(v * 1000) / 10]) set.add(String(x)); // ratios as %
      return;
    }
    if (typeof v === "string") { for (const m of v.match(/\d[\d,]*(?:\.\d+)?/g) || []) set.add(String(Number(m.replace(/,/g, "")))); return; }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts);
  return set;
}
function ungroundedNumbers(text, facts) {
  const known = factNumbers(facts || {});
  return claimNumbers(text).filter(c => !known.has(String(c.n)) && !known.has(String(Math.round(c.n)))).map(c => c.raw);
}

/**
 * Validate a pair. Returns { ok, errors[] }.
 * ctx: { premium, formula, pillar, allowLink, allowedLinks[], forbiddenHook[], banned[] (regex strings),
 *        capsExtra[], history: [{pillar, formula, text, at}], facts (for numbers), numbersFromApi }
 */
function validatePair(pair, ctx = {}) {
  const errors = [];
  const hook = String(pair.hook || "").trim();
  const replies = (pair.replies || []).map(r => String(r || "").trim()).filter(Boolean);
  const all = [hook, ...replies].join("\n");

  if (/[–—]/.test(all)) errors.push("contains an em or en dash");
  const caps = capsViolations(all, ctx.capsExtra || []);
  if (caps.length) errors.push(`ALL-CAPS words not allowed: ${caps.slice(0, 5).join(", ")}`);
  for (const re of SUPERLATIVES) if (re.test(all)) errors.push(`hollow superlative: "${all.match(re)[0]}"`);
  for (const re of BAIT) if (re.test(all)) errors.push(`engagement bait: "${all.match(re)[0]}"`);
  for (const b of ctx.banned || []) { const re = new RegExp(b, "i"); if (re.test(all)) errors.push(`banned for this account: "${all.match(re)[0]}"`); }

  // hook
  if (!hook) errors.push("hook is empty");
  const hl = weightedLength(hook);
  if (hl > 200) errors.push(`hook is ${hl} characters (max 200)`);
  const hLines = hook.split("\n").map(l => l.trim()).filter(Boolean);
  if (hLines[hLines.length - 1] !== POINTER) errors.push(`hook must end with ${POINTER} on its own line`);
  else if (hLines.length < 3) errors.push(`hook needs the idea, then a pointer line, then ${POINTER}`);
  else if (/👇/.test(hLines[hLines.length - 2])) errors.push("pointer line must be text, the 👇 goes on its own line");
  const hookEmojis = emojis(hook).filter(e => e !== POINTER);
  if (hookEmojis.length || emojis(hook).length > 1) errors.push(`hook may only use the single ${POINTER} emoji`);
  if (links(hook).length) errors.push("hook contains a link");
  if (hashtags(hook).length) errors.push("hook contains a hashtag");
  if (mentions(hook).length) errors.push("hook contains an @mention");
  for (const term of ctx.forbiddenHook || []) if (term && hook.toLowerCase().includes(term.toLowerCase())) errors.push(`hook names "${term}"`);

  // payload
  if (!replies.length) errors.push("payload is empty");
  if (ctx.premium) {
    if (replies.length !== 1) errors.push(`premium account: payload must be one reply (got ${replies.length})`);
    if (replies[0] && weightedLength(replies[0]) > 1200) errors.push(`payload is ${weightedLength(replies[0])} characters (max 1200)`);
  } else {
    if (replies.length > 4) errors.push(`payload has ${replies.length} replies (max 4)`);
    replies.forEach((r, i) => { const l = weightedLength(r); if (l > 280) errors.push(`reply ${i + 1} is ${l} characters (max 280)`); });
  }
  const last = replies[replies.length - 1] || "";
  const lastLines = lines(last);
  const closer = lastLines.filter(l => !/^(#[\p{L}\p{N}_]+\s*)+$/u.test(l) && !/^https?:\/\/\S+$/.test(l)).pop() || "";
  if (!/\?\s*$/.test(closer)) errors.push("payload must end with a soft closing question");

  // links: payload only, max 1, only when this pair may carry one, only allowed urls
  const pLinks = replies.flatMap(links);
  if (pLinks.length > 1) errors.push("payload has more than 1 link");
  if (pLinks.length && !ctx.allowLink) errors.push("this pair may not carry a link (cadence)");
  if (pLinks.length && ctx.allowedLinks && ctx.allowedLinks.length && !pLinks.every(l => ctx.allowedLinks.some(a => l.replace(/[).,]+$/, "").replace(/\/$/, "") === a.replace(/\/$/, "")))) errors.push(`link not allowed: ${pLinks[0]}`);
  if (replies.some(mentions) && replies.flatMap(mentions).length) errors.push("payload contains an @mention");

  // hashtags: max 2, only on the last line
  const tags = replies.flatMap(hashtags);
  if (tags.length > 2) errors.push(`payload has ${tags.length} hashtags (max 2)`);
  if (tags.length) {
    const lastLine = lastLines[lastLines.length - 1] || "";
    const before = replies.slice(0, -1).flatMap(hashtags).length + hashtags(lastLines.slice(0, -1).join("\n")).length;
    if (before || !hashtags(lastLine).length) errors.push("hashtags only on the last line of the payload");
  }

  // brand mention is a payload-only, cadence-limited thing
  if (ctx.brandName && replies.join("\n").toLowerCase().includes(ctx.brandName.toLowerCase()) && !ctx.allowBrand) errors.push(`this pair may not mention ${ctx.brandName} (cadence)`);

  // count: hook promise must match the payload
  const want = hookCount(hook);
  const got = payloadCount(replies);
  if (ctx.formula === "numbered_promise" && want == null) errors.push("numbered_promise hook must promise a count (\"3 checks ...\")");
  if (want != null) {
    if (got < 0) errors.push(`payload numbering is not 1..n (${-got} numbered lines)`);
    else if (got !== want) errors.push(`hook promises ${want}, payload delivers ${got} numbered items`);
  }

  // numbers must come from the API facts of this run
  if (ctx.numbersFromApi) {
    const bad = ungroundedNumbers(all.replace(/https?:\/\/\S+/g, " "), ctx.facts);
    if (bad.length) errors.push(`numbers not in the API data of this run: ${bad.slice(0, 5).join(", ")}`);
  }

  // recent duplicates: same pillar + same formula + similar text
  const text = [hook, ...replies].join("\n");
  for (const h of ctx.history || []) {
    if (h.pillar !== ctx.pillar || h.formula !== ctx.formula) continue;
    const sim = similarity(text, h.text);
    if (sim >= SIMILARITY_MAX) { errors.push(`too similar (${Math.round(sim * 100)}%) to a ${h.formula}/${h.pillar} pair from ${String(h.at || "").slice(0, 10)}`); break; }
  }
  return { ok: !errors.length, errors };
}

// "at most 1 in k": allowed when none of the last k-1 pairs had the flag.
function cadenceAllows(history, field, ratio) {
  if (!(ratio > 0)) return false;
  if (ratio >= 1) return true;
  const k = Math.round(1 / ratio);
  return !history.slice(0, k - 1).some(h => h[field]);
}

function weightedPick(items, weights, rand = Math.random, exploration = EXPLORATION) {
  if (!items.length) return null;
  if (rand() < exploration) return items[Math.floor(rand() * items.length)];
  const w = items.map(i => Math.max(0.05, Number(weights[i]) || 1));
  let r = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

// Never the same formula twice in a row for an account.
function pickFormula(lastFormula, weights = {}, rand = Math.random, list = Object.keys(FORMULAS)) {
  const items = list.filter(f => f !== lastFormula);
  return weightedPick(items.length ? items : list, weights, rand);
}

function pickPillar(pillars, recent = [], weights = {}, rand = Math.random) {
  const ids = pillars.map(p => p.id);
  const lastTwo = recent.slice(0, 2);
  const items = ids.filter(id => !lastTwo.includes(id));
  return weightedPick(items.length ? items : ids, weights, rand);
}

function scorePair(m, w = {}) {
  if (!m || !m.hook) return null;
  const h = m.hook;
  const impr = Math.max(1, Number(h.impression_count) || 0);
  const eng = (Number(h.like_count) || 0) * (w.like ?? 1) + (Number(h.reply_count) || 0) * (w.reply ?? 2)
    + (Number(h.retweet_count) || 0) * (w.retweet ?? 3) + (Number(h.quote_count) || 0) * (w.quote ?? 3)
    + (Number(h.bookmark_count) || 0) * (w.bookmark ?? 2);
  const depth = m.reply ? (Number(m.reply.impression_count) || 0) / impr : 0;
  const rate = eng / impr;
  return { engagement: round(rate, 4), depth: round(depth, 4), score: round(rate * (w.engagement_scale ?? 10) + depth * (w.depth_weight ?? 1), 4) };
}
function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }

// Weekly reweight: mean score per key relative to the overall mean, clamped. Unseen keys = 1.
function reweight(pairs, field, keys) {
  const scored = pairs.filter(p => p.score && Number.isFinite(p.score.score));
  const out = {};
  if (!scored.length) { for (const k of keys) out[k] = 1; return out; }
  const mean = scored.reduce((a, p) => a + p.score.score, 0) / scored.length || 1e-9;
  for (const k of keys) {
    const mine = scored.filter(p => p[field] === k);
    if (mine.length < 2) { out[k] = 1; continue; }
    const m = mine.reduce((a, p) => a + p.score.score, 0) / mine.length;
    out[k] = round(Math.min(3, Math.max(0.3, m / mean)), 3);
  }
  return out;
}

function profileFor(profiles, channel) {
  const p = profiles && channel && profiles[channel.id];
  if (!p || p.enabled === false) return null;
  return {
    ...p,
    premium: !!p.premium, per_day: Math.max(0, Math.min(6, Number(p.per_day) || 0)),
    language: p.language || "English", voice: p.voice || "", pillars: (p.pillars || []).filter(x => x && x.id),
    never: p.never || [], banned_patterns: p.banned_patterns || [], caps_allow: p.caps_allow || [], tickers: p.tickers || [],
    media: p.media || null, link: p.link || null, brand_mention: p.brand_mention || null,
    numbers_from_api: !!p.numbers_from_api, data: p.data || null, hashtags: p.hashtags || [],
    formulas: (p.formulas || Object.keys(FORMULAS)).filter(f => FORMULAS[f]), learning: p.learning || {},
  };
}

function splitThread(text, max = 280) {
  const out = [];
  let cur = "";
  for (const para of String(text || "").split(/\n{2,}/)) {
    const next = cur ? `${cur}\n\n${para}` : para;
    if (weightedLength(next) <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = para;
  }
  if (cur) out.push(cur);
  return out;
}

function cleanText(t) {
  return String(t || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- runtime ----------

function createPairs(deps) {
  const {
    dataDir, mediaDir, readTasks, addTask, anthropic, model, brandKnowledge, twitterApi, twitterCredsFor, log = () => {},
    apiBase = "http://127.0.0.1:8000/collectibles/v1", fetchImpl = fetch, now = () => new Date(),
  } = deps;
  const profilesFile = deps.profilesFile || path.join(dataDir, "x-pair-profiles.json");
  const stateFile = path.join(dataDir, "community", "x-pairs-state.json");

  function profiles() { try { return JSON.parse(fs.readFileSync(profilesFile, "utf8")); } catch { return {}; } }
  function profile(channel) { return profileFor(profiles(), channel); }
  function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } }
  function saveState(s) { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); }
  function mutate(id, fn) { const s = loadState(); s[id] = s[id] || {}; const r = fn(s[id]); saveState(s); return r; }

  function pairTasks(channelId) {
    return readTasks().filter(t => t.channel_id === channelId && t.pair)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }
  function history(channelId) {
    const cutoff = now().getTime() - HISTORY_DAYS * 864e5;
    return pairTasks(channelId).filter(t => !["cancelled", "failed"].includes(t.status) && Date.parse(t.created_at) >= cutoff)
      .map(t => ({ id: t.id, pillar: t.pair.pillar, formula: t.pair.formula, has_link: !!t.pair.has_link, has_media: !!t.pair.has_media,
        brand: !!t.pair.brand_mention, text: [t.pair.hook, ...(t.pair.replies || [])].join("\n"), at: t.created_at }));
  }

  function perDay(channel) { const p = profile(channel); return p ? p.per_day : 0; }

  // --- Slabhaus facts from the NeuraCollectibles API (read only, fetched in this run) ---
  async function getJson(url) {
    const r = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function fetchFacts(p, pillarId) {
    const d = p.data || {};
    const base = d.api_base || apiBase;
    const want = (d.pillar_endpoints || {})[pillarId] || [];
    if (!want.length) return null;
    const facts = { source: "NeuraCollectibles API", fetched_at: now().toISOString() };
    for (const ep of want) {
      try {
        const j = await getJson(`${base}/${ep}`);
        facts[ep.split("?")[0]] = slimFacts(ep, j);
      } catch (e) { log(`pairs: API ${ep} failed: ${e.message}`); }
    }
    return Object.keys(facts).length > 2 ? facts : null;
  }
  function slimFacts(ep, j) {
    const name = ep.split("?")[0];
    if (name === "packs") return (j.items || []).slice(0, 8).map(x => ({ pack: x.name, platform: x.platform && x.platform.name, window: x.window, price_usd: x.price_usd, ev_usd: x.ev_usd, ev_ratio: x.ev_ratio, return_per_100: x.return_per_100, share_above_price_pct: x.share_above_price, sellback_rate_pct: x.sellback_rate, sample_size: x.sample_size, low_confidence: x.low_confidence }));
    if (name === "pop-shock") return (j.items || []).slice(0, 3).map(x => ({ card: x.card && x.card.name, set: x.card && x.card.set_name, number: x.card && x.card.number, language: x.card && x.card.language, grade: x.card && `${x.card.grade_company} ${x.card.grade}`, psa10_pop_then: x.psa10_then, psa10_pop_now: x.psa10_now, growth_pct: x.growth_pct, since: x.since, as_of: x.as_of }));
    if (name === "movers") { const f = a => (a || []).slice(0, 5).map(x => ({ card: x.card && x.card.name, set: x.card && x.card.set_name, language: x.card && x.card.language, variant: x.variant, change_pct: x.change_pct })); return { window: j.window, kind: j.kind, as_of: j.as_of, up: f(j.up), down: f(j.down) }; }
    if (name === "mood") return { score: j.score, label: j.label, change_24h: j.change_24h, components: Object.fromEntries(Object.entries(j.components || {}).map(([k, v]) => [k, v && v.detail])) };
    if (name === "volume") { const w = (j.windows || {})["24h"] || {}; return { window: "24h", total_usd: w.total_usd, pack_spend_usd: w.pack_spend_usd, trading_usd: w.trading_usd, sellback_usd: w.sellback_usd, count: w.count }; }
    return j;
  }

  // --- media: gh0st still or a slab photo ---
  function gh0stStills() {
    const dir = path.join(dataDir, "character-batches");
    const out = [];
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json") && !f.includes("dry-run")); } catch {}
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        for (const s of m.slots || []) {
          if (!s.still_url) continue;
          const file = path.join(dataDir, "generated-images", path.basename(s.still_url));
          if (fs.existsSync(file)) out.push({ file, label: `${s.city || ""} ${s.onscreen_text || ""}`.trim() });
        }
      } catch {}
    }
    return out;
  }
  async function slabPhotos(p) {
    const url = p.media && p.media.feed_url;
    if (!url) return [];
    try {
      const feed = require("./listings-autopilot").normaliseFeed(await getJson(url), url);
      return feed.items.filter(i => i.image).map(i => ({ url: i.image, label: [i.short_name || i.name, i.grade].filter(Boolean).join(", ") }));
    } catch (e) { log(`pairs: slab feed failed: ${e.message}`); return []; }
  }
  async function pickMedia(channel, p, used) {
    const m = p.media || {};
    const counts = used || {};
    const pickLeast = list => list.slice().sort((a, b) => (counts[a.key] || 0) - (counts[b.key] || 0) || Math.random() - 0.5)[0];
    if (m.kind === "gh0st_still") {
      const s = pickLeast(gh0stStills().map(x => ({ ...x, key: path.basename(x.file) })));
      return s ? { kind: "gh0st_still", key: s.key, file: s.file, label: s.label || "the gh0st character" } : null;
    }
    if (m.kind === "slab_photo") {
      const s = pickLeast((await slabPhotos(p)).map(x => ({ ...x, key: x.url })));
      return s ? { kind: "slab_photo", key: s.key, url: s.url, label: s.label } : null;
    }
    return null;
  }
  async function materializeMedia(media, id) {
    if (!media) return null;
    const dir = path.join(mediaDir, "pairs");
    fs.mkdirSync(dir, { recursive: true });
    if (media.file) {
      const ext = path.extname(media.file).toLowerCase() || ".png";
      const name = `${id}${ext}`;
      fs.copyFileSync(media.file, path.join(dir, name));
      return `/media/pairs/${name}`;
    }
    const r = await fetchImpl(media.url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`slab photo HTTP ${r.status}`);
    const type = r.headers.get("content-type") || "";
    const ext = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : ".jpg";
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error("slab photo over 5 MB");
    const name = `${id}${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return `/media/pairs/${name}`;
  }

  // --- plan one pair: formula, pillar, cadence flags, facts, media ---
  async function plan(channel, p, opts = {}) {
    const st = loadState()[channel.id] || {};
    const hist = opts.history || history(channel.id);
    const weights = st.weights || {};
    const lastFormula = opts.lastFormula !== undefined ? opts.lastFormula : (hist[0] && hist[0].formula);
    const formula = pickFormula(lastFormula, weights.formulas || {}, Math.random, p.formulas);
    let pillarId = pickPillar(p.pillars, hist.map(h => h.pillar), weights.pillars || {});
    let pillar = p.pillars.find(x => x.id === pillarId);
    let facts = null, fallback = null;
    if (pillar && pillar.needs_data) {
      facts = await fetchFacts(p, pillar.id);
      if (!facts) {
        const ever = p.pillars.filter(x => !x.needs_data);
        const alt = ever.find(x => x.id === pickPillar(ever, hist.map(h => h.pillar), weights.pillars || {})) || ever[0];
        fallback = `API data for ${pillar.id} unavailable, used evergreen pillar ${alt.id}`;
        log(`pairs: ${channel.name}: ${fallback}`);
        pillar = alt;
      }
    }
    const allowLink = !!(p.link && (p.link.urls || []).some(u => u && u.url && u.enabled !== false) && cadenceAllows(hist, "has_link", p.link.ratio));
    const allowBrand = !!(p.brand_mention && cadenceAllows(hist, "brand", p.brand_mention.ratio));
    const linkOk = allowLink && (!p.link.requires_brand || allowBrand);
    const wantMedia = !!(p.media && cadenceAllows(hist, "has_media", p.media.ratio));
    const media = wantMedia ? await pickMedia(channel, p, st.media_counts) : null;
    return { formula, pillar, facts, fallback, allowLink: linkOk, allowBrand, media, history: hist };
  }

  function prompt(channel, p, pl) {
    const links = (p.link && p.link.urls || []).filter(u => u && u.url && u.enabled !== false);
    const linkRule = pl.allowLink && links.length
      ? `- This pair MAY carry one link, in the payload only (never in the hook), and only if it fits naturally. Allowed: ${links.map(l => `${l.url} (${l.label})`).join(" or ")}. Set has_link accordingly.`
      : "- No links anywhere in this pair.";
    const brandRule = p.brand_mention
      ? (pl.allowBrand ? `- ${p.brand_mention.name} may be named in the payload (never in the hook), at most once, in a natural way${p.brand_mention.url ? `, with ${p.brand_mention.url}` : ""}. Not required.` : `- Do not name ${p.brand_mention.name} anywhere in this pair.`)
      : "";
    const payloadRule = p.premium
      ? "- Payload: ONE reply of at most 1200 characters (this account has X Premium). Short paragraphs with a blank line between them."
      : "- Payload: a chain of 1 to 4 replies, each at most 280 characters. Each reply reads on its own; numbered items may continue across replies.";
    const factsBlock = pl.facts
      ? `\nData for this pair (fetched now from the NeuraCollectibles API). Every price, percentage, pop count or market figure you use MUST appear in this data. Use only a few, never invent or extrapolate:\n${JSON.stringify(pl.facts, null, 1)}\n`
      : (p.numbers_from_api ? "\nNo market data is available for this pair: write evergreen. Do NOT state any price, percentage, pop count or market figure.\n" : "");
    const mediaBlock = pl.media
      ? `\nThe hook gets an image: ${pl.media.kind === "slab_photo" ? `a photo of a slab from our own collection (${pl.media.label}). You may refer to it, but claim nothing about it beyond what that label says.` : `a still of our character (${pl.media.label}). The text does not need to describe it.`}\n`
      : "\nThe hook has no image.\n";
    return `You write one hook + reply pair for the X account "${channel.name}". Language: ${p.language}.
Voice: ${p.voice}
${brandKnowledge ? brandKnowledge(channel) : ""}

Pillar for this pair: ${pl.pillar.label}. ${pl.pillar.brief || ""}
Formula: ${pl.formula}. ${FORMULAS[pl.formula]}
${factsBlock}${mediaBlock}
How the pair works: the hook is posted first and makes people open the reply. The payload is our reply under the hook and delivers exactly what the hook promised.

Hook rules:
- At most 200 characters, one idea, opens a curiosity gap without giving the answer.
- Last two lines: a short pointer line (for example "Here is the checklist:" or "What I do now:"), then ${POINTER} alone on the final line.
- The ${POINTER} is the only emoji. No links, no hashtags, no @mentions.
${p.brand_mention ? `- Never name ${p.brand_mention.name} in the hook.\n` : ""}
Payload rules:
${payloadRule}
- Deliver the promise concretely. If the hook promises a number of items, the payload has exactly that many numbered lines ("1. ...", "2. ...").
- End with a soft, genuine closing question to the reader (not "agree?", not a demand).
${linkRule}
${brandRule}
- At most 2 hashtags, only on the very last line, or none.

Always:
- NEVER use em dashes or en dashes. Use periods, colons or line breaks.
- No ALL-CAPS words, except: ${[...CAPS_ALLOW, ...p.caps_allow].join(", ")}${p.tickers.length ? ` and tickers (${p.tickers.join(", ")})` : ""}.
- No hollow superlatives ("insane", "game changer", "the best ever", "you won't believe") and no engagement bait ("like and RT", "follow for more", "comment YES").
- Never: ${p.never.join("; ")}.
- Plain, human, specific. Our own experience and reasoning, no generic listicle filler.

Recent pairs on this account (do not repeat their angle):
${pl.history.slice(0, 8).map(h => `- [${h.formula}/${h.pillar}] ${h.text.split("\n")[0].slice(0, 140)}`).join("\n") || "- none yet"}

Answer only by calling the submit_pair tool.`;
  }

  const TOOL = {
    name: "submit_pair",
    description: "Submit the hook and its payload replies.",
    input_schema: {
      type: "object",
      properties: {
        hook: { type: "string", description: `The hook post, ending with a pointer line and then ${POINTER} on its own line.` },
        replies: { type: "array", items: { type: "string" }, description: "The payload: one reply (premium) or 1 to 4 replies (thread)." },
        has_link: { type: "boolean" },
        angle: { type: "string", description: "One sentence: the idea of this pair." },
      },
      required: ["hook", "replies", "has_link", "angle"],
      additionalProperties: false,
    },
  };

  // Write + validate. Up to MAX_REGENERATIONS regenerations; returns {pair, validation, attempts} or throws {dropped}.
  async function write(channel, p, pl) {
    const ctx = {
      premium: p.premium, formula: pl.formula, pillar: pl.pillar.id, allowLink: pl.allowLink, allowBrand: pl.allowBrand,
      allowedLinks: (p.link && p.link.urls || []).filter(l => l && l.url && l.enabled !== false).map(l => l.url),
      forbiddenHook: p.brand_mention ? [p.brand_mention.name, ...(p.brand_mention.aliases || [])] : [],
      brandName: p.brand_mention ? p.brand_mention.name : null,
      banned: p.banned_patterns, capsExtra: [...p.caps_allow, ...p.tickers], history: pl.history,
      facts: pl.media && pl.media.label ? { ...(pl.facts || {}), image_label: pl.media.label } : pl.facts, numbersFromApi: p.numbers_from_api,
    };
    const messages = [{ role: "user", content: prompt(channel, p, pl) }];
    const tries = [];
    for (let attempt = 0; attempt <= MAX_REGENERATIONS; attempt++) {
      const msg = await anthropic.messages.create({
        model, max_tokens: 6000, tools: [TOOL], tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages,
      });
      const use = msg.content.find(b => b.type === "tool_use");
      if (!use) {
        if (msg.stop_reason === "refusal") break;
        messages.push({ role: "assistant", content: msg.content });
        messages.push({ role: "user", content: "Answer only by calling the submit_pair tool." });
        tries.push(["no tool call"]);
        continue;
      }
      const out = use.input || {};
      let replies = (Array.isArray(out.replies) ? out.replies : [out.replies]).map(cleanText).filter(Boolean);
      if (p.premium && replies.length > 1 && weightedLength(replies.join("\n\n")) <= 1200) replies = [replies.join("\n\n")];
      const pair = { hook: cleanText(out.hook), replies, has_link: replies.some(r => links(r).length > 0), angle: String(out.angle || "").slice(0, 300) };
      const v = validatePair(pair, ctx);
      tries.push(v.errors);
      if (v.ok) return { pair, validation: v, attempts: attempt + 1, tries };
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Rejected by the validator:\n- ${v.errors.join("\n- ")}\nFix every point and call submit_pair again.` }] });
    }
    const err = new Error(`pair dropped after ${tries.length} attempts: ${(tries[tries.length - 1] || []).join("; ")}`);
    err.dropped = true;
    err.tries = tries;
    throw err;
  }

  function logDrop(channel, pl, e) {
    log(`pairs: ${channel.name}: ${e.message}`);
    mutate(channel.id, s => {
      s.dropped = [{ at: now().toISOString(), formula: pl && pl.formula, pillar: pl && pl.pillar && pl.pillar.id, reasons: e.tries || [[e.message]] }, ...(s.dropped || [])].slice(0, 50);
    });
  }

  // Scheduled/manual production through the autopilot: creates one task (draft in review mode).
  async function produce(channel, { mode, step = () => {}, record = () => {} } = {}) {
    const p = profile(channel);
    if (!p) throw new Error("No pair profile for this channel (data/x-pair-profiles.json)");
    step("planning pair");
    const pl = await plan(channel, p);
    step(`writing pair (${pl.formula} · ${pl.pillar.id})`);
    let res;
    try { res = await write(channel, p, pl); } catch (e) { if (e.dropped) logDrop(channel, pl, e); throw e; }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let mediaPath = null;
    if (pl.media) {
      step("preparing image");
      try { mediaPath = await materializeMedia(pl.media, id); } catch (e) { log(`pairs: media failed, posting hook without image: ${e.message}`); }
    }
    const brandHit = !!(p.brand_mention && res.pair.replies.join("\n").toLowerCase().includes(p.brand_mention.name.toLowerCase()));
    const ts = now().toISOString();
    const task = {
      id, channel_id: channel.id,
      status: mode === "review" ? "draft" : "scheduled",
      created_at: ts, updated_at: ts, scheduled_at: ts, scheduled_local: null,
      archetype: "Autopilot · Pair", trigger_word: null,
      media_path: mediaPath, media_paths: mediaPath ? [mediaPath] : [],
      text: res.pair.hook, published_at: null, message_id: null, attempts: 0, error: null,
      autopilot: true, topic: pl.pillar.label, format: pl.formula, reason: res.pair.angle,
      instagram: { status: "skipped", reason: "hook + reply pair (X only)" },
      pair: {
        hook: res.pair.hook, replies: res.pair.replies, formula: pl.formula, pillar: pl.pillar.id, pillar_label: pl.pillar.label,
        premium: p.premium, has_media: !!mediaPath, has_link: res.pair.has_link, brand_mention: brandHit,
        media_kind: mediaPath ? pl.media.kind : null, facts_used: !!pl.facts, fallback: pl.fallback || null,
        validator: { ok: true, attempts: res.attempts }, hook_id: null, reply_ids: [], posted_at: null,
        metrics: {}, score: null, created_at: ts,
      },
    };
    addTask(task);
    if (mediaPath) mutate(channel.id, s => { s.media_counts = { ...(s.media_counts || {}), [pl.media.key]: ((s.media_counts || {})[pl.media.key] || 0) + 1 }; });
    record({ status: "done", task_id: id, finished_at: now().toISOString() });
    log(`pairs: ${channel.name}: queued ${id} (${pl.formula}/${pl.pillar.id}, ${res.pair.replies.length} repl${res.pair.replies.length === 1 ? "y" : "ies"}, media ${mediaPath ? pl.media.kind : "none"}, link ${res.pair.has_link})`);
    return { task };
  }

  // Dry run: n pairs, nothing stored as task, nothing posted. Formula rotation simulated in sequence.
  async function dryRun(channel, n = 5) {
    const p = profile(channel);
    if (!p) throw new Error("No pair profile for this channel");
    const out = [];
    let hist = history(channel.id);
    for (let i = 0; i < n; i++) {
      const pl = await plan(channel, p, { history: hist, lastFormula: hist[0] && hist[0].formula });
      const row = { n: i + 1, formula: pl.formula, pillar: pl.pillar.id, facts_used: !!pl.facts, fallback: pl.fallback, allow_link: pl.allowLink, allow_brand: pl.allowBrand, media: pl.media ? { kind: pl.media.kind, label: pl.media.label } : null };
      try {
        const res = await write(channel, p, pl);
        Object.assign(row, { hook: res.pair.hook, replies: res.pair.replies, has_link: res.pair.has_link, angle: res.pair.angle, validator: { ok: true, attempts: res.attempts, rejected_attempts: res.tries.filter(t => t.length) } });
        hist = [{ pillar: pl.pillar.id, formula: pl.formula, has_link: res.pair.has_link, has_media: !!pl.media, brand: !!(p.brand_mention && res.pair.replies.join(" ").toLowerCase().includes(p.brand_mention.name.toLowerCase())), text: [res.pair.hook, ...res.pair.replies].join("\n"), at: now().toISOString() }, ...hist];
      } catch (e) {
        Object.assign(row, { validator: { ok: false, dropped: !!e.dropped, error: e.message, rejected_attempts: e.tries || [] } });
      }
      out.push(row);
    }
    return { channel: channel.name, premium: p.premium, pairs: out };
  }

  // --- metrics at 24 h / 72 h + weekly reweight ---
  let ticking = false;
  async function tick(channels) {
    if (ticking) return;
    ticking = true;
    try {
      const t = now().getTime();
      for (const channel of channels) {
        if (!profile(channel)) continue;
        const due = pairTasks(channel.id).filter(x => x.status === "published" && x.pair.hook_id && x.pair.posted_at).map(x => {
          const age = t - Date.parse(x.pair.posted_at);
          const want = !x.pair.metrics.h24 && age >= 24 * 3.6e6 && age < 60 * 3.6e6 ? "h24" : (!x.pair.metrics.h72 && age >= 72 * 3.6e6 && age < 14 * 864e5 ? "h72" : null);
          return want ? { task: x, want } : null;
        }).filter(Boolean).slice(0, 10);
        if (due.length) await fetchMetrics(channel, due).catch(e => log(`pairs: metrics ${channel.name}: ${e.message}`));
        maybeReweight(channel);
      }
    } finally { ticking = false; }
  }

  async function fetchMetrics(channel, due) {
    const creds = twitterCredsFor(channel);
    const ids = [...new Set(due.flatMap(d => [d.task.pair.hook_id, d.task.pair.reply_ids[0]]).filter(Boolean))];
    const resp = await twitterApi("GET", `https://api.x.com/2/tweets?ids=${ids.join(",")}&tweet.fields=public_metrics`, creds);
    const byId = Object.fromEntries((resp.data || []).map(x => [x.id, x.public_metrics || {}]));
    const learn = (profile(channel) || {}).learning || {};
    if (deps.updateTask) for (const d of due) {
      const hook = byId[d.task.pair.hook_id];
      if (!hook) continue;
      const reply = byId[d.task.pair.reply_ids[0]] || null;
      const m = { at: now().toISOString(), hook, reply };
      deps.updateTask(d.task.id, task => {
        task.pair.metrics = { ...(task.pair.metrics || {}), [d.want]: m };
        const best = task.pair.metrics.h72 || task.pair.metrics.h24;
        task.pair.score = scorePair(best, learn);
      });
    }
  }

  function maybeReweight(channel, force = false) {
    const st = loadState()[channel.id] || {};
    const last = Date.parse(st.reweighted_at || 0);
    if (!force && now().getTime() - last < 7 * 864e5) return null;
    const p = profile(channel);
    const cutoff = now().getTime() - 56 * 864e5;
    const scored = pairTasks(channel.id).filter(x => x.pair.score && Date.parse(x.created_at) >= cutoff).map(x => ({ formula: x.pair.formula, pillar: x.pair.pillar, score: x.pair.score }));
    const weights = { formulas: reweight(scored, "formula", p.formulas), pillars: reweight(scored, "pillar", p.pillars.map(x => x.id)), based_on: scored.length, exploration: EXPLORATION };
    mutate(channel.id, s => { s.weights = weights; s.reweighted_at = now().toISOString(); });
    if (scored.length) log(`pairs: ${channel.name}: reweighted on ${scored.length} scored pairs`);
    return weights;
  }

  // Our pair replies, so x-replies also answers people who react under them.
  function ourReplies(channel) {
    const out = [];
    for (const t of pairTasks(channel.id)) {
      if (t.status !== "published" || !t.pair.hook_id) continue;
      t.pair.reply_ids.forEach((rid, i) => out.push({ id: rid, conversation_id: t.pair.hook_id, text: t.pair.replies[i] || "", to_text: t.pair.hook, to_author: null, at: t.pair.posted_at || t.published_at }));
    }
    return out;
  }

  function status(channel) {
    const p = profile(channel);
    const st = loadState()[channel.id] || {};
    const rows = pairTasks(channel.id).slice(0, 20).map(t => {
      const m = t.pair.metrics.h72 || t.pair.metrics.h24 || null;
      const hi = m && m.hook ? Number(m.hook.impression_count) || 0 : null;
      const ri = m && m.reply ? Number(m.reply.impression_count) || 0 : null;
      return {
        id: t.id, status: t.status, created_at: t.created_at, posted_at: t.pair.posted_at, formula: t.pair.formula, pillar: t.pair.pillar,
        hook: t.pair.hook, replies: t.pair.replies, has_media: t.pair.has_media, has_link: t.pair.has_link,
        hook_id: t.pair.hook_id, reply_ids: t.pair.reply_ids, hook_impressions: hi, reply_impressions: ri,
        ratio: hi ? round((ri || 0) / hi, 3) : null, metrics_at: m ? (t.pair.metrics.h72 ? "72h" : "24h") : null, score: t.pair.score, error: t.error,
      };
    });
    return { enabled: !!p, profile: p ? { premium: p.premium, per_day: p.per_day, pillars: p.pillars.map(x => x.id), formulas: p.formulas } : null,
      weights: st.weights || null, reweighted_at: st.reweighted_at || null, dropped: (st.dropped || []).slice(0, 10), pairs: rows };
  }

  return { perDay, produce, dryRun, tick, status, ourReplies, profile, maybeReweight, _plan: plan, _write: write };
}

// ---------- publishing (used by the X publisher in api-server.js) ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Post hook + replies. api(method, url, body) wraps twitterApi with creds.
 * Each reply: 3 retries with backoff, all inside a 2 minute window; on a 429 wait until the reset
 * header if it fits. If a reply still fails: delete what we posted (replies + hook) and throw final.
 */
async function publishPair({ hookBody, replies, api, wait = sleep, clock = Date.now, windowMs = 120000, backoff = [5000, 15000, 40000], log = () => {} }) {
  const hook = await api("POST", "https://api.x.com/2/tweets", hookBody);
  const hookId = hook && hook.data && hook.data.id;
  if (!hookId) throw new Error("X API: hook created but no id returned");
  const replyIds = [];
  let prev = hookId;
  for (let i = 0; i < replies.length; i++) {
    const start = clock();
    let lastErr = null;
    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      try {
        const d = await api("POST", "https://api.x.com/2/tweets", { text: replies[i], reply: { in_reply_to_tweet_id: prev } });
        if (!d || !d.data || !d.data.id) throw new Error("X API: reply created but no id returned");
        replyIds.push(d.data.id);
        prev = d.data.id;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt === backoff.length) break;
        let delay = backoff[attempt];
        if (e.status === 429 && e.resetAt) delay = Math.max(delay, e.resetAt - clock() + 1000);
        if (clock() - start + delay > windowMs) { log(`pair reply ${i + 1}: next retry would pass the 2 min window`); break; }
        log(`pair reply ${i + 1} failed (${e.message}), retry in ${Math.round(delay / 1000)}s`);
        await wait(delay);
      }
    }
    if (lastErr) {
      const cleanup = [];
      for (const id of [...replyIds].reverse().concat(hookId)) {
        try { await api("DELETE", `https://api.x.com/2/tweets/${id}`); cleanup.push(id); } catch (e) { log(`pair cleanup: delete ${id} failed: ${e.message}`); }
      }
      const err = new Error(`Pair reply ${i + 1} failed after retries (${lastErr.message}); hook ${cleanup.includes(hookId) ? "deleted" : "could NOT be deleted"}`);
      err.final = true;
      err.deleted = cleanup;
      throw err;
    }
  }
  return { hook_id: hookId, reply_ids: replyIds };
}

module.exports = {
  FORMULAS, CAPS_ALLOW, POINTER, EXPLORATION, MAX_REGENERATIONS,
  weightedLength, emojis, links, hashtags, mentions, capsViolations, hookCount, payloadCount, similarity, claimNumbers, ungroundedNumbers,
  validatePair, cadenceAllows, pickFormula, pickPillar, weightedPick, scorePair, reweight, profileFor, splitThread, cleanText,
  createPairs, publishPair,
};
