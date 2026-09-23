// Edu Designer autopilot: finds educational trading/crypto content on X and the web
// (Instagram, TikTok, YouTube via web search), extracts the lesson and re-designs it
// as a clean, logo-free image in the house style, plus a ready-to-post caption.
//
// Pure helpers live here so they can be tested without network; the orchestration
// (Claude call, X search, Telegram) lives in api-server.js (runEduDesign).
const fs = require("fs");
const path = require("path");

const MODEL = process.env.EDU_DESIGNER_MODEL || "claude-opus-5-5";
const MAX_SEARCHES = 8;
const MAX_FETCHES = 4;
const MAX_X_IMAGES = 4;
const FORMATS = ["glossary", "steps", "checklist", "tips"];
const PLATFORMS = ["x", "instagram", "tiktok", "youtube", "reddit", "web"];
const SIZES = {
  portrait: { width: 1080, height: 1350, label: "4:5" },
  square: { width: 1080, height: 1080, label: "1:1" },
  story: { width: 1080, height: 1920, label: "9:16" },
};
const FONTS_DIR = path.join(__dirname, "assets", "fonts");
const DEFAULT_TOPICS = ["trading terms", "crypto basics", "risk management", "chart patterns", "technical indicators", "smart money concepts", "DeFi explained", "trading psychology"];

// ── text hygiene ──
// Hard style rule: no em/en dashes in social copy.
function stripDashes(s) {
  return String(s || "")
    .replace(/\s*[—–]\s*(?=\n|$)/g, "")
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/\s+[—–]\s+/g, ". ")
    .replace(/[—–]/g, ", ");
}

