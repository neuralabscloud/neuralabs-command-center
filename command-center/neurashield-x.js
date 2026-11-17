// NeuraShield on X (task "neurashield-x"): a campaign on top of the hook + reply pair engine (x-pairs.js).
// One pair a day in a random slot inside the Madrid window, a same-day news override, a weekly poll,
// reply triage into an approval queue (a human presses send), tickets for bug / false positive reports,
// a weekly report and a weekly facts updater. Product claims come only from config/neurashield/facts.md.
"use strict";

const fs = require("fs");
const path = require("path");
const xp = require("./x-pairs");

const CAMPAIGN = "neurashield";
const BRAND = "NeuraShield";
const PILLARS = ["threat_explainer", "scenario", "why_neurashield", "what_it_means", "news_reaction", "behind_build"];
const ENGAGEMENT = {
  question: "a specific question about the reader's own experience with this exact topic (for example \"Which of these have you seen in your own feed?\").",
  what_would_you_add: "\"What would you add?\" or a close variant that ends with a question mark.",
  poll_suggestion: "a poll suggestion phrased as a question (for example \"Should we turn this into a poll next week?\").",
};
const BANNED_WORDS = [/\bguarantee(d|s)?\b/i, /\bunhackable\b/i, /\b100\s?%/, /\bbullet-?proof\b/i, /\bnever lose\b/i];
const SECURITY_RE = /\b(hack(ed|er|s)?|exploit(ed)?|drain(ed|er)?|phish(ing)?|malware|stealer|infostealer|stolen|theft|scam|poison(ing)?|clipper|supply[- ]chain|attack(er|ed)?|breach|compromis(e|ed)|backdoor|vulnerabilit(y|ies)|address poisoning|fake (app|installer|extension)|malicious)\b/i;
const OPERATIONAL_RE = [/`[^`]+`/, /\b(curl|wget|osascript|base64 -d|chmod \+x|sudo\s|bash -c|zsh -c|powershell|xattr -[dcr])\b/i, /\|\s*(ba|z)?sh\b/];
const TESTIMONIAL_RE = /\b(a|one of our|our) (users?|customers?|readers?|members?|followers?) (wrote|told|messaged|emailed|said|sent)\b/i;

// ---------- time helpers (Europe/Madrid by default) ----------
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(date).map(p => [p.type, p.value]));
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(o.weekday) + 1; // 1 = Monday
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, weekday: wd, date: `${o.year}-${o.month}-${o.day}` };
}
const localDate = (date, tz) => localParts(date, tz).date;
function addDays(dateStr, n) { const t = new Date(`${dateStr}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function weekStart(date, tz) { const p = localParts(date, tz); return addDays(p.date, 1 - p.weekday); }
// Local wall time (YYYY-MM-DD + HH:MM in tz) to a Date.
function zonedTime(dateStr, hhmm, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Date.UTC(y, m - 1, d, hh, mm);
    guess -= diff;
  }
  return new Date(guess);
}
// Random moment inside today's window, never earlier than now + 5 min. null when the window is over.
function randomSlot(now, win, rand = Math.random, dateStr) {
  const day = dateStr || localDate(now, win.tz);
  const start = zonedTime(day, win.start, win.tz).getTime();
  const end = zonedTime(day, win.end, win.tz).getTime();
  const from = Math.max(start, now.getTime() + 5 * 60e3);
  if (from >= end) return null;
  return new Date(from + Math.floor(rand() * (end - from)));
}

// ---------- pure planning helpers ----------
const pairDate = (h, tz) => (h.pair && h.pair.slot_date) || localDate(new Date(h.at || h.created_at || 0), tz);
const isLive = h => !["cancelled", "failed"].includes(h.status);

// Pillars and formulas that may not be used today: everything from yesterday plus the pair right before.
function yesterdayRule(hist, now, tz) {
  const y = addDays(localDate(now, tz), -1);
  const live = hist.filter(isLive);
  const set = live.filter(h => pairDate(h, tz) === y);
  if (live[0]) set.push(live[0]);
  return { date: y, pillars: [...new Set(set.map(h => h.pillar).filter(Boolean))], formulas: [...new Set(set.map(h => h.formula).filter(Boolean))] };
}

function weekCounts(hist, now, tz) {
  const ws = weekStart(now, tz);
  const out = Object.fromEntries(PILLARS.map(p => [p, 0]));
  let polls = 0;
  for (const h of hist.filter(isLive)) {
    if (pairDate(h, tz) < ws) continue;
    if (out[h.pillar] != null) out[h.pillar]++;
    if (h.pair && h.pair.poll) polls++;
  }
  return { week: ws, pillars: out, polls };
}

// Weekly quota planner: pillars with quota left (news only via the news watcher), never yesterday's pillar.
// Falls back to a threat explainer (the news fallback), then to any allowed pillar.
function planPillar({ hist, now, tz, mix, weights = {}, rand = Math.random }) {
  const y = yesterdayRule(hist, now, tz);
  const wc = weekCounts(hist, now, tz).pillars;
  const left = PILLARS.filter(p => p !== "news_reaction" && (mix[p] || 0) - (wc[p] || 0) > 0 && !y.pillars.includes(p));
  if (left.length) {
    const w = Object.fromEntries(left.map(p => [p, ((mix[p] || 0) - (wc[p] || 0)) * Math.max(0.05, Number(weights[p]) || 1)]));
    return { pillar: xp.weightedPick(left, w, rand), fallback: null };
  }
  if (!y.pillars.includes("threat_explainer")) return { pillar: "threat_explainer", fallback: "weekly quota used up or blocked: threat explainer (news fallback)" };
  const any = PILLARS.filter(p => p !== "news_reaction" && !y.pillars.includes(p));
  return { pillar: xp.weightedPick(any, weights, rand), fallback: "weekly quota used up: free pick" };
}

function engagementKind(hist) {
  const recent = hist.filter(isLive).slice(0, 3).map(h => h.pair && h.pair.engagement).filter(Boolean);
  const kinds = Object.keys(ENGAGEMENT);
  return kinds.filter(k => k !== recent[0]).sort((a, b) => recent.filter(x => x === a).length - recent.filter(x => x === b).length)[0];
}

// ---------- deterministic NeuraShield rules (on top of x-pairs validatePair) ----------
const stripUrls = s => String(s || "").replace(/https?:\/\/\S+/g, " ");
function brandCount(s) { return (stripUrls(s).match(/neura\s?shield/gi) || []).length; }

// Prices: only "59 euro per year" or "free".
function moneyViolations(text) {
  const t = stripUrls(text).replace(/\b59 euro(s)? (per|a) year\b/gi, " ");
  const re = /(?:[€$£]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:€|\$|£|eur|euros?|usd|dollars?|bucks)\b|\b(?:eur|usd)\s?\d[\d.,]*|\bper (?:month|year)\b|\/(?:mo|month|yr|year)\b)/gi;
  return t.match(re) || [];
}

