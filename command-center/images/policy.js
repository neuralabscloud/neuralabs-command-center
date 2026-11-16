// Image policy for news card hook slides, shared by all accounts (accounts/<name>.yaml image_policy).
// resolve() picks one image per slot in this order and records every step in the manifest:
//   tier 3 match  own gallery photo that matches the card or set of the story (wins over tier 1 and 2)
//   tier 1        official press image: item URL and image URL both on the newsmaker's own domain (source policy "official")
//   tier 2        card scan from the NeuraCollectibles card database (source policy "card_db"), shown whole in a slab frame
//   tier 3        generic own gallery photo (or gh0st still for persona)
//   tier 4        own SVG chart when the item has a series, Nano Banana neutral scene, else the account pattern
// Layouts: signal and versus take tier 1 to 4, persona tier 3 only, number and payload no image.
// Never: open web or image search, outlet/photographer/Reddit/auction photos, people, memes, screenshots, generated card art.
// Every download is stored in <data_dir>/images/<hash>.<ext> with a <hash>.json sidecar and a line in index.jsonl
// (source_page_url, image_url, policy_tier, fetched_at), so a takedown or question is one lookup.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { execFile } = require("child_process");
const http = require("../sources/http");

const INSPECT = path.join(__dirname, "inspect.py");
const LAYOUT_TIERS = { signal: [1, 2, 3, 4], versus: [1, 2, 3, 4], persona: [3], number: [], payload: [] };
const MIN_LONG_SIDE = 1000;
const MAX_BYTES = 15e6;
const TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };   // no SVG, no GIF

// Per source in the account YAML: image_policy.sources["<source name>"] = {policy: official|card_db|none, hosts: [...], credit}.
// Default none (tiers 3 and 4 only).
function sourcePolicy(A, sourceName) {
  const map = ((A.profile || {}).image_policy || {}).sources || {};
  const e = map[sourceName] || {};
  return {
    policy: ["official", "card_db"].includes(e.policy) ? e.policy : "none",
    hosts: (Array.isArray(e.hosts) ? e.hosts : []).map(h => String(h).toLowerCase()).filter(Boolean),
    credit: e.credit || null,
  };
}
const hostOk = (host, hosts) => !!host && hosts.some(h => host === h || host.endsWith(`.${h}`));
function creditFor(sp, imageUrl, fallback) {
  if (sp.credit && typeof sp.credit === "object") { const h = new URL(imageUrl).hostname; return sp.credit[h] || fallback; }
  return sp.credit || fallback;
}

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80") || s.startsWith("::ffff:") && privateIp(s.slice(7));
}
async function assertPublicHost(host, lookup = dns.lookup) {
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error(`host ${host} wijst naar een intern adres`);
}

// https only, allowlisted host on every hop, public IPs only, png/jpeg/webp only, size cap, magic bytes checked.
async function download(url, hosts, { fetchImpl = fetch, lookup } = {}) {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== "https:") throw new Error(`alleen https (${u.protocol})`);
    if (!hostOk(u.hostname, hosts)) throw new Error(`host niet toegestaan: ${u.hostname}`);
    await assertPublicHost(u.hostname, lookup);
    const res = await fetchImpl(u.toString(), { redirect: "manual", headers: { "user-agent": http.UA, accept: "image/png,image/jpeg,image/webp" }, signal: AbortSignal.timeout(20000) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!TYPES[type]) throw new Error(`type ${type || "onbekend"} niet toegestaan`);
    if (Number(res.headers.get("content-length") || 0) > MAX_BYTES) throw new Error("te groot");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("te groot");
    const magic = buf.subarray(0, 12);
    const real = magic[0] === 0x89 && magic[1] === 0x50 ? "image/png" : magic[0] === 0xff && magic[1] === 0xd8 ? "image/jpeg"
      : magic.subarray(0, 4).toString() === "RIFF" && magic.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
    if (!real) throw new Error("geen png/jpeg/webp");
    return { buf, ext: TYPES[real], final_url: u.toString() };
  }
  throw new Error("te veel redirects");
}

function runPy(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile("python3", ["-I", "-S", INSPECT, ...args], { timeout, maxBuffer: 1e6 }, (err, stdout) => {
      let j = null;
      try { j = JSON.parse(String(stdout || "").trim().split("\n").pop()); } catch {}
      if (!j) return reject(new Error(err ? err.message.slice(0, 160) : "geen uitvoer van inspect.py"));
      if (j.error) return reject(new Error(j.error));
      resolve(j);
    });
  });
}
const inspect = file => runPy(["inspect", file]);
const composeSlab = (src, out) => runPy(["slab", src, out]);

