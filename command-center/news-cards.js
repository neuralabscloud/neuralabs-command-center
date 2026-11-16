// gh0stlayer news cards: pure helpers (scoring, mix, validator, prompt) + HTML builder + Playwright renderer.
// Wiring (sources, images, gallery, publish, scheduler) lives in api-server.js. No network here except via injected fns.
const fs = require("fs");
const path = require("path");
const xPairs = require("./x-pairs");

const ROOT = __dirname;
const TPL_DIR = path.join(ROOT, "templates", "cards");
const FONTS_DIR = path.join(ROOT, "assets", "fonts");
const SIZE = { width: 1080, height: 1350 };

const LAYOUTS = ["signal", "number", "versus", "persona"];
const PILLS = ["signal", "on-chain", "macro", "defi", "ai", "then vs now", "trader's take", "did you know"];
const WEEKLY_MIX = { signal: 3, number: 2, versus: 1, persona: 1 };
const IMAGE_RULES = "Cinematic, realistic, dark, purple-tinted light. No people, no faces, no readable text, no numbers, no logos, no brand marks.";
const TICKERS = ["BTC", "ETH", "SOL", "XRP", "BNB", "USDT", "USDC", "DOGE", "ADA", "AVAX", "LINK", "DOT", "TRX", "TON", "HYPE", "SUI", "LTC", "ARB", "OP", "UNI", "AAVE", "MKR", "DAI"];
const CAPS_EXTRA = ["ETF", "ETFs", "TVL", "US", "EU", "UK", "SEC", "CFTC", "FOMC", "CPI", "ATH", "CME", "OI", "L2", "DEX", "CEX", "MEV", "RWA", "VS", ...TICKERS];
const SUPERLATIVES = [/\binsane(ly)?\b/i, /\bgame[\s-]?changers?\b/i, /\bthe best ever\b/i, /\byou won'?t believe\b/i, /\bmind[\s-]?blowing\b/i, /\bshocking\b/i];
const BAIT = [/\blike\s*(and|&|\+|n)\s*(rt|retweet|repost)\b/i, /\bfollow (me )?for more\b/i, /\bcomment\s+["'“]?yes\b/i, /\btag a friend\b/i, /\bsmash (that|the) like\b/i];
const PREDICTION = [/\bwill\b/i, /\bprice target\b/i, /\bto the moon\b/i, /\b(buy|sell|long|short) (now|here)\b/i, /\bentry\b/i, /\bnot financial advice\b/i];

// ---------- text helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function stripMarks(s) { return String(s || "").replace(/\[\/?[ap]\]/g, ""); }
// Escape everything first, then turn [a]..[/a] / [p]..[/p] into spans.
function highlight(s) {
  return esc(s).replace(/\[a\]([\s\S]*?)\[\/a\]/g, '<span class="hl-a">$1</span>').replace(/\[p\]([\s\S]*?)\[\/p\]/g, '<span class="hl-p">$1</span>').replace(/\[\/?[ap]\]/g, "");
}
function numbersIn(text) {
  return (stripMarks(text).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(m => Number(m.replace(/,/g, ""))).filter(Number.isFinite);
}
function numberVariants(facts) {
  const set = new Set();
  const add = v => {
    for (const x of [v, Math.round(v), Math.round(v * 10) / 10, Math.round(v * 100) / 100, Math.floor(v), Math.ceil(v)]) set.add(String(x));
    for (const d of [1e3, 1e6, 1e9, 1e12]) if (Math.abs(v) >= d) for (const x of [Math.round(v / d), Math.round(v / d * 10) / 10, Math.round(v / d * 100) / 100]) set.add(String(x));
  };
  const walk = v => {
    if (v == null) return;
    if (typeof v === "number") return Number.isFinite(v) && add(v);
    if (typeof v === "string") return numbersIn(v).forEach(add);
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts);
  return set;
}

// ---------- scoring ----------
const RELEVANT = /\b(liquidity|liquidation|funding|open interest|leverage|order ?book|spread|volume|structure|supply|issuance|halving|hashrate|difficulty|miners?|fees?|stablecoins?|tvl|treasury|reserves?|etf|regulat\w*|sec|cftc|mica|law|bill|court|infra\w*|upgrade|fork|validator|staking|exchange|outflows?|inflows?|custody|ai|agents?|onchain|on-chain|defi|lending|yield|rate|fed|inflation|cpi|dominance|market cap|unlock|hack|exploit)\b/i;
const REJECT = /\b(memecoins?|meme ?coins?|celebrity|kardashian|airdrop farming|presale|token launch|launches (its|a) token|price prediction|price targets?|could (hit|reach|fall|drop|rally|surge)|risks? (falling|dropping|a drop)|eyes \$|predicts?|forecasts?|to the moon|100x|nft drop|giveaway)\b/i;

function scoreItem(item, now = Date.now()) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  const comp = { freshness: 0, hard_fact: 0, relevance: 0, fit: 0 };
  if (item.kind === "evergreen") comp.freshness = 40;
  else if (item.kind === "metric") comp.freshness = 35;
  else {
    const age = (now - Date.parse(item.published_at || 0)) / 3600e3;
    comp.freshness = !Number.isFinite(age) || age > 24 || age < -1 ? 0 : Math.round(age <= 6 ? 40 : 40 - (age - 6) * (30 / 18));
  }
  const hasFact = (item.numbers || []).length > 0 || /\b(19|20)\d{2}\b/.test(text);
  if (!hasFact) return { ...comp, total: 0, reject: "geen hard feit" };
  comp.hard_fact = 30;
  if (REJECT.test(text)) return { ...comp, total: 0, reject: "niet trader-relevant (gossip/memecoin/launch/predictie)" };
  comp.relevance = RELEVANT.test(text) || item.kind !== "news" ? 20 : 5;
  const firstNum = (item.numbers || [])[0];
  comp.fit = firstNum != null && String(item.title || "").length <= 110 ? 10 : 4;
  const total = comp.freshness + comp.hard_fact + comp.relevance + comp.fit;
  return { ...comp, total, reject: item.kind === "news" && comp.freshness === 0 ? "nieuws ouder dan 24 u" : null };
}

function dedupKey(item) {
  const ent = String((item.entities || [])[0] || item.source || "").toLowerCase().trim();
  const n = (item.numbers || [])[0];
  const fact = n == null ? String(item.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60) : String(typeof n === "object" ? n.value : n);
  return `${ent}|${fact}`;
}
function isDuplicate(item, history, now = Date.now(), days = 30) {
  const key = dedupKey(item);
  return (history || []).some(h => h.dedup_key === key && now - Date.parse(h.created_at || 0) < days * 86400e3);
}

function compatibleLayouts(item) {
  if (Array.isArray(item.layouts) && item.layouts.length) return item.layouts.filter(l => LAYOUTS.includes(l));
  if (item.versus) return ["versus", "number"];
  if (item.kind === "metric") return item.series ? ["number", "signal"] : ["number", "signal"];
  return ["signal", "persona"];
}

// Weekly mix: prefer the layout with the largest deficit vs WEEKLY_MIX over the last 7 days.
function layoutDeficits(history, now = Date.now()) {
  const counts = Object.fromEntries(LAYOUTS.map(l => [l, 0]));
  for (const h of history || []) if (now - Date.parse(h.created_at || 0) < 7 * 86400e3 && counts[h.layout] != null) counts[h.layout]++;
  // Proportional to WEEKLY_MIX (3/2/1/1), so the mix holds at any number of sets per day.
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const mixSum = Object.values(WEEKLY_MIX).reduce((a, b) => a + b, 0);
  return Object.fromEntries(LAYOUTS.map(l => [l, Math.round((WEEKLY_MIX[l] / mixSum * (total + 1) - counts[l]) * 1000) / 1000]));
}

// Plan the day: for each slot pick the most-needed layout, then the best fresh non-duplicate item that fits it.
function planDay(candidates, history, { count = 1, weights = {}, rand = Math.random, now = Date.now(), minScore = 50 } = {}) {
  const scored = candidates.map(item => ({ item, score: scoreItem(item, now) }))
    .filter(c => !c.score.reject && c.score.total >= minScore && !isDuplicate(c.item, history, now))
    .sort((a, b) => b.score.total - a.score.total);
  const used = new Set();
  const plan = [];
  const hist = [...(history || [])];
  for (let i = 0; i < count; i++) {
    const def = layoutDeficits(hist, now);
    const ordered = [...LAYOUTS].sort((a, b) => def[b] - def[a]);
    const top = ordered.filter(l => def[l] === def[ordered[0]]);
    const first = xPairs.weightedPick(top, weights.layout || {}, rand);
    let pick = null;
    for (const layout of [first, ...ordered.filter(l => l !== first)]) {
      const c = scored.find(c => !used.has(c) && compatibleLayouts(c.item).includes(layout));
      if (c) { pick = { ...c, layout }; break; }
    }
    if (!pick) break;
    used.add(scored.find(c => c.item === pick.item));
    plan.push(pick);
    hist.push({ layout: pick.layout, created_at: new Date(now).toISOString() });
  }
  return plan;
}

// ---------- LLM prompt + validator ----------
function systemPrompt() {
  return [
    "You write one news card set for gh0stlayer, a crypto trading brand for traders. Output strict JSON only, no prose, no code fences.",
    "Schema: {\"layout\":\"signal|number|versus|persona\",\"pill\":\"" + PILLS.join("|") + "\",\"headline\":\"...\",\"hint\":\"...\",\"number\":null,\"unit\":null,\"series\":null,\"versus\":null,\"context_line\":null,\"image_brief\":\"...\",\"payload\":{\"title\":\"...\",\"items\":[{\"title\":\"...\",\"body\":\"...\"},{...},{...}]},\"closer\":{\"line\":\"...\",\"question\":\"...\"},\"caption\":\"...\",\"x_hook\":\"...\",\"x_reply\":\"...\",\"source\":{\"name\":\"...\",\"url\":\"...\",\"date\":\"YYYY-MM-DD\"}}",
    "number layout: number (string, e.g. \"3.125\") and unit (e.g. \"BTC per block\"); series only if given in the item. versus layout: versus = {left:{label,value,unit},right:{label,value,unit}}.",
    "Rules: English. Headline max 70 characters, sentence case, max 4 lines. Mark the payoff or number with [a]...[/a] and the subject with [p]...[/p], at most one of each.",
    "Exactly one number or named fact in the headline, and it must reappear in the payload items. Use only facts and numbers from the item; never invent numbers.",
    "Persona layout only: first-person past tense hook (I did, I stopped, I lost). Other layouts never start with I.",
    "Never a price prediction, never the word will, never signals, entries or targets. No em or en dashes. No ALL CAPS except tickers and acronyms like BTC, ETH, ETF, TVL.",
    "No hollow superlatives (insane, game changer, you won't believe), no engagement bait.",
    "payload: title (short, may use one [a]) and exactly 3 items, each a short title plus one explaining sentence. closer: one line plus one question that invites comments.",
    "caption: all lowercase, exactly 3 lines: hook line, one question, four hashtags. No NeuraLabs mention, no links except the words link in bio.",
    "x_hook: max 240 characters, no hashtags, no links. x_reply: the payload in text form, max 270 characters, ends with the source name.",
    "image_brief: one sentence describing a cinematic object or scene shot (no people, no text, no logos).",
  ].join("\n");
}
function userPrompt(item, layout, pill, feedback) {
  const facts = { source: item.source, url: item.url, title: item.title, summary: String(item.summary || "").slice(0, 1800), published_at: item.published_at, numbers: item.numbers, entities: item.entities, series: item.series || null, versus: item.versus || null };
  return [`Layout: ${layout}. Pill: ${pill || "choose the best fit"}.`, "Item:", JSON.stringify(facts), feedback ? `Your previous attempt was rejected: ${feedback}. Fix exactly that.` : ""].filter(Boolean).join("\n");
}
function parseJson(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("geen JSON in LLM-antwoord");
  return JSON.parse(s.slice(a, b + 1));
}

function textFields(card) {
  const p = card.payload || {};
  return [card.headline, card.hint, card.context_line, p.title, ...(p.items || []).flatMap(i => [i.title, i.body]), card.closer?.line, card.closer?.question, card.caption, card.x_hook, card.x_reply, card.versus?.left?.label, card.versus?.right?.label, card.unit].filter(v => typeof v === "string");
}

function validateCard(card, item = {}) {
  const errors = [];
  if (!card || typeof card !== "object") return { ok: false, errors: ["geen object"] };
  if (!LAYOUTS.includes(card.layout)) errors.push(`onbekende layout ${card.layout}`);
  if (!PILLS.includes(String(card.pill || "").toLowerCase())) errors.push(`onbekende pill ${card.pill}`);
  const all = textFields(card).join("\n");
  if (/[–—]/.test(all)) errors.push("em/en dash");
  const caps = xPairs.capsViolations(stripMarks(all.replace(/link in bio/gi, "")), [...CAPS_EXTRA, ...(item.entities || []).filter(e => /^[A-Z0-9]{2,6}$/.test(e))]);
  if (caps.length) errors.push(`ALL CAPS: ${caps.slice(0, 5).join(", ")}`);
  if (SUPERLATIVES.some(r => r.test(all))) errors.push("holle superlatief");
  if (BAIT.some(r => r.test(all))) errors.push("engagement bait");
  if (PREDICTION.some(r => r.test(all))) errors.push("predictie/will/signal-taal");
  const head = String(card.headline || "");
  const plain = stripMarks(head);
  if (!plain.trim()) errors.push("geen headline");
  if (plain.length > 70) errors.push(`headline ${plain.length} > 70 tekens`);
  if ((head.match(/\[a\]/g) || []).length > 1) errors.push("meer dan een [a]");
  if ((head.match(/\[p\]/g) || []).length > 1) errors.push("meer dan een [p]");
  const items = card.payload?.items;
  if (!Array.isArray(items) || items.length !== 3 || items.some(i => !i?.title || !i?.body)) errors.push("payload moet 3 items met title+body hebben");
  const known = numberVariants([(items || []).map(i => `${i?.title} ${i?.body}`), card.payload?.title, item.numbers, item.title, item.summary, card.source]);
  const missing = numbersIn(head).filter(n => !known.has(String(n)));
  if (missing.length) errors.push(`getal in headline niet in payload/bron: ${missing.join(", ")}`);
  const ungrounded = numbersIn([(items || []).map(i => `${i?.title} ${i?.body}`).join(" "), card.number].join(" ")).filter(n => n >= 13 && !(n >= 1990 && n <= 2035) && !numberVariants([item.numbers, item.title, item.summary, item.series, item.versus]).has(String(n)));
  if (ungrounded.length) errors.push(`verzonnen getal(len): ${ungrounded.slice(0, 4).join(", ")}`);
  if (card.layout === "number" && (!card.number || !card.unit)) errors.push("number layout zonder number/unit");
  if (card.layout === "versus" && !(card.versus?.left?.value && card.versus?.right?.value && card.versus?.left?.label && card.versus?.right?.label)) errors.push("versus layout zonder beide kanten");
  const firstPerson = /^\s*I\b/.test(plain);
  if (card.layout === "persona" && !firstPerson) errors.push("persona hook moet eerste persoon verleden tijd zijn");
  if (card.layout !== "persona" && firstPerson) errors.push("eerste persoon alleen in persona");
  const cap = String(card.caption || "");
  const capLines = cap.split("\n").map(l => l.trim()).filter(Boolean);
  if (capLines.length !== 3) errors.push(`caption moet 3 regels hebben (${capLines.length})`);
  if (/[A-Z]/.test(cap.replace(new RegExp(`\\b(${[...TICKERS, "ETF", "TVL", "AI", "DeFi"].join("|")})\\b`, "g"), ""))) errors.push("caption niet lowercase");
  if ((cap.match(/#[\p{L}\p{N}_]+/gu) || []).length !== 4) errors.push("caption moet 4 hashtags hebben");
  if (/neura\s*labs/i.test(all)) errors.push("NeuraLabs-vermelding");
  const srcName = String(card.source?.name || item.source || "");
  const linkText = [cap, card.x_hook || "", card.x_reply || ""].join("\n").split(srcName || "\u0000").join(" ");
  if (xPairs.links(linkText).length) errors.push("link in tekst");
  if (!card.x_hook || xPairs.weightedLength(card.x_hook) > 270) errors.push("x_hook ontbreekt of te lang");
  if (!card.x_reply || xPairs.weightedLength(card.x_reply) > 280) errors.push("x_reply ontbreekt of te lang");
  if (["signal", "versus"].includes(card.layout) && !card.image_brief) errors.push("image_brief ontbreekt");
  return { ok: errors.length === 0, errors };
}

// llm(system, user) -> text. Max 2 regenerations, then give up with the reasons.
async function generateCard({ llm, item, layout, pill, maxAttempts = 3, log = () => {} }) {
  let feedback = null;
  const attempts = [];
  for (let i = 0; i < maxAttempts; i++) {
    let card, v;
    try {
      card = parseJson(await llm(systemPrompt(), userPrompt(item, layout, pill, feedback)));
      card.layout = layout;
      card.pill = String(card.pill || pill || "signal").toLowerCase();
      if (!card.source?.url) card.source = { name: item.source, url: item.url, date: String(item.published_at || "").slice(0, 10) };
      v = validateCard(card, item);
    } catch (e) { v = { ok: false, errors: [`parse: ${e.message}`] }; }
    attempts.push({ attempt: i + 1, errors: v.errors });
    if (v.ok) return { ok: true, card, attempts };
    feedback = v.errors.join("; ");
    log(`news-cards: poging ${i + 1} afgewezen: ${feedback}`);
  }
  return { ok: false, card: null, attempts, reason: feedback };
}

// ---------- chart + slides ----------
function chartSvg(series, w = 912, h = 260) {
  const pts = (series || []).map(p => Array.isArray(p) ? { label: p[0], value: Number(p[1]) } : { label: p.label, value: Number(p.value) }).filter(p => Number.isFinite(p.value));
  if (pts.length < 2) return "";
  const pad = { l: 10, r: 10, t: 20, b: 44 };
  const min = Math.min(...pts.map(p => p.value)), max = Math.max(...pts.map(p => p.value));
  const span = max - min || 1;
  const x = i => pad.l + i * (w - pad.l - pad.r) / (pts.length - 1);
  const y = v => pad.t + (1 - (v - min) / span) * (h - pad.t - pad.b);
  let d = `M${x(0).toFixed(1)},${y(pts[0].value).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(i).toFixed(1)} V${y(pts[i].value).toFixed(1)}`;
  const fill = `${d} V${h - pad.b} H${x(0).toFixed(1)} Z`;
  const every = Math.ceil(pts.length / 6);
  const labels = pts.map((p, i) => (i % every === 0 || i === pts.length - 1)
    ? `<text x="${x(i).toFixed(1)}" y="${h - 12}" text-anchor="${i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}" fill="${/^\d{4}$/.test(String(p.label)) ? "hsl(215 20% 45%)" : "hsl(215 20% 65%)"}" font-family="Inter" font-weight="500" font-size="22">${esc(p.label)}</text>` : "").join("");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="cf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(264 65% 58%)" stop-opacity=".35"/><stop offset="1" stop-color="hsl(264 65% 58%)" stop-opacity="0"/></linearGradient></defs><path d="${fill}" fill="url(#cf)"/><path d="${d}" fill="none" stroke="hsl(264 65% 70%)" stroke-width="5" stroke-linejoin="round"/>${labels}</svg>`;
}

function fill(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] == null ? "" : String(vars[k])); }
function tpl(name) { return fs.readFileSync(path.join(TPL_DIR, `${name}.html`), "utf8"); }
function topHtml(pill, i, n) { return `<div class="top"><span class="pill">${esc(pill)}</span><span class="counter">0${i + 1} / 0${n}</span></div>`; }
function footHtml(i, n) { return `<div class="foot"><span class="mark">gh0stlayer</span><div class="dots">${Array.from({ length: n }, (_, k) => `<i${k === i ? ' class="on"' : ""}></i>`).join("")}</div></div>`; }
function safeImg(u) { const s = String(u || ""); return /^(data:image\/(png|jpeg|webp);base64,|https:\/\/|file:\/\/)/.test(s) ? s.replace(/['"()\\\s]/g, encodeURIComponent) : ""; }

// images: { hook, left, right } as data: URIs (local files, no network during render).
function buildSlides(card, images = {}) {
  const n = card.closer?.line && card.closer?.question ? 3 : 2;
  const pill = card.pill || "signal";
  const L = card.layout;
  const base = i => ({ top: topHtml(pill, i, n), foot: footHtml(i, n) });
  let hook;
  if (L === "signal") hook = fill(tpl("signal"), { ...base(0), image: safeImg(images.hook), headline: highlight(card.headline), hint: esc(card.hint || "swipe for the breakdown") });
  else if (L === "persona") hook = fill(tpl("persona"), { ...base(0), image: safeImg(images.hook), headline: highlight(card.headline), hint: esc(card.hint || card.context_line || "swipe for the breakdown") });
  else if (L === "number") {
    const svg = chartSvg(card.series);
    hook = fill(tpl("number"), { ...base(0), number: esc(card.number), unit: esc(card.unit), chart_h: svg ? 260 : 0, chart_svg: svg, headline: highlight(card.headline), context_line: esc(card.context_line || card.hint || "") });
  } else if (L === "versus") {
    const v = card.versus || {};
    const side = s => `${esc(s?.value)}${s?.unit ? ` <span style="font:700 26px/1 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">${esc(s.unit)}</span>` : ""}`;
    hook = fill(tpl("versus"), { ...base(0), left_image: safeImg(images.left), right_image: safeImg(images.right), left_label: esc(v.left?.label), right_label: esc(v.right?.label), left_value: side(v.left), right_value: side(v.right), headline: highlight(card.headline), context_line: esc(card.context_line || card.hint || "") });
  } else throw new Error(`onbekende layout ${L}`);
  const p = card.payload || {};
  const items = (p.items || []).map((it, k) => `<li><b class="n">0${k + 1}</b><div><h3>${esc(stripMarks(it.title))}</h3><p>${esc(stripMarks(it.body))}</p></div></li>`).join("");
  const src = card.source ? `Source: ${esc(card.source.name || "")}${card.source.date ? `, ${esc(card.source.date)}` : ""}` : "";
  const slides = [
    { layout: L, html: hook },
    { layout: "payload", html: fill(tpl("payload"), { top: topHtml("the breakdown", 1, n), foot: footHtml(1, n), title: highlight(p.title), items, source: src }) },
  ];
  if (n === 3) slides.push({ layout: "closer", html: fill(tpl("closer"), { top: topHtml(pill, 2, n), foot: footHtml(2, n), line: highlight(card.closer.line), question: esc(card.closer.question) }) });
  return slides;
}

// ---------- page + render ----------
let _fontCss = null;
function fontCss() {
  if (_fontCss != null) return _fontCss;
  const face = (family, file, extra) => {
    const f = path.join(FONTS_DIR, file);
    return fs.existsSync(f) ? `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${fs.readFileSync(f).toString("base64")}) format('woff2');font-display:block;${extra}}` : "";
  };
  _fontCss = [face("Inter", "Inter-Medium.woff2", "font-weight:500"), face("Inter", "Inter-Bold.woff2", "font-weight:600 700"),
    face("Akira", "Akira-Expanded.woff2", "font-weight:400"), face("ArchivoX", "Archivo-Variable.woff2", "font-weight:100 900;font-stretch:62% 125%")].join("\n");
  return _fontCss;
}
function fontStatus() {
  return { akira: fs.existsSync(path.join(FONTS_DIR, "Akira-Expanded.woff2")), archivo_fallback: fs.existsSync(path.join(FONTS_DIR, "Archivo-Variable.woff2")), inter: fs.existsSync(path.join(FONTS_DIR, "Inter-Bold.woff2")) };
}

const FIT_JS = `(async () => {
  await document.fonts.ready;
  for (const el of document.querySelectorAll('.fit')) {
    const max = +el.dataset.max || 80, min = +el.dataset.min || 30, lim = parseFloat(el.style.maxHeight) || 9999;
    el.style.maxHeight = 'none';
    let s = max; el.style.fontSize = s + 'px';
    while (s > min && (el.scrollHeight > lim || el.scrollWidth > el.clientWidth + 1)) { s -= 2; el.style.fontSize = s + 'px'; }
  }
  for (const el of document.querySelectorAll('.fit-num')) {
    let s = parseFloat(getComputedStyle(el).fontSize); const w = el.parentElement.clientWidth;
    while (s > 60 && el.scrollWidth > w) { s -= 6; el.style.fontSize = s + 'px'; }
  }
  for (const ol of document.querySelectorAll('.fit-list')) {
    const box = ol.parentElement, src = box.querySelector('.src');
    let s = 1, guard = 0;
    const over = () => src ? ol.getBoundingClientRect().bottom > src.getBoundingClientRect().top - 24 : box.scrollHeight > box.clientHeight;
    while (over() && guard++ < 20) { s -= 0.04; ol.style.zoom = s; }
  }
  window.__fit = true;
})();`;

const ITEM_CSS = `.items li{display:flex;gap:30px;align-items:flex-start}.items .n{flex:none;font:400 40px/1 var(--display);font-stretch:125%;color:var(--accent-glow);min-width:84px;padding-top:6px}.items h3{font:700 46px/1.2 var(--body);color:var(--fg)}.items p{font:500 35px/1.38 var(--body);color:var(--muted);margin-top:10px}`;

function pageHtml(slideHtml) {
  const css = fs.readFileSync(path.join(TPL_DIR, "base.css"), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss()}\n${css}\n${ITEM_CSS}</style></head><body>${slideHtml}<script>${FIT_JS}</script></body></html>`;
}

let _browser = null;
async function browser() {
  if (!_browser || !_browser.isConnected()) {
    const { chromium } = require("playwright");
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}
async function closeBrowser() { if (_browser) { try { await _browser.close(); } catch {} _browser = null; } }

async function renderSet(card, { setId, outDir, images = {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const slides = buildSlides(card, images);
  const b = await browser();
  const out = [];
  for (let i = 0; i < slides.length; i++) {
    const page = await b.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
    try {
      await page.route("**/*", r => (/^(data|about):/.test(r.request().url()) ? r.continue() : r.abort()));
      await page.setContent(pageHtml(slides[i].html), { waitUntil: "load" });
      await page.waitForFunction(() => window.__fit === true, null, { timeout: 15000 });
      const file = path.join(outDir, `set_${setId}_slide_${i + 1}.png`);
      await page.screenshot({ path: file, type: "png", fullPage: false });
      out.push({ slide: i + 1, layout: slides[i].layout, path: file });
    } finally { await page.close(); }
  }
  return out;
}

function dataUri(file) {
  if (!file || !fs.existsSync(file)) return "";
  const buf = fs.readFileSync(file);
  const mime = buf[0] === 0x89 ? "image/png" : buf[0] === 0xff ? "image/jpeg" : buf.slice(8, 12).toString() === "WEBP" ? "image/webp" : null;
  return mime ? `data:${mime};base64,${buf.toString("base64")}` : "";
}
function imagePrompt(brief) { return `${String(brief || "").replace(/[–—]/g, ",").trim().replace(/\.?$/, ".")} ${IMAGE_RULES}`; }

module.exports = {
  SIZE, LAYOUTS, PILLS, WEEKLY_MIX, IMAGE_RULES, CAPS_EXTRA,
  esc, stripMarks, highlight, numbersIn, numberVariants,
  scoreItem, dedupKey, isDuplicate, compatibleLayouts, layoutDeficits, planDay,
  systemPrompt, userPrompt, parseJson, validateCard, generateCard,
  chartSvg, buildSlides, pageHtml, fontStatus, renderSet, closeBrowser, dataUri, imagePrompt,
};