function antivirusSelf(text) {
  const t = stripUrls(text);
  return /\b(neura\s?shield|it|we|this app)\s+(is|are|'s|works as)\s+(an?\s+|your\s+)?(antivirus|anti-virus)\b/i.test(t)
    || /\b(our|the neura\s?shield)\s+(antivirus|anti-virus)\b/i.test(t);
}

function validateNeuraShield(pair, pl, { cfg, testimonials = [] } = {}) {
  const errors = [];
  const hook = String(pair.hook || "");
  const replies = (pair.replies || []).map(String);
  const payload = replies.join("\n\n");
  const all = `${hook}\n${payload}`;
  const productLink = cfg.product_link;

  if (brandCount(hook)) errors.push(`${BRAND} is named in the hook (only the payload may name it)`);
  const n = brandCount(payload);
  if (n !== 1) errors.push(`${BRAND} must appear exactly once in the payload (found ${n})`);
  else {
    const lines = payload.split("\n").map(l => l.trim()).filter(Boolean);
    const idx = lines.findIndex(l => brandCount(l));
    if (idx < 2) errors.push(`${BRAND} is in the first two lines of the payload; move the product sentence near the end`);
    const body = stripUrls(payload);
    const pos = body.search(/neura\s?shield/i) / Math.max(1, body.length);
    if (idx >= 2 && pos < 0.45) errors.push(`${BRAND} appears too early (${Math.round(pos * 100)}% into the payload); put the one product sentence near the end`);
  }
  for (const re of BANNED_WORDS) if (re.test(all)) errors.push(`banned word: "${all.match(re)[0]}"`);
  if (antivirusSelf(all)) errors.push(`${BRAND} described as an antivirus (facts: it is not an antivirus)`);
  const money = moneyViolations(all);
  if (money.length) errors.push(`price not allowed: ${money.slice(0, 3).join(", ")} (only "59 euro per year" or "free")`);
  for (const c of cfg.competitors || []) {
    const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s?")}\\b`, "i");
    if (re.test(all)) errors.push(`competitor named: ${c}`);
  }
  for (const re of OPERATIONAL_RE) if (re.test(all)) errors.push(`operational detail (command or code): "${all.match(re)[0]}". Describe the pattern and the tell, not the recipe`);
  if (!testimonials.length && TESTIMONIAL_RE.test(all)) errors.push(`testimonial-like line "${all.match(TESTIMONIAL_RE)[0]}" while testimonials.md is empty: write it as a scenario`);
  if (pl.yesterday) {
    if (pl.yesterday.pillars.includes(pl.pillar.id)) errors.push(`same pillar as yesterday (${pl.pillar.id})`);
    if (pl.yesterday.formulas.includes(pl.formula)) errors.push(`same formula as yesterday (${pl.formula})`);
  }
  const hasProduct = all.includes(productLink);
  if (pl.requireProductLink && !hasProduct) errors.push(`this payload must link ${productLink}`);
  if (hasProduct && !pl.allowProductLink && !pl.requireProductLink) errors.push(`no product link in this pair (max 1 in 3 payloads)`);
  if (pl.news) {
    if (!payload.includes(pl.news.url)) errors.push(`news reaction must link the source: ${pl.news.url}`);
    if (!/here is how it works:?/i.test(hook)) errors.push(`news hook needs date + fact + "here is how it works:"`);
  }
  if (pl.poll) {
    const o = pair.poll_options || [];
    if (o.length !== 4) errors.push(`poll needs exactly 4 options (got ${o.length})`);
    o.forEach((x, i) => { if ([...x].length > 25) errors.push(`poll option ${i + 1} is over 25 characters`); });
    if (new Set(o.map(x => x.toLowerCase())).size !== o.length) errors.push("poll options must be different");
    if (o.some(x => xp.emojis(x).length || xp.links(x).length)) errors.push("poll options: no emoji or links");
  }
  return errors;
}

// ---------- files ----------
function readFacts(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  const lines = text.split("\n").map((t, i) => ({ n: i + 1, text: t.replace(/^\s*-\s+/, "").trim(), bullet: /^\s*-\s+/.test(t) })).filter(l => l.bullet && l.text);
  return { text, lines };
}
function readTestimonials(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  const after = text.split(/^---\s*$/m)[1] || "";
  return after.split("\n").filter(l => /^\s*-\s+\S/.test(l) && /["“]/.test(l)).map(l => l.replace(/^\s*-\s+/, "").trim());
}
// Threat list envelope {payload: base64 JSON, signature}: we only read version + published.
function threatMeta(envelope) {
  const env = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
  const raw = env && env.payload;
  if (!raw) throw new Error("threat list: no payload");
  const j = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  return { version: j.version != null ? j.version : null, published: j.published || j.publishedAt || null, signed: !!env.signature };
}
// README changelog: "## Changelog" then "### 0.5 (Nov 2026)" headings with bullets. Returns [{version, heading, bullets}].
function parseChangelog(md) {
  const sec = String(md || "").split(/^##\s+(?:changelog|release notes|changes)\b.*$/im)[1];
  if (!sec) return [];
  const body = sec.split(/^##\s(?!#)/m)[0];
  const out = [];
  let cur = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^###\s+v?(\d+(?:\.\d+)*)\b(.*)$/);
    if (h) { cur = { version: h[1], heading: h[2].replace(/[()\s:–—-]+/g, " ").trim(), bullets: [] }; out.push(cur); continue; }
    const b = line.match(/^\s*[-*]\s+(.+)$/);
    if (cur && b) cur.bullets.push(b[1].trim());
  }
  return out;
}
const fmtDay = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Madrid" });

// ---------- runtime ----------
function createNeuraShield(deps) {
  const {
    root, dataDir, readChannels, readTasks, updateTask, twitterApi, twitterCredsFor,
    sendTelegram = () => {}, notify = () => {}, bumpUsage = () => {}, log = () => {},
    fetchImpl = fetch, now = () => new Date(), rss = require("./sources/rss"),
  } = deps;
  const cfgDir = path.join(root, "config", CAMPAIGN);
  const files = {
    config: path.join(cfgDir, "config.json"), profile: path.join(cfgDir, "profile.json"),
    facts: path.join(cfgDir, "facts.md"), testimonials: path.join(cfgDir, "testimonials.md"),
  };
  const nsDir = path.join(dataDir, CAMPAIGN);
  const stateFile = path.join(nsDir, "state.json");
  const draftsFile = path.join(nsDir, "reply-drafts.json");
  const ticketsFile = path.join(nsDir, "tickets.json");
  let bot = null;

  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
  const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2)); fs.renameSync(tmp, f); };
  const config = () => (readJson(files.config, {}).neurashield || {});
  const state = () => readJson(stateFile, {});
  const mutate = fn => { const s = state(); const r = fn(s); writeJson(stateFile, s); return r; };
  const anthropic = () => (typeof deps.anthropic === "function" ? deps.anthropic() : deps.anthropic);
  const model = () => deps.model || "claude-sonnet-5-5";

  function baseChannel() {
    const cfg = config();
    const all = readChannels();
    const acct = String(cfg.x_account || "").replace(/^@/, "").toLowerCase();
    return all.find(c => c.id === cfg.channel_id) || all.find(c => c.platform === "twitter" && [c.name, c.handle, c.username].some(v => String(v || "").replace(/^@/, "").toLowerCase() === acct)) || null;
  }
  function channel() { const c = baseChannel(); return c ? { ...c, pair_campaign: CAMPAIGN } : null; }

  // Campaign profile for x-pairs; premium comes from the account's own pair profile (same flag as the other accounts).
  function extraProfiles() {
    const c = baseChannel();
    if (!c) return {};
    const prof = readJson(files.profile, null);
    if (!prof) return {};
    const acct = readJson(path.join(dataDir, "x-pair-profiles.json"), {})[c.id] || {};
    return { [`${c.id}#${CAMPAIGN}`]: { ...prof, premium: acct.premium != null ? !!acct.premium : !!c.x_premium } };
  }

  // --- gallery: designer tasks in a neurashield-* batch ---
  function gallery() {
    const prefix = config().gallery_batch_prefix || "neurashield-";
    return readJson(path.join(dataDir, "designer-tasks.json"), []).filter(t => t && String(t.batch_id || "").startsWith(prefix) && t.status === "completed" && t.result_url)
      .map(t => ({ id: t.id, file: path.join(dataDir, "generated-images", path.basename(t.result_url)), label: t.description || "", tags: (t.tags || []).map(String), text: `${t.description || ""} ${(t.tags || []).join(" ")}`.toLowerCase(), kind: t.asset_kind || "image" }))
      .filter(g => fs.existsSync(g.file));
  }
  function pickGallery(pillarId, topic, counts = {}) {
    const g = gallery();
    if (!g.length) return null;
    let pool = g;
    if (topic && ["threat_explainer", "news_reaction"].includes(pillarId)) {
      const match = g.filter(x => (topic.keywords || []).some(k => x.text.includes(k.toLowerCase())) && x.kind === "carousel_slide");
      if (match.length) pool = match;
    }
    const pick = pool.slice().sort((a, b) => (counts[path.basename(a.file)] || 0) - (counts[path.basename(b.file)] || 0) || Math.random() - 0.5)[0];
    return { kind: "gallery", key: path.basename(pick.file), file: pick.file, label: pick.label,
      describe: `our own NeuraShield brand image (${pick.label}). Do not describe it in detail; claim nothing beyond the facts file.` };
  }

  // --- the campaign hooks x-pairs calls ---
  function plan(ch, p, base, opts) {
    const cfg = config();
    const tz = cfg.window.tz;
    const hist = base.history;
    const t = now();
    const y = yesterdayRule(hist, t, tz);
    const weights = (opts.state && opts.state.weights) || {};
    let pillarId, fallback = null;
    const news = opts.news || null;
    if (news) pillarId = "news_reaction";
    else if (opts.forcePillar) pillarId = opts.forcePillar;
    else ({ pillar: pillarId, fallback } = planPillar({ hist, now: t, tz, mix: cfg.weekly_mix, weights: weights.pillars || {} }));
    const pillar = p.pillars.find(x => x.id === pillarId) || p.pillars[0];

    const wc = weekCounts(hist, t, tz);
    const pc = cfg.poll || {};
    let poll = opts.poll != null ? !!opts.poll
      : !news && wc.polls < (pc.per_week || 1) && localParts(t, tz).weekday >= (pc.from_weekday || 1) && !(pc.not_on || []).includes(pillar.id) && !y.formulas.includes("question");

    let formula;
    if (news) formula = "news";
    else if (poll) formula = "question";
    else {
      const reserved = p.reserved_formulas || [];
      let allowed = (pillar.formulas || p.formulas).filter(f => p.formulas.includes(f) && !reserved.includes(f) && !y.formulas.includes(f));
      if (!allowed.length) allowed = p.formulas.filter(f => !reserved.includes(f) && !y.formulas.includes(f));
      formula = xp.weightedPick(allowed, weights.formulas || {});
    }

    // threat topic: least recently used
    let topic = null;
    if (["threat_explainer", "what_it_means", "scenario"].includes(pillar.id) || poll) {
      const used = hist.slice(0, 12).map(h => h.pair && h.pair.topic).filter(Boolean);
      const topics = cfg.threat_topics || [];
      topic = topics.slice().sort((a, b) => (used.indexOf(a.id) === -1 ? -1 : 12 - used.indexOf(a.id)) - (used.indexOf(b.id) === -1 ? -1 : 12 - used.indexOf(b.id)) || Math.random() - 0.5)[0] || null;
    }

    const linkHist = hist.filter(isLive).map(h => ({ l: String(h.text || "").includes(cfg.product_link) }));
    const allowProductLink = xp.cadenceAllows(linkHist, "l", cfg.link_ratio || 0.3333);
    const facts = readFacts(files.facts);
    const recentUpdate = facts.lines.filter(l => /^\d{1,2} \w{3} \d{4}:/.test(l.text) && Date.parse(l.text.split(":")[0]) >= t.getTime() - 7 * 864e5);
    const announcesUpdate = pillar.id === "behind_build" && recentUpdate.length > 0;
    const requireProductLink = !!news || announcesUpdate;
    const allowLink = allowProductLink || requireProductLink;

    const mediaOk = !poll && pillar.id !== "scenario" && xp.cadenceAllows(hist.filter(isLive), "has_media", cfg.media_ratio || 0.5);
    const media = mediaOk ? pickGallery(pillar.id, topic, (opts.state || {}).media_counts) : null;
    const engagement = engagementKind(hist);
    const testimonials = readTestimonials(files.testimonials);
    const st = state();

    const lines = [
      `${BRAND} rules for this pair (they override anything above):`,
      `Facts file, the ONLY source for anything you say about ${BRAND}. Line numbers in brackets:`,
      ...facts.lines.map(l => `[L${l.n}] ${l.text}`),
      "",
      testimonials.length ? `Testimonials you may quote word for word (with the credit given): ${testimonials.join(" | ")}` : "Testimonials file is empty: every story is an illustrative scenario. No names, no quotes, no \"a user wrote us\".",
      `- Name ${BRAND} exactly once, in the payload, near the end, never in the first two lines of the payload: one sentence, as the guard that covers this, matching a facts line. Never name it in the hook${pillar.id === "behind_build" ? " (the hook may say \"we\")" : ""}.`,
      "- Describe the pattern and the tell, never the recipe: no commands, no code, no payload URLs, no exploit steps.",
      "- Never name or mock a competitor or another security product. Prices: only \"59 euro per year\" or \"free\", and only when relevant.",
      "- Never the words guaranteed, unhackable, 100%, bulletproof, never lose. Never call NeuraShield an antivirus.",
      "- No fear for its own sake, no urgency, no countdowns. The attack is the tension, the payload is the relief.",
      `- The last line of the payload (before any hashtags) is the engagement line: ${ENGAGEMENT[engagement]} Never \"follow for more\", never \"like and RT\".`,
      `- Hashtags: zero to two, last line only, only from: ${cfg.hashtags.join(" ")}.`,
      requireProductLink ? `- The payload MUST contain ${cfg.product_link}${news ? " (in addition to the source link)" : ""}, on its own line after the product sentence.`
        : allowProductLink ? `- You may add ${cfg.product_link} on its own line after the product sentence. No other links.` : "- No product link in this pair.",
      p.premium ? "" : "- Keep every reply within 280 characters.",
    ];
    if (pillar.id === "behind_build") lines.push(`- Voice: first person plural ("we"). Only from the facts file and the threat list version (${st.threat ? `version ${st.threat.version}, published ${st.threat.published}` : "unknown"}).${announcesUpdate ? " This pair announces this week's update." : ""}`);
    if (topic && !news) lines.push(`- Topic for this pair: ${topic.label}.`);
    if (pillar.id === "what_it_means" && (st.polls || []).length) lines.push(`- Results of our own earlier polls (real numbers, use them if relevant): ${(st.polls || []).slice(0, 3).map(x => `"${x.question}": ${x.options.map(o => `${o.label} ${o.pct}%`).join(", ")} (${x.total} votes)`).join(" | ")}`);
    if (poll) lines.push(`- This hook is an X poll about a habit related to the topic, for example "How do you check an address before sending?". The hook is the poll question (it still ends with the pointer line and the 👇 line). Give exactly 4 poll_options, each at most 25 characters, covering the realistic range (for example "first and last 4", "full compare", "trusted list", "I don't"). The payload gives the breakdown: what each option protects against and what it misses, in the same order.`);
    if (news) lines.push(`- News story (the only source for what happened; do not add details it does not contain): ${news.source}, ${news.published_at}: "${news.title}". ${news.summary}`,
      `- Our assessment: mechanism "${news.mechanism || "see story"}", ${BRAND} coverage: ${news.covered || "unknown"}${news.covered_line ? ` (facts line L${news.covered_line})` : ""}. If coverage is "no" or "partly", say so plainly in the product sentence; that honesty is the point.`,
      `- The hook starts with the date (${fmtDay(new Date(news.published_at || t))}) and the fact, then "here is how it works:" as the pointer line, then 👇.`,
      `- The payload links the source exactly as ${news.url} on its own line.`);

    const allowedLinks = [cfg.product_link, ...(news ? [news.url] : [])];
    return {
      ...base, pillar, formula, fallback, poll, news, topic, engagement, media, yesterday: y,
      allowLink, allowBrand: false, allowProductLink, requireProductLink,
      brandBlock: `Product: ${BRAND} by NeuraLabs Capital, a macOS menu bar security app for crypto holders. Account: ${ch.name}.`,
      extraPrompt: lines.filter(Boolean).join("\n"),
      ctx: { allowLink, allowedLinks, maxLinks: news ? 2 : 1, hashtagAllow: cfg.hashtags, forbiddenHook: [BRAND, "Neura Shield"], brandName: null },
    };
  }

  function validate(pair, pl) {
    return validateNeuraShield(pair, pl, { cfg: config(), testimonials: readTestimonials(files.testimonials) });
  }

  // LLM check against facts.md: every product claim needs a matching line; also flags invented people,
  // operational detail, competitors, antivirus self-description and fear.
  const CHECK_TOOL = {
    name: "report_check",
    description: "Report the facts check of one NeuraShield X pair.",
    input_schema: {
      type: "object",
      properties: {
        claims: { type: "array", items: { type: "object", properties: { claim: { type: "string" }, line: { type: ["integer", "null"], description: "facts line number that supports it, or null" } }, required: ["claim", "line"] }, description: "Every claim about what NeuraShield is, does, costs or does not do." },
        invented_people_or_quotes: { type: "array", items: { type: "string" } },
        operational_detail: { type: "array", items: { type: "string" }, description: "Commands, payload URLs or exploit steps that would let someone reproduce an attack." },
        competitors: { type: "array", items: { type: "string" } },
        antivirus_self_description: { type: "boolean" },
        fear_or_urgency: { type: "array", items: { type: "string" } },
      },
      required: ["claims", "invented_people_or_quotes", "operational_detail", "competitors", "antivirus_self_description", "fear_or_urgency"],
    },
  };
  async function check(pair, pl) {
    const facts = readFacts(files.facts);
    const testimonials = readTestimonials(files.testimonials);
    const text = [`HOOK:\n${pair.hook}`, ...(pair.poll_options ? [`POLL OPTIONS: ${pair.poll_options.join(" | ")}`] : []), `PAYLOAD:\n${pair.replies.join("\n\n")}`].join("\n\n");
    const msg = await anthropic().messages.create({
      model: model(), max_tokens: 2000, tools: [CHECK_TOOL], tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: `You check an X post pair about the app ${BRAND} before it is published. Answer only by calling the report_check tool.

FACTS FILE (numbered lines; the only allowed source of claims about ${BRAND}):
${facts.lines.map(l => `L${l.n}: ${l.text}`).join("\n")}

TESTIMONIALS FILE (quotes allowed word for word): ${testimonials.length ? testimonials.join(" | ") : "(empty: no quote, name or testimonial is allowed)"}
${pl.news ? `\nNEWS SOURCE for this pair (allowed source for claims about the incident, not about ${BRAND}): ${pl.news.title}. ${pl.news.summary}\n` : ""}
PAIR:
${text}

Rules:
- List every claim about ${BRAND} (what it does, detects, blocks, costs, runs, does not do). For each, give the facts line number that clearly supports it, or null when no line does. A claim stretched beyond the line (for example "blocks every fake app" when the line says "warns") gets null.
- General statements about how attacks work are not product claims; do not list them.
- invented_people_or_quotes: named people, quotes or "a user told us" that are not in the testimonials file. Clearly illustrative second-person scenarios ("you copy an address...") are fine.
- operational_detail: anything that would let a reader reproduce an attack (commands, code, payload URLs, exact exploit steps).
- competitors: any other security product or company named or mocked. Wallet apps and sites named as targets are not competitors.
- antivirus_self_description: true only if ${BRAND} is presented as an antivirus.
- fear_or_urgency: phrases that push fear for its own sake or fake urgency.` }],
    });
    const call = msg.content.find(b => b.type === "tool_use");
    if (!call) return { errors: ["facts check returned no result"], meta: null };
    const out = call.input || {};
    const byNo = Object.fromEntries(facts.lines.map(l => [l.n, l.text]));
    const claims = (out.claims || []).map(c => ({ claim: String(c.claim || ""), line: c.line != null && byNo[c.line] ? c.line : null, text: c.line != null ? byNo[c.line] || null : null }));
    const errors = [];
    for (const c of claims.filter(c => !c.line)) errors.push(`product claim not in facts.md: "${c.claim}"`);
    if (!claims.some(c => c.line)) errors.push(`the ${BRAND} sentence makes no claim that matches a facts.md line`);
    for (const q of out.invented_people_or_quotes || []) errors.push(`name, quote or testimonial not in testimonials.md: "${q}"`);
    for (const d of out.operational_detail || []) errors.push(`operational attack detail: "${d}"`);
    for (const c of out.competitors || []) errors.push(`competitor named: ${c}`);
    if (out.antivirus_self_description) errors.push(`${BRAND} presented as an antivirus`);
    for (const f of out.fear_or_urgency || []) errors.push(`fear or urgency: "${f}"`);
    return { errors, meta: { facts_matched: claims.filter(c => c.line), checked_at: now().toISOString() } };
  }

  function decorate(task, res, pl, { mode } = {}) {
    const cfg = config();
    const t = now();
    const tz = cfg.window.tz;
    task.archetype = pl.news ? "NeuraShield · News pair" : "NeuraShield · Pair";
    task.no_auto_replies = true;
    task.campaign = CAMPAIGN;
    const all = [res.pair.hook, ...res.pair.replies].join("\n");
    Object.assign(task.pair, {
      kind: pl.news ? "news" : "daily", topic: pl.topic ? pl.topic.id : null, engagement: pl.engagement,
      has_product_link: all.includes(cfg.product_link), facts_matched: (res.validation.meta || {}).facts_matched || [],
      news: pl.news ? { url: pl.news.url, title: pl.news.title, source: pl.news.source, published_at: pl.news.published_at, covered: pl.news.covered || null } : null,
      fallback: pl.fallback || null,
    });
    let at = t, day = localDate(t, tz);
    if (!pl.news) {
      const slot = randomSlot(t, cfg.window);
      if (slot) at = slot;
      else { day = addDays(day, 1); at = randomSlot(t, cfg.window, Math.random, day); }
    }
    task.pair.slot_date = day;
    task.scheduled_at = at.toISOString();
    task.scheduled_local = `${localDate(at, tz)} ${String(localParts(at, tz).hh).padStart(2, "0")}:${String(localParts(at, tz).mm).padStart(2, "0")} ${tz}`;
    if (pl.poll) { task.media_path = null; task.media_paths = []; task.pair.has_media = false; }
    const live = mode !== "review" && cfg.publishing_enabled === true;
    task.status = live ? "scheduled" : "draft";
    if (!live) task.pair.held = cfg.publishing_enabled === true ? "review mode" : "publishing disabled in config/neurashield/config.json";
  }

  const campaign = { plan, validate, check, decorate };
  function attach(b) { bot = b; }
  function need() { if (!bot) throw new Error("neurashield: pair engine not attached"); const ch = channel(); if (!ch) throw new Error(`neurashield: X account ${config().x_account} not found in channels`); return ch; }
  const tasks = () => readTasks().filter(t => t.pair && t.pair.campaign === CAMPAIGN);

  // --- daily run (scheduler 13:45 Madrid): one pair in a random slot 14:00-18:00 ---
  async function runDaily({ mode, force = false, step = () => {} } = {}) {
    const ch = need();
    const cfg = config();
    const today = localDate(now(), cfg.window.tz);
    const todays = tasks().filter(t => isLive(t) && t.pair.slot_date === today);
    if (!force && todays.some(t => t.pair.kind !== "news")) return { skipped: `already a pair for ${today}`, task_id: todays[0].id };
    if (!force && todays.length >= (cfg.max_pairs_per_day || 2)) return { skipped: `max ${cfg.max_pairs_per_day || 2} pairs on ${today}` };
    try { twitterCredsFor(ch); } catch (e) { return { skipped: `no X credentials for ${ch.name}: ${e.message}` }; }
    const r = await bot.produce(ch, { mode, step });
    return { task_id: r.task.id, status: r.task.status, scheduled_at: r.task.scheduled_at, pillar: r.task.pair.pillar, formula: r.task.pair.formula };
  }

  // --- news watcher ---
  async function findNews({ maxAgeH, dryRun = false } = {}) {
    const cfg = config();
    const nc = cfg.news || {};
    const seen = new Set((state().news_seen || []));
    const items = [];
    for (const feed of rss.FEEDS) {
      try { items.push(...await rss.fetchFeed(feed, { now: now().getTime(), maxAgeH: maxAgeH || nc.max_age_h || 24 })); } catch (e) { log(`neurashield: feed ${feed.source}: ${e.message}`); }
    }
    const cands = items.filter(i => SECURITY_RE.test(`${i.title} ${i.summary}`) && (dryRun || !seen.has(i.url)))
      .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at))).slice(0, 10);
    if (!dryRun && cands.length) mutate(s => { s.news_seen = [...cands.map(c => c.url), ...(s.news_seen || [])].slice(0, 500); });
    if (!cands.length) return null;
    const facts = readFacts(files.facts);
    const msg = await anthropic().messages.create({
      model: model(), max_tokens: 2000,
      tools: [{ name: "judge", description: "Judge news items for a same-day NeuraShield news reaction.", input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: {
        index: { type: "integer" }, qualifies: { type: "boolean" }, score: { type: "integer", description: "0-10: real crypto security incident relevant to people holding crypto on a computer, with a clear mechanism" },
        mechanism: { type: "string" }, covered: { type: "string", enum: ["yes", "partly", "no"] }, covered_line: { type: ["integer", "null"] } }, required: ["index", "qualifies", "score", "mechanism", "covered", "covered_line"] } } }, required: ["items"] } }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: `Answer only by calling the judge tool. Which of these news items is a real crypto security incident worth a same-day post for crypto holders on a Mac? Qualifies only if it is a confirmed incident from the reporting outlet (not opinion, price news, or a lawsuit recap) with a mechanism people can learn from. "covered": does NeuraShield (facts below) watch the moment this attack uses? Be strict and honest.

FACTS:
${facts.lines.map(l => `L${l.n}: ${l.text}`).join("\n")}

ITEMS:
${cands.map((c, i) => `[${i}] ${c.source}, ${c.published_at}: ${c.title}. ${String(c.summary || "").slice(0, 600)}`).join("\n")}` }],
    });
    const j = ((msg.content.find(b => b.type === "tool_use") || {}).input || {}).items || [];
    const best = j.filter(x => x.qualifies && x.score >= (nc.min_score || 7) && cands[x.index]).sort((a, b) => b.score - a.score)[0];
    if (!best) return null;
    const item = await rss.enrich(cands[best.index]).catch(() => cands[best.index]);
    return { url: item.url, title: item.title, summary: String(item.summary || "").slice(0, 1200), source: item.source, published_at: item.published_at, mechanism: best.mechanism, covered: best.covered, covered_line: best.covered_line, score: best.score };
  }

  let newsBusy = false;
  async function tickNews({ force = false } = {}) {
    const cfg = config();
    const nc = cfg.news || {};
    if (newsBusy || !nc.enabled || !bot) return null;
    const t = now();
    if (!force && nc.live_from && t.getTime() < Date.parse(nc.live_from)) return null; // nothing before the first live window
    const lp = localParts(t, cfg.window.tz);
    const [h0, h1] = nc.hours || [8, 21];
    const st = state();
    if (!force && (lp.hh < h0 || lp.hh > h1 || t.getTime() - Date.parse(st.news_checked_at || 0) < (nc.check_every_min || 30) * 60e3)) return null;
    newsBusy = true;
    try {
      mutate(s => { s.news_checked_at = t.toISOString(); });
      const ch = need();
      const today = lp.date;
      const all = tasks();
      const hist = bot.history(ch);
      const y = yesterdayRule(hist, t, cfg.window.tz);
      if (y.pillars.includes("news_reaction")) return { skipped: "news reaction yesterday" };
      if (weekCounts(hist, t, cfg.window.tz).pillars.news_reaction >= (nc.max_per_week || 2)) return { skipped: "weekly news maximum reached" };
      const todays = all.filter(x => isLive(x) && x.pair.slot_date === today);
      if (todays.some(x => x.pair.kind === "news")) return { skipped: "already a news pair today" };
      const pending = todays.find(x => x.pair.kind !== "news" && ["scheduled", "draft"].includes(x.status));
      const posted = todays.filter(x => x.status === "published" || x.status === "publishing").length;
      if (posted >= (cfg.max_pairs_per_day || 2)) return { skipped: "max pairs today" };
      const news = await findNews();
      if (!news) return { found: false };
      // News pre-empts today's planned pair when it has not gone out yet (max 2 pairs on a news day).
      if (pending && updateTask) updateTask(pending.id, x => { x.status = "cancelled"; x.error = `vervangen door nieuwsreactie (${news.title.slice(0, 80)})`; });
      const r = await bot.produce(ch, { planOpts: { news } });
      sendTelegram("NeuraShield nieuwsreactie", `${r.task.status === "scheduled" ? "Ingepland" : "Concept"}: ${news.title}\n${news.url}${pending ? "\nGeplande pair van vandaag vervangen." : ""}`, "info");
      return { task_id: r.task.id, status: r.task.status, news: news.title, preempted: pending ? pending.id : null };
    } catch (e) {
      log(`neurashield: news: ${e.message}`);
      return { error: e.message };
    } finally { newsBusy = false; }
  }

  // --- replies: every 2 h for 12 h after a post ---
  const drafts = () => readJson(draftsFile, []);
  const tickets = () => readJson(ticketsFile, []);
  async function ourAuthorId(ch, creds, hookId) {
    const st = state();
    if (st.author_id) return st.author_id;
    const d = await twitterApi("GET", `https://api.x.com/2/tweets?ids=${hookId}&tweet.fields=author_id`, creds);
    const id = d && d.data && d.data[0] && d.data[0].author_id;
    if (id) mutate(s => { s.author_id = id; });
    return id;
  }
  async function tickReplies() {
    if (!bot) return null;
    const cfg = config();
    const rc = cfg.replies || { every_h: 2, window_h: 12 };
    const t = now().getTime();
    const ch = channel();
    if (!ch) return null;
    const due = tasks().filter(x => x.status === "published" && x.pair.hook_id && x.pair.posted_at).filter(x => {
      const age = t - Date.parse(x.pair.posted_at);
      if (age > (rc.window_h + 1) * 3.6e6) return false;
      const done = ((state().reply_checks || {})[x.id] || {}).n || 0;
      return age >= (done + 1) * rc.every_h * 3.6e6 && done < Math.floor(rc.window_h / rc.every_h);
    });
    let found = 0;
    for (const task of due) {
      try { found += await checkReplies(ch, task, rc); }
      catch (e) { log(`neurashield: replies ${task.id}: ${e.message}`); }
    }
    return { checked: due.length, found };
  }
  async function checkReplies(ch, task, rc) {
    const creds = twitterCredsFor(ch);
    const age = now().getTime() - Date.parse(task.pair.posted_at);
    mutate(s => { s.reply_checks = s.reply_checks || {}; s.reply_checks[task.id] = { n: Math.min(Math.floor(rc.window_h / rc.every_h), Math.floor(age / (rc.every_h * 3.6e6))), at: now().toISOString() }; });
    const me = await ourAuthorId(ch, creds, task.pair.hook_id);
    const params = new URLSearchParams({ query: `conversation_id:${task.pair.hook_id}`, max_results: "100", expansions: "author_id", "tweet.fields": "author_id,created_at,conversation_id,referenced_tweets", "user.fields": "username" });
    const resp = await twitterApi("GET", `https://api.x.com/2/tweets/search/recent?${params}`, creds);
    const users = Object.fromEntries(((resp.includes || {}).users || []).map(u => [u.id, u.username]));
    const ours = new Set([task.pair.hook_id, ...(task.pair.reply_ids || [])]);
    const seen = new Set(state().reply_seen || []);
    const fresh = (resp.data || []).filter(r => !ours.has(r.id) && r.author_id !== me && !seen.has(r.id));
    if (!fresh.length) return 0;
    mutate(s => { s.reply_seen = [...fresh.map(r => r.id), ...(s.reply_seen || [])].slice(0, 3000); });
    const items = await classifyReplies(task, fresh);
    for (const it of items) {
      const r = fresh[it.index];
      if (!r) continue;
      const base = { tweet_id: r.id, url: `https://x.com/${users[r.author_id] || "i"}/status/${r.id}`, author: users[r.author_id] || r.author_id, text: r.text, task_id: task.id, hook: task.pair.hook, created_at: now().toISOString() };
      if (it.kind === "product_question" && it.answer) {
        const warn = [...moneyViolations(it.answer).map(m => `prijs: ${m}`), ...BANNED_WORDS.filter(re => re.test(it.answer)).map(re => `woord: ${it.answer.match(re)[0]}`)];
        writeJson(draftsFile, [{ id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ...base, draft: it.answer, facts_lines: it.lines || [], warnings: warn, status: "pending" }, ...drafts()].slice(0, 300));
        notify("NeuraShield: antwoord klaar voor goedkeuring", `@${base.author}: ${r.text.slice(0, 140)}`, "info");
      } else if (it.kind === "false_positive" || it.kind === "bug_report") {
        const tk = { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind: it.kind, ...base, summary: it.summary || "", status: "open" };
        writeJson(ticketsFile, [tk, ...tickets()].slice(0, 500));
        sendTelegram(`NeuraShield ticket: ${it.kind === "bug_report" ? "bug" : "false positive"}`, `@${base.author}: ${r.text.slice(0, 300)}\n${base.url}`, "warning");
        notify(`NeuraShield ticket (${it.kind === "bug_report" ? "bug" : "false positive"})`, `@${base.author}: ${r.text.slice(0, 200)}`, "warning");
      }
    }
    return fresh.length;
  }
  async function classifyReplies(task, replies) {
    const facts = readFacts(files.facts);
    const msg = await anthropic().messages.create({
      model: model(), max_tokens: 3000,
      tools: [{ name: "triage", description: "Triage replies under a NeuraShield post.", input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: {
        index: { type: "integer" }, kind: { type: "string", enum: ["product_question", "false_positive", "bug_report", "other"] },
        answer: { type: ["string", "null"], description: "product_question only: a short, friendly answer under 260 characters, using only the facts file; say you will check when the facts do not answer it" },
        lines: { type: "array", items: { type: "integer" } }, summary: { type: ["string", "null"] } }, required: ["index", "kind", "answer", "lines", "summary"] } } }, required: ["items"] } }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: `Answer only by calling the triage tool. Replies under our ${BRAND} post on X. Classify each: product_question (asks what ${BRAND} does, costs, supports, how to install), false_positive (says ${BRAND} flagged something harmless), bug_report (crash, broken feature), other. For product questions, draft an answer only from the facts (no em or en dashes, no prices other than "59 euro per year" or "free", no promises).

FACTS:
${facts.lines.map(l => `L${l.n}: ${l.text}`).join("\n")}

OUR POST: ${task.pair.hook}

REPLIES:
${replies.map((r, i) => `[${i}] ${String(r.text).slice(0, 500)}`).join("\n")}` }],
    });
    return ((msg.content.find(b => b.type === "tool_use") || {}).input || {}).items || [];
  }
  // Human pressed send in the dashboard.
  async function sendDraft(id, text) {
    const all = drafts();
    const d = all.find(x => x.id === id);
    if (!d) throw new Error("concept niet gevonden");
    if (d.status !== "pending") throw new Error(`concept is al ${d.status}`);
    const body = String(text != null ? text : d.draft).trim();
    if (!body) throw new Error("lege tekst");
    if (xp.weightedLength(body) > 280) throw new Error("antwoord is langer dan 280 tekens");
    if (/[–—]/.test(body)) throw new Error("geen em of en dash");
    const ch = need();
    const resp = await twitterApi("POST", "https://api.x.com/2/tweets", twitterCredsFor(ch), { json: { text: body, reply: { in_reply_to_tweet_id: d.tweet_id } } });
    bumpUsage();
    Object.assign(d, { status: "sent", sent_text: body, sent_id: resp && resp.data && resp.data.id, sent_at: now().toISOString() });
    writeJson(draftsFile, all);
    return d;
  }
  function setDraft(id, status) {
    const all = drafts();
    const d = all.find(x => x.id === id);
    if (!d) throw new Error("concept niet gevonden");
    d.status = status; d.updated_at = now().toISOString();
    writeJson(draftsFile, all);
    return d;
  }
  function setTicket(id, status) {
    const all = tickets();
    const tk = all.find(x => x.id === id);
    if (!tk) throw new Error("ticket niet gevonden");
    tk.status = status; tk.updated_at = now().toISOString();
    writeJson(ticketsFile, all);
    return tk;
  }

  // --- polls: store results after close ---
  async function tickPolls() {
    const ch = channel();
    if (!ch || !updateTask) return null;
    const t = now().getTime();
    const due = tasks().filter(x => x.status === "published" && x.pair.poll && !x.pair.poll.results && x.pair.hook_id && x.pair.posted_at
      && t > Date.parse(x.pair.posted_at) + ((x.pair.poll.duration_minutes || 1440) + 10) * 60e3 && t - Date.parse(x.pair.poll.checked_at || 0) > 3.6e6);
    for (const task of due) {
      try {
        updateTask(task.id, x => { x.pair.poll.checked_at = now().toISOString(); });
        const d = await twitterApi("GET", `https://api.x.com/2/tweets?ids=${task.pair.hook_id}&expansions=attach_polls_ids&poll.fields=options,voting_status,end_datetime`, twitterCredsFor(ch));
        const poll = ((d.includes || {}).polls || [])[0];
        if (!poll || poll.voting_status !== "closed") continue;
        const total = (poll.options || []).reduce((a, o) => a + (Number(o.votes) || 0), 0);
        const options = (poll.options || []).map(o => ({ label: o.label, votes: Number(o.votes) || 0, pct: total ? Math.round((Number(o.votes) || 0) * 100 / total) : 0 }));
        const results = { options, total, closed_at: poll.end_datetime || now().toISOString(), poll_id: poll.id };
        updateTask(task.id, x => { x.pair.poll.results = results; x.pair.poll.poll_id = poll.id; });
        mutate(s => { s.polls = [{ task_id: task.id, question: task.pair.hook.split("\n")[0], ...results }, ...(s.polls || []).filter(p => p.task_id !== task.id)].slice(0, 20); });
        log(`neurashield: poll ${task.id} closed, ${total} votes`);
      } catch (e) { log(`neurashield: poll ${task.id}: ${e.message}`); }
    }
    return { checked: due.length };
  }

  // --- threat list (read only: version + published) ---
  async function fetchThreat() {
    const url = config().threat_list_url;
    const u = new URL(url);
    if (u.protocol !== "https:" || !/\.supabase\.co$/.test(u.hostname)) throw new Error("threat_list_url must be https on supabase.co");
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!r.ok) throw new Error(`threat list HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 20e6) throw new Error("threat list over 20 MB");
    const meta = threatMeta(buf.toString("utf8"));
    mutate(s => { s.threat = { ...meta, checked_at: now().toISOString() }; });
    return meta;
  }

  // --- weekly facts updater: README changelog + threat list version only ---
  async function readChangelog(src) {
    if (!src) return null;
    if (/^https:\/\//.test(src)) {
      const u = new URL(src);
      if (!["raw.githubusercontent.com", "github.com", "api.github.com"].includes(u.hostname)) throw new Error("changelog_source host not allowed");
      const r = await fetchImpl(src, { signal: AbortSignal.timeout(20000), redirect: "error" });
      if (!r.ok) throw new Error(`changelog HTTP ${r.status}`);
      return (await r.text()).slice(0, 2e6);
    }
    if (!path.isAbsolute(src)) throw new Error("changelog_source must be an absolute path or https URL");
    return fs.readFileSync(src, "utf8");
  }
  async function updateFacts({ dryRun = false } = {}) {
    const cfg = config();
    const st = state();
    const day = fmtDay(now());
    const add = [];
    const notes = [];
    try {
      const th = await fetchThreat();
      const last = st.facts_threat_version != null ? st.facts_threat_version : Number((readFacts(files.facts).text.match(/threat list version (\d+)/gi) || []).map(x => x.match(/\d+/)[0]).sort((a, b) => b - a)[0] || 0);
      if (th.version != null && Number(th.version) > Number(last)) add.push({ line: `${day}: threat list version ${th.version} published (${th.published}).`, threat: th.version });
      else notes.push(`threat list v${th.version} (geen wijziging)`);
    } catch (e) { notes.push(`threat list: ${e.message}`); }
    if (cfg.changelog_source) {
      try {
        const seen = new Set(st.changelog_seen || []);
        for (const rel of parseChangelog(await readChangelog(cfg.changelog_source))) {
          if (seen.has(rel.version)) continue;
          for (const b of rel.bullets) add.push({ line: `${day}: ${BRAND} ${rel.version}${rel.heading ? ` (${rel.heading})` : ""} release notes: ${b.replace(/[–—]/g, ":")}`, version: rel.version });
          if (!rel.bullets.length) add.push({ line: `${day}: ${BRAND} ${rel.version} released.`, version: rel.version });
        }
      } catch (e) { notes.push(`changelog: ${e.message}`); }
    } else notes.push("changelog_source is leeg: geen release notes bron ingesteld");
    if (!dryRun && add.length) {
      let text = fs.readFileSync(files.facts, "utf8");
      if (!/^## Updates/m.test(text)) text = `${text.trimEnd()}\n\n## Updates (appended weekly, dated)\n`;
      text = `${text.trimEnd()}\n${add.map(a => `- ${a.line}`).join("\n")}\n`;
      fs.writeFileSync(files.facts, text);
      mutate(s => {
        const tv = add.filter(a => a.threat != null).map(a => Number(a.threat));
        if (tv.length) s.facts_threat_version = Math.max(...tv);
        s.changelog_seen = [...new Set([...(s.changelog_seen || []), ...add.filter(a => a.version).map(a => a.version)])];
        s.facts_updated_at = now().toISOString();
      });
    }
    return { added: add.map(a => a.line), notes, dry_run: dryRun };
  }

  // --- weekly report (Monday 09:00 Madrid) ---
  async function report({ send = true } = {}) {
    const t = now().getTime();
    let threat = state().threat || null;
    try { threat = await fetchThreat(); } catch (e) { log(`neurashield: threat list: ${e.message}`); }
    const all = tasks().filter(x => x.status === "published");
    const week = all.filter(x => t - Date.parse(x.pair.posted_at || x.published_at || 0) <= 7 * 864e5);
    const scored = week.filter(x => x.pair.score && Number.isFinite(x.pair.score.score)).sort((a, b) => b.pair.score.score - a.pair.score.score);
    const row = x => {
      const m = x.pair.metrics.h72 || x.pair.metrics.h24 || {};
      return `${x.pair.pillar}/${x.pair.formula} · score ${x.pair.score.score.toFixed(3)} · ${m.hook ? m.hook.impression_count : "?"} views · "${x.pair.hook.split("\n")[0].slice(0, 70)}"`;
    };
    const month = all.filter(x => t - Date.parse(x.pair.posted_at || 0) <= 28 * 864e5 && x.pair.score);
    const perPillar = PILLARS.map(p => { const xs = month.filter(x => x.pair.pillar === p); return xs.length ? `${p}: ${xs.length} pairs, gem. score ${(xs.reduce((a, x) => a + x.pair.score.score, 0) / xs.length).toFixed(3)}` : `${p}: geen data`; });
    const pend = drafts().filter(d => d.status === "pending").length;
    const open = tickets().filter(x => x.status === "open").length;
    const msg = [
      `Week tot ${fmtDay(now())}: ${week.length} pairs gepost, ${scored.length} met metrics.`,
      "", "Top 3:", ...(scored.slice(0, 3).map(row).map(s => `+ ${s}`) || []), ...(scored.length ? [] : ["(nog geen metrics)"]),
      "", "Slechtste 3:", ...scored.slice(-3).reverse().map(row).map(s => `- ${s}`),
      "", "Pillars (28 dagen):", ...perPillar,
      "", `Antwoorden wachten op goedkeuring: ${pend}. Open tickets: ${open}.`,
      `Threat list: ${threat ? `versie ${threat.version}, gepubliceerd ${threat.published}` : "onbekend"}.`,
      `Publiceren: ${config().publishing_enabled ? "aan" : "uit"}.`,
    ].join("\n");
    if (send) { sendTelegram("NeuraShield weekrapport", msg, "info"); notify("NeuraShield weekrapport", msg, "info"); }
    mutate(s => { s.last_report_at = now().toISOString(); });
    return { message: msg };
  }

  // --- dry run: 7 pairs, the weekly mix, one of them the poll ---
  async function dryRun({ n = 7 } = {}) {
    const ch = need();
    const news = await findNews({ maxAgeH: 72, dryRun: true }).catch(e => { log(`neurashield: dry-run news: ${e.message}`); return null; });
    const slots = [
      { forcePillar: "threat_explainer", poll: false }, { forcePillar: "scenario", poll: false }, { forcePillar: "why_neurashield", poll: false },
      { forcePillar: "what_it_means", poll: false }, news ? { news } : { forcePillar: "threat_explainer", poll: false, fallbackNote: "no qualifying news in the last 72 h" },
      { forcePillar: "behind_build", poll: false }, { forcePillar: "threat_explainer", poll: true },
    ];
    const res = await bot.dryRun(ch, n, { planFor: i => slots[i % slots.length] });
    const facts = readFacts(files.facts);
    const out = { ...res, generated_at: now().toISOString(), facts_file: files.facts, news_found: news ? { title: news.title, url: news.url, source: news.source } : null,
      pairs: res.pairs.map((r, i) => ({ ...r, fallback: r.fallback || slots[i].fallbackNote || null })) };
    out.facts_lines = facts.lines.length;
    writeJson(path.join(nsDir, `dry-run-${now().toISOString().replace(/[:.]/g, "-")}.json`), out);
    return out;
  }

  function status() {
    const cfg = config();
    const ch = channel();
    const st = state();
    let creds = false;
    try { if (ch) { twitterCredsFor(ch); creds = true; } } catch {}
    const ps = ch && bot ? bot.status(ch) : { pairs: [], weights: null, dropped: [] };
    const hist = ch && bot ? bot.history(ch) : [];
    const t = now();
    return {
      account: cfg.x_account, channel_id: ch ? ch.id : null, channel_name: ch ? ch.name : null, credentials: creds,
      premium: !!(ps.profile && ps.profile.premium), publishing_enabled: cfg.publishing_enabled === true,
      window: cfg.window, files: { facts: files.facts, config: files.config, testimonials: files.testimonials },
      testimonials: readTestimonials(files.testimonials).length, facts_lines: readFacts(files.facts).lines.length,
      week: weekCounts(hist, t, cfg.window.tz), mix: cfg.weekly_mix, yesterday: yesterdayRule(hist, t, cfg.window.tz),
      threat: st.threat || null, polls: (st.polls || []).slice(0, 5), news_checked_at: st.news_checked_at || null,
      weights: ps.weights, reweighted_at: ps.reweighted_at, dropped: ps.dropped,
      drafts: drafts().filter(d => d.status === "pending").slice(0, 30), tickets: tickets().filter(x => x.status === "open").slice(0, 30),
      gallery: gallery().length,
      pairs: (ps.pairs || []).map(r => {
        const task = tasks().find(x => x.id === r.id);
        return { ...r, kind: task && task.pair.kind, topic: task && task.pair.topic, facts_matched: task && task.pair.facts_matched, held: task && task.pair.held, news: task && task.pair.news, scheduled_local: task && task.scheduled_local };
      }),
    };
  }

  return { campaign, attach, channel, extraProfiles, runDaily, tickNews, tickReplies, tickPolls, updateFacts, report, dryRun, status, sendDraft, setDraft, setTicket, fetchThreat, findNews, config, files };
}

module.exports = {
  CAMPAIGN, PILLARS, ENGAGEMENT,
  localParts, localDate, weekStart, zonedTime, randomSlot, addDays,
  yesterdayRule, weekCounts, planPillar, engagementKind,
  brandCount, moneyViolations, antivirusSelf, validateNeuraShield,
  readFacts, readTestimonials, threatMeta, parseChangelog,
  createNeuraShield,
};