// Long side >= 1000 px, no face, no watermark or credit text.
function checkErrors(info) {
  const e = [];
  const long = Math.max(Number(info.width) || 0, Number(info.height) || 0);
  if (long < MIN_LONG_SIDE) e.push(`te klein (${long} px lange zijde, minimaal ${MIN_LONG_SIDE})`);
  if (info.faces !== 0) e.push(info.faces < 0 ? "beeld onleesbaar" : `gezicht gevonden (${info.faces})`);
  if ((info.watermark || []).length) e.push(`watermerk of credit-tekst: ${info.watermark.slice(0, 3).join(", ")}`);
  return e;
}

function store(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const index = path.join(dir, "index.jsonl");
  return {
    dir,
    record(rec) { fs.appendFileSync(index, JSON.stringify(rec) + "\n"); },
    lookup(key) {   // by file name or image URL; one read of the index
      try { return fs.readFileSync(index, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => r.file === key || r.image_url === key || r.composed_file === key); }
      catch { return []; }
    },
  };
}

// Download + validate + store one candidate. Returns the stored record or throws with the reasons.
async function fetchCandidate({ S, tier, imageUrl, pageUrl, hosts, sourceName, credit, account, setId, io = {} }) {
  const at = new Date().toISOString();
  const id = crypto.createHash("sha1").update(imageUrl).digest("hex").slice(0, 16);
  const base = { id, account, set_id: setId, policy_tier: tier, source_name: sourceName, credit, source_page_url: pageUrl, image_url: imageUrl, fetched_at: at };
  let dl;
  try { dl = await (io.download || download)(imageUrl, hosts, io); }
  catch (e) { S.record({ ...base, status: "rejected", reasons: [`download: ${e.message}`] }); throw new Error(`download: ${e.message}`); }
  const file = path.join(S.dir, `${id}${dl.ext}`);
  fs.writeFileSync(file, dl.buf);
  let info;
  try { info = await (io.inspect || inspect)(file); }
  catch (e) { fs.rmSync(file, { force: true }); S.record({ ...base, status: "rejected", reasons: [`inspect: ${e.message}`] }); throw new Error(`inspect: ${e.message}`); }
  const errs = checkErrors(info);
  if (errs.length) { fs.rmSync(file, { force: true }); S.record({ ...base, final_url: dl.final_url, checks: info, status: "rejected", reasons: errs }); throw new Error(errs.join("; ")); }
  const rec = { ...base, final_url: dl.final_url, file: path.basename(file), checks: info, status: "ok" };
  fs.writeFileSync(path.join(S.dir, `${id}.json`), JSON.stringify(rec, null, 2));
  S.record(rec);
  return { ...rec, path: file };
}

