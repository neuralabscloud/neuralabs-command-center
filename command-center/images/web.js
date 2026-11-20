// Web media resolver for news card hook slides (accounts with image_policy.kind: web; Slabhaus only).
// The hook shows the actual card, slab, product or event of the story, taken from existing images online, like a
// news account does, with a credit line and full source logging. gh0stlayer keeps images/policy.js unchanged.
//
// Order per slot (signal: hook; versus: left + right):
//   1 article   og:image, twitter:image and the largest in-article images of the picked story (srcset largest,
//               resize parameters stripped, original preferred)
//   2 coverage  the same from other outlets covering the same story (item.trend.related from the trending matcher)
//   3 search    image search by subject (provider in the account YAML, key in .env; google_cse or brave)
//   4 card_db   card scan from the NeuraCollectibles card database, whole card in the virtual slab frame with the real
//               grade from the story (or no grade); only for stories about one specific card
//   5 set_art   set logo from the card database for set and era stories: on top of a photo from 1 to 3, or alone
// Nothing from 1 to 5 = NoImageError: the set stops and the owner is notified. No Nano Banana, no empty slab pattern.
//
// Every candidate: blocklisted domain or same image URL used in the last 30 days = skip; https + public IP on every
// hop; png/jpeg/webp only; long side >= 1000 px; not blurry (Laplacian); not mostly text; then the vision model
// answers "does this image show <subject>?" plus kind (photo, screenshot, meme, collage...), grade label and the
// subject bounding box. Crop around the subject (4:5 hook, 1:1.5 versus), never stretch. Subject filling >= 40% wins.
// Every used image: one line in data/slabhaus/image_log.jsonl. Rejections: <data_dir>/images/index.jsonl.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const policy = require("./policy");

const ROOT = path.join(__dirname, "..");
const INSPECT = path.join(__dirname, "inspect.py");
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const MAX_BYTES = 15e6;
const STOCK = /(getty|shutterstock|alamy|istock|dreamstime|depositphotos|123rf|adobe ?stock)/i;
const BAD_KINDS = ["screenshot", "social_post", "meme", "collage", "text_graphic", "diagram"];

class NoImageError extends Error { constructor(msg, steps) { super(msg); this.code = "NO_IMAGE"; this.steps = steps; } }

// ---------- config ----------
function settings(A) {
  const w = ((A.profile || {}).image_policy || {}).web || {};
  const abs = p => path.isAbsolute(p) ? p : path.join(ROOT, p);
  return {
    min_long_side: Number(w.min_long_side) || 1000,
    blur_min: Number(w.blur_min) || 60,
    text_max: Number(w.text_max) || 0.25,
    fill_pref: Number(w.fill_pref) || 0.4,
    rotation_days: Number(w.rotation_days) || 30,
    max_vision: Number(w.max_vision_per_slot) || 8,
    max_candidates: Number(w.max_candidates_per_step) || 12,
    vision_model: process.env.SLABHAUS_VISION_MODEL || w.vision_model || "claude-sonnet-5-5",
    search: { provider: "none", ...(w.search || {}) },
    prefer_domains: (w.prefer_domains || []).map(String),
    avoid_domains: (w.avoid_domains || []).map(String),
    card_db_hosts: (w.card_db_hosts || ["images.scrydex.com", "images.pokemontcg.io"]).map(String),
    blocklist: abs(w.blocklist || "data/slabhaus/image_blocklist.yaml"),
    log: abs(w.log || "data/slabhaus/image_log.jsonl"),
    takedown_log: abs(w.takedown_log || "data/slabhaus/takedown_log.jsonl"),
    takedown_repost: w.takedown_repost === true,
  };
}

