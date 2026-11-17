// Vault posts (Slabhaus): "for sale" and "sold" posts in the news-card visual system.
// Trigger stays in listings-autopilot.js (feed check, listing slot, sold detection); this module
// builds the record from the inventory feed, renders vault_listing / vault_sold, writes and checks
// the copy (LLM only writes captions), and publishes: Instagram direct (Graph API, one image),
// X as hook + reply (listing link in the reply) via the community publisher. Daily cap + overflow queue.
// Nothing here ever deletes a post.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const nc = require("./news-cards");
const { localDay, zonedTime } = require("./social-autopilot");
const { priceText, gradeShort, displayName } = require("./listings-autopilot");

const ROOT = __dirname;
const MODEL = process.env.VAULT_POSTS_MODEL || process.env.LISTINGS_AUTOPILOT_MODEL || process.env.SOCIAL_AUTOPILOT_MODEL || "claude-sonnet-5-5";
const PYTHON = process.env.VAULT_CUTOUT_PYTHON || "/root/rembg-env/venv/bin/python";
const CUTOUT_PY = path.join(ROOT, "images", "slab_cutout.py");
const VAULT_DEFAULTS = { enabled: false, account: "slabhaus", daily_cap: 2, sold_delay_min: 120, sold_comment: "sold, thank you", x: true, instagram: true };
const PRESSURE = /\b(last (one|chance|copy)|only one left|don'?t miss( out)?|won'?t last|hurry|act fast|before it'?s gone|selling fast|limited time|grab it|going fast|now or never)\b/i;
const INVEST = /\b(invest\w*|portfolio|roi|returns?|profit\w*|flip\w*|undervalued|overvalued|appreciat\w*|gains?|to the moon|price target|going up|will rise|store of value|asset)\b/i;
const DASH = /[‒–—―]|\s-\s/;
const GRADERS = ["PSA", "CGC", "BGS", "SGC", "TAG", "ACE", "BECKETT"];

function vaultConfig(channel) {
  const raw = (channel && channel.listings && channel.listings.vault) || {};
  const c = { ...VAULT_DEFAULTS, ...raw };
  c.enabled = !!raw.enabled;
  c.daily_cap = Math.min(10, Math.max(1, Number(c.daily_cap) || VAULT_DEFAULTS.daily_cap));
  c.sold_delay_min = Math.min(24 * 60, Math.max(0, Number.isFinite(+c.sold_delay_min) ? +c.sold_delay_min : VAULT_DEFAULTS.sold_delay_min));
  c.sold_comment = String(c.sold_comment || VAULT_DEFAULTS.sold_comment).slice(0, 120);
  c.x = raw.x !== false; c.instagram = raw.instagram !== false;
  c.account = String(c.account || "slabhaus").replace(/[^\w-]/g, "");
  return c;
}

// "Scarlet & Violet 151 - MEW EN" → "Scarlet & Violet 151"; "Pokemon Svp EN-SV Black Star Promo" → "SV Black Star Promo".
function cleanSet(set) {
  let s = String(set || "").split(/\s+[-–—]\s+/)[0];
  s = s.replace(/^pok[eé]mon\s+/i, "").replace(/\bSvp EN-SV\b/i, "SV").replace(/\b(EN|JP|JPN)\b$/i, "").replace(/\s+/g, " ").trim();
  return s.slice(0, 60);
}

function certFromImage(url) {
  const m = String(url || "").match(/graded-cards-renders\/(PSA|CGC|BGS|SGC|TAG)(?:%20|\s)(\d{6,14})\//i);
  return m ? { grader: m[1].toUpperCase(), cert: m[2] } : null;
}

// Inventory item (+ overrides) → the record every field on the card and in the copy comes from.
function buildRecord(item, overrides = {}) {
  const d = (item && item.details) || {};
  const fromImg = certFromImage(item.image) || {};
  const gs = gradeShort(item.grade).match(/^(\w+)\s+(\d{1,2}(?:\.5)?)$/) || [];
  const cert = String(d.cert || fromImg.cert || "").replace(/\D/g, "") || null;
  const o = (cert && overrides[cert]) || overrides[item.id] || {};
  const grader = String(d.grader || fromImg.grader || gs[1] || "").toUpperCase() || null;
  const yearM = String(item.name || "").match(/\b(19[89]\d|20[0-4]\d)\b/);
  return {
    id: item.id,
    card: String(d.card || displayName(item)).replace(/[–—]/g, " ").trim(),
    set: cleanSet(d.set) || null,
    year: Number(d.year) || (yearM ? Number(yearM[1]) : null),
    number: d.number || null,
    variant: d.variant || null,
    grader: GRADERS.includes(grader) ? grader : grader,
    grade: String(d.grade || gs[2] || "").trim() || null,
    cert,
    pop: Number(d.pop) > 0 ? Number(d.pop) : null,
    price_usd: Number(item.price && (item.price.usd || item.price.amount)) || null,
    price_text: priceText(item) || null,
    platform: item.platform_label || item.platform || null,
    platform_id: item.platform || null,
    listing_url: item.marketplace_url || null,
    page_url: item.page_url || null,
    image: item.image || null,
    listed_at: d.listed_at || item.first_seen || null,
    sold_at: item.sold_at || null,
    show_price: o.show_price !== false,
    photo_override: o.photo || null,
  };
}

function recordProblems(rec, kind) {
  const p = [];
  if (!rec.card) p.push("card name missing");
  if (!rec.grader || !rec.grade) p.push("grader/grade missing");
  if (!rec.cert) p.push("cert missing (photo cannot be tied to the slab)");
  if (kind === "listing" && !rec.price_text) p.push("asking price missing");
  if (!rec.platform) p.push("platform missing");
  return p;
}

// Own slab photo for exactly this cert: gallery photo tagged with the cert, else the vault platform's
// photo of this slab (Courtyard render URL carries grader + cert; Collector Crypt photo comes from the
// NFT whose metadata holds the cert). Never a card image from another source.
function photoSource(rec, gallery = []) {
  const tagged = gallery.find(p => rec.cert && String(p.cert || "").replace(/\D/g, "") === rec.cert && (p.kind || "slab") === "slab");
  if (tagged) return { kind: "gallery", path: tagged.path, file: tagged.file };
  const u = String(rec.image || "");
  if (rec.platform_id === "courtyard") {
    const c = certFromImage(u);
    if (c && c.cert === rec.cert && /^https:\/\/static\.courtyard\.io\/graded-cards-renders\//.test(u)) return { kind: "platform", url: u, source: "courtyard" };
  }
  if (rec.platform_id === "collectorcrypt" && /^https:\/\/d1xpxki1g4htqu\.cloudfront\.net\/[\w-]+$/.test(u)) return { kind: "platform", url: u, source: "collectorcrypt" };
  return null;
}

function esc(s) { return nc.esc(s); }
function dateText(iso, tz) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(t)).toLowerCase();
}

function chipsHtml(rec, kind, tz = "Europe/Amsterdam") {
  const c = [`<span class="chip">${esc(rec.grader)} <b>${esc(rec.grade)}</b></span>`];
  if (kind === "sold") {
    const d = dateText(rec.sold_at, tz);
    if (d) c.push(`<span class="chip">sold ${esc(d)}</span>`);
    c.push(`<span class="chip">via ${esc(rec.platform)}</span>`);
  } else {
    c.push(`<span class="chip">cert ${esc(rec.cert)}</span>`);
    if (rec.pop) c.push(`<span class="chip">pop ${esc(rec.pop.toLocaleString("en-US"))}</span>`);
  }
  return c.join("");
}

function slideHtml(rec, kind, photoUri, acct, tz) {
  const A = nc.account(acct);
  const line1 = [rec.set, rec.year].filter(Boolean).join(" · ");
  const soldLeft = rec.show_price && rec.price_text
    ? `<div class="k">sold for</div><div class="price">${esc(rec.price_text)}</div>`
    : `<div class="k">sold</div><div class="soldword">from the vault</div>`;
  const css = fs.readFileSync(path.join(nc.TPL_DIR, "vault.css"), "utf8");
  return `<style>${css}</style>` + nc.fill(nc.tpl(kind === "sold" ? "vault_sold" : "vault_listing"), {
    pattern: nc.slabPatternSvg(), brand: A.brandHtml, photo: nc.safeImg(photoUri),
    line1: esc(line1), card: esc(rec.card), chips: chipsHtml(rec, kind, tz),
    price: esc(rec.price_text || ""), platform: esc(rec.platform || ""), sold_left: soldLeft,
  });
}

// ---------- copy ----------
function numbersOk(text, rec) {
  const allowed = new Set();
  const add = v => { for (const n of String(v ?? "").match(/\d+(?:[.,]\d+)?/g) || []) { allowed.add(n); allowed.add(n.replace(/,/g, "")); } };
  [rec.card, rec.set, rec.year, rec.number, rec.variant, rec.grade, rec.cert, rec.pop, rec.pop && rec.pop.toLocaleString("en-US")].forEach(add);
  if (rec.show_price) { add(rec.price_text); add(rec.price_usd); }
  const body = String(text).replace(/#[\w]+/g, "");
  const bad = (body.match(/\d+(?:[.,]\d+)?/g) || []).filter(n => !allowed.has(n) && !allowed.has(n.replace(/,/g, "")));
  return bad;
}

function validateCopy(copy, rec, kind, acct) {
  const A = nc.account(acct);
  const tags = (A.hashtags || ["#pokemontcg", "#psa10", "#slabs", "#pokemoncards"]).slice(0, 4);
  const problems = [];
  const ig = String(copy.ig_caption || "").trim();
  const hook = String(copy.x_hook || "").trim();
  for (const [name, t] of [["ig_caption", ig], ["x_hook", hook]]) {
    if (!t) { problems.push(`${name} is empty`); continue; }
    if (DASH.test(t)) problems.push(`${name}: no dashes (use a period, colon or line break)`);
    if (/https?:\/\/|www\./i.test(t)) problems.push(`${name}: no URLs`);
    if (PRESSURE.test(t)) problems.push(`${name}: no pressure lines ("${t.match(PRESSURE)[0]}")`);
    if (INVEST.test(t)) problems.push(`${name}: no investment framing ("${t.match(INVEST)[0]}")`);
    for (const f of A.forbid || []) if (f.re.test(t)) problems.push(`${name}: ${f.reason}`);
    const caps = (t.replace(/#\w+/g, "").match(/\b[A-Z][A-Z0-9]+\b/g) || []).filter(w => !(A.capsAllow || []).includes(w) && !String(rec.number || "").toUpperCase().split(/[\s/]+/).includes(w));
    if (caps.length) problems.push(`${name}: no capitals outside the allowlist (${[...new Set(caps)].join(", ")})`);
    const bad = numbersOk(t, rec);
    if (bad.length) problems.push(`${name}: numbers not in the record (${bad.join(", ")})`);
    if (!rec.show_price && /\$\s?\d/.test(t)) problems.push(`${name}: the price is hidden for this slab`);
  }
  if (ig) {
    if (ig !== ig.toLowerCase()) problems.push("ig_caption must be all lowercase");
    const lines = ig.split("\n").map(s => s.trim()).filter(Boolean);
    if (lines.length !== 3) problems.push(`ig_caption must be exactly 3 lines (has ${lines.length})`);
    else {
      if (lines[2] !== tags.join(" ")) problems.push(`ig_caption line 3 must be exactly: ${tags.join(" ")}`);
      const l1 = lines[0].toLowerCase();
      if (!l1.includes(rec.card.toLowerCase().split(" ")[0])) problems.push("ig_caption line 1 must name the card");
      if (!l1.includes(String(rec.grade))) problems.push("ig_caption line 1 must name the grade");
      if (kind === "listing" && !ig.includes("link in bio")) problems.push('ig_caption must say "link in bio"');
      if (lines[0].length > 70) problems.push("ig_caption line 1 too long (max 70 characters)");
      if (lines[1].length > 120) problems.push("ig_caption line 2 too long (max 120 characters)");
      if (kind === "sold" && !l1.includes("found a new home")) problems.push('sold ig_caption line 1 must end with "found a new home"');
      if (kind === "sold" && !/thank/.test(lines[1])) problems.push("sold ig_caption line 2 must thank the buyer");
      if (kind === "sold" && !lines[1].includes("next drop soon")) problems.push('sold ig_caption line 2 must include "next drop soon"');
    }
    if (ig.length > 600) problems.push("ig_caption too long");
  }
  if (hook) {
    if (/#\w/.test(hook)) problems.push("x_hook: no hashtags");
    if (hook.length > 240) problems.push(`x_hook too long (${hook.length}/240)`);
  }
  return problems;
}

function facts(rec, kind) {
  return [
    `card: ${rec.card}`, rec.set ? `set: ${rec.set}` : "", rec.year ? `year: ${rec.year}` : "",
    rec.number ? `card number: ${rec.number}` : "", rec.variant ? `variant: ${rec.variant}` : "",
    `grader: ${rec.grader}`, `grade: ${rec.grade}`, `cert: ${rec.cert}`,
    rec.pop ? `population at this grade (${rec.grader}): ${rec.pop}` : "",
    kind === "listing" ? `asking price: ${rec.price_text}` : rec.show_price && rec.price_text ? `sold for: ${rec.price_text}` : "price: do not mention",
    `platform: ${rec.platform}`,
  ].filter(Boolean).join("\n");
}

function fallbackCopy(rec, kind, acct) {
  const A = nc.account(acct);
  const tags = (A.hashtags || []).slice(0, 4).join(" ");
  const g = `${rec.grader} ${rec.grade}`.toLowerCase();
  const card = rec.card.toLowerCase();
  if (kind === "sold") {
    return {
      ig_caption: `${card} ${g} found a new home\nthank you to the buyer, next drop soon\n${tags}`,
      x_hook: `${card} ${rec.grader} ${rec.grade} found a new home. thank you to the buyer, next drop soon`,
    };
  }
  const why = rec.pop ? `one of ${rec.pop.toLocaleString("en-US")} graded ${g} copies` : [rec.set && rec.set.toLowerCase(), rec.year].filter(Boolean).join(", ") || `cert ${rec.cert}`;
  return {
    ig_caption: `${card} ${g} is in the vault\n${why}, link in bio\n${tags}`,
    x_hook: `${card} ${rec.grader} ${rec.grade} is in the vault. ${why}. asking ${rec.price_text}`,
  };
}

async function writeCopy({ anthropic, rec, kind, acct, recent = [], log = () => {} }) {
  const A = nc.account(acct);
  const tags = (A.hashtags || []).slice(0, 4).join(" ");
  const tool = {
    name: "submit_copy", description: "Submit the Instagram caption and the X hook.",
    input_schema: { type: "object", properties: { ig_caption: { type: "string" }, x_hook: { type: "string" } }, required: ["ig_caption", "x_hook"], additionalProperties: false },
  };
  const task = kind === "sold"
    ? `This slab from our own vault just sold. Line 1: "${rec.card.toLowerCase()} ${rec.grader.toLowerCase()} ${rec.grade} found a new home". Line 2: a short thank you to the buyer (never named) plus the words "next drop soon".${rec.show_price ? "" : " Do not mention any price."}`
    : `This slab from our own vault is for sale. Line 1: the card and grade in plain words. Line 2: one short, natural reason why this copy (max 90 characters before "link in bio"), using only the record fields below (for example the population, the set, the year or the variant), ending with ", link in bio". Line 1 stays short: card, grader and grade, nothing else.`;
  const prompt = `You write copy for ${A.name}, a Pokemon slab account. ${A.voiceIntro || ""}
${task}

Record (the only facts you may use, never add numbers, prices, sales or values that are not here):
"""
${facts(rec, kind)}
"""

ig_caption: all lowercase, exactly 3 lines separated by single newlines. Line 3 is exactly: ${tags}
No URLs on Instagram.
x_hook: lowercase except grader names (PSA, CGC, BGS, SGC) and set codes, max 220 characters, no hashtags, no links. ${kind === "listing" ? `Mention the asking price ${rec.price_text}. The listing link goes in a reply that is added automatically, so do not mention links or "below".` : "No link."}
Rules for both: no em or en dashes and no " - " (use periods, colons or line breaks). No investment framing (no invest, value going up, returns, flip, portfolio). No pressure lines (no "last one", "don't miss out", "hurry", "won't last"). No emojis.${recent.length ? `\nRecent captions (use different wording):\n${recent.map(t => "- " + String(t).replace(/\s+/g, " ").slice(0, 160)).join("\n")}` : ""}
Answer only by calling submit_copy.`;
  const messages = [{ role: "user", content: prompt }];
  let last = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 1500, tools: [tool], tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages });
    const use = msg.content.find(b => b.type === "tool_use");
    messages.push({ role: "assistant", content: msg.content });
    if (!use) { messages.push({ role: "user", content: "Answer only by calling submit_copy." }); continue; }
    const copy = { ig_caption: String(use.input.ig_caption || "").replace(/\r/g, "").trim(), x_hook: String(use.input.x_hook || "").trim() };
    last = validateCopy(copy, rec, kind, A);
    if (!last.length) return { ...copy, by: "claude", attempts: attempt + 1 };
    log(`copy attempt ${attempt + 1}: ${last.join("; ")}`);
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: `Fix these and resubmit: ${last.join("; ")}`, is_error: true }] });
  }
  const fb = fallbackCopy(rec, kind, A);
  const fbProblems = validateCopy(fb, rec, kind, A);
  if (fbProblems.length) throw new Error(`copy failed the checks: ${last.concat(fbProblems).join("; ")}`);
  return { ...fb, by: "fallback", attempts: 3, llm_problems: last };
}