// og:image / twitter:image from the official page itself (never from a copy on a news outlet).
function metaImage(html, pageUrl) {
  const tags = String(html).match(/<meta\b[^>]*>/gi) || [];
  for (const want of ["og:image:secure_url", "og:image", "twitter:image"]) {
    for (const t of tags) {
      const key = (t.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const val = (t.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (key && val && key.toLowerCase() === want) { try { return new URL(val.replace(/&amp;/g, "&"), pageUrl).toString(); } catch {} }
    }
  }
  return null;
}

async function tierOfficial({ A, item, sp, S, setId, io = {} }) {
  if (!item.url) throw new Error("item zonder URL");
  const page = new URL(item.url);
  if (!hostOk(page.hostname, sp.hosts)) throw new Error(`item-URL ${page.hostname} is niet het eigen domein van de nieuwsmaker`);
  const html = await (io.getPage || (u => http.get(u, { allowHosts: sp.hosts, timeout: 15000, maxBytes: 2e6 })))(page.toString());
  const img = metaImage(html, page.toString());
  if (!img) throw new Error("geen og:image op de officiële pagina");
  if (!hostOk(new URL(img).hostname, sp.hosts)) throw new Error(`beeldhost ${new URL(img).hostname} niet toegestaan`);
  return fetchCandidate({ S, tier: 1, imageUrl: img, pageUrl: page.toString(), hosts: sp.hosts, sourceName: item.source, credit: creditFor(sp, img, item.source), account: A.id, setId, io });
}

async function tierCardDb({ A, item, sp, S, setId, io = {} }) {
  if (!item.card) throw new Error("item gaat niet over één specifieke kaart");
  if (!io.cardImage) throw new Error("geen kaartdatabase gekoppeld");
  const hit = await io.cardImage(item.card);
  if (!hit?.image_url) throw new Error(`kaart ${item.card.name} niet gevonden in de kaartdatabase`);
  if (!hostOk(new URL(hit.image_url).hostname, sp.hosts)) throw new Error(`beeldhost ${new URL(hit.image_url).hostname} niet toegestaan`);
  const rec = await fetchCandidate({ S, tier: 2, imageUrl: hit.image_url, pageUrl: hit.source_page_url, hosts: sp.hosts, sourceName: item.source, credit: creditFor(sp, hit.image_url, "card database"), account: A.id, setId, io });
  // Whole card inside a slab frame, never cropped to the artwork alone.
  const composed = path.join(S.dir, `${rec.id}-slab.png`);
  await (io.composeSlab || composeSlab)(rec.path, composed);
  S.record({ id: rec.id, account: A.id, set_id: setId, composed_file: path.basename(composed), from_file: rec.file, policy_tier: 2, fetched_at: rec.fetched_at, image_url: rec.image_url, source_page_url: rec.source_page_url, status: "composed" });
  return { ...rec, path: composed, composed_file: path.basename(composed), frame: "slab" };
}

// One slot. ctx: {galleryMatch(slot), galleryGeneric(slot), tier4(slot), cardImage, log}
// Returns { file|null, chart|null, record } where record goes into the manifest (m.images[slot]).
async function resolve({ A, item, layout, slot, setId, dataDir, ctx = {}, io = {} }) {
  const tiers = LAYOUT_TIERS[layout] || [];
  const steps = [];
  const note = (tier, result) => steps.push({ tier, result });
  if (!tiers.length) return { file: null, record: { source: "none", policy_steps: [{ tier: 0, result: `layout ${layout} heeft geen beeld` }] } };
  const done = (file, record, extra = {}) => ({ file, ...extra, record: { ...record, policy_steps: steps } });

  if (tiers.includes(3) && ctx.galleryMatch) {
    const g = await ctx.galleryMatch(slot);
    if (g) { note(3, `eigen foto match (${g.record.match || "match"})`); return done(g.file, { ...g.record, policy_tier: 3 }); }
    note(3, "geen eigen foto die bij het verhaal past");
  }
  const sp = sourcePolicy(A, item.source);
  const S = store(path.join(dataDir, "images"));
  const used = ctx.used || [];
  for (const tier of [1, 2].filter(t => tiers.includes(t))) {
    const want = tier === 1 ? "official" : "card_db";
    if (sp.policy !== want) { note(tier, `bron ${item.source}: image_policy ${sp.policy}`); continue; }
    try {
      const rec = await (tier === 1 ? tierOfficial : tierCardDb)({ A, item, sp, S, setId, io: { ...io, cardImage: io.cardImage || ctx.cardImage } });
      if (used.includes(rec.image_url)) { note(tier, "al gebruikt in deze set"); continue; }
      used.push(rec.image_url);
      note(tier, `ok ${rec.image_url}`);
      const { path: p, ...keep } = rec;
      return done(p, { source: tier === 1 ? "official" : "card_db", ...keep });
    } catch (e) { note(tier, `afgewezen: ${e.message.slice(0, 200)}`); ctx.log?.(`beeld tier ${tier}: ${e.message.slice(0, 160)}`); }
  }
  if (tiers.includes(3) && ctx.galleryGeneric) {
    const g = await ctx.galleryGeneric(slot);
    if (g) { note(3, "eigen generieke foto"); return done(g.file, { ...g.record, policy_tier: 3 }); }
    note(3, "geen generieke eigen foto");
  }
  if (tiers.includes(4) && ctx.tier4) {
    const r = await ctx.tier4(slot).catch(e => { note(4, `fout: ${e.message.slice(0, 160)}`); return null; });
    if (r) { note(4, r.record.source); return done(r.file || null, { ...r.record, policy_tier: 4 }, r.chart ? { chart: r.chart } : {}); }
  }
  if (!tiers.includes(4)) { note(3, "geen eigen beeld; layout zonder beeld"); return done(null, { source: "none", policy_tier: null }); }
  note(4, "patroon");
  return done(null, { source: "pattern", policy_tier: 4 });
}

// Caption last line when a downloaded image (tier 1 or 2) is used: "image: <source name>".
function creditLine(records) {
  const r = records.find(x => x && (x.policy_tier === 1 || x.policy_tier === 2) && x.credit);
  return r ? `image: ${String(r.credit).toLowerCase()}` : "";
}

module.exports = { LAYOUT_TIERS, MIN_LONG_SIDE, sourcePolicy, hostOk, privateIp, assertPublicHost, download, inspect, composeSlab, checkErrors, store, fetchCandidate, metaImage, tierOfficial, tierCardDb, resolve, creditLine };
