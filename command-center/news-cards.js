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

// ---------- accounts ----------
// Every function takes an optional account (id, raw profile or normalised object). Default = gh0stlayer,
// whose profile reproduces the constants above exactly (checked in scripts/test-news-cards-accounts.js).
const accounts = require("./accounts");
const _acct = new Map();
function readOpt(file) { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
function account(a) {
  if (a && a.__acct) return a;
  const p = a && typeof a === "object" ? a : accounts.load(a || "gh0stlayer");
  const key = `${p.id}|${JSON.stringify(p)}`; // full content: a length key mixed up configs of equal length (3/2/1/1 vs 4/0/1/1)
  if (_acct.has(key)) return _acct.get(key);
  const sc = p.scoring || {}, v = p.voice || {}, ip = p.image_policy || {};
  const A = {
    __acct: true, id: p.id, name: p.name || p.id, label: p.label || `${p.name || p.id} news cards`, profile: p,
    pills: p.pills || PILLS, weeklyMix: p.weekly_mix || WEEKLY_MIX, layoutLabels: p.layout_labels || {},
    pillRules: p.pill_rules || {},
    relevant: new RegExp(sc.relevant || RELEVANT.source, "i"), reject: new RegExp(sc.reject || REJECT.source, "i"),
    rejectReason: sc.reject_reason || "niet relevant", maxAge: Number(sc.max_age_hours) || 24, minScore: Number(sc.min_score) || 50,
    trending: sc.trending || null, topicCooldownDays: Number(sc.topic_cooldown_days) || 0,
    voiceIntro: v.intro || "", voiceRules: v.rules || "", capsAllow: v.caps_allow || CAPS_EXTRA, captionCaps: v.caption_caps || [...TICKERS, "ETF", "TVL", "AI", "DeFi"],
    forbid: (v.forbid || []).map(f => ({ re: new RegExp(f.pattern, "i"), reason: f.reason || "verboden formulering" })),
    hashtags: Array.isArray(v.hashtags) && v.hashtags.length ? v.hashtags.map(h => String(h).toLowerCase()) : null,
    captionRequired: Array.isArray(v.caption_required) ? v.caption_required.map(x => String(x).toLowerCase()) : [],
    headlineAnchor: !!v.headline_anchor, gradeRe: v.grade_pattern ? new RegExp(v.grade_pattern, "g") : null,
    imageRules: ip.rules || IMAGE_RULES, imagePolicy: ip,
    themeCss: readOpt(path.join(TPL_DIR, "themes", `${p.theme || p.id}.css`)),
    brandHtml: readOpt(path.join(TPL_DIR, "brand", `${p.brand_mark || p.id}.html`)).trim() || `<span class="mark">${esc(p.name || p.id)}</span>`,
    tagline: p.payload_tagline || "", fallback: p.fallback_pattern || "none", chartColor: p.chart_color || null,
    fontAliases: p.font_aliases || [],
  };
  _acct.set(key, A);
  return A;
}
function layoutLabel(layout, A) { return (account(A).layoutLabels || {})[layout] || layout; }

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

function scoreItem(item, now = Date.now(), acct) {
  const A = account(acct);
  const text = `${item.title || ""} ${item.summary || ""}`;
  const comp = { freshness: 0, hard_fact: 0, relevance: 0, fit: 0 };
  // Per account override (scoring.kind_freshness), e.g. Slabhaus ranks same-run NC numbers above evergreen facts.
  const kf = (A.profile.scoring && A.profile.scoring.kind_freshness) || {};
  if (item.kind === "evergreen") comp.freshness = kf.evergreen != null ? Number(kf.evergreen) : 40;
  else if (item.kind === "metric") comp.freshness = kf.metric != null ? Number(kf.metric) : 35;
  else {
    const age = (now - Date.parse(item.published_at || 0)) / 3600e3;
    comp.freshness = !Number.isFinite(age) || age > A.maxAge || age < -1 ? 0 : Math.round(age <= 6 ? 40 : 40 - (age - 6) * (30 / (A.maxAge - 6)));
  }
  const hasFact = (item.numbers || []).length > 0 || /\b(19|20)\d{2}\b/.test(text);
  if (!hasFact) return { ...comp, total: 0, reject: "geen hard feit" };
  comp.hard_fact = 30;
  if (A.reject.test(text)) return { ...comp, total: 0, reject: A.rejectReason };
  comp.relevance = A.relevant.test(text) || item.kind !== "news" ? 20 : 5;
  const firstNum = (item.numbers || [])[0];
  comp.fit = firstNum != null && String(item.title || "").length <= 110 ? 10 : 4;
  // Trending (accounts with scoring.trending): outlets covering the same story + Reddit mentions, ranking only.
  if (A.trending && item.trend) {
    const t = A.trending, outlets = Number(item.trend.outlets) || 1, reddit = Number(item.trend.reddit) || 0;
    comp.trending = (outlets >= (t.outlets_min || 3) ? (t.outlets_bonus || 10) : 0) + Math.min(t.reddit_max || 8, reddit * (t.reddit_each || 4));
  }
  const total = comp.freshness + comp.hard_fact + comp.relevance + comp.fit + (comp.trending || 0);
  return { ...comp, total, reject: item.kind === "news" && comp.freshness === 0 ? `nieuws ouder dan ${A.maxAge} u` : null };
}

function dedupKey(item) {
  const ent = String((item.entities || [])[0] || item.source || "").toLowerCase().trim();
  const n = (item.numbers || [])[0];
  const fact = n == null ? String(item.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60) : String(typeof n === "object" ? n.value : n);
  return `${ent}|${fact}`;
}
// Topic = what the post is about (set, card, evergreen theme), independent of the number in it. Used for the
// per-account cooldown (scoring.topic_cooldown_days): "30th Celebration -19.6%" and "-9.1%" are the same topic.
const normTopic = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const GENERIC_ENTITIES = new Set(["psa", "cgc", "bgs", "beckett", "sgc", "tag", "pop", "market", "release"]);
function topicKey(item) {
  if (!item) return "";
  if (item.topic) return normTopic(item.topic);
  if (item.card && item.card.name) return normTopic(item.card.name);
  if (item.kind === "metric") { const e = (item.entities || []).find(x => !GENERIC_ENTITIES.has(String(x).toLowerCase())); if (e) return normTopic(e); }
  if (item.kind === "evergreen") return normTopic(item.id || item.title);
  return "";
}
function isDuplicate(item, history, now = Date.now(), days = 30, topicDays = 0) {
  const key = dedupKey(item);
  const topic = topicDays > 0 ? topicKey(item) : "";
  return (history || []).some(h => {
    const age = now - Date.parse(h.created_at || 0);
    if (h.dedup_key === key && age < days * 86400e3) return true;
    return !!topic && h.topic_key === topic && age < topicDays * 86400e3;
  });
}

function compatibleLayouts(item) {
  if (Array.isArray(item.layouts) && item.layouts.length) return item.layouts.filter(l => LAYOUTS.includes(l));
  if (item.versus) return ["versus", "number"];
  if (item.kind === "metric") return item.series ? ["number", "signal"] : ["number", "signal"];
  return ["signal", "persona"];
}

// Weekly mix: prefer the layout with the largest deficit vs WEEKLY_MIX over the last 7 days.
function layoutDeficits(history, now = Date.now(), acct) {
  const WEEKLY_MIX = account(acct).weeklyMix;
  const counts = Object.fromEntries(LAYOUTS.map(l => [l, 0]));
  for (const h of history || []) if (now - Date.parse(h.created_at || 0) < 7 * 86400e3 && counts[h.layout] != null) counts[h.layout]++;
  // Proportional to WEEKLY_MIX (3/2/1/1), so the mix holds at any number of sets per day.
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const mixSum = Object.values(WEEKLY_MIX).reduce((a, b) => a + b, 0);
  // A layout with weight 0 (or missing) is never planned for that account.
  return Object.fromEntries(LAYOUTS.filter(l => (WEEKLY_MIX[l] || 0) > 0).map(l => [l, Math.round((WEEKLY_MIX[l] / mixSum * (total + 1) - counts[l]) * 1000) / 1000]));
}

// Plan the day: for each slot pick the most-needed layout, then the best fresh non-duplicate item that fits it.
function planDay(candidates, history, { count = 1, weights = {}, rand = Math.random, now = Date.now(), minScore = 50, account: acct } = {}) {
  const scored = candidates.map(item => ({ item, score: scoreItem(item, now, acct) }))
    .filter(c => !c.score.reject && c.score.total >= minScore && !isDuplicate(c.item, history, now, 30, account(acct).topicCooldownDays))
    .sort((a, b) => b.score.total - a.score.total);
  const used = new Set(), usedTopics = new Set();
  const plan = [];
  const hist = [...(history || [])];
  for (let i = 0; i < count; i++) {
    const def = layoutDeficits(hist, now, acct);
    const ordered = Object.keys(def).sort((a, b) => def[b] - def[a] || LAYOUTS.indexOf(a) - LAYOUTS.indexOf(b));
    const top = ordered.filter(l => def[l] === def[ordered[0]]);
    const first = xPairs.weightedPick(top, weights.layout || {}, rand);
    let pick = null;
    for (const layout of [first, ...ordered.filter(l => l !== first)]) {
      const c = scored.find(c => !used.has(c) && !usedTopics.has(topicKey(c.item) || c) && compatibleLayouts(c.item).includes(layout));
      if (c) { pick = { ...c, layout }; break; }
    }
    if (!pick) break;
    used.add(scored.find(c => c.item === pick.item));
    if (topicKey(pick.item)) usedTopics.add(topicKey(pick.item));
    plan.push(pick);
    hist.push({ layout: pick.layout, created_at: new Date(now).toISOString() });
  }
  return plan;
}

// ---------- LLM prompt + validator ----------
function systemPrompt(acct) {
  const A = account(acct);
  return [
    A.voiceIntro,
    "Schema: {\"layout\":\"signal|number|versus|persona\",\"pill\":\"" + A.pills.join("|") + "\",\"headline\":\"...\",\"hint\":\"...\",\"number\":null,\"unit\":null,\"series\":null,\"versus\":null,\"context_line\":null,\"image_brief\":\"...\",\"payload\":{\"title\":\"...\",\"items\":[{\"title\":\"...\",\"body\":\"...\"},{...},{...}]},\"closer\":{\"line\":\"...\",\"question\":\"...\"},\"caption\":\"...\",\"x_hook\":\"...\",\"x_reply\":\"...\",\"source\":{\"name\":\"...\",\"url\":\"...\",\"date\":\"YYYY-MM-DD\"}}",
    ...A.voiceRules.split("\n").filter(l => l.trim()),
  ].join("\n");
}
function userPrompt(item, layout, pill, feedback, acct) {
  const label = layoutLabel(layout, acct);
  const facts = { source: item.source, url: item.url, title: item.title, summary: String(item.summary || "").slice(0, 1800), published_at: item.published_at, numbers: item.numbers, entities: item.entities, series: item.series || null, versus: item.versus || null };
  if (item.pop) facts.pop_report = item.pop;
  if (item.data_fetched_at) facts.data_fetched_at = item.data_fetched_at;
  return [`Layout: ${layout}${label !== layout ? ` (${label})` : ""}. Pill: ${pill || "choose the best fit"}.`, "Item:", JSON.stringify(facts), feedback ? `Your previous attempt was rejected: ${feedback}. Fix exactly that.` : ""].filter(Boolean).join("\n");
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

function validateCard(card, item = {}, acct) {
  const A = account(acct);
  const errors = [];
  if (!card || typeof card !== "object") return { ok: false, errors: ["geen object"] };
  if (!LAYOUTS.includes(card.layout)) errors.push(`onbekende layout ${card.layout}`);
  if (!A.pills.includes(String(card.pill || "").toLowerCase())) errors.push(`onbekende pill ${card.pill}`);
  const all = textFields(card).join("\n");
  if (/[–—]/.test(all)) errors.push("em/en dash");
  const caps = xPairs.capsViolations(stripMarks(all.replace(/link in bio/gi, "")), [...A.capsAllow, ...(item.entities || []).filter(e => /^[A-Z0-9]{2,6}$/.test(e))]);
  if (caps.length) errors.push(`ALL CAPS: ${caps.slice(0, 5).join(", ")}`);
  if (SUPERLATIVES.some(r => r.test(all))) errors.push("holle superlatief");
  if (BAIT.some(r => r.test(all))) errors.push("engagement bait");
  if (PREDICTION.some(r => r.test(all))) errors.push("predictie/will/signal-taal");
  for (const f of A.forbid) if (f.re.test(stripMarks(all))) errors.push(f.reason);
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
  if (A.headlineAnchor) {
    // Exactly one number, set or card name in the headline, and it reappears in the payload.
    const bare = A.gradeRe ? plain.replace(A.gradeRe, "grade") : plain;
    const nums = numbersIn(bare);
    const payloadText = stripMarks([(items || []).map(i => `${i?.title} ${i?.body}`).join(" "), card.payload?.title].join(" ")).toLowerCase();
    if (nums.length > 1) errors.push(`headline heeft ${nums.length} getallen, max 1`);
    if (!nums.length) {
      const marked = [...head.matchAll(/\[[ap]\]([\s\S]*?)\[\/[ap]\]/g)].map(x => x[1].trim());
      const names = [...marked, ...(plain.match(/(?:[A-Z][\w'’é-]+(?:\s+(?:[A-Z][\w'’é-]+|ex|EX|GX|V|VMAX|VSTAR))*)/g) || []).slice(1)].filter(x => x.length >= 3);
      if (!names.some(n => payloadText.includes(n.toLowerCase()))) errors.push("headline-anker (getal, set of kaart) komt niet terug in de payload");
    }
  }
  const ungrounded = numbersIn([(items || []).map(i => `${i?.title} ${i?.body}`).join(" "), card.number].join(" ")).filter(n => n >= 13 && !(n >= 1990 && n <= 2035) && !numberVariants([item.numbers, item.title, item.summary, item.series, item.versus, item.pop ? Object.entries(item.pop).filter(([k]) => k !== "as_of").map(([, v]) => v) : null]).has(String(n)));
  if (ungrounded.length) errors.push(`verzonnen getal(len): ${ungrounded.slice(0, 4).join(", ")}`);
  if (card.layout === "number" && (!card.number || !card.unit)) errors.push("number layout zonder number/unit");
  if (card.layout === "versus" && !(card.versus?.left?.value && card.versus?.right?.value && card.versus?.left?.label && card.versus?.right?.label)) errors.push("versus layout zonder beide kanten");
  const firstPerson = /^\s*I\b/.test(plain);
  if (card.layout === "persona" && !firstPerson) errors.push("persona hook moet eerste persoon verleden tijd zijn");
  if (card.layout !== "persona" && firstPerson) errors.push("eerste persoon alleen in persona");
  const cap = String(card.caption || "");
  const capLines = cap.split("\n").map(l => l.trim()).filter(Boolean);
  if (capLines.length !== 3) errors.push(`caption moet 3 regels hebben (${capLines.length})`);
  if (/[A-Z]/.test(cap.replace(new RegExp(`\\b(${A.captionCaps.join("|")})\\b`, "g"), ""))) errors.push("caption niet lowercase");
  const tags = (cap.match(/#[\p{L}\p{N}_]+/gu) || []);
  if (tags.length !== 4) errors.push("caption moet 4 hashtags hebben");
  else if (A.hashtags && tags.map(t => t.toLowerCase()).sort().join(" ") !== [...A.hashtags].sort().join(" ")) errors.push(`caption-hashtags moeten exact ${A.hashtags.join(" ")} zijn`);
  for (const w of A.captionRequired) if (!cap.toLowerCase().includes(w)) errors.push(`caption mist "${w}"`);
  if (/neura\s*labs/i.test(all)) errors.push("NeuraLabs-vermelding");
  const srcName = String(card.source?.name || item.source || "");
  const linkText = [cap, card.x_hook || "", card.x_reply || ""].join("\n").split(srcName || "\u0000").join(" ");
  if (xPairs.links(linkText).length) errors.push("link in tekst");
  if (!card.x_hook || xPairs.weightedLength(card.x_hook) > 270) errors.push("x_hook ontbreekt of te lang");
  if (!card.x_reply || xPairs.weightedLength(card.x_reply) > 280) errors.push("x_reply ontbreekt of te lang");
  if (A.imagePolicy.brief_required !== false && ["signal", "versus"].includes(card.layout) && !card.image_brief) errors.push("image_brief ontbreekt");
  return { ok: errors.length === 0, errors };
}

// llm(system, user) -> text. Max 2 regenerations, then give up with the reasons.
async function generateCard({ llm, item, layout, pill, maxAttempts = 3, log = () => {}, account: acct }) {
  let feedback = null;
  const attempts = [];
  for (let i = 0; i < maxAttempts; i++) {
    let card, v;
    try {
      card = parseJson(await llm(systemPrompt(acct), userPrompt(item, layout, pill, feedback, acct)));
      card.layout = layout;
      card.pill = String(card.pill || pill || "signal").toLowerCase();
      if (!card.source?.url) card.source = { name: item.source, url: item.url, date: String(item.published_at || "").slice(0, 10) };
      v = validateCard(card, item, acct);
    } catch (e) { v = { ok: false, errors: [`parse: ${e.message}`] }; }
    attempts.push({ attempt: i + 1, errors: v.errors });
    if (v.ok) return { ok: true, card, attempts };
    feedback = v.errors.join("; ");
    log(`news-cards: poging ${i + 1} afgewezen: ${feedback}`);
  }
  return { ok: false, card: null, attempts, reason: feedback };
}

// ---------- chart + slides ----------
function chartSvg(series, w = 912, h = 260, color = "hsl(264 65% 58%)", stroke = "hsl(264 65% 70%)") {
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
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="cf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${fill}" fill="url(#cf)"/><path d="${d}" fill="none" stroke="${stroke}" stroke-width="5" stroke-linejoin="round"/>${labels}</svg>`;
}

// Pop report bars: grades 6..10 from NeuraCollectibles pop data, the 10 bar in the accent colour (gold for Slabhaus).
function popBarsSvg(pop, w = 912, h = 220) {
  const grades = ["6", "7", "8", "9", "10"];
  const vals = grades.map(g => Number(pop?.[g]));
  if (vals.filter(Number.isFinite).length < 2) return "";
  const max = Math.max(...vals.filter(Number.isFinite), 1);
  const gap = 28, bw = (w - gap * (grades.length - 1)) / grades.length, top = 40, base = h - 40;
  const fmt = v => Number.isFinite(v) ? v.toLocaleString("en-US") : "n/a";
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` + grades.map((g, i) => {
    const v = vals[i], x = i * (bw + gap), bh = Number.isFinite(v) ? Math.max(4, (v / max) * (base - top)) : 0, y = base - bh;
    const gold = g === "10";
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="10" fill="${gold ? "var(--accent)" : "var(--dot, #2f2f35)"}"/>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 12).toFixed(1)}" text-anchor="middle" fill="${gold ? "var(--accent)" : "var(--muted)"}" font-family="Inter" font-weight="700" font-size="24">${esc(fmt(v))}</text>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle" fill="${gold ? "var(--accent)" : "var(--muted)"}" font-family="Inter" font-weight="600" font-size="24">${g}</text>`;
  }).join("") + `</svg>`;
}

// Image fallback (accounts with fallback_pattern: slab): rows of slab outlines with a label bar.
function slabPatternSvg() {
  return `<svg class="slabpat" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><pattern id="slab" width="150" height="200" patternUnits="userSpaceOnUse"><rect x="20" y="20" width="110" height="160" rx="12" fill="none" stroke="#232326" stroke-width="3"/><rect x="32" y="32" width="86" height="24" rx="5" fill="none" stroke="#232326" stroke-width="3"/><rect x="32" y="66" width="86" height="100" rx="6" fill="none" stroke="#232326" stroke-width="2"/></pattern></defs><rect width="100%" height="100%" fill="#141416"/><rect width="100%" height="100%" fill="url(#slab)"/></svg>`;
}

// Image fallback (accounts with fallback_pattern: chart): faint stepped chart silhouette, no numbers.
function chartPatternSvg(color = "hsl(264 65% 58%)") {
  const pts = [62, 58, 60, 49, 53, 41, 45, 33, 38, 27, 30, 22];
  let d = "M0," + pts[0] * 10; pts.forEach((v, i) => { if (i) d += ` H${i * 98} V${v * 10}`; }); d += " H1080";
  return `<svg class="chartpat" style="position:absolute;inset:0" width="100%" height="100%" viewBox="0 0 1080 1350" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="cpg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${d} V1350 H0 Z" fill="url(#cpg)"/><path d="${d}" fill="none" stroke="${color}" stroke-opacity=".35" stroke-width="4"/></svg>`;
}
// Tier 4 with a series on the item: the item's own data as an SVG chart in the image zone.
function zoneChartSvg(series, A) {
  const svg = A.chartColor ? chartSvg(series, 900, 420, A.chartColor, A.chartColor) : chartSvg(series, 900, 420);
  return svg ? `<div class="zonechart" style="position:absolute;left:0;right:0;top:12%;display:flex;justify-content:center;opacity:.9">${svg}</div>` : "";
}

function fill(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] == null ? "" : String(vars[k])); }
function tpl(name) { return fs.readFileSync(path.join(TPL_DIR, `${name}.html`), "utf8"); }
function topHtml(pill, i, n) { return `<div class="top"><span class="pill">${esc(pill)}</span><span class="counter">0${i + 1} / 0${n}</span></div>`; }
function footHtml(i, n, acct) { return `<div class="foot">${account(acct).brandHtml}<div class="dots">${Array.from({ length: n }, (_, k) => `<i${k === i ? ' class="on"' : ""}></i>`).join("")}</div></div>`; }
function safeImg(u) { const s = String(u || ""); return /^(data:image\/(png|jpeg|webp);base64,|https:\/\/|file:\/\/)/.test(s) ? s.replace(/['"()\\\s]/g, encodeURIComponent) : ""; }

// Web media (image_policy.kind: web): images.<slot>_fit says how the image sits in the zone.
//   photo  signal: photo fills the image zone (0 to 820 px) with a fade into the card; versus: cover, subject centered
//   object card, slab or product on a plain background: whole, centered, 60% of the slide height, on the dark pattern
//   slab   card database scan composited into the virtual slab frame (own 4:5 image with its own background)
//   logo   set art alone, centered on the dark pattern
// images.<slot>_logo: set logo laid over a photo. Never stretched (contain or cover only).
const bgBox = (img, css, size = "contain") => `<div style="position:absolute;${css};background:url('${img}') center/${size} no-repeat"></div>`;
function webZone(images, slot, layout) {
  const img = safeImg(images[slot]);
  const fit = images[`${slot}_fit`];
  if (!img || !fit) return null;
  const logo = safeImg(images[`${slot}_logo`]);
  const logoHtml = logo ? bgBox(logo, layout === "signal" ? "left:120px;right:120px;top:110px;height:190px;filter:drop-shadow(0 6px 18px rgba(0,0,0,.7))" : "left:24px;right:24px;top:24px;height:110px;filter:drop-shadow(0 4px 12px rgba(0,0,0,.7))") : "";
  if (layout === "versus") {
    const size = fit === "photo" ? "cover" : "contain";
    return { image: "", fallback: (fit === "photo" ? "" : slabPatternSvg()) + bgBox(img, "inset:0", size) + logoHtml };
  }
  if (fit === "photo") return { image: "", fallback: bgBox(img, "left:0;right:0;top:0;height:820px", "cover") + `<div style="position:absolute;left:0;right:0;top:600px;height:222px;background:linear-gradient(180deg,rgba(20,20,22,0),#141416)"></div>` + logoHtml };
  // object/slab/logo: class fit-above, FIT_JS shrinks the box so it ends above the fitted headline (never overlaps text).
  const above = (css, pad) => `<div class="fit-above" data-pad="${pad}" style="position:absolute;${css};background:url('${img}') center/contain no-repeat"></div>`;
  if (fit === "object" || fit === "slab") return { image: "", fallback: slabPatternSvg() + above("left:90px;right:90px;top:170px;height:810px;filter:drop-shadow(0 18px 40px rgba(0,0,0,.6))", 36) };
  if (fit === "logo") return { image: "", fallback: slabPatternSvg() + above("left:130px;right:130px;top:170px;height:440px;filter:drop-shadow(0 10px 30px rgba(0,0,0,.7))", 36) };
  return null;
}

// images: { hook, left, right } as data: URIs (local files, no network during render).
function buildSlides(card, images = {}, acct) {
  const A = account(acct);
  const n = card.closer?.line && card.closer?.question ? 3 : 2;
  const pill = card.pill || "signal";
  const L = card.layout;
  const base = i => ({ top: topHtml(pill, i, n), foot: footHtml(i, n, A) });
  const fb = (img, series) => {
    if (safeImg(img)) return "";
    if (series) { const c = zoneChartSvg(series, A); if (c) return c; }
    return A.fallback === "slab" ? slabPatternSvg() : A.fallback === "chart" ? chartPatternSvg(A.chartColor || undefined) : "";
  };
  let hook;
  const wz = slot => webZone(images, slot, L);
  if (L === "signal") hook = fill(tpl("signal"), { ...base(0), ...(wz("hook") || { image: safeImg(images.hook), fallback: fb(images.hook, images.hook_series) }), headline: highlight(card.headline), hint: esc(card.hint || "swipe for the breakdown") });
  else if (L === "persona") hook = fill(tpl("persona"), { ...base(0), image: safeImg(images.hook), headline: highlight(card.headline), hint: esc(card.hint || card.context_line || "swipe for the breakdown") });
  else if (L === "number") {
    const bars = card.pop ? popBarsSvg(card.pop) : "";
    const svg = bars || (A.chartColor ? chartSvg(card.series, 912, 260, A.chartColor, A.chartColor) : chartSvg(card.series));
    hook = fill(tpl("number"), { ...base(0), number: esc(card.number), unit: esc(card.unit), chart_h: svg ? (bars ? 220 : 260) : 0, chart_svg: svg, chart_kind: bars ? "pop" : (svg ? "series" : ""), headline: highlight(card.headline), context_line: esc(card.context_line || card.hint || "") });
  } else if (L === "versus") {
    const v = card.versus || {};
    const side = s => `${esc(s?.value)}${s?.unit ? ` <span style="font:700 26px/1 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">${esc(s.unit)}</span>` : ""}`;
    const wl = wz("left"), wr = wz("right");
    hook = fill(tpl("versus"), { ...base(0), left_image: wl ? wl.image : safeImg(images.left), right_image: wr ? wr.image : safeImg(images.right), left_fallback: wl ? wl.fallback : fb(images.left, images.left_series), right_fallback: wr ? wr.fallback : fb(images.right, images.right_series), left_label: esc(v.left?.label), right_label: esc(v.right?.label), left_value: side(v.left), right_value: side(v.right), headline: highlight(card.headline), context_line: esc(card.context_line || card.hint || "") });
  } else throw new Error(`onbekende layout ${L}`);
  const p = card.payload || {};
  const items = (p.items || []).map((it, k) => `<li><b class="n">0${k + 1}</b><div><h3>${esc(stripMarks(it.title))}</h3><p>${esc(stripMarks(it.body))}</p></div></li>`).join("");
  const src = card.source ? `Source: ${esc(card.source.name || "")}${card.source.date ? `, ${esc(card.source.date)}` : ""}` : "";
  const slides = [
    { layout: L, html: hook },
    { layout: "payload", html: fill(tpl("payload"), { top: topHtml("the breakdown", 1, n), foot: footHtml(1, n, A), title: highlight(p.title), items, source: src, tagline: A.tagline ? `<p class="tagline">${esc(A.tagline)}</p>` : "" }) },
  ];
  if (n === 3) slides.push({ layout: "closer", html: fill(tpl("closer"), { top: topHtml(pill, 2, n), foot: footHtml(2, n, A), line: highlight(card.closer.line), question: esc(card.closer.question) }) });
  return slides;
}

// ---------- page + render ----------
let _fontCss = null;
function fontCss(aliases = []) {
  if (aliases.length) return fontCss() + "\n" + aliases.map(a => fontCss().split("\n").filter(l => l.includes(`'${a.from}'`)).map(l => l.replace(`'${a.from}'`, `'${a.to}'`)).join("\n")).join("\n");
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
  for (const el of document.querySelectorAll('.fit-above')) {
    const card = el.closest('.card'), h = card && card.querySelector('.headline');
    if (!h) continue;
    const top = el.getBoundingClientRect().top, lim = h.getBoundingClientRect().top - (+el.dataset.pad || 30);
    if (top + el.offsetHeight > lim) el.style.height = Math.max(200, lim - top) + 'px';
  }
  window.__fit = true;
})();`;

const ITEM_CSS = `.items li{display:flex;gap:30px;align-items:flex-start}.items .n{flex:none;font:400 40px/1 var(--display);font-stretch:125%;color:var(--accent-glow);min-width:84px;padding-top:6px}.items h3{font:700 46px/1.2 var(--body);color:var(--fg)}.items p{font:500 35px/1.38 var(--body);color:var(--muted);margin-top:10px}`;

function pageHtml(slideHtml, acct) {
  const A = account(acct);
  const css = fs.readFileSync(path.join(TPL_DIR, "base.css"), "utf8");
  const theme = A.id === "gh0stlayer" ? "" : `\n${A.themeCss}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss(A.fontAliases)}\n${css}\n${ITEM_CSS}${theme}</style></head><body>${slideHtml}<script>${FIT_JS}</script></body></html>`;
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

async function renderSet(card, { setId, outDir, images = {}, account: acct }) {
  fs.mkdirSync(outDir, { recursive: true });
  const slides = buildSlides(card, images, acct);
  const b = await browser();
  const out = [];
  for (let i = 0; i < slides.length; i++) {
    const page = await b.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
    try {
      await page.route("**/*", r => (/^(data|about):/.test(r.request().url()) ? r.continue() : r.abort()));
      await page.setContent(pageHtml(slides[i].html, acct), { waitUntil: "load" });
      await page.waitForFunction(() => window.__fit === true, null, { timeout: 15000 });
      const file = path.join(outDir, `set_${setId}_slide_${i + 1}.png`);
      await page.screenshot({ path: file, type: "png", fullPage: false });
      out.push({ slide: i + 1, layout: slides[i].layout, path: file });
    } finally { await page.close(); }
  }
  return out;
}

// One finished page (own HTML, e.g. the vault templates) → 1080×1350 PNG. Same fonts, base.css, theme and fit as the card sets.
async function renderHtml(slideHtml, file, acct) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const page = await (await browser()).newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  try {
    await page.route("**/*", r => (/^(data|about):/.test(r.request().url()) ? r.continue() : r.abort()));
    await page.setContent(pageHtml(slideHtml, acct), { waitUntil: "load" });
    await page.waitForFunction(() => window.__fit === true, null, { timeout: 15000 });
    await page.screenshot({ path: file, type: "png", fullPage: false });
    return file;
  } finally { await page.close(); }
}

function dataUri(file) {
  if (!file || !fs.existsSync(file)) return "";
  const buf = fs.readFileSync(file);
  const mime = buf[0] === 0x89 ? "image/png" : buf[0] === 0xff ? "image/jpeg" : buf.slice(8, 12).toString() === "WEBP" ? "image/webp" : null;
  return mime ? `data:${mime};base64,${buf.toString("base64")}` : "";
}
function imagePrompt(brief, acct) { return `${String(brief || "").replace(/[–—]/g, ",").trim().replace(/\.?$/, ".")} ${account(acct).imageRules}`; }

module.exports = {
  SIZE, LAYOUTS, PILLS, WEEKLY_MIX, IMAGE_RULES, CAPS_EXTRA, RELEVANT, REJECT, TICKERS, account, layoutLabel,
  esc, stripMarks, highlight, numbersIn, numberVariants,
  scoreItem, dedupKey, topicKey, isDuplicate, compatibleLayouts, layoutDeficits, planDay,
  systemPrompt, userPrompt, parseJson, validateCard, generateCard,
  chartSvg, popBarsSvg, slabPatternSvg, buildSlides, pageHtml, fontStatus, renderSet, renderHtml, closeBrowser, dataUri, safeImg, fill, tpl, TPL_DIR, imagePrompt,
};
