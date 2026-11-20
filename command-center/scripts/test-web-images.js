// node scripts/test-web-images.js   (geen netwerk: pagina's, downloads, checks, vision en zoeken zijn nagebootst)
// Slabhaus webbeeld (images/web.js): bronvolgorde, kwaliteitsregels, onderwerpcheck, blocklist, rotatie, credit,
// kaartscan in slab-kader, setlogo, stoppen zonder beeld, layout in de render, takedown op een dry-run set.
const os = require("os"), fs = require("fs"), path = require("path");
process.env.NEWS_CARDS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nc-web-test-"));
const W = require("../images/web");
const nc = require("../news-cards");
const NC = require("../news-cards-pipeline");
let fails = 0;
const t = (name, cond) => { console.log(`${cond ? "ok  " : "FOUT"} ${name}`); if (!cond) fails++; };

// failed set releases its picks (Deerling 2026-11-20): not counted as recently used
{
  const f = path.join(os.tmpdir(), `rel-${process.pid}.jsonl`);
  const at = new Date().toISOString();
  W.appendLog(f, { used_at: at, action: "used", set_id: "a", image_url: "https://x/a.png" });
  W.appendLog(f, { used_at: at, action: "used", set_id: "b", image_url: "https://x/b.png" });
  W.appendLog(f, { used_at: at, action: "released", set_id: "b" });
  const r = W.recentlyUsed(f, 30);
  t("released set telt niet als gebruikt", r.has("https://x/a.png") && !r.has("https://x/b.png"));
  fs.rmSync(f, { force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "web-img-"));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

const base = require("../accounts").load("slabhaus");
const webCfg = (extra = {}) => ({ ...base.image_policy.web, blocklist: path.join(tmp, "blocklist.yaml"), log: path.join(tmp, "image_log.jsonl"), takedown_log: path.join(tmp, "takedown_log.jsonl"), ...extra });
const A = nc.account({ ...base, image_policy: { ...base.image_policy, web: webCfg() } });

// Mock world: url -> {html} for pages, url -> {info, vision} for images.
function world(images, pages = {}, search = []) {
  let last = null;
  const calls = { vision: 0, dl: [], search: 0 };
  const io = {
    getPage: async u => { if (!pages[u]) throw new Error("HTTP 404"); return { html: pages[u], final_url: u }; },
    downloadImage: async u => { calls.dl.push(u); if (!images[u]) throw new Error("HTTP 404"); last = u; return { buf: PNG, ext: ".png" }; },
    inspectWeb: async () => ({ width: 1600, height: 2000, faces: 0, watermark: [], blur: 300, text_ratio: 0.02, ...(images[last].info || {}) }),
    thumb: async () => ({ ok: true }),
    vision: async () => { calls.vision++; return JSON.stringify({ shows_subject: true, kind: "photo", reason: "slab visible", grade_label: null, people_main_subject: false, plain_background: false, subject_bbox: [0.2, 0.1, 0.8, 0.9], subject_fill: 0.6, ...(images[last].vision || {}) }); },
    crop: async (src, out) => { fs.copyFileSync(src, out); return { ok: true, width: 1200, height: 1500, box: [0, 0, 1200, 1500] }; },
    composeSlab: async (src, out) => { fs.copyFileSync(src, out); return { ok: true }; },
    searchImages: async (cfg, q) => { calls.search++; return { provider: "mock", results: search, query: q }; },
  };
  return { io, calls };
}
const page = (img, site = "PokeGuardian", extra = "") => `<html><head><meta property="og:site_name" content="${site}"><meta property="og:image" content="${img}"></head><body><article>${extra}</article></body></html>`;
const cardSubject = { type: "card", card: "Umbreon ex", set: "Prismatic Evolutions", grader: "PSA", grade: "10", event: null, product: null };
const subj = s => ({ ...s, query: W.searchQuery(s), label: W.subjectLabel(s) });
const newsItem = (url, extra = {}) => ({ kind: "news", source: "PokeGuardian", url, title: "PSA 10 Umbreon ex sells for a record", ...extra });
let n = 0;
const resolve = (item, w, ctx = {}, layout = "signal", slot = "hook") => W.resolveSlot({ A, item, card: { headline: "x" }, layout, slot, setId: `s${++n}`, dataDir: path.join(tmp, "d"), io: w.io, ctx: { subject: subj(cardSubject), dryRun: true, ...ctx } });
const fail = async p => { try { await p; return null; } catch (e) { return e; } };

(async () => {
  // ---------- helpers ----------
  t("upgradeUrl: CDN-upscale (enable=upscale) eraf", W.upgradeUrl("https://primary.jwwb.nl/a/tins-thumb-high.jpg?enable-io=true&enable=upscale")[0] === "https://primary.jwwb.nl/a/tins-thumb-high.jpg");
  t("upgrade: WordPress maat + resize-params weg", W.upgradeUrl("https://x.com/wp/a-300x200.jpg?w=300&quality=80&id=5")[0] === "https://x.com/wp/a.jpg?id=5");
  t("upgrade: eBay s-l1600, origineel als laatste", (u => u[0].endsWith("/s-l1600.jpg") && u[u.length - 1].endsWith("/s-l300.jpg"))(W.upgradeUrl("https://i.ebayimg.com/images/g/abc/s-l300.jpg")));
  t("srcset: grootste", W.largestFromSrcset("a.jpg 400w, b.jpg 1600w, c.jpg 800w", "https://x.com/p/").url === "https://x.com/p/b.jpg");
  const imgs = W.pageImages(page("/og.jpg", "PG", '<img src="/logo.png"><img srcset="/s1.jpg 600w, /s2.jpg 2000w" src="/s1.jpg"><img src="/tiny.jpg" width="120"><img src="/a.svg">'), "https://pokeguardian.com/n/1");
  t("pagina: og:image eerst, srcset groot, logo/klein/svg weg", imgs.map(i => i.url).join() === "https://pokeguardian.com/og.jpg,https://pokeguardian.com/s2.jpg");
  t("credit: og:site_name, fotograaf bij beeld", W.pageCredit(page("x", "PokeGuardian"), "https://pokeguardian.com/a").publisher === "PokeGuardian" && W.pageCredit("<p>Photo by Jane Doe</p>", "https://a.com").photographer === "Jane Doe");
  t("grade: PSA 10 = PSA 10, PSA 9 niet", W.gradeMatches(subj(cardSubject), { grade_label: "PSA GEM MT 10" }).ok && !W.gradeMatches(subj(cardSubject), { grade_label: "PSA 9" }).ok && W.gradeMatches(subj(cardSubject), { grade_label: null }).ok);
  t("zoekvragen: kaart+set+grade, set booster box, grader slab", W.searchQuery(cardSubject) === "Umbreon ex Prismatic Evolutions PSA 10" && W.searchQuery({ type: "set", set: "Surging Sparks" }) === "Surging Sparks booster box" && W.searchQuery({ type: "grading", grader: "CGC" }) === "CGC slab");
  const s0 = await W.subjectFor({ item: { title: "BGS 9.5 Charizard sells", card: { name: "Charizard", set_name: "Base Set" } }, card: {}, layout: "signal", slot: "hook" });
  const s1 = await W.subjectFor({ item: { title: "The TCG launched in Japan in 1996" }, card: {}, layout: "versus", slot: "left", llm: async () => '{"type":"set","set":"null","card":null}' });
  t("onderwerp: LLM-\"null\" telt niet, valt terug op product met titel", s1.type === "product" && !/null/.test(s1.label) && /1996/.test(s1.label));
  t("onderwerp zonder LLM: kaart + grade uit de tekst", s0.type === "card" && s0.grader === "BGS" && s0.grade === "9.5" && /Charizard/.test(s0.label));

  // ---------- search providers: key in header, never in the URL ----------
  let seen = null;
  const fake = async (url, opt) => { seen = { url, opt }; return { ok: true, json: async () => ({ results: [{ url: "https://tcgplayer.com/p", properties: { url: "https://img.tcgplayer.com/a.jpg", width: 1400, height: 1400 }, title: "x" }] }) }; };
  const br = await W.searchImages({ search: { provider: "brave", key_env: "TEST_BRAVE" } }, "Umbreon ex", { fetchImpl: fake, env: { TEST_BRAVE: "k123" } });
  t("brave: sleutel in header, niet in URL", seen.opt.headers["X-Subscription-Token"] === "k123" && !seen.url.includes("k123") && br.results[0].domain === "tcgplayer.com");
  await W.searchImages({ search: { provider: "google_cse" } }, "x", { fetchImpl: fake, env: { GOOGLE_CSE_KEY: "g999", GOOGLE_CSE_CX: "cx1" } });
  t("google_cse: sleutel in header, niet in URL", seen.opt.headers["x-goog-api-key"] === "g999" && !seen.url.includes("g999"));
  const none = await W.searchImages({ search: { provider: "brave", key_env: "NOPE" } }, "x", { fetchImpl: fake, env: {} });
  t("zoeken zonder sleutel: overgeslagen met reden", none.results.length === 0 && /niet geconfigureerd/.test(none.note));
  const ranked = W.rankSearch([{ domain: "reddit.com", width: 3000, height: 3000 }, { domain: "random.net", width: 800, height: 600 }, { domain: "psacard.com", width: 1500, height: 1500 }], W.settings(A));
  t("rangorde: grader boven forum, klein onderaan", ranked[0].domain === "psacard.com" && ranked[2].domain === "random.net");

  // ---------- 1 article ----------
  const art = "https://pokeguardian.com/news/umbreon";
  let w = world({ "https://pokeguardian.com/og.jpg": {} }, { [art]: page("https://pokeguardian.com/og.jpg") });
  let r = await resolve(newsItem(art), w);
  const rec = r.record;
  t("stap 1: og:image uit het artikel", rec.step === "article" && rec.image_url === "https://pokeguardian.com/og.jpg" && rec.mode === "photo");
  t("log-velden: image_url, pagina, domein, credit, fetched_at, set", ["image_url", "source_page_url", "source_domain", "credit_name", "fetched_at", "set_id"].every(k => rec[k]) && rec.credit_name === "PokeGuardian" && rec.source_domain === "pokeguardian.com");
  t("onderwerpcheck vastgelegd (model + vraag + antwoord)", rec.subject_check.model === W.settings(A).vision_model && /does this image show/.test(rec.subject_check.question) && rec.subject_check.answer === "yes");
  t("crop 4:5 rond onderwerp", rec.crop && rec.crop.aspect === "4:5");
  const logLines = W.readLog(path.join(tmp, "image_log.jsonl"));
  t("image_log.jsonl: regel per gebruikt beeld", logLines.some(l => l.action === "used" && l.image_url === rec.image_url && l.credit_name === "PokeGuardian"));
  t("caption-credit: image: <naam>", W.creditLine([rec]) === "image: PokeGuardian");

  // ---------- quality rules fall through to the next candidate ----------
  const bad = { "https://a.com/blur.jpg": { info: { blur: 12 } }, "https://a.com/small.jpg": { info: { width: 640, height: 800 } }, "https://a.com/text.jpg": { info: { text_ratio: 0.5 } },
    "https://a.com/shot.jpg": { vision: { kind: "screenshot" } }, "https://a.com/no.jpg": { vision: { shows_subject: false, reason: "different card" } }, "https://a.com/psa9.jpg": { vision: { grade_label: "PSA 9" } },
    "https://a.com/stock.jpg": { info: { watermark: ["shutterstock"] } }, "https://a.com/good.jpg": {} };
  const tags = Object.keys(bad).map(u => `<img src="${u}" width="1600" height="2000">`).join("");
  const art2 = "https://pokeguardian.com/news/two";
  w = world(bad, { [art2]: `<html><head><meta property="og:site_name" content="PG"></head><body><article>${tags}</article></body></html>` });
  r = await resolve(newsItem(art2), w);
  const idx = fs.readFileSync(path.join(tmp, "d", "images", "index.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(x => x.set_id === `s${n}` && x.status === "rejected");
  const why = u => (idx.find(x => x.image_url === u) || {}).reasons?.join(" ") || "";
  t("afgewezen: onscherp (Laplacian)", /onscherp/.test(why("https://a.com/blur.jpg")));
  t("afgewezen: kleiner dan 1000 px", /te klein/.test(why("https://a.com/small.jpg")));
  t("afgewezen: vooral tekst", /vooral tekst/.test(why("https://a.com/text.jpg")));
  t("afgewezen: screenshot", /screenshot/.test(why("https://a.com/shot.jpg")));
  t("afgewezen: onderwerpcheck nee", /toont het onderwerp niet/.test(why("https://a.com/no.jpg")));
  t("afgewezen: grade klopt niet", /grade klopt niet/.test(why("https://a.com/psa9.jpg")));
  t("afgewezen: stock-watermerk", /stock/.test(why("https://a.com/stock.jpg")));
  t("goede kandidaat gekozen na afwijzingen", r.record.image_url === "https://a.com/good.jpg");

  // ---------- fill preference + plain background ----------
  const art3 = "https://pokeguardian.com/news/three";
  w = world({ "https://a.com/far.jpg": { vision: { subject_fill: 0.15 } }, "https://a.com/near.jpg": { vision: { subject_fill: 0.7, plain_background: true } } },
    { [art3]: `<html><body><article><img src="https://a.com/far.jpg" width="2000" height="2000"><img src="https://a.com/near.jpg" width="1500" height="1500"></article></body></html>` });
  r = await resolve(newsItem(art3), w);
  t("voorkeur: onderwerp vult >= 40%", r.record.image_url === "https://a.com/near.jpg" && r.record.alternates.includes("https://a.com/far.jpg"));
  t("los object op effen achtergrond: object-modus (60% hoogte)", r.record.mode === "object" && r.record.crop.aspect === "object");

  // ---------- 2 coverage ----------
  const art4 = "https://pokeguardian.com/news/four", cov = "https://pokebeach.com/story";
  w = world({ "https://pokebeach.com/c.jpg": {} }, { [art4]: page("https://dead.example/none.jpg"), [cov]: page("https://pokebeach.com/c.jpg", "PokeBeach") });
  r = await resolve(newsItem(art4, { trend: { related: [{ source: "PokeBeach", url: cov }] } }), w);
  t("stap 2: andere outlet met hetzelfde verhaal", r.record.step === "coverage" && r.record.credit_name === "PokeBeach");

  // ---------- blocklist + rotation ----------
  W.addToBlocklist(path.join(tmp, "blocklist.yaml"), "pokebeach.com", "test");
  t("blocklist: yaml lezen/schrijven", W.readBlocklist(path.join(tmp, "blocklist.yaml")).includes("pokebeach.com") && !W.addToBlocklist(path.join(tmp, "blocklist.yaml"), "pokebeach.com", "dubbel"));
  w = world({ "https://pokebeach.com/c.jpg": {} }, { [art4]: page("https://dead.example/none.jpg"), [cov]: page("https://pokebeach.com/c.jpg", "PokeBeach") });
  let e = await fail(resolve(newsItem(art4, { trend: { related: [{ source: "PokeBeach", url: cov }] } }), w));
  t("blocklist: domein overgeslagen", e && e.code === "NO_IMAGE" && w.calls.vision === 0);
  fs.writeFileSync(path.join(tmp, "blocklist.yaml"), "domains: []\n");
  const logF = path.join(tmp, "image_log.jsonl");
  W.appendLog(logF, { used_at: new Date().toISOString(), action: "used", set_id: "live1", dry_run: false, image_url: "https://pokebeach.com/c.jpg" });
  e = await fail(resolve(newsItem(art4, { trend: { related: [{ source: "PokeBeach", url: cov }] } }), w));
  t("rotatie: zelfde URL binnen 30 dagen overgeslagen", e && e.code === "NO_IMAGE");
  t("rotatie: dry runs en oude regels tellen niet", W.recentlyUsed(logF, 30, Date.now() + 31 * 864e5).size === 0 && (W.appendLog(logF, { used_at: new Date().toISOString(), action: "used", set_id: "d1", dry_run: true, image_url: "https://q.com/dry.jpg" }), !W.recentlyUsed(logF, 30, Date.now()).has("https://q.com/dry.jpg")));

  // ---------- 3 search ----------
  w = world({ "https://img.psacard.com/s.jpg": {}, "https://i.redd.it/r.jpg": {} }, { "https://www.psacard.com/cert/1": page("x", "PSA") },
    [{ image_url: "https://i.redd.it/r.jpg", page_url: "https://reddit.com/r/x", domain: "reddit.com", width: 3000, height: 3000 }, { image_url: "https://img.psacard.com/s.jpg", page_url: "https://www.psacard.com/cert/1", domain: "psacard.com", width: 1500, height: 1500 }]);
  r = await resolve({ kind: "metric", source: "NeuraCollectibles API", url: "https://api.neuralabs.cloud", title: "x" }, w);
  t("stap 3: zoekresultaat, grader boven forum, credit van de pagina", r.record.step === "search" && r.record.source_domain === "psacard.com" && r.record.credit_name === "PSA" && r.record.search_query === "Umbreon ex Prismatic Evolutions PSA 10");

  // ---------- 4 card_db ----------
  const scan = "https://images.scrydex.com/pokemon/sv8pt5-161/large";
  w = world({ [scan]: { info: { width: 600, height: 825 } } });
  e = await fail(resolve({ kind: "metric", source: "NeuraCollectibles API", url: "https://api.neuralabs.cloud", title: "x" }, w, { cardImage: async () => ({ image_url: scan }) }));
  t("stap 4: te kleine scan afgewezen (min 1000 px)", e && e.code === "NO_IMAGE" && e.steps.some(s => s.step === "card_db" && /te klein/.test(s.result)));
  w = world({ [scan]: { info: { width: 1100, height: 1536 } } });
  let slabArgs = null;
  w.io.composeSlab = async (src, out, name, grade) => { slabArgs = { name, grade }; fs.copyFileSync(src, out); return { ok: true }; };
  r = await resolve({ kind: "metric", source: "NeuraCollectibles API", url: "https://api.neuralabs.cloud", title: "x" }, w, { cardImage: async () => ({ image_url: scan, source_page_url: "https://api.neuralabs.cloud/collectibles/v1/cards/x" }) });
  t("stap 4: kaartscan in slab-kader met de echte grade", r.record.step === "card_db" && r.record.mode === "slab" && slabArgs.grade === "PSA 10" && slabArgs.name === "Umbreon ex" && r.record.credit_name === "scrydex" && r.record.source_domain === "images.scrydex.com");
  w = world({ [scan]: { info: { width: 1100, height: 1536 } } });
  w.io.composeSlab = async (src, out, name, grade) => { slabArgs = { name, grade }; fs.copyFileSync(src, out); return { ok: true }; };
  await resolve({ kind: "metric", title: "x" }, w, { cardImage: async () => ({ image_url: scan }), subject: subj({ ...cardSubject, grader: null, grade: null }) });
  t("stap 4: geen grade in het verhaal = geen grade op het label", slabArgs.grade === "");
  w = world({ "https://evil.example/x.png": {} });
  e = await fail(resolve({ kind: "metric", title: "x" }, w, { cardImage: async () => ({ image_url: "https://evil.example/x.png" }) }));
  t("stap 4: alleen kaartdatabase-hosts", e && e.steps.some(s => /niet toegestaan/.test(s.result)));

  // ---------- 5 set art ----------
  const setS = subj({ type: "set", set: "Surging Sparks", card: null, grader: null, grade: null, event: null, product: null });
  w = world({ "https://images.scrydex.com/pokemon/sv8-logo/logo": {} });
  r = await resolve({ kind: "metric", title: "Surging Sparks index up" }, w, { subject: setS, setArt: async () => ({ logo_url: "https://images.scrydex.com/pokemon/sv8-logo/logo" }) });
  t("stap 5: setlogo als enige beeld", r.record.step === "set_art" && r.record.mode === "logo" && !r.logo);
  const art5 = "https://pokeguardian.com/news/box";
  w = world({ "https://pokeguardian.com/box.jpg": {}, "https://images.scrydex.com/pokemon/sv8-logo/logo": {} }, { [art5]: page("https://pokeguardian.com/box.jpg") });
  r = await resolve(newsItem(art5), w, { subject: setS, setArt: async () => ({ logo_url: "https://images.scrydex.com/pokemon/sv8-logo/logo" }) });
  t("stap 5: setlogo op de foto, beide in de credit", r.record.step === "article" && r.logo && r.record.logo && W.creditLine([r.record]) === "image: PokeGuardian, scrydex");

  // ---------- nothing: stop ----------
  w = world({});
  e = await fail(resolve({ kind: "metric", title: "x" }, w));
  t("niets gevonden: NoImageError met stappen (geen Nano Banana)", e instanceof W.NoImageError && e.steps.map(s => s.step).join() .includes("article") && e.steps.some(s => s.step === "card_db"));

  // ---------- render ----------
  const png = nc.dataUri(path.join(tmp, "d", "images", fs.readdirSync(path.join(tmp, "d", "images")).find(f => f.endsWith(".png"))));
  const html = (layout, images) => nc.buildSlides({ layout, pill: "signal", headline: "x [a]1[/a]", versus: { left: { label: "a", value: "1" }, right: { label: "b", value: "2" } }, number: "1", payload: { title: "t", items: [] } }, images, "slabhaus").map(x => x.html || x).join("");
  const hp = html("signal", { hook: png, hook_fit: "photo" });
  t("render signal foto: vult 0-820 px met fade", /height:\s*820px/.test(hp) && /linear-gradient/.test(hp) && /cover/.test(hp));
  t("render signal object: op patroon, contain", /contain/.test(html("signal", { hook: png, hook_fit: "object" })));
  const hv = html("versus", { left: png, left_fit: "photo", right: png, right_fit: "photo" });
  t("render versus: foto per helft", (hv.match(/data:image\/png;base64/g) || []).length >= 2);
  t("render: gh0stlayer ongewijzigd (geen webzone)", !/height:\s*820px/.test(nc.buildSlides({ layout: "signal", pill: "signal", headline: "x", payload: { title: "t", items: [] } }, {}, "gh0stlayer").map(x => x.html || x).join("")));

  // ---------- pipeline: takedown on a dry-run set ----------
  const SP = NC.forAccount("slabhaus");
  Object.assign(SP.account.profile.image_policy.web, webCfg());
  fs.writeFileSync(path.join(tmp, "blocklist.yaml"), "domains: []\n");
  const art6 = "https://pokeguardian.com/news/td";
  const td = world({ "https://pokeguardian.com/td1.jpg": {}, "https://www.elitefourum.com/td2.jpg": {} },
    { [art6]: page("https://pokeguardian.com/td1.jpg"), "https://www.elitefourum.com/t/1": page("https://www.elitefourum.com/td2.jpg", "Elite Fourum") });
  const item6 = newsItem(art6, { trend: { related: [{ source: "Elite Fourum", url: "https://www.elitefourum.com/t/1" }] } });
  const card6 = { layout: "signal", pill: "signal", headline: "PSA 10 Umbreon ex [a]record[/a]", caption: "line one\n#pokemontcg", payload: { title: "t", items: [] } };
  const m = { id: "20261117-test", account: "slabhaus", dry_run: true, status: "rendered", layout: "signal", card: card6, item: item6, plan: { item: item6, layout: "signal", score: { total: 1 } }, images: {}, slides: [], posts: {}, log: [] };
  const deps = { webIo: td.io, cardImage: async () => null, setArt: async () => null, llm: null };
  await SP.webImagesFor({ deps, m, card: card6, plan: m.plan, setId: m.id, dryRun: true });
  t("pipeline: caption eindigt op image-regel", card6.caption.split("\n").pop() === "image: PokeGuardian" && m.images.policy === "web");
  SP.saveDrySet(m);
  let platform = 0;
  const res = await SP.takedown({ ...deps, igDelete: async () => { platform++; }, xDelete: async () => { platform++; } }, m.id, { reason: "test", by: "test" });
  const after = SP.loadSet(m.id);
  t("takedown: geen platform-calls bij dry run", platform === 0 && /dry run/.test(res.action.deleted.note));
  t("takedown: domein op de blocklist", W.readBlocklist(path.join(tmp, "blocklist.yaml")).includes("pokeguardian.com"));
  t("takedown: opnieuw gerenderd met volgende kandidaat", res.action.rerender.ok && after.images.hook.source_domain === "elitefourum.com" && after.card.caption.split("\n").pop() === "image: Elite Fourum");
  t("takedown: gelogd (image_log + takedown_log + manifest)", W.readLog(logF).some(l => l.action === "takedown" && l.set_id === m.id) && W.readLog(path.join(tmp, "takedown_log.jsonl")).length === 1 && after.takedowns.length === 1);
  await nc.closeBrowser();

  // ---------- source guards ----------
  const src = fs.readFileSync(path.join(__dirname, "..", "images", "web.js"), "utf8");
  t("web.js: geen sleutel in een query-string", !/[?&](key|api_key|token)=/i.test(src));
  t("web.js: geen beeldgenerator aangeroepen", !/genImage|gemini|infsh|generateImage/i.test(src));
  t("slabhaus yaml: kind web, geen neutral_scenes", SP.account.imagePolicy.kind === "web" && !SP.account.imagePolicy.neutral_scenes);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(process.env.NEWS_CARDS_DIR, { recursive: true, force: true });
  console.log(fails ? `${fails} FOUT` : "alles ok");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("FOUT", e.stack); process.exit(1); });
