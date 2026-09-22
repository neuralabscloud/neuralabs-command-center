// Growth Marketeer: pure helpers for the weekly growth report.
// The agent researches the product online (web search), looks at competitors,
// gaps in the market and buzz opportunities, and returns a set of concrete
// growth ideas towards the owner's goal. api-server.js does the API call and
// storage; everything here is side-effect free so it can be tested offline.

const MODEL = process.env.GROWTH_MARKETEER_MODEL || "claude-opus-5-5";
const MAX_SEARCHES = parseInt(process.env.GROWTH_MARKETEER_SEARCHES || "", 10) || 12;

const CHANNELS = [
  "newsletter", "meta_ads", "google_ads", "ugc_video", "short_video", "youtube", "telegram", "x",
  "instagram", "tiktok", "seo", "content", "influencer", "partnership", "referral", "community",
  "pr", "event", "product", "promo", "other",
];
const LEVELS = ["low", "medium", "high"];
const IDEA_STATUSES = ["new", "planned", "doing", "done", "dismissed"];

function clean(s, max = 2000) {
  return String(s == null ? "" : s).replace(/[—–]/g, "-").replace(/\s+\n/g, "\n").trim().slice(0, max);
}

function level(v, fallback = "medium") {
  const s = String(v || "").toLowerCase();
  if (LEVELS.includes(s)) return s;
  if (/^(very )?high|groot|hoog/.test(s)) return "high";
  if (/^low|klein|laag/.test(s)) return "low";
  return fallback;
}

function channel(v) {
  const s = String(v || "").toLowerCase().trim().replace(/[\s/-]+/g, "_");
  if (CHANNELS.includes(s)) return s;
  const alias = { email: "newsletter", mail: "newsletter", facebook: "meta_ads", meta: "meta_ads", ads: "meta_ads",
    ugc: "ugc_video", reels: "short_video", shorts: "short_video", twitter: "x", affiliate: "referral",
    influencers: "influencer", kol: "influencer", partnerships: "partnership", giveaway: "promo", actie: "promo",
    webinar: "event", livestream: "event", blog: "content" };
  for (const [k, c] of Object.entries(alias)) if (s.includes(k)) return c;
  return "other";
}

const LEVEL_SCORE = { low: 1, medium: 2, high: 3 };
// Quick wins first: high impact, low effort.
function ideaScore(idea) {
  return LEVEL_SCORE[idea.impact] * 2 - LEVEL_SCORE[idea.effort];
}

function systemPrompt({ language = "English" } = {}) {
  return `You are a senior growth marketer. You act fully autonomously: you research, think like a growth lead at a fast growing startup and deliver a weekly growth plan the owner can act on right away.

How you work:
- Use web search. Look up the product itself (what people say about it, where it is mentioned, reviews, social posts), its direct and indirect competitors (how they acquire users, their pricing, offers, content, ads, communities, affiliate programs), trends and news in the niche, and moments or conversations where the product could create buzz this week or this month.
- Ground every claim in what you found or in the brand knowledge. Never invent numbers about the product (users, revenue, results). Estimates are fine when you label them as estimates.
- Think in the full funnel: attention, signup, activation, retention, referral.
- Ideas must be varied across channels (for example newsletter, Meta ads, UGC video, Telegram promo or action, X, YouTube, influencers, partnerships, referral program, SEO, PR, events, product-led growth) and concrete enough to execute: who, what, where, first steps, what it costs, how you measure it.
- Include at least one bold or unconventional idea and at least two quick wins that can be done within a week.
- Write everything in ${language}. Do not use em dashes or en dashes anywhere; use periods, colons or commas instead.`;
}

function userPrompt({ goal, focus, product, previous = [], today }) {
  const prev = previous.length
    ? `\n\nIdeas from earlier weeks and what the owner did with them (do not repeat these; build on the ones that were done or planned, learn from dismissed ones):\n${previous.map(p => `- [${p.status}] ${p.title} (${p.channel})`).join("\n")}`
    : "";
  return `Today is ${today}. Weekly growth review.

Goal: ${goal || "grow the number of users of the main product"}
${product ? `Product to grow: ${product}\n` : ""}${focus ? `Extra focus this week: ${focus}\n` : ""}${prev}

Do your research first, then answer with ONLY one JSON object in a \`\`\`json fence, with this shape:
{
  "headline": "one sentence: the biggest growth opportunity this week",
  "summary": "3 to 5 sentences: where the product stands, what you found, what to prioritise",
  "goal": { "target": "the goal in short", "estimate_now": "short: your best estimate of where it stands now, or 'unknown' plus one line why", "weekly_target": "short: what to aim for this week to stay on track (max two sentences)" },
  "findings": [ { "title": "...", "detail": "what you found about the product online", "source": "url or empty" } ],
  "competitors": [ { "name": "...", "url": "...", "how_they_grow": "...", "weakness": "...", "our_angle": "how we beat or differ from them" } ],
  "gaps": [ { "title": "...", "detail": "a gap in the market or an unserved audience" } ],
  "buzz": [ { "title": "...", "detail": "a moment, trend, event or conversation to ride", "when": "date or period" } ],
  "ideas": [ {
    "title": "short name",
    "channel": "one of: ${CHANNELS.join(", ")}",
    "description": "what exactly we do",
    "why_now": "why this works for this product right now",
    "steps": ["first step", "second step", "..."],
    "kpi": "how we measure success, with a number",
    "impact": "low | medium | high",
    "effort": "low | medium | high",
    "cost": "rough cost estimate",
    "timeline": "how long until results"
  } ],
  "top3": ["titles of the three ideas to start this week, in order"]
}
Give 8 to 12 ideas, 3 to 6 competitors, 3 to 6 findings, 2 to 5 gaps and 2 to 5 buzz opportunities.`;
}

