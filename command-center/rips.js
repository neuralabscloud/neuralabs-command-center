// Rip shorts: pure helpers (no network, no ffmpeg). Timeline math, script
// validation, captions, post text, X trimming, chips → steps, log redaction.
// The pipeline itself lives in rips-pipeline.js.
"use strict";

const STEPS = ["normalize", "analyze", "edit", "script", "voice", "mix", "captions", "final", "post"];
const STATUSES = ["uploaded", "processing", "ready_for_review", "revising", "approved", "publishing", "published", "failed"];

const DEFAULT_PLAN = {
  min_duration: 20,
  max_duration: 30,
  max_speed: 2,          // loading screens at most 2x
  pre_reveal_real: 2,    // last seconds before the reveal always 1x
  reveal_hold: 1.5,      // hold on the revealed card
  market_lead: 4,        // market clip before the value appears
  zoom_secs: 1,          // zoom 1.0 → zoom_to over this many seconds
  zoom_to: 1.6,
  value_hold: 2,         // hold on the value after the zoom
  tone: "neutral",       // calm | neutral | excited
  hook_instruction: "",
  script_instruction: "",
  caption_instruction: "",
  voice_seed: 1,
};

const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── Edit plan ────────────────────────────────────────────────────────────
// Returns the cut list plus markers on the output timeline:
//   pull:   [p0, pFast) sped up by `speed`, [pFast, revealT + hold) real time
//   market: [m0, valueT + zoom + hold) with the zoom starting at valueT
function planEdit({ pullDur, marketDur, packStart, revealT, valueT }, planIn = {}) {
  const p = { ...DEFAULT_PLAN, ...planIn };
  if (!(revealT > 0) || !(pullDur > 0)) throw new Error("reveal time unknown");
  if (!(valueT >= 0) || !(marketDur > 0)) throw new Error("value time unknown");
  revealT = Math.min(revealT, pullDur);
  const holdReal = clamp(pullDur - revealT, 0, p.reveal_hold); // frames that exist after the reveal
  const holdFreeze = r2(p.reveal_hold - holdReal);              // rest is a freeze frame
  let p0 = clamp(Number.isFinite(packStart) ? packStart - 0.5 : 0, 0, revealT);
  const pFast = Math.max(p0, revealT - p.pre_reveal_real);

  // market: lead into the value, then zoom + hold
  const tail = p.zoom_secs + p.value_hold;
  let lead = clamp(p.market_lead, 1.5, valueT);
  const marketAvailTail = Math.max(0, marketDur - valueT);
  const marketFreeze = r2(Math.max(0, tail - marketAvailTail));

  const pullLen = (speed) => (pFast - p0) / speed + (revealT - pFast) + p.reveal_hold;
  const total = (speed) => pullLen(speed) + lead + tail;

  // aim a little under the cap: the encoder rounds to whole frames
  const cap = p.max_duration - 0.1;
  let speed = 1;
  if (total(1) > cap) {
    const fastSrc = pFast - p0;
    const room = cap - ((revealT - pFast) + p.reveal_hold + lead + tail);
    speed = room > 0 && fastSrc > 0 ? clamp(fastSrc / room, 1, p.max_speed) : p.max_speed;
    speed = Math.min(p.max_speed, Math.ceil(speed * 100) / 100); // round up, never past the cap
    if (total(speed) > cap) {
      // still too long at max speed: start later in the loading stretch
      const over = total(speed) - cap;
      p0 = Math.min(pFast, p0 + over * speed);
    }
  } else if (total(1) < p.min_duration) {
    // too short: more market lead first, then start earlier in the pull clip
    let short = p.min_duration - total(1);
    const extraLead = Math.min(short, Math.max(0, valueT - lead), 3);
    lead += extraLead; short -= extraLead;
    if (short > 0) p0 = Math.max(0, p0 - short);
  }
  const m0 = r2(Math.max(0, valueT - lead));
  const fastOut = (pFast - p0) / speed;
  const tReveal = r2(fastOut + (revealT - pFast));
  const tCut = r2(tReveal + p.reveal_hold);
  const tValue = r2(tCut + (valueT - m0));
  const tZoomEnd = r2(tValue + p.zoom_secs);
  const tEnd = r2(tZoomEnd + p.value_hold);
  return {
    pull: { p0: r2(p0), pFast: r2(pFast), revealT: r2(revealT), holdReal: r2(holdReal), holdFreeze, speed },
    market: { m0, valueT: r2(valueT), end: r2(Math.min(marketDur, valueT + tail)), freeze: marketFreeze },
    zoom: { from: 1, to: p.zoom_to, secs: p.zoom_secs },
    markers: { t_reveal: tReveal, t_cut: tCut, t_value: tValue, t_zoom_end: tZoomEnd, t_end: tEnd },
    duration: tEnd,
    within_target: tEnd >= p.min_duration - 0.05 && tEnd <= p.max_duration,
  };
}