// Image text may never carry handles, links or creator credits.
function cleanImageText(s, max = 160) {
  return String(s || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/(^|\s)@\w{2,}/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── X search ──
function xSearchQuery(topics = DEFAULT_TOPICS) {
  const words = (topics.length ? topics : DEFAULT_TOPICS).slice(0, 6).map(t => `"${String(t).replace(/"/g, "")}"`);
  return `(${words.join(" OR ")} OR "you need to know" OR "cheat sheet" OR explained) (trading OR crypto OR bitcoin) has:images -is:retweet -is:reply lang:en`;
}

// Keep posts with a photo and some traction, best first; skip ids we already used.
function rankXPosts(resp, { usedIds = [], minLikes = 20, limit = 8 } = {}) {
  const media = new Map((resp?.includes?.media || []).map(m => [m.media_key, m]));
  const users = new Map((resp?.includes?.users || []).map(u => [u.id, u]));
  const used = new Set(usedIds);
  return (resp?.data || [])
    .filter(t => !used.has(t.id) && !t.possibly_sensitive)
    .map(t => {
      const photo = (t.attachments?.media_keys || []).map(k => media.get(k)).find(m => m && m.type === "photo" && m.url);
      const pm = t.public_metrics || {};
      const score = (pm.like_count || 0) + 2 * (pm.retweet_count || 0) + 3 * (pm.bookmark_count || 0);
      const user = users.get(t.author_id);
      return {
        id: t.id, text: String(t.text || "").slice(0, 600), image: photo?.url || "",
        likes: pm.like_count || 0, score,
        url: `https://x.com/${user?.username || "i"}/status/${t.id}`,
      };
    })
    .filter(c => c.image && c.likes >= minLikes)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── prompts ──
function systemPrompt({ language = "English" } = {}) {
  return `You are the research and content lead for an educational trading and crypto social account.
Every day you find ONE piece of high-performing educational content on social media (X, Instagram, TikTok, YouTube Shorts, Reddit), extract the actual lesson and turn it into the text for a new, clean infographic that our designer renders. You never copy someone's design or branding; you rebuild the knowledge.

The content TYPE we want is text-first educational content: glossaries ("trading terms you need to know"), cheat sheets, step-by-step checklists, rules, patterns explained, "X things every trader should know". Short, scannable, saveable. The reference image in the first message shows the type (not the look).

Research:
- Use web_search to find what is performing right now on Instagram, TikTok, X and YouTube (search e.g. "site:instagram.com trading terms", "tiktok crypto cheat sheet", popular carousels, reels, threads). Use web_fetch to read a promising page.
- X candidates with their images may be attached; read the text inside those images.
- For videos you usually only get the caption, description or a transcript page: extract the lesson from whatever text is available.
- Pick the single best topic that we have NOT covered yet (the list of past topics is given). Prefer evergreen, useful, accurate knowledge.

Accuracy and rights:
- Check every definition and fact; fix mistakes of the source. No price predictions, no financial advice, no promises of profit.
- Write everything in your own words. Never include creator names, @handles, usernames, logos, watermarks, brand or exchange names, links or "follow" credits in the image text.

Design text (rendered exactly as you write it, so spelling matters):
- format: "glossary" (term + short meaning, like "SL" + "Stop Loss"), "steps" (ordered steps), "checklist" (things to check) or "tips" (short heading + one line).
- 5 to 22 items. term max 28 characters, text max 90 characters (glossary meanings short, ideally under 45).
- kicker: 1 to 3 words above the title. title: max 48 characters, punchy. highlight: the word(s) of the title to color. subtitle: optional, max 90 characters. footer: a short save/share nudge, max 40 characters.
- All image text in ${language}. Trading abbreviations stay as they are.

Caption (for Instagram, TikTok and X):
- In ${language}. Hook in the first line, 2 to 5 short lines of value or context, a question or save/share prompt at the end. Max 900 characters.
- NEVER use em dashes or en dashes. Use periods, colons or line breaks instead.
- 5 to 10 relevant hashtags, separately.

Output: after your research, answer with ONLY one JSON object, no prose around it:
{"topic": "...", "format": "glossary|steps|checklist|tips", "kicker": "...", "title": "...", "highlight": "...", "subtitle": "...", "items": [{"term": "...", "text": "..."}], "footer": "...", "caption": "...", "hashtags": ["#..."], "sources": [{"url": "...", "platform": "x|instagram|tiktok|youtube|reddit|web", "note": "what you took from it"}] (only sources you actually used, with the direct URL of the post or article; leave out rejected candidates), "why": "one line: why this topic, what made the source perform"}`;
}

function userPrompt({ focus = "", history = [], xPosts = [], today = "", hasReference = false } = {}) {
  const parts = [];
  if (today) parts.push(`Today is ${today}.`);
  if (hasReference) parts.push("The first image above is the reference for the TYPE of content (text-first educational list). Match the type, not the look.");
  if (focus) parts.push(`Focus for today, from the owner: ${focus}`);
  parts.push(history.length
    ? `Topics already covered (do NOT repeat, pick something clearly different):\n${history.map(h => `- ${h}`).join("\n")}`
    : "Nothing covered yet.");
  if (xPosts.length) {
    parts.push(`X candidates found this morning (${xPosts.length}), best first. Images with [X n] labels are attached where available:\n` +
      xPosts.map((p, i) => `[X ${i + 1}] ${p.likes} likes · ${p.url}\n${p.text}`).join("\n\n"));
  } else {
    parts.push("No X candidates today; rely on web search.");
  }
  parts.push("Research, choose one topic, then answer with the JSON object only.");
  return parts.join("\n\n");
}

// ── response parsing ──
function textOf(content) {
  return (content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

// Last balanced {...} that parses; Claude sometimes thinks out loud before it.
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
        try { const o = JSON.parse(s.slice(start, i + 1)); if (o && typeof o === "object" && Array.isArray(o.items)) best = o; } catch {}
        break;
      }
    }
  }
  if (!best) throw new Error("No design JSON in Claude's answer");
  return best;
}

// A source must point at a post or article, not at a feed like instagram.com/reels/.
function isSpecificUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/.test(u.protocol)) return false;
    const segs = u.pathname.split("/").filter(Boolean);
    return !(segs.length === 0 || (segs.length === 1 && /^(reels?|explore|discover|trending|search|home|feed|shorts|foryou|hashtag|tags?)$/i.test(segs[0])));
  } catch { return false; }
}

function wordTrim(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1).replace(/\s+\S*$/, "");
  return (cut || s.slice(0, max)).replace(/[\s,:;.]+$/, "");
}