// Pull the JSON object out of the reply text (thinking-out-loud text may precede it).
function extractJson(text) {
  const s = String(text || "");
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1]).reverse();
  for (const f of fences) { try { return JSON.parse(f); } catch {} }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  throw new Error("No JSON report in the reply");
}

function arr(v) { return Array.isArray(v) ? v : []; }

function normalizeReport(raw, { idPrefix = "i" } = {}) {
  const ideas = arr(raw.ideas).filter(i => i && i.title).slice(0, 20).map((i, n) => ({
    id: `${idPrefix}${n + 1}`,
    title: clean(i.title, 140),
    channel: channel(i.channel),
    description: clean(i.description),
    why_now: clean(i.why_now),
    steps: arr(i.steps).map(s => clean(s, 400)).filter(Boolean).slice(0, 8),
    kpi: clean(i.kpi, 300),
    impact: level(i.impact),
    effort: level(i.effort),
    cost: clean(i.cost, 200),
    timeline: clean(i.timeline, 200),
    status: "new",
  }));
  if (!ideas.length) throw new Error("Report has no ideas");
  const titles = ideas.map(i => i.title.toLowerCase());
  const top3 = arr(raw.top3).map(t => titles.indexOf(clean(t, 140).toLowerCase())).filter(i => i >= 0).map(i => ideas[i].id);
  // Fill up with the best quick wins when the model's top3 did not match titles
  for (const i of [...ideas].sort((a, b) => ideaScore(b) - ideaScore(a))) {
    if (top3.length >= 3) break;
    if (!top3.includes(i.id)) top3.push(i.id);
  }
  const g = raw.goal && typeof raw.goal === "object" ? raw.goal : {};
  return {
    headline: clean(raw.headline, 300),
    summary: clean(raw.summary, 3000),
    goal: { target: clean(g.target, 200), estimate_now: clean(g.estimate_now, 600), weekly_target: clean(g.weekly_target, 800) },
    findings: arr(raw.findings).filter(f => f && f.title).slice(0, 10).map(f => ({ title: clean(f.title, 200), detail: clean(f.detail), source: clean(f.source, 500) })),
    competitors: arr(raw.competitors).filter(c => c && c.name).slice(0, 10).map(c => ({
      name: clean(c.name, 120), url: clean(c.url, 500), how_they_grow: clean(c.how_they_grow), weakness: clean(c.weakness), our_angle: clean(c.our_angle) })),
    gaps: arr(raw.gaps).filter(x => x && x.title).slice(0, 10).map(x => ({ title: clean(x.title, 200), detail: clean(x.detail) })),
    buzz: arr(raw.buzz).filter(x => x && x.title).slice(0, 10).map(x => ({ title: clean(x.title, 200), detail: clean(x.detail), when: clean(x.when, 120) })),
    ideas,
    top3: top3.slice(0, 3),
  };
}

// Web search result urls + titles from the response content
function collectSources(blocks = []) {
  const seen = new Map();
  for (const b of blocks) {
    if (b?.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) if (r?.url && !seen.has(r.url)) seen.set(r.url, { url: r.url, title: clean(r.title || r.url, 200) });
  }
  return [...seen.values()];
}

function collectQueries(blocks = []) {
  return blocks.filter(b => b?.type === "server_tool_use" && b.input?.query).map(b => String(b.input.query));
}

function textOf(blocks = []) {
  return blocks.filter(b => b?.type === "text").map(b => b.text).join("");
}

// Previous ideas (newest reports first) as feedback for the next run
function previousIdeas(reports = [], max = 40) {
  const out = [];
  for (const r of reports) for (const i of r.ideas || []) if (out.length < max) out.push({ title: i.title, channel: i.channel, status: i.status || "new" });
  return out;
}

// Short Telegram text
function telegramSummary(report, { url } = {}) {
  const top = report.top3.map(id => report.ideas.find(i => i.id === id)).filter(Boolean);
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return [
    esc(report.headline),
    "",
    ...top.map((i, n) => `${n + 1}. <b>${esc(i.title)}</b> (${i.channel.replace(/_/g, " ")}, impact ${i.impact}, effort ${i.effort})`),
    "",
    `${report.ideas.length} ideas · ${report.competitors.length} competitors · ${report.sources?.length || 0} sources`,
    url ? url : "",
  ].join("\n").trim();
}

module.exports = {
  MODEL, MAX_SEARCHES, CHANNELS, IDEA_STATUSES,
  systemPrompt, userPrompt, extractJson, normalizeReport, collectSources, collectQueries, textOf,
  previousIdeas, telegramSummary, ideaScore, channel, level,
};