// Zoom factor at output time t (seconds), for ffmpeg expressions and tests.
function zoomAt(t, edit) {
  const { t_value } = edit.markers;
  const k = clamp((t - t_value) / edit.zoom.secs, 0, 1);
  const e = k * k * (3 - 2 * k); // smoothstep
  return 1 + (edit.zoom.to - 1) * e;
}

// ── Outcome and numbers ──────────────────────────────────────────────────
function outcome(a) {
  const pack = num(a && a.pack_price), mv = num(a && a.market_value);
  if (pack == null || mv == null) return { kind: "unknown", diff: null, pct: null };
  const diff = r2(mv - pack);
  const pct = pack > 0 ? Math.round((diff / pack) * 100) : null;
  return { kind: diff > 0 ? "win" : diff < 0 ? "loss" : "even", diff, pct };
}
function num(v) { const s = typeof v === "string" ? v.replace(/[^0-9.\-]/g, "") : null; const n = typeof v === "string" ? (/[0-9]/.test(s) ? Number(s) : NaN) : v; return Number.isFinite(n) ? n : null; }

// Every number a script or caption is allowed to say.
function allowedNumbers(a) {
  const o = outcome(a);
  const out = new Set();
  const add = (v) => {
    const n = num(v); if (n == null) return;
    for (const x of [n, Math.abs(n), Math.round(n), Math.round(Math.abs(n)), Math.floor(Math.abs(n)), Math.ceil(Math.abs(n))]) {
      out.add(String(r2(x)));
    }
  };
  if (a) { add(a.pack_price); add(a.market_value); add(a.buyback); add(a.grade); }
  if (o.diff != null) add(o.diff);
  if (o.pct != null) add(o.pct);
  if (a && a.pack_price != null && a.market_value != null && num(a.pack_price) > 0) {
    const ratio = num(a.market_value) / num(a.pack_price);
    if (ratio >= 2) { out.add(String(Math.floor(ratio))); out.add(String(r2(ratio))); out.add(String(Math.round(ratio * 10) / 10)); }
  }
  // the year in a set name or card name (e.g. "1999") may be read out
  for (const s of [a && a.set, a && a.card]) for (const m of String(s || "").match(/\d+(?:\.\d+)?/g) || []) out.add(String(Number(m)));
  return out;
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000 };
function numbersIn(text) {
  const t = stripTags(text).replace(/(\d),(\d{3})/g, "$1$2");
  const out = [];
  for (const m of t.match(/\d+(?:\.\d+)?/g) || []) out.push(String(Number(m)));
  for (const w of t.toLowerCase().match(/[a-z]+/g) || []) if (NUMBER_WORDS[w] != null) out.push(`word:${w}`);
  return out;
}