// ---------- blocklist + image log ----------
const domainOf = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const domainIn = (d, list) => !!d && list.some(x => { x = String(x).toLowerCase().replace(/^www\./, ""); return d === x || d.endsWith(`.${x}`); });
function readBlocklist(file) {
  // Own line reader: "domains:" followed by "- domain   # note" items, or an inline ["a", "b"] list.
  let txt;
  try { txt = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  let inList = false;
  for (const raw of txt.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    const top = line.match(/^domains:\s*(.*)$/);
    if (top) { inList = true; if (top[1].trim().startsWith("[")) for (const x of top[1].replace(/[\[\]]/g, "").split(",")) out.push(x); continue; }
    if (/^\S/.test(line)) { inList = false; continue; }
    const it = inList && line.match(/^\s*-\s*(.+)$/);
    if (it) out.push(it[1]);
  }
  return [...new Set(out.map(x => String(x).trim().replace(/^["']|["']$/g, "").toLowerCase().replace(/^www\./, "")).filter(x => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)))];
}
function addToBlocklist(file, domain, note = "") {
  const list = readBlocklist(file);
  domain = String(domain || "").toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || list.includes(domain)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "# Slabhaus image blocklist. The web image resolver (images/web.js) skips these domains.\n# Takedowns add lines here automatically (cards takedown --set <id>).\ndomains:\n");
  else {
    // An empty inline list ("domains: []") cannot take appended items: turn it into a block list first.
    const cur = fs.readFileSync(file, "utf8");
    if (/^domains:[ \t]*\[[ \t]*\][ \t]*$/m.test(cur)) fs.writeFileSync(file, cur.replace(/^domains:[ \t]*\[[ \t]*\][ \t]*$/m, "domains:"));
    else if (!/^domains:/m.test(cur)) fs.appendFileSync(file, `${cur.endsWith("\n") || !cur ? "" : "\n"}domains:\n`);
  }
  fs.appendFileSync(file, `  - ${JSON.stringify(domain)}${note ? `   # ${String(note).replace(/[\r\n]/g, " ").slice(0, 120)}` : ""}\n`);
  return true;
}
function readLog(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function appendLog(file, rec) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(rec) + "\n"); }
// Image URLs used on a live set in the last N days (dry runs do not count, takedowns do).
function recentlyUsed(file, days, now = Date.now(), exceptSet = null) {
  const cut = now - days * 864e5;
  const rows = readLog(file);
  // A set that failed (no image for another slot) never posted: its picks are released and may be used again.
  const released = new Set(rows.filter(r => r.action === "released").map(r => r.set_id));
  return new Set(rows.filter(r => (r.action || "used") === "used" && !r.dry_run && r.set_id !== exceptSet && !released.has(r.set_id) && Date.parse(r.used_at) >= cut).map(r => r.image_url));
}

// ---------- safe fetch (any public host, https only, every hop checked) ----------
async function safeFetch(url, { accept, maxBytes, timeout = 20000, fetchImpl = fetch, lookup } = {}) {
  let u = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (u.protocol !== "https:") throw new Error(`alleen https (${u.protocol})`);
    await policy.assertPublicHost(u.hostname, lookup);
    const res = await fetchImpl(u.toString(), { redirect: "manual", headers: { "user-agent": BROWSER_UA, accept }, signal: AbortSignal.timeout(timeout) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") || 0) > maxBytes) throw new Error("te groot");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("te groot");
    return { buf, type: String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), final_url: u.toString() };
  }
  throw new Error("te veel redirects");
}
async function getPage(url, io = {}) {
  const r = await (io.safeFetch || safeFetch)(url, { accept: "text/html,application/xhtml+xml", maxBytes: 4e6, ...io });
  if (!/html|xml/.test(r.type)) throw new Error(`geen html (${r.type})`);
  return { html: r.buf.toString("utf8"), final_url: r.final_url };
}
async function downloadImage(url, io = {}) {
  const r = await (io.safeFetch || safeFetch)(url, { accept: "image/png,image/jpeg,image/webp", maxBytes: MAX_BYTES, ...io });
  const m = r.buf.subarray(0, 12);
  const real = m[0] === 0x89 && m[1] === 0x50 ? "image/png" : m[0] === 0xff && m[1] === 0xd8 ? "image/jpeg"
    : m.subarray(0, 4).toString() === "RIFF" && m.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
  if (!real) throw new Error(`geen png/jpeg/webp (${r.type || "onbekend"})`);   // also rejects SVG and GIF
  return { buf: r.buf, ext: TYPES[real], final_url: r.final_url };
}

// ---------- page parsing ----------
const decode = s => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const attr = (tag, name) => decode((tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i")) || [])[1]);
function abs(u, base) { try { const x = new URL(decode(u), base); return x.protocol === "https:" || x.protocol === "http:" ? x.toString().replace(/^http:/, "https:") : null; } catch { return null; } }

// Original instead of a resized CDN variant. Returns [best guess, ...fallbacks], original URL last.
function upgradeUrl(url) {
  let out = [];
  try {
    const u = new URL(url);
    let p = u.pathname;
    p = p.replace(/-\d{2,4}x\d{2,4}(?=\.(jpe?g|png|webp)$)/i, "");            // WordPress -300x200
    p = p.replace(/-scaled(?=\.(jpe?g|png|webp)$)/i, "");                     // WordPress -scaled
    p = p.replace(/_\d{2,4}x\d{0,4}(?=\.(jpe?g|png|webp)$)/i, "");             // Shopify _600x
    p = p.replace(/\/s-l\d{2,4}(\.\w+)$/i, "/s-l1600$1");                      // eBay
    if (/googleusercontent|ggpht|blogger/.test(u.hostname)) p = p.replace(/\/[swh]\d{2,4}(-[a-z0-9-]+)?\//i, "/s0/").replace(/=[swh]\d{2,4}[^/]*$/i, "=s0");
    const drop = ["w", "h", "width", "height", "resize", "fit", "quality", "q", "crop", "dpr", "auto", "fm", "format", "ssl", "strip", "lossy", "size", "sz", "im", "tr", "enable", "enable-io", "upscale", "scale"];   // enable=upscale (Fastly IO): fake resolution
    const u2 = new URL(u.toString()); u2.pathname = p;
    for (const k of [...u2.searchParams.keys()]) if (drop.includes(k.toLowerCase())) u2.searchParams.delete(k);
    out.push(u2.toString());
    const u3 = new URL(u.toString()); u3.pathname = p; out.push(u3.toString());
  } catch {}
  out.push(url);
  return [...new Set(out)];
}
function largestFromSrcset(srcset, base) {
  const parts = String(srcset || "").split(/,\s+(?=\S)/).map(s => s.trim().split(/\s+/)).filter(x => x[0]);
  let best = null, bw = -1;
  for (const [u, d] of parts) { const w = /(\d+)w/.test(d || "") ? Number(RegExp.$1) : /([\d.]+)x/.test(d || "") ? Number(RegExp.$1) * 1000 : 0; if (w > bw) { bw = w; best = u; } }
  return best ? { url: abs(best, base), width: bw > 0 && bw < 1000 * 50 ? bw : null } : null;
}
// Credit: the outlet/publisher/marketplace/auction house, or a photographer when the page names one near the image.
function pageCredit(html, pageUrl) {
  const metas = String(html).match(/<meta\b[^>]*>/gi) || [];
  const meta = k => { for (const t of metas) { const key = (attr(t, "property") || attr(t, "name")).toLowerCase(); if (key === k) return attr(t, "content"); } return ""; };
  let publisher = meta("og:site_name") || meta("application-name");
  if (!publisher) { const m = String(html).match(/"publisher"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]{2,60})"/); if (m) publisher = decode(m[1]); }
  const fig = String(html).match(/(?:[Pp]hoto|PHOTO|[Ii]mage|[Pp]icture)\s*(?:[Cc]redit|[Bb]y|[Vv]ia|[Cc]ourtesy(?: of)?)\s*[:\-]?\s*([A-Z][\w&.' ]{1,40}?)(?=\s*(?:<|$|[.,;|/]))/);
  const photographer = fig ? fig[1].trim().replace(/[.\s]+$/, "") : "";
  return { publisher: publisher.slice(0, 60), photographer: photographer.slice(0, 40), domain: domainOf(pageUrl) };
}
// og:image, twitter:image, then in-article <img> (srcset largest), ranked by declared size. Skips logos, icons, avatars.
function pageImages(html, pageUrl) {
  const out = [];
  const add = (u, how, w = null, h = null) => { const a = abs(u, pageUrl); if (a && !out.some(x => x.url === a)) out.push({ url: a, how, width: w, height: h }); };
  const metas = String(html).match(/<meta\b[^>]*>/gi) || [];
  for (const want of ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]) {
    for (const t of metas) { const key = (attr(t, "property") || attr(t, "name")).toLowerCase(); if (key === want && attr(t, "content")) add(attr(t, "content"), want); }
  }
  const body = (String(html).match(/<article\b[\s\S]*?<\/article>/i) || String(html).match(/<main\b[\s\S]*?<\/main>/i) || [String(html)])[0];
  const imgs = [];
  for (const t of body.match(/<img\b[^>]*>/gi) || []) {
    const src = attr(t, "data-src") || attr(t, "data-lazy-src") || attr(t, "data-original") || attr(t, "src");
    const ss = largestFromSrcset(attr(t, "data-srcset") || attr(t, "srcset"), pageUrl);
    const u = (ss && ss.url) || abs(src, pageUrl);
    if (!u || /^data:/.test(u) || /\.(svg|gif)(\?|$)/i.test(u)) continue;
    if (/(logo|icon|avatar|sprite|emoji|badge|banner-ad|gravatar|pixel|spacer|placeholder)/i.test(u + " " + attr(t, "class") + " " + attr(t, "alt"))) continue;
    const w = Number(attr(t, "width")) || (ss && ss.width) || 0, h = Number(attr(t, "height")) || 0;
    if (w && w < 300) continue;
    imgs.push({ u, w, h });
  }
  imgs.sort((a, b) => (b.w * (b.h || b.w)) - (a.w * (a.h || a.w)));
  for (const i of imgs.slice(0, 8)) add(i.u, "article_img", i.w || null, i.h || null);
  return out;
}

// ---------- subject ----------
const GRADE_RE = /\b(PSA|CGC|BGS|TAG|SGC|Beckett)\s?(\d{1,2}(?:\.\d)?)\b/;
// What the slot must show. Heuristics from the item, refined by the LLM (one small JSON call per set).
async function subjectFor({ item, card, layout, slot, llm }) {
  const text = [card?.headline && String(card.headline).replace(/\[\/?[ap]\]/g, ""), item.title, item.summary].filter(Boolean).join(" ");
  const g = text.match(GRADE_RE);
  const base = {
    type: item.card ? "card" : null,
    card: item.card?.name || null, set: item.card?.set_name || null,
    grader: g ? g[1].toUpperCase().replace("BECKETT", "BGS") : null, grade: g ? g[2] : null, event: null, product: null,
  };
  let s = { ...base };
  if (llm) {
    const side = layout === "versus" ? card?.versus?.[slot] : null;
    const sys = "You pick the photo subject for a Pokémon TCG news card. Reply with JSON only, no prose.";
    const user = [
      `Story title: ${item.title}`, item.summary ? `Summary: ${String(item.summary).slice(0, 600)}` : "",
      card?.headline ? `Card headline: ${String(card.headline).replace(/\[\/?[ap]\]/g, "")}` : "",
      side ? `This image is the ${slot} half of a then-vs-now card: ${side.label} = ${side.value} ${side.unit || ""}` : "",
      item.card ? `Card in the data: ${item.card.name} (${item.card.set_name || "?"})` : "",
      'JSON: {"type":"card|set|grading|product|event","card":null|"card name as printed incl. ex/V/VMAX and variant like alt art","set":null|"set name","grader":null|"PSA|CGC|BGS|TAG|SGC","grade":null|"10","event":null|"event name","product":null|"sealed product name"}',
      "type card = the story is about one specific card; set = a set or era (release, set index, launch); grading = a grading company or slabs in general; product = a sealed product; event = a tournament, show or auction event. Use names from the text; when the text clearly points at one set or product without naming it (e.g. the first Japanese set for a 1996 Japan launch), you may name that set. A grade only if the text names it.",
    ].filter(Boolean).join("\n");
    try {
      const raw = await llm(sys, user);
      const j = JSON.parse(String(raw).slice(String(raw).indexOf("{"), String(raw).lastIndexOf("}") + 1));
      const val = v => v == null || /^(null|none|n\/a|unknown|)$/i.test(String(v).trim()) ? null : String(v).trim();
      for (const k of Object.keys(base)) if (val(j[k]) && (base[k] == null || k === "type")) s[k] = val(j[k]);
      if (item.card) { s.card = item.card.name; s.set = item.card.set_name || s.set; }
    } catch {}
  }
  if (!s.type) s.type = s.card ? "card" : s.grader && !s.set ? "grading" : s.set ? "set" : s.event ? "event" : "product";
  if (!["card", "set", "grading", "product", "event"].includes(s.type)) s.type = "product";
  if (s.type === "card" && !s.card) s.type = s.set ? "set" : "product";
  if (s.type === "set" && !s.set) s.type = s.product ? "product" : s.event ? "event" : "product";
  if (s.type === "event" && !s.event) s.type = "product";
  if (s.type === "product" && !s.product && !s.set) s.product = s.card || String(item.title || "").slice(0, 80);
  return { ...s, query: searchQuery(s), label: subjectLabel(s) };
}
function searchQuery(s) {
  const gr = s.grader && s.grade ? `${s.grader} ${s.grade}` : "";
  if (s.type === "card") return [s.card, s.set, gr].filter(Boolean).join(" ");
  if (s.type === "set") return `${s.set || s.product} booster box`;
  if (s.type === "grading") return `${s.grader || "graded"} slab${s.card ? ` ${s.card}` : ""}`;
  if (s.type === "event") return s.event || s.product || "";
  return s.product || s.set || s.card || "";
}
function subjectLabel(s) {
  const gr = s.grader && s.grade ? ` (a ${s.grader} ${s.grade} slab or the raw card)` : "";
  if (s.type === "card") return `the Pokémon card "${s.card}"${s.set ? ` from the set ${s.set}` : ""}${gr}`;
  if (s.type === "set") return `the Pokémon TCG set "${s.set || s.product}": its sealed product (booster box, packs, ETB), its cards or its logo`;
  if (s.type === "grading") return `a ${s.grader || "graded"} graded card slab${s.card ? ` of ${s.card}` : ""}`;
  if (s.type === "event") return `the event "${s.event || s.product}" (venue, stage, booth or players at that event)`;
  return `the Pokémon TCG product "${s.product || s.set}"`;
}

// ---------- python helpers ----------
function runPy(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile("python3", ["-I", "-S", INSPECT, ...args.map(String)], { timeout, maxBuffer: 1e6 }, (err, stdout) => {
      let j = null;
      try { j = JSON.parse(String(stdout || "").trim().split("\n").pop()); } catch {}
      if (!j) return reject(new Error(err ? err.message.slice(0, 160) : "geen uitvoer van inspect.py"));
      if (j.error) return reject(new Error(j.error));
      resolve(j);
    });
  });
}

// ---------- vision ----------
let _anthropic = null;
function defaultVision(model) {
  return async (jpegPath, prompt) => {
    if (!_anthropic) { const Anthropic = require("@anthropic-ai/sdk"); _anthropic = new (Anthropic.default || Anthropic)(); }
    const msg = await _anthropic.messages.create({
      model, max_tokens: 600,
      system: "You check press photos for a Pokémon TCG news account. Reply with one JSON object only.",
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(jpegPath).toString("base64") } },
        { type: "text", text: prompt },
      ] }],
    });
    return (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  };
}
function visionPrompt(subject) {
  return [
    `Question: does this image show ${subject.label}? Answer strictly: the subject must be clearly visible, not just mentioned in text.`,
    subject.grade ? `The story names grade ${subject.grader || ""} ${subject.grade}. If a grading label is readable, report its grader and grade.` : "",
    'JSON: {"shows_subject":true|false,"reason":"max 15 words","kind":"photo|product_render|card_scan|illustration|screenshot|social_post|meme|collage|text_graphic|diagram",',
    '"grade_label":null|"PSA 10","people_main_subject":true|false,"plain_background":true|false,',
    '"subject_bbox":[x0,y0,x1,y1] as fractions 0..1 of width and height around the subject (the card, slab, product or event scene),"subject_fill":0..1 share of the frame the subject covers}',
    "plain_background = one card, slab or product on a plain studio or single-colour background. collage = several separate photos combined. screenshot = a captured app, web page or social post.",
  ].filter(Boolean).join("\n");
}
function parseVision(raw) {
  const s = String(raw || "");
  const j = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
  const bb = Array.isArray(j.subject_bbox) && j.subject_bbox.length === 4 ? j.subject_bbox.map(Number) : [0, 0, 1, 1];
  return { ...j, shows_subject: j.shows_subject === true, subject_bbox: bb.map(v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))), subject_fill: Math.max(0, Math.min(1, Number(j.subject_fill) || 0)) };
}
const normGrade = s => String(s || "").toUpperCase().replace(/BECKETT/, "BGS").replace(/\s+/g, " ").replace(/GEM\s*(MT|MINT)\s*/, "").trim();
function gradeMatches(subject, v) {
  if (!subject.grade || !v.grade_label) return { ok: true, note: subject.grade ? "geen gradelabel leesbaar" : "geen grade in het verhaal" };
  const want = normGrade(`${subject.grader || ""} ${subject.grade}`), got = normGrade(v.grade_label);
  const num = x => (x.match(/\d+(\.\d)?/) || [""])[0];
  const graderOk = !subject.grader || got.includes(subject.grader.toUpperCase());
  return num(got) === num(want) && graderOk ? { ok: true, note: `label ${v.grade_label}` } : { ok: false, note: `label ${v.grade_label}, verhaal ${want}` };
}

// ---------- search providers ----------
// google_cse: Custom Search JSON API (closed to new customers, off on 2027-01-01). brave: Brave Search image API.
// Keys only in .env (names in the account YAML), sent in headers, never in the URL.
async function searchImages(cfg, query, { fetchImpl = fetch, env = process.env } = {}) {
  const sc = cfg.search || {};
  const p = String(sc.provider || "none");
  if (!query) return { provider: p, results: [], note: "geen zoekvraag" };
  if (p === "google_cse") {
    const key = env[sc.key_env || "GOOGLE_CSE_KEY"], cx = env[sc.cx_env || "GOOGLE_CSE_CX"];
    if (!key || !cx) return { provider: p, results: [], note: `niet geconfigureerd (${sc.key_env || "GOOGLE_CSE_KEY"} / ${sc.cx_env || "GOOGLE_CSE_CX"} ontbreekt in .env)` };
    const q = new URLSearchParams({ cx, q: query, searchType: "image", num: "10", imgSize: "xlarge", safe: "active" });
    const r = await fetchImpl(`https://customsearch.googleapis.com/customsearch/v1?${q}`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`google_cse HTTP ${r.status}: ${d.error?.message || ""}`.slice(0, 200));
    return { provider: p, results: (d.items || []).map(i => ({ image_url: i.link, page_url: i.image?.contextLink, width: i.image?.width, height: i.image?.height, title: i.title, domain: domainOf(i.image?.contextLink || i.link) })) };
  }
  if (p === "brave") {
    const key = env[sc.key_env || "BRAVE_SEARCH_KEY"];
    if (!key) return { provider: p, results: [], note: `niet geconfigureerd (${sc.key_env || "BRAVE_SEARCH_KEY"} ontbreekt in .env)` };
    const q = new URLSearchParams({ q: query, count: "30", safesearch: "strict" });
    const r = await fetchImpl(`https://api.search.brave.com/res/v1/images/search?${q}`, { headers: { "X-Subscription-Token": key, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`brave HTTP ${r.status}`);
    return { provider: p, results: (d.results || []).map(i => ({ image_url: i.properties?.url, page_url: i.url, width: i.properties?.width || null, height: i.properties?.height || null, title: i.title, domain: domainOf(i.url || i.properties?.url) })).filter(x => x.image_url) };
  }
  return { provider: p, results: [], note: "geen zoekprovider ingesteld (image_policy.web.search.provider)" };
}
// Above 1200 px, preferred domains (TCG outlets, marketplaces, auction houses, graders) first, forums last.
function rankSearch(results, cfg) {
  const score = r => {
    const long = Math.max(Number(r.width) || 0, Number(r.height) || 0);
    return (long >= 1200 ? 3 : long >= 1000 ? 1 : long ? -3 : 0) + (domainIn(r.domain, cfg.prefer_domains) ? 4 : 0) - (domainIn(r.domain, cfg.avoid_domains) ? 6 : 0);
  };
  return results.map((r, i) => ({ r, s: score(r), i })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.r);
}

// ---------- one candidate ----------
async function evaluate({ c, subject, cfg, S, ctx, io, aspect }) {
  const base = { account: ctx.account, set_id: ctx.setId, slot: ctx.slot, step: c.step, image_url: c.image_url, source_page_url: c.page_url || null, source_domain: domainOf(c.page_url || c.image_url), search_query: c.search_query || null, fetched_at: new Date().toISOString() };
  const reject = (reasons, extra = {}) => { S.record({ ...base, ...extra, status: "rejected", reasons }); return { ok: false, reasons }; };
  let dl = null, tried = [];
  for (const u of c.step === "card_db" || c.step === "set_art" ? [c.image_url] : upgradeUrl(c.image_url)) {
    try { dl = await (io.downloadImage || downloadImage)(u, io); dl.url = u; break; } catch (e) { tried.push(`${u === c.image_url ? "origineel" : "upgrade"}: ${e.message}`); }
  }
  if (!dl) return reject([`download: ${tried.join("; ").slice(0, 200)}`]);
  const id = crypto.createHash("sha1").update(dl.url).digest("hex").slice(0, 16);
  const file = path.join(S.dir, `${id}${dl.ext}`);
  fs.writeFileSync(file, dl.buf);
  const drop = () => fs.rmSync(file, { force: true });
  let info;
  try { info = await (io.inspectWeb || (f => runPy(["web", f])))(file); } catch (e) { drop(); return reject([`inspect: ${e.message}`]); }
  const errs = [];
  const long = Math.max(info.width || 0, info.height || 0);
  if (c.step !== "set_art" && long < cfg.min_long_side) errs.push(`te klein (${long} px)`);
  if (c.step !== "card_db" && c.step !== "set_art") {
    if (info.blur >= 0 && info.blur < cfg.blur_min) errs.push(`onscherp (Laplacian ${info.blur} < ${cfg.blur_min})`);
    if (info.text_ratio > cfg.text_max) errs.push(`vooral tekst (${Math.round(info.text_ratio * 100)}% tekstvlak)`);
  }
  const stock = (info.watermark || []).filter(t => STOCK.test(t));
  if (stock.length) errs.push(`stock-watermerk: ${stock.join(", ")}`);
  if (errs.length) { drop(); return reject(errs, { image_url: dl.url, checks: info }); }
  if (ctx.visionCalls.n >= cfg.max_vision) { drop(); return { ok: false, reasons: ["vision-budget op"], budget: true }; }
  ctx.visionCalls.n++;
  let v;
  const thumb = path.join(S.dir, `${id}-vision.jpg`);
  try {
    await (io.thumb || ((a, b) => runPy(["thumb", a, b, 1024])))(file, thumb);
    v = parseVision(await (io.vision || defaultVision(cfg.vision_model))(thumb, visionPrompt(subject)));
  } catch (e) { drop(); fs.rmSync(thumb, { force: true }); return reject([`vision: ${e.message.slice(0, 160)}`], { image_url: dl.url, checks: info }); }
  fs.rmSync(thumb, { force: true });
  const vErr = [];
  if (!v.shows_subject) vErr.push(`toont het onderwerp niet (${v.reason || "nee"})`);
  if (BAD_KINDS.includes(v.kind)) vErr.push(`soort ${v.kind}`);
  if (v.people_main_subject && subject.type !== "event") vErr.push("mensen zijn het hoofdonderwerp");
  const gm = gradeMatches(subject, v);
  if (subject.type === "card" && !gm.ok) vErr.push(`grade klopt niet (${gm.note})`);
  const check = { model: cfg.vision_model, question: `does this image show ${subject.label}?`, answer: v.shows_subject ? "yes" : "no", reason: v.reason || null, kind: v.kind, grade_check: gm.note, subject_fill: v.subject_fill, plain_background: !!v.plain_background };
  if (vErr.length) { drop(); return reject(vErr, { image_url: dl.url, checks: info, subject_check: check }); }
  return { ok: true, id, file, ext: dl.ext, image_url: dl.url, info, vision: v, check, base: { ...base, image_url: dl.url } };
}

// Crop around the subject: 4:5 hook, 1:1.5 versus half; plain-background object = tight crop (shown at 60% height).
async function prepare({ hit, layout, S, io }) {
  const v = hit.vision;
  const object = layout === "signal" && !!v.plain_background && hit.base.step !== "set_art";
  const mode = hit.base.step === "card_db" ? "object" : object ? "object" : "photo";
  if (hit.base.step === "card_db" || hit.base.step === "set_art") return { file: hit.file, mode: hit.base.step === "set_art" ? "logo" : "object", crop: null };
  const aspect = object ? "object" : layout === "versus" ? String(1 / 1.5) : String(4 / 5);
  const out = path.join(S.dir, `${hit.id}-${object ? "obj" : layout === "versus" ? "2x3" : "4x5"}.png`);
  const r = await (io.crop || ((...a) => runPy(["crop", ...a])))(hit.file, out, ...v.subject_bbox, aspect);
  return { file: out, mode, crop: { aspect: object ? "object" : layout === "versus" ? "1:1.5" : "4:5", ...r } };
}

function creditName(page, c) {
  if (c.credit) return c.credit;
  if (page?.photographer && page?.publisher) return `${page.photographer} / ${page.publisher}`;
  return page?.photographer || page?.publisher || c.domain || domainOf(c.page_url || c.image_url);
}

// ---------- one slot ----------
// ctx: {account, setId, slot, dryRun, item, card, layout, llm, cardImage, setArt, excludeUrls, log}
// Returns {file, mode, logo?, record}. Throws NoImageError when nothing from 1 to 5 resolves.
async function resolveSlot({ A, item, card, layout, slot, setId, dataDir, ctx = {}, io = {} }) {
  const cfg = settings(A);
  const S = policy.store(path.join(dataDir, "images"));
  const steps = [];
  const note = (step, result) => { steps.push({ step, result }); ctx.log?.(`beeld ${slot} ${step}: ${String(result).slice(0, 160)}`); };
  const subject = ctx.subject || await subjectFor({ item, card, layout, slot, llm: ctx.llm });
  note("subject", `${subject.type}: ${subject.label}`);
  const blocked = readBlocklist(cfg.blocklist);
  const recent = recentlyUsed(cfg.log, cfg.rotation_days, Date.now(), setId);
  const exclude = new Set([...(ctx.excludeUrls || []), ...(ctx.usedInSet || [])]);
  const vctx = { account: A.id, setId, slot, visionCalls: { n: 0 } };
  const seen = new Set();
  const alternates = [];
  let photo = null, backup = null;

  const filter = (list, step) => list.filter(c => {
    if (!c.image_url || seen.has(c.image_url)) return false;
    seen.add(c.image_url);
    const d = domainOf(c.page_url || c.image_url), di = domainOf(c.image_url);
    if (domainIn(d, blocked) || domainIn(di, blocked)) { S.record({ step, image_url: c.image_url, source_domain: d, set_id: setId, status: "rejected", reasons: ["domein op de blocklist"] }); return false; }
    if (exclude.has(c.image_url)) return false;
    if (recent.has(c.image_url)) { S.record({ step, image_url: c.image_url, set_id: setId, status: "rejected", reasons: [`al gebruikt in de laatste ${cfg.rotation_days} dagen`] }); return false; }
    return true;
  });
  async function tryList(list, step) {
    for (const c of list.slice(0, cfg.max_candidates)) {
      const r = await evaluate({ c, subject, cfg, S, ctx: vctx, io });
      if (r.budget) { note(step, "vision-budget op"); return true; }
      if (!r.ok) continue;
      r.candidate = c;
      if (r.vision.subject_fill >= cfg.fill_pref || subject.type === "event") { if (backup) alternates.push(backup.image_url); photo = r; return true; }
      if (!backup || r.vision.subject_fill > backup.vision.subject_fill) { if (backup) alternates.push(backup.image_url); backup = r; }
      else alternates.push(r.image_url);
    }
    return false;
  }
  async function fromPages(pages, step) {
    const list = [];
    for (const pg of pages) {
      try {
        const { html, final_url } = await (io.getPage || getPage)(pg.url, io);
        const credit = pageCredit(html, final_url);
        for (const im of pageImages(html, final_url)) list.push({ step, image_url: im.url, page_url: final_url, how: im.how, page_credit: credit, domain: credit.domain });
      } catch (e) { note(step, `pagina ${domainOf(pg.url)}: ${e.message.slice(0, 100)}`); }
    }
    return filter(list, step);
  }

  // 1 article
  if (item.url && /^https:\/\//.test(item.url) && (item.kind === "news" || item.kind === "evergreen")) {
    const list = await fromPages([{ url: item.url }], "article");
    note("article", `${list.length} kandidaten`);
    if (list.length && await tryList(list, "article")) {}
  } else note("article", item.url ? "geen artikel (data-item van de NC API)" : "item zonder URL");
  // 2 coverage
  if (!photo) {
    const rel = ((item.trend || {}).related || []).filter(r => r.url && r.url !== item.url).slice(0, 4);
    if (rel.length) {
      const list = await fromPages(rel, "coverage");
      note("coverage", `${rel.length} andere outlets, ${list.length} kandidaten`);
      await tryList(list, "coverage");
    } else note("coverage", "geen andere outlets met hetzelfde verhaal");
  }
  // 3 search
  let searchInfo = null;
  if (!photo) {
    try {
      const sr = await (io.searchImages || searchImages)(cfg, subject.query, io);
      searchInfo = { provider: sr.provider, query: subject.query, results: sr.results.length, note: sr.note || null };
      if (sr.note) note("search", sr.note);
      const list = filter(rankSearch(sr.results, cfg).map(r => ({ step: "search", image_url: r.image_url, page_url: r.page_url, domain: r.domain, search_query: subject.query, width: r.width, height: r.height })), "search");
      if (sr.results.length) note("search", `${sr.provider} "${subject.query}": ${sr.results.length} resultaten, ${list.length} na filters`);
      // Credit for search hits: the context page's publisher (one page read for the chosen hit, below).
      await tryList(list, "search");
    } catch (e) { note("search", `fout: ${e.message.slice(0, 160)}`); }
  }
  if (!photo && backup) { photo = backup; note(photo.base.step, `beste foto onder ${Math.round(cfg.fill_pref * 100)}% vulling gekozen (${Math.round(photo.vision.subject_fill * 100)}%)`); }

  // 4 card_db (only when no photo, story about one specific card)
  let chosen = photo;
  if (!chosen && subject.type === "card" && ctx.cardImage) {
    try {
      const hit = await ctx.cardImage(item.card || { name: subject.card, set_name: subject.set });
      if (!hit?.image_url) note("card_db", `kaart ${subject.card} niet in de kaartdatabase`);
      else if (!domainIn(domainOf(hit.image_url), cfg.card_db_hosts)) note("card_db", `beeldhost ${domainOf(hit.image_url)} niet toegestaan`);
      else {
        const c = { step: "card_db", image_url: hit.image_url, page_url: hit.source_page_url, credit: domainOf(hit.image_url).replace(/^images\./, "").replace(/\.(io|com)$/, "") };
        const r = filter([c], "card_db").length ? await evaluate({ c, subject: { ...subject, grade: null }, cfg, S, ctx: vctx, io }) : { ok: false, reasons: ["uitgesloten"] };
        if (r.ok) {
          const out = path.join(S.dir, `${r.id}-slab.png`);
          const grade = subject.grader && subject.grade ? `${subject.grader} ${subject.grade}` : "";
          await (io.composeSlab || ((a, b, n, g) => runPy(["slab", a, b, n, g])))(r.file, out, subject.card || "", grade);
          r.slab = { file: out, grade: grade || null };
          r.candidate = c;
          chosen = r;
          note("card_db", `ok ${hit.image_url} in slab-kader${grade ? ` met ${grade}` : " zonder grade"}`);
        } else note("card_db", `afgewezen: ${r.reasons.join("; ").slice(0, 160)}`);
      }
    } catch (e) { note("card_db", `fout: ${e.message.slice(0, 160)}`); }
  } else if (!chosen) note("card_db", subject.type === "card" ? "geen kaartdatabase gekoppeld" : "verhaal gaat niet over één kaart");

  // 5 set art (set and era stories): logo on top of the photo, or alone
  let logo = null;
  if ((subject.type === "set" || subject.type === "product") && subject.set && ctx.setArt && (!chosen || chosen.base.step !== "card_db")) {
    try {
      const art = await ctx.setArt(subject.set);
      if (!art?.logo_url) note("set_art", `geen logo voor ${subject.set}`);
      else {
        const dl = await (io.downloadImage || downloadImage)(art.logo_url, io);
        const f = path.join(S.dir, `${crypto.createHash("sha1").update(art.logo_url).digest("hex").slice(0, 16)}-logo${dl.ext}`);
        fs.writeFileSync(f, dl.buf);
        logo = { file: f, image_url: art.logo_url, source_page_url: art.source_page_url || null, credit: domainOf(art.logo_url).replace(/^images\./, "").replace(/\.(io|com)$/, ""), set: subject.set };
        note("set_art", `logo ${art.logo_url}${chosen ? " op de foto" : " alleen"}`);
      }
    } catch (e) { note("set_art", `fout: ${e.message.slice(0, 160)}`); }
  }

  if (!chosen && !logo) throw new NoImageError(`geen beeld voor ${slot}: ${subject.label}`, steps);

  // Credit + record + image log
  let rec;
  if (chosen) {
    const c = chosen.candidate;
    let pc = c.page_credit || null;
    if (!pc && c.page_url && c.step === "search") { try { const { html, final_url } = await (io.getPage || getPage)(c.page_url, io); pc = pageCredit(html, final_url); } catch {} }
    const prep = chosen.slab ? { file: chosen.slab.file, mode: "slab", crop: null } : await prepare({ hit: chosen, layout, S, io });
    rec = {
      source: "web", step: c.step, image_url: chosen.image_url, source_page_url: c.page_url || null,
      source_domain: c.step === "card_db" ? domainOf(chosen.image_url) : domainOf(c.page_url || chosen.image_url),
      credit_name: creditName(pc, c), search_query: c.search_query || null, fetched_at: chosen.base.fetched_at, set_id: setId, slot,
      file: path.basename(prep.file), original_file: path.basename(chosen.file), mode: prep.mode, crop: prep.crop, grade_on_slab: chosen.slab?.grade || null,
      checks: { width: chosen.info.width, height: chosen.info.height, blur: chosen.info.blur, text_ratio: chosen.info.text_ratio, faces: chosen.info.faces },
      subject, subject_check: chosen.check, alternates: alternates.slice(0, 6), search: searchInfo,
    };
    chosen.prepared = prep.file;
  } else {
    rec = { source: "web", step: "set_art", image_url: logo.image_url, source_page_url: logo.source_page_url, source_domain: domainOf(logo.image_url), credit_name: logo.credit, search_query: null,
      fetched_at: new Date().toISOString(), set_id: setId, slot, file: path.basename(logo.file), mode: "logo", subject, subject_check: { model: null, answer: "n.v.t. (setlogo uit de kaartdatabase)" }, search: searchInfo, alternates: [] };
  }
  if (logo && chosen) rec.logo = { image_url: logo.image_url, credit_name: logo.credit, file: path.basename(logo.file) };
  rec.steps = steps;
  S.record({ ...rec, steps: undefined, status: "ok" });
  const logLine = r => ({ used_at: new Date().toISOString(), action: "used", account: A.id, set_id: setId, slot, layout, dry_run: !!ctx.dryRun, step: r.step,
    image_url: r.image_url, source_page_url: r.source_page_url, source_domain: r.source_domain, credit_name: r.credit_name, search_query: r.search_query || null,
    fetched_at: r.fetched_at, file: r.file, subject: subject.label, subject_check: r.subject_check?.answer || null, vision_model: r.subject_check?.model || null });
  appendLog(cfg.log, logLine(rec));
  if (rec.logo) appendLog(cfg.log, logLine({ ...rec.logo, step: "set_art", source_page_url: logo.source_page_url, source_domain: domainOf(logo.image_url), fetched_at: rec.fetched_at, subject_check: { answer: "n.v.t." } }));
  return { file: chosen ? chosen.prepared : logo.file, mode: rec.mode, logo: chosen && logo ? logo.file : null, record: rec };
}

// Caption last line and X reply suffix: "image: <credit>" (both credits when a set logo sits on a photo).
function creditLine(records) {
  const names = [];
  for (const r of records) {
    if (!r || r.source !== "web") continue;
    for (const n of [r.credit_name, r.logo?.credit_name]) if (n && !names.includes(n)) names.push(n);
  }
  return names.length ? `image: ${names.join(", ")}` : "";
}

module.exports = {
  NoImageError, settings, domainOf, domainIn, readBlocklist, addToBlocklist, readLog, appendLog, recentlyUsed,
  safeFetch, getPage, downloadImage, upgradeUrl, largestFromSrcset, pageCredit, pageImages,
  subjectFor, searchQuery, subjectLabel, visionPrompt, parseVision, gradeMatches, searchImages, rankSearch,
  evaluate, prepare, resolveSlot, creditLine, runPy,
};