function xReply(rec) {
  return rec.listing_url ? `${String(rec.platform || "listing").toLowerCase()}: ${rec.listing_url}` : null;
}

// ---------- queue + publish ----------
function createVault(deps) {
  const {
    dataDir, mediaDir, tz = "Europe/Amsterdam", anthropic,
    galleryPhotos = () => [], fetch: fetchFn = fetch,
    igImage, igComment, addXTask, xOk = () => true, notify = () => {},
    run = (cmd, args, timeout = 240000) => new Promise((ok, no) => execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (e, so, se) => e && !String(so).trim() ? no(new Error(String(se || e.message).slice(-300))) : ok(String(so)))),
    log = (...a) => console.log("[VAULT]", ...a),
  } = deps;
  const DIR = path.join(dataDir, "vault-posts");
  const STATE = path.join(DIR, "state.json");
  const OVERRIDES = path.join(DIR, "overrides.json");
  const CUT_DIR = path.join(DIR, "cutouts");
  const OUT_DIR = path.join(mediaDir, "vault-posts");
  let busy = false;

  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
  function load() { const s = readJson(STATE, {}); s.posts = Array.isArray(s.posts) ? s.posts : []; return s; }
  function save(s) {
    fs.mkdirSync(DIR, { recursive: true });
    s.posts = s.posts.slice(-300);
    fs.writeFileSync(STATE + ".tmp", JSON.stringify(s, null, 2));
    fs.renameSync(STATE + ".tmp", STATE);
  }
  function mutate(fn) { const s = load(); const r = fn(s); save(s); return r; }
  function overrides() { return readJson(OVERRIDES, {}) || {}; }

  async function download(url, file) {
    const r = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`photo download HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15e6) throw new Error("photo too large");
    fs.writeFileSync(file, buf);
  }

  // Background-removed slab (cached per cert).
  async function cutout(rec, galleryDir) {
    fs.mkdirSync(CUT_DIR, { recursive: true });
    const out = path.join(CUT_DIR, `${rec.cert}.png`);
    const meta = out + ".json";
    if (fs.existsSync(out) && fs.existsSync(meta)) return { path: out, ...readJson(meta, {}) };
    const src = rec.photo_override && galleryDir ? { kind: "gallery", path: path.join(galleryDir, path.basename(rec.photo_override)) } : photoSource(rec, galleryPhotos());
    if (!src) throw new Error(`no own slab photo for cert ${rec.cert} (tag one in the gallery with this cert)`);
    let input = src.path;
    if (src.kind === "platform") { input = path.join(CUT_DIR, `${rec.cert}.src`); await download(src.url, input); }
    if (!input || !fs.existsSync(input)) throw new Error("slab photo file missing");
    const res = JSON.parse(String(await run(PYTHON, ["-I", CUTOUT_PY, input, out])).trim().split("\n").pop() || "{}");
    if (!res.ok) throw new Error(`cutout: ${res.error}`);
    const info = { photo: src.kind === "gallery" ? `gallery:${src.file || path.basename(src.path)}` : `${src.source}:${src.url}`, method: res.method, w: res.w, h: res.h };
    fs.writeFileSync(meta, JSON.stringify(info));
    return { path: out, ...info };
  }

  async function render(rec, kind, { acct, file }) {
    const cut = await cutout(rec, deps.galleryDir);
    await nc.renderHtml(slideHtml(rec, kind, nc.dataUri(cut.path), acct, tz), file, acct);
    return { file, photo: cut.photo, cutout: cut.method };
  }

  // Build one post (render + copy). Returns the entry; queue() stores it.
  async function build(channel, { kind, item, dryRun = false, outDir }) {
    const cfg = vaultConfig(channel);
    const rec = buildRecord(item, overrides());
    const missing = recordProblems(rec, kind);
    if (missing.length) throw new Error(`record incomplete for ${rec.card || item.id}: ${missing.join(", ")}`);
    const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const dir = outDir || OUT_DIR;
    const file = path.join(dir, `vault_${kind}_${rec.cert}_${id}.png`);
    const r = await render(rec, kind, { acct: cfg.account, file });
    const recent = load().posts.filter(p => p.kind === kind && p.copy).slice(-5).map(p => p.copy.ig_caption);
    const copy = await writeCopy({ anthropic, rec, kind, acct: cfg.account, recent, log: m => log(`${rec.card}: ${m}`) });
    return {
      id, channel_id: channel.id, kind, item_id: item.id, cert: rec.cert, record: rec, dry_run: dryRun,
      png: file, rel: file.startsWith(mediaDir + path.sep) ? "/media/" + path.relative(mediaDir, file).split(path.sep).join("/") : null,
      photo: r.photo, cutout: r.cutout,
      copy: { ig_caption: copy.ig_caption, x_hook: copy.x_hook, x_reply: kind === "listing" ? xReply(rec) : null, by: copy.by },
      created_at: new Date().toISOString(),
    };
  }

  // Called by the listings trigger. Listing = due now; sold = due now, latest at sold_at + sold_delay_min.
  async function enqueue(channel, { kind, item, mode = "auto", trigger = "schedule" }) {
    const cfg = vaultConfig(channel);
    const e = await build(channel, { kind, item });
    const now = Date.now();
    Object.assign(e, {
      status: mode === "review" ? "draft" : "queued", trigger,
      due_at: new Date(now).toISOString(),
      deadline_at: kind === "sold" ? new Date(Date.parse(item.sold_at || new Date(now).toISOString()) + cfg.sold_delay_min * 60e3).toISOString() : null,
      listed_at: e.record.listed_at, ig: { status: cfg.instagram ? "pending" : "off" }, x: { status: cfg.x && xOk(channel) ? "pending" : "off" },
      comment: kind === "sold" ? { status: "pending" } : null,
    });
    mutate(s => { s.posts.push(e); });
    log(`${channel.name}: ${kind} ${e.record.card} queued (${e.id}, ${e.status})`);
    return e;
  }

  function releasedToday(s, channelId, day) {
    return s.posts.filter(p => p.channel_id === channelId && p.released_day === day).length;
  }

  // Which queued entries may go now: cap per local day; overflow waits for the next day's window, oldest listing first.
  function eligible(s, channel, now, windowStart = "10:00") {
    const cfg = vaultConfig(channel);
    const day = localDay(new Date(now), tz);
    let room = cfg.daily_cap - releasedToday(s, channel.id, day);
    if (room <= 0) return [];
    const opens = zonedTime(day, windowStart, tz).getTime();
    return s.posts
      .filter(p => p.channel_id === channel.id && p.status === "queued" && Date.parse(p.due_at) <= now)
      .filter(p => localDay(new Date(p.due_at), tz) === day || now >= opens)
      .sort((a, b) => String(a.listed_at || a.created_at).localeCompare(String(b.listed_at || b.created_at)))
      .slice(0, room);
  }

  async function release(channel, e, now = Date.now()) {
    const day = localDay(new Date(now), tz);
    mutate(s => { const p = s.posts.find(x => x.id === e.id); if (p && !p.released_day) { p.status = "publishing"; p.released_day = day; p.released_at = new Date(now).toISOString(); } });
    // X: hook with the image, listing link in the reply. Instagram is published direct, so the X task never cross-posts.
    if (e.x.status === "pending") {
      try {
        const replies = e.copy.x_reply ? [e.copy.x_reply] : [];
        const t = addXTask({
          channel_id: channel.id, status: "scheduled", scheduled_at: new Date().toISOString(), text: e.copy.x_hook,
          media_path: e.rel, media_paths: [e.rel], topic: e.kind === "sold" ? "Sold" : "For sale", format: "vault_post",
          archetype: e.kind === "sold" ? "Vault · Sold" : "Vault · For sale", vault_post_id: e.id,
          instagram: { status: "skipped", reason: "vault post: Instagram is published direct" },
          ...(replies.length ? { pair: { hook: e.copy.x_hook, replies, formula: "vault_post", pillar: e.kind, pillar_label: e.kind === "sold" ? "sold" : "for sale", has_media: true, has_link: true, media_kind: "vault_post", facts_used: [e.record.listing_url].filter(Boolean), fallback: e.copy.by === "fallback", metrics: {}, score: null, created_at: new Date().toISOString() } } : {}),
          reason: `vault ${e.kind}: ${e.record.card} ${e.record.grader} ${e.record.grade}`,
        });
        e.x = { status: "queued", task_id: t.id };
      } catch (err) { e.x = { status: "failed", error: String(err.message).slice(0, 200) }; }
    }
    if (e.ig.status === "pending" || e.ig.status === "retry") {
      try {
        const r = await igImage(channel, e.png, e.copy.ig_caption, e.id);
        e.ig = { status: "published", media_id: r.media_id, permalink: r.permalink, published_at: new Date().toISOString() };
        notify(`Vault ${e.kind === "sold" ? "sold" : "for sale"}: Instagram`, r.permalink || r.media_id, "info");
      } catch (err) {
        const attempts = (e.ig.attempts || 0) + 1;
        e.ig = { status: attempts >= 3 ? "failed" : "retry", attempts, error: String(err.message).slice(0, 300), retry_at: new Date(Date.now() + attempts * 10 * 60e3).toISOString() };
        if (attempts >= 3) notify("Vault post: Instagram failed", `${e.record.card}: ${e.ig.error}`, "danger");
      }
    }
    // Sold: comment on our own listing post on Instagram. Never delete or edit it.
    if (e.kind === "sold" && e.comment && e.comment.status === "pending") {
      const listing = load().posts.filter(p => p.kind === "listing" && p.item_id === e.item_id && p.ig && p.ig.media_id && !p.dry_run).pop();
      if (!listing) e.comment = { status: "none", note: "no Instagram listing post for this slab" };
      else {
        try { const c = await igComment(channel, listing.ig.media_id, vaultConfig(channel).sold_comment); e.comment = { status: "posted", id: c.id, on: listing.ig.media_id }; }
        catch (err) { e.comment = { status: "failed", error: String(err.message).slice(0, 200), on: listing.ig.media_id }; }
      }
    }
    e.status = e.ig.status === "retry" ? "publishing" : (e.ig.status === "failed" && e.x.status !== "queued") ? "failed" : "published";
    mutate(s => { const i = s.posts.findIndex(x => x.id === e.id); if (i >= 0) s.posts[i] = { ...s.posts[i], ...e }; });
    log(`${channel.name}: ${e.kind} ${e.record.card} → ig ${e.ig.status}${e.ig.permalink ? " " + e.ig.permalink : ""}, x ${e.x.status}`);
    return e;
  }

  async function tick(channels, now = Date.now(), windowOf = () => "10:00") {
    if (busy) return;
    busy = true;
    try {
      for (const channel of channels) {
        if (!vaultConfig(channel).enabled) continue;
        const s = load();
        const retry = s.posts.filter(p => p.channel_id === channel.id && p.status === "publishing" && p.ig && p.ig.status === "retry" && Date.parse(p.ig.retry_at || 0) <= now);
        for (const e of [...retry, ...eligible(s, channel, now, windowOf(channel))]) await release(channel, e, now);
      }
    } catch (err) { log(`tick: ${err.message}`); }
    finally { busy = false; }
  }

  function approve(id) {
    return mutate(s => { const p = s.posts.find(x => x.id === id && x.status === "draft"); if (!p) return null; p.status = "queued"; p.due_at = new Date().toISOString(); return p; });
  }

  function status(channel) {
    const cfg = vaultConfig(channel);
    const s = load();
    const mine = s.posts.filter(p => p.channel_id === channel.id && !p.dry_run);
    const day = localDay(new Date(), tz);
    return {
      config: cfg, today: releasedToday(s, channel.id, day),
      queued: mine.filter(p => p.status === "queued" || p.status === "draft").map(p => ({ id: p.id, kind: p.kind, card: p.record.card, status: p.status, due_at: p.due_at, listed_at: p.listed_at })),
      recent: mine.slice(-10).reverse().map(p => ({ id: p.id, kind: p.kind, card: p.record.card, status: p.status, ig: p.ig, x: p.x, comment: p.comment, released_at: p.released_at })),
    };
  }

  return { build, enqueue, tick, release, approve, status, render, cutout, load, eligible };
}

module.exports = { VAULT_DEFAULTS, PRESSURE, INVEST, vaultConfig, cleanSet, certFromImage, buildRecord, recordProblems, photoSource, chipsHtml, slideHtml, validateCopy, fallbackCopy, writeCopy, xReply, createVault };