// ── Text rules ───────────────────────────────────────────────────────────
const DASH_RE = /[‒–—―]/;
const CTA_RE = /\b(buy now|buy it|buy one|go buy|purchase|shop now|link in bio|order now|use code|sign up|subscribe|tap the link|grab yours|check out the link)\b/i;
const HOLLOW_RE = /\b(insane|incredible|unbelievable|mind[- ]?blowing|best ever|amazing|epic|legendary|crazy good|game[- ]?changer|unreal|jaw[- ]?dropping|ultimate)\b/i;
const CLOSING = "vault it or sell it back?";

function stripTags(s) { return String(s || "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim(); }
// "$61.5" -> "$61.50" (a dollar amount with one decimal reads wrong on screen and in TTS)
function fixMoney(s) { return String(s || "").replace(/\$(\d[\d,]*)\.(\d)(?!\d)/g, "$$$1.$20"); }
function cleanText(s) { return fixMoney(stripDashes(s)); }
function stripDashes(s) { return String(s || "").replace(/\s*[‒–—―]\s*/g, ". ").replace(/\.\s*\./g, ".").trim(); }

function textIssues(text, allowed, { allowWordNumbers = true } = {}) {
  const issues = [];
  if (DASH_RE.test(text)) issues.push("contains an em or en dash");
  if (HOLLOW_RE.test(stripTags(text))) issues.push(`hollow superlative: "${stripTags(text).match(HOLLOW_RE)[0]}"`);
  for (const n of numbersIn(text)) {
    if (n.startsWith("word:")) { if (!allowWordNumbers) issues.push(`spelled-out number "${n.slice(5)}"`); continue; }
    if (!allowed.has(n)) issues.push(`number ${n} is not in the analysis`);
  }
  return issues;
}

// Validates script.json against the timeline. Returns [] when it is fine.
function validateScript(script, { edit, analysis, toolName = "", wordsPerSec = 2.6 }) {
  const errs = [];
  const segs = (script && Array.isArray(script.segments)) ? script.segments : [];
  if (!segs.length) return ["no segments"];
  const m = edit.markers;
  const allowed = allowedNumbers(analysis);
  for (let i = 1; i < segs.length; i++) if (!(segs[i].start > segs[i - 1].start)) errs.push(`segment ${i + 1} does not start after segment ${i}`);
  if (!(segs[0].start <= 0.2)) errs.push("first segment (the hook) must start at 0");
  const hookWords = stripTags(segs[0].text).split(/\s+/).filter(Boolean).length;
  if (hookWords > 6) errs.push(`hook has ${hookWords} words, max 6 so it lands within 1.5 s`);
  const silentFrom = m.t_reveal - 0.5, reactFrom = m.t_reveal + 0.3, reactTo = m.t_reveal + 0.5;
  segs.forEach((s, i) => {
    const t = Number(s.start);
    if (!Number.isFinite(t) || t < 0 || t >= m.t_end) errs.push(`segment ${i + 1} start ${s.start} is outside the video`);
    if (t > silentFrom && t < reactFrom) errs.push(`segment ${i + 1} starts at ${t}, inside the silence window ${r2(silentFrom)} to ${r2(reactFrom)}`);
    for (const e of textIssues(s.text, allowed)) errs.push(`segment ${i + 1}: ${e}`);
    if (CTA_RE.test(stripTags(s.text))) errs.push(`segment ${i + 1}: buy call to action is not allowed in the voice over`);
    if (!stripTags(s.text)) errs.push(`segment ${i + 1} is empty`);
  });
  // pre-reveal segments must fit before the silence window
  segs.forEach((s, i) => {
    if (s.start >= silentFrom) return;
    const next = segs[i + 1];
    const end = Math.min(next ? next.start : m.t_end, silentFrom);
    const words = stripTags(s.text).split(/\s+/).filter(Boolean).length;
    const max = Math.max(1, Math.floor((end - s.start) * wordsPerSec));
    if (words > max) errs.push(`segment ${i + 1} has ${words} words but only room for about ${max}`);
  });
  if (!segs.some(s => s.start >= reactFrom - 0.01 && s.start <= reactTo + 0.01)) errs.push(`no reaction line starting between ${r2(reactFrom)} and ${r2(reactTo)} s`);
  if (toolName) {
    const tl = toolName.toLowerCase();
    if (!segs.some(s => Math.abs(s.start - m.t_cut) <= 0.8 && stripTags(s.text).toLowerCase().includes(tl))) errs.push(`no line naming ${toolName} at the cut (${m.t_cut} s)`);
  }
  const o = outcome(analysis);
  if (analysis && analysis.market_value != null && !segs.some(s => s.start >= m.t_cut - 0.2 && numbersIn(s.text).some(n => allowed.has(n)))) errs.push("no line saying the market value after the cut");
  if (o.kind === "unknown" && segs.some(s => /\b(profit|lost|loss|up \$|down \$)\b/i.test(stripTags(s.text)))) errs.push("win or loss is unknown, do not claim one");
  const last = stripTags(segs[segs.length - 1].text).toLowerCase();
  if (!last.endsWith(CLOSING)) errs.push(`last line must end with "${CLOSING}"`);
  return errs;
}

// ── Captions (ASS) ───────────────────────────────────────────────────────
function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
  return `${h}:${String(mi).padStart(2, "0")}:${se.toFixed(2).padStart(5, "0")}`;
}
function assEscape(s) { return String(s).replace(/\\/g, "").replace(/[{}]/g, "").replace(/\n/g, " "); }

// Drops v3 audio tags ([excited], [laughs softly]) from timed words.
function dropTagWords(words) {
  const out = []; let inTag = false;
  for (const w of words || []) {
    let t = String(w.text);
    if (inTag) { const j = t.indexOf("]"); if (j < 0) continue; inTag = false; t = t.slice(j + 1); }
    t = t.replace(/\[[^\]]*\]/g, "");
    const k = t.indexOf("["); if (k >= 0) { inTag = true; t = t.slice(0, k); }
    t = t.trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) out.push({ ...w, text: t });
  }
  return out;
}