function normalizeHashtags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || "").split(/[\s,]+/);
  const out = [];
  for (const t of list) {
    const w = String(t || "").replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (w && !out.some(o => o.toLowerCase() === "#" + w.toLowerCase())) out.push("#" + w);
  }
  return out.slice(0, 12);
}

function normalizeDesign(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Design is not an object");
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map(it => typeof it === "string" ? { term: "", text: it } : it || {})
    .map(it => ({ term: cleanImageText(it.term, 28), text: cleanImageText(it.text, 90) }))
    .filter(it => it.text || it.term)
    .slice(0, 22);
  if (items.length < 3) throw new Error(`Design has only ${items.length} usable items`);
  const title = cleanImageText(raw.title, 60);
  if (!title) throw new Error("Design has no title");
  const highlight = cleanImageText(raw.highlight, 60);
  return {
    topic: wordTrim(cleanImageText(raw.topic || title, 200), 80),
    format: FORMATS.includes(raw.format) ? raw.format : "glossary",
    kicker: cleanImageText(raw.kicker, 30),
    title,
    highlight: highlight && title.toLowerCase().includes(highlight.toLowerCase()) ? highlight : "",
    subtitle: cleanImageText(raw.subtitle, 100),
    items,
    footer: cleanImageText(raw.footer, 44),
    caption: stripDashes(String(raw.caption || "").trim()).slice(0, 1200),
    hashtags: normalizeHashtags(raw.hashtags),
    sources: (Array.isArray(raw.sources) ? raw.sources : [])
      .filter(s => s && isSpecificUrl(s.url))
      .map(s => ({ url: String(s.url).slice(0, 500), platform: PLATFORMS.includes(s.platform) ? s.platform : "web", note: String(s.note || "").slice(0, 200) }))
      .slice(0, 8),
    why: String(raw.why || "").slice(0, 300),
  };
}

function fullCaption(d) {
  return [d.caption, d.hashtags.join(" ")].filter(Boolean).join("\n\n");
}

// Topics of earlier runs, newest first, so Claude does not repeat itself.
function recentTopics(tasks, limit = 40) {
  return (tasks || [])
    .filter(t => t.engine === "edu" && t.status === "completed" && (t.topic || t.description))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map(t => t.topic || t.description);
}

function usedXIds(tasks) {
  return (tasks || []).filter(t => t.engine === "edu").flatMap(t => t.x_ids || []);
}

// ── rendering ──
function fontFace(family, file, weight) {
  const full = path.join(FONTS_DIR, file);
  if (!fs.existsSync(full)) return "";
  return `@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${fs.readFileSync(full).toString("base64")}) format('truetype');font-weight:${weight};font-display:block}`;
}

function titleHtml(title, highlight) {
  if (!highlight) return escHtml(title);
  const i = title.toLowerCase().indexOf(highlight.toLowerCase());
  if (i < 0) return escHtml(title);
  return escHtml(title.slice(0, i)) + `<span class="hl">${escHtml(title.slice(i, i + highlight.length))}</span>` + escHtml(title.slice(i + highlight.length));
}

function itemHtml(it, i, format) {
  const term = escHtml(it.term), text = escHtml(it.text);
  if (format === "glossary") {
    return `<span class="term">${term}</span><span class="arrow">${term ? "→" : ""}</span><span class="text">${text}</span>`;
  }
  const mark = format === "checklist" ? `<span class="badge check">✓</span>` : `<span class="badge">${i + 1}</span>`;
  return `<div class="row n">${mark}<div class="body">${term ? `<div class="head">${term}</div>` : ""}${text ? `<div class="text">${text}</div>` : ""}</div></div>`;
}