function chunkWords(words, max = 3) {
  const out = []; let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= max || /[.!?,]$/.test(w.text)) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

// Word-by-word captions, max 3 words per card, lower third; from `raiseAt`
// (the zoom) the captions move up (from 24% to 33% off the bottom, on a plate)
// so they stay under the centred value and never reach the card title on top.
function buildCaptionsAss({ words, raiseAt = Infinity, width = 1080, height = 1920, font = "Montserrat ExtraBold", highlight = "&H00E6FF&" }) {
  const fsz = Math.round(width * 0.074);
  const outline = Math.max(3, Math.round(width * 0.006));
  // boxed = BorderStyle 3: a translucent plate behind the words, used while the
  // captions sit on top of the zoomed market screen (busy text underneath).
  const style = (name, align, marginV, boxed = false) => `Style: ${name},${font},${fsz},&H00FFFFFF,&H00FFFFFF,${boxed ? "&H40000000" : "&H00000000"},&H64000000,-1,0,0,0,100,100,0,0,${boxed ? 3 : 1},${boxed ? Math.round(outline * 3) : outline},${boxed ? 0 : Math.round(outline / 2)},${align},${Math.round(width * 0.08)},${Math.round(width * 0.08)},${marginV},1`;
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style("Low", 2, Math.round(height * 0.24)),   // lower third
    style("High", 2, Math.round(height * 0.33), true),  // raised during the zoom: the zoom centres the value, so just under the centre stays clear of it and of the title above
    "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const clean = dropTagWords(words);
  const chunks = chunkWords(clean, 3);
  chunks.forEach((chunk, ci) => {
    const next = chunks[ci + 1];
    const chunkEnd = next ? Math.min(next[0].start, chunk[chunk.length - 1].end + 0.5) : chunk[chunk.length - 1].end + 0.4;
    chunk.forEach((w, wi) => {
      const start = w.start;
      const end = wi < chunk.length - 1 ? chunk[wi + 1].start : chunkEnd;
      if (!(end > start)) return;
      const text = chunk.map((x, xi) => {
        const t = assEscape(x.text).toUpperCase();
        return xi === wi ? `{\\c${highlight}}${t}{\\c&H00FFFFFF&}` : t;
      }).join(" ");
      const st = start >= raiseAt - 0.05 ? "High" : "Low";
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},${st},,0,0,0,,${text}`);
    });
  });
  return lines.join("\n") + "\n";
}

// Words from an ElevenLabs alignment, shifted to `offset` seconds.
function wordsFromAlignment(al, offset = 0, tempo = 1) {
  const chars = (al && al.characters) || [];
  const st = (al && al.character_start_times_seconds) || [];
  const en = (al && al.character_end_times_seconds) || [];
  const words = []; let cur = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { text: "", start: offset + (Number(st[i]) || 0) / tempo, end: offset + (Number(en[i]) || 0) / tempo };
    cur.text += c;
    cur.end = offset + (Number(en[i]) || 0) / tempo;
  }
  if (cur) words.push(cur);
  return words.map(w => ({ ...w, start: r2(w.start), end: r2(w.end) }));
}

// ── Post text ────────────────────────────────────────────────────────────
function cleanHashtags(list, n = 5) {
  const seen = new Set(); const out = [];
  for (const raw of list || []) {
    const t = "#" + String(raw).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (t.length < 3 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
    if (out.length === n) break;
  }
  return out;
}

function buildPostTxt({ captionLine, lines = [], hashtags = [] }) {
  const tags = cleanHashtags(hashtags, 5);
  if (tags.length !== 5) throw new Error(`need exactly 5 hashtags, got ${tags.length}`);
  const body = [cleanText(captionLine).trim(), ...lines.map(l => String(l).trim()).filter(Boolean)];
  return body.join("\n") + "\n\n" + tags.join(" ");
}

// X counts most characters as 1 and CJK/emoji as 2; a URL is always 23.
function weightedLength(text) {
  let n = 0;
  const rest = String(text || "").replace(/https?:\/\/\S+/g, () => { n += 23; return ""; });
  for (const ch of rest) {
    const c = ch.codePointAt(0);
    n += (c <= 0x10FF || (c >= 0x2000 && c <= 0x200D) || (c >= 0x2010 && c <= 0x201F) || (c >= 0x2032 && c <= 0x2037)) ? 1 : 2;
  }
  return n;
}

// X caption ≤ limit: hashtags go first (last one first), then the caption
// line loses whole words from its end ("…"). Fixed lines (disclosure) stay.
function trimForX(post, limit = 280, measure = weightedLength) {
  const parts = String(post).split(/\n\n/);
  let tagLine = parts.length > 1 && /^(#\S+\s*)+$/.test(parts[parts.length - 1].trim()) ? parts.pop().trim() : "";
  const bodyLines = parts.join("\n\n").split("\n");
  let tags = tagLine ? tagLine.split(/\s+/) : [];
  const build = (first) => [first, ...bodyLines.slice(1)].join("\n") + (tags.length ? "\n\n" + tags.join(" ") : "");
  let first = bodyLines[0] || "";
  let out = build(first);
  while (measure(out) > limit && tags.length) { tags.pop(); out = build(first); }
  if (measure(out) <= limit) return out;
  const words = first.split(/\s+/);
  while (words.length > 1 && measure(build(words.join(" ") + "…")) > limit) words.pop();
  out = build(words.join(" ") + "…");
  if (measure(out) <= limit) return out;
  // last resort: whole text word by word
  const all = out.split(/ /);
  while (all.length > 1 && measure(all.join(" ") + "…") > limit) all.pop();
  return all.join(" ") + "…";
}

// ── Revisions ────────────────────────────────────────────────────────────
const CHIPS = {
  shorter: { steps: ["edit"], plan: (p) => ({ max_duration: Math.max(20, (p.max_duration || 30) - 5), min_duration: 20 }) },
  calmer: { steps: ["script"], plan: () => ({ tone: "calm" }) },
  more_excited: { steps: ["script"], plan: () => ({ tone: "excited" }) },
  new_hook: { steps: ["script"], plan: () => ({ hook_instruction: "Write a different hook than the previous version." }) },
  different_voice_take: { steps: ["voice"], plan: (p) => ({ voice_seed: (p.voice_seed || 1) + 1 }) },
  longer_value_zoom: { steps: ["edit"], plan: (p) => ({ value_hold: Math.min(5, (p.value_hold || 2) + 1.5) }) },
  caption_only: { steps: ["post"], plan: () => ({}) },
};

// Downstream closure: a step reruns everything after it that depends on it.
const DOWNSTREAM = {
  edit: ["edit", "script", "voice", "mix", "captions", "final", "post"],
  script: ["script", "voice", "mix", "captions", "final", "post"],
  voice: ["voice", "mix", "captions", "final"],
  mix: ["mix", "final"],
  captions: ["captions", "final"],
  final: ["final"],
  post: ["post"],
};
function closeSteps(steps) {
  const set = new Set();
  for (const s of steps || []) for (const d of DOWNSTREAM[s] || []) set.add(d);
  return STEPS.filter(s => set.has(s));
}

function applyChips(plan, chips) {
  let next = { ...plan }; const steps = [];
  for (const c of chips || []) {
    const def = CHIPS[c]; if (!def) continue;
    next = { ...next, ...def.plan(next) };
    steps.push(...def.steps);
  }
  return { plan: next, steps };
}

// ── Status machine ───────────────────────────────────────────────────────
const TRANSITIONS = {
  uploaded: ["processing", "failed"],
  processing: ["ready_for_review", "failed"],
  ready_for_review: ["revising", "approved"],
  revising: ["ready_for_review", "failed"],
  approved: ["publishing", "revising", "ready_for_review"],
  publishing: ["published", "approved", "failed"],
  published: ["revising", "publishing"],
  failed: ["processing", "revising", "publishing", "uploaded"],
};
function canMove(from, to) { return (TRANSITIONS[from] || []).includes(to); }

// ── Log redaction ────────────────────────────────────────────────────────
function makeRedactor(env = process.env) {
  const secrets = Object.entries(env)
    .filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|PASS\b|AUTH/i.test(k) && v && String(v).length >= 8)
    .map(([, v]) => String(v)).sort((a, b) => b.length - a.length);
  return (s) => {
    let out = String(s);
    for (const v of secrets) out = out.split(v).join("***");
    return out
      .replace(/sk-ant-[\w-]+/g, "sk-ant-***")
      .replace(/\bEAA[A-Za-z0-9]{20,}/g, "EAA***")
      .replace(/(access_token|token|key|secret|signature)=([^&\s"]+)/gi, "$1=***")
      .replace(/(Bearer|OAuth)\s+[^\s",]+/g, "$1 ***");
  };
}

// Masks a token for dry-run output: first 4 + last 4.
function mask(v) { const s = String(v || ""); return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : (s ? "***" : ""); }

module.exports = {
  STEPS, STATUSES, DEFAULT_PLAN, CHIPS, CLOSING,
  planEdit, zoomAt, outcome, allowedNumbers, numbersIn, stripTags, stripDashes, fixMoney, cleanText, textIssues,
  validateScript, buildCaptionsAss, wordsFromAlignment, dropTagWords, chunkWords, assTime,
  cleanHashtags, buildPostTxt, trimForX, weightedLength,
  closeSteps, applyChips, canMove, makeRedactor, mask, num, r2,
};