// Self-contained HTML (fonts inlined, no external requests, no logo slot).
// A small script shrinks the item font until everything fits the canvas.
function buildHtml(d, { width = 1080, height = 1350, hue = 264, fonts = true } = {}) {
  const h = Number.isFinite(+hue) ? +hue : 264;
  const faces = fonts ? [
    fontFace("Display", "Montserrat-ExtraBold.ttf", 800),
    fontFace("Inter", "Inter-Medium.ttf", 500),
    fontFace("Inter", "Inter-Bold.ttf", 700),
  ].join("") : "";
  const tall = height / width > 1.5;
  // Glossaries: the page tries one and two aligned columns and keeps whichever
  // gives the biggest font with every term on a single line.
  const glossary = d.format === "glossary";
  const startFs = Math.round((tall ? 56 : 48) - Math.max(0, d.items.length - 7) * 0.9);
  const listHtml = glossary
    ? `<div class="gcol">${d.items.map((it, i) => itemHtml(it, i, "glossary")).join("")}</div>`
    : d.items.map((it, i) => itemHtml(it, i, d.format)).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${faces}
:root{--bg:hsl(0 0% 0%);--fg:hsl(210 40% 98%);--card:hsl(0 0% 5%);--muted:hsl(215 20% 65%);--border:hsl(217 32% 20%);
--primary:hsl(${h} 65% 49%);--glow:hsl(${h} 65% 65%);--fs:${startFs}px}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${width}px;height:${height}px;background:var(--bg);overflow:hidden}
body{font-family:'Inter',sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased}
#frame{position:relative;width:${width}px;height:${height}px;padding:${tall ? 150 : 84}px 76px ${tall ? 150 : 72}px;display:flex;flex-direction:column;overflow:hidden;
background:radial-gradient(900px 700px at 100% 0%,hsl(${h} 65% 49% / .38),transparent 60%),radial-gradient(800px 600px at 0% 100%,hsl(${h} 65% 40% / .28),transparent 60%),var(--bg)}
#frame:before{content:"";position:absolute;inset:0;background-image:linear-gradient(hsl(217 32% 20% / .35) 1px,transparent 1px),linear-gradient(90deg,hsl(217 32% 20% / .35) 1px,transparent 1px);background-size:54px 54px;mask-image:radial-gradient(ellipse at 50% 40%,#000 20%,transparent 75%);-webkit-mask-image:radial-gradient(ellipse at 50% 40%,#000 20%,transparent 75%)}
#frame>*{position:relative}
.kicker{align-self:flex-start;font-weight:700;font-size:22px;letter-spacing:.22em;text-transform:uppercase;color:var(--glow);border:1.5px solid hsl(${h} 65% 60% / .55);background:hsl(${h} 65% 49% / .12);padding:10px 20px;border-radius:999px;margin-bottom:28px}
h1{font-family:'Display','Inter',sans-serif;font-weight:800;text-transform:uppercase;font-size:66px;line-height:1.02;letter-spacing:.02em}
h1 .hl{background:linear-gradient(135deg,var(--primary),var(--glow));-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin-top:18px;font-size:27px;line-height:1.35;color:var(--muted);font-weight:500}
.card{margin-top:40px;flex:1 1 auto;min-height:0;background:linear-gradient(180deg,hsl(0 0% 5% / .92),hsl(0 0% 3% / .92));border:1.5px solid var(--border);border-radius:28px;padding:34px 40px;box-shadow:0 8px 32px hsl(0 0% 0% / .6),0 0 60px hsl(${h} 65% 49% / .15);display:flex;flex-direction:column;justify-content:center;overflow:hidden}
#list{display:flex;flex-direction:column;gap:calc(var(--fs) * .42);font-size:var(--fs);line-height:1.2}
#list.gl{flex-direction:row;gap:calc(var(--fs) * 1.2)}
.gcol{flex:1 1 0;min-width:0;display:grid;grid-template-columns:max-content max-content 1fr;column-gap:.4em;row-gap:calc(var(--fs) * var(--rg,.5));align-content:start;align-items:baseline}
.gcol .term{font-weight:700;color:var(--glow)}
.gcol .arrow{color:var(--muted);font-weight:500}
.gcol .text{font-weight:500;line-height:1.2}
.row.n{display:flex;gap:.6em;align-items:flex-start}
.badge{flex:0 0 auto;width:1.55em;height:1.55em;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.72em;font-weight:700;background:linear-gradient(135deg,var(--primary),var(--glow));color:var(--fg);margin-top:.05em}
.badge.check{background:hsl(142 76% 36%)}
.row.n .head{font-weight:700;color:var(--glow)}
.row.n .text{font-weight:500;color:var(--fg);font-size:.86em;line-height:1.3;margin-top:.1em}
.foot{margin-top:30px;display:flex;align-items:center;gap:14px;font-size:24px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.foot .bar{flex:1;height:2px;background:linear-gradient(90deg,var(--primary),transparent)}
</style></head><body><div id="frame">
${d.kicker ? `<div class="kicker">${escHtml(d.kicker)}</div>` : ""}
<h1>${titleHtml(d.title, d.highlight)}</h1>
${d.subtitle ? `<div class="sub">${escHtml(d.subtitle)}</div>` : ""}
<div class="card" id="card"><div id="list"${glossary ? ' class="gl"' : ""}>${listHtml}</div></div>
${d.footer ? `<div class="foot"><span>${escHtml(d.footer)}</span><span class="bar"></span></div>` : ""}
</div><script>
(async()=>{try{await document.fonts.ready}catch(e){}
const card=document.getElementById('card'),list=document.getElementById('list');let fs=${startFs};
const set=v=>{fs=v;document.documentElement.style.setProperty('--fs',v+'px')};
const over=()=>list.scrollHeight>card.clientHeight-68||list.scrollWidth>card.clientWidth-80;
const wraps=()=>[...document.querySelectorAll('.gcol .text,.gcol .term')].some(e=>e.getClientRects().length>1||e.offsetHeight>fs*1.6);
const cells=[...document.querySelectorAll('.gcol > span')];
const layout=n=>{const per=Math.ceil(cells.length/3/n);list.innerHTML='';for(let c=0;c<n;c++){const col=document.createElement('div');col.className='gcol';cells.slice(c*per*3,(c+1)*per*3).forEach(x=>col.appendChild(x));list.appendChild(col)}};
const shrink=floor=>{set(${startFs});while(fs>floor&&(over()||wraps()))set(fs-1);return !over()&&!wraps()};
if(${glossary}){let best=null;
  for(const n of (cells.length/3>=8?[1,2]:[1])){layout(n);const ok=shrink(14);if(!best||(ok&&!best.ok)||(ok===best.ok&&fs>best.fs))best={n,fs,ok}}
  layout(best.n);set(best.fs);
  // Spread the rows over the free height, up to a comfortable gap.
  let g=.5;while(g<1.1&&!over()){g+=.05;document.documentElement.style.setProperty('--rg',g)}if(over())document.documentElement.style.setProperty('--rg',g-.05);
}
while(fs>14&&over())set(fs-1);
window.__fit={fs,overflow:over()};})();
</script></body></html>`;
}

let _browser = null;
async function browser() {
  if (!_browser || !_browser.isConnected()) {
    const { chromium } = require("playwright");
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}

async function render(d, outFile, { size = "portrait", hue = 264 } = {}) {
  const dim = SIZES[size] || SIZES.portrait;
  const page = await (await browser()).newPage({ viewport: { width: dim.width, height: dim.height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(buildHtml(d, { ...dim, hue }), { waitUntil: "load" });
    await page.waitForFunction(() => window.__fit, null, { timeout: 15000 });
    const fit = await page.evaluate(() => window.__fit);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile, type: "png" });
    return { ...dim, size, fit };
  } finally {
    await page.close().catch(() => {});
  }
}

function sizesFor(value) {
  const list = String(value || "portrait").split(/[+,\s]+/).filter(s => SIZES[s]);
  return list.length ? [...new Set(list)] : ["portrait"];
}

module.exports = {
  MODEL, MAX_SEARCHES, MAX_FETCHES, MAX_X_IMAGES, FORMATS, SIZES, DEFAULT_TOPICS,
  stripDashes, cleanImageText, isSpecificUrl, wordTrim, xSearchQuery, rankXPosts, systemPrompt, userPrompt,
  textOf, extractJson, normalizeDesign, normalizeHashtags, fullCaption, recentTopics, usedXIds,
  buildHtml, render, sizesFor,
};
