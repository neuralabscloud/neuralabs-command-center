// node scripts/test-image-policy.js   (geen netwerk; downloads zijn nagebootst, inspect.py draait lokaal op eigen fixtures)
// Beeldbeleid news cards: tiers per layout, host-allowlist, provenance, caption-credit, afwijzing op gezicht/maat/watermerk.
const os = require("os"), fs = require("fs"), path = require("path");
const { execFileSync } = require("child_process");
process.env.NEWS_CARDS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nc-img-test-"));
const P = require("../images/policy");
const nc = require("../news-cards");
const NC = require("../news-cards-pipeline");
let fails = 0;
const t = (name, cond) => { console.log(`${cond ? "ok  " : "FOUT"} ${name}`); if (!cond) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "img-policy-"));
const S = nc.account("slabhaus"), G = nc.account("gh0stlayer");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

(async () => {
  // layouts
  t("layouts: signal/versus 1-4, persona alleen 3, number/payload geen", P.LAYOUT_TIERS.signal.join() === "1,2,3,4" && P.LAYOUT_TIERS.versus.join() === "1,2,3,4" && P.LAYOUT_TIERS.persona.join() === "3" && !P.LAYOUT_TIERS.number.length && !P.LAYOUT_TIERS.payload.length);

  // bronbeleid
  t("bron: NC = card_db, outlet standaard none", P.sourcePolicy(S, "NeuraCollectibles API").policy === "card_db" && P.sourcePolicy(S, "PokeGuardian").policy === "none" && P.sourcePolicy(S, "r/PokemonTCG").policy === "none");
  t("bron: gh0stlayer alles none", P.sourcePolicy(G, "NeuraCollectibles API").policy === "none" && G.fallback === "chart");
  const hosts = ["images.pokemontcg.io", "pokemon.com"];
  t("host: exact en subdomein ok", P.hostOk("images.pokemontcg.io", hosts) && P.hostOk("assets.pokemon.com", hosts));
  t("host: lookalikes geweigerd", !P.hostOk("images.pokemontcg.io.evil.com", hosts) && !P.hostOk("notpokemon.com", hosts) && !P.hostOk("", hosts));
  t("ip: intern herkend", ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.1.1", "::1", "fd00::1", "::ffff:127.0.0.1"].every(P.privateIp) && !P.privateIp("151.101.1.1"));

  // download
  const pub = async () => [{ address: "151.101.1.1" }];
  const res = (status, headers, body = PNG) => ({ status, ok: status >= 200 && status < 300, headers: { get: k => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => body });
  const rej = async (url, h, io) => { try { await P.download(url, h, io); return ""; } catch (e) { return e.message; } };
  t("download: alleen https", /https/.test(await rej("http://images.pokemontcg.io/a.png", hosts, { lookup: pub, fetchImpl: async () => res(200, { "content-type": "image/png" }) })));
  t("download: host buiten allowlist", /niet toegestaan/.test(await rej("https://i.redd.it/a.png", hosts, { lookup: pub, fetchImpl: async () => res(200, { "content-type": "image/png" }) })));
  t("download: redirect naar andere host geweigerd", /niet toegestaan/.test(await rej("https://images.pokemontcg.io/a.png", hosts, { lookup: pub, fetchImpl: async () => res(302, { location: "https://cdn.example.com/a.png" }) })));
  t("download: svg geweigerd", /type/.test(await rej("https://images.pokemontcg.io/a.svg", hosts, { lookup: pub, fetchImpl: async () => res(200, { "content-type": "image/svg+xml" }, Buffer.from("<svg/>")) })));
  t("download: intern IP geweigerd", /intern/.test(await rej("https://images.pokemontcg.io/a.png", hosts, { lookup: async () => [{ address: "127.0.0.1" }], fetchImpl: async () => res(200, { "content-type": "image/png" }) })));
  t("download: nep-png geweigerd", /png/.test(await rej("https://images.pokemontcg.io/a.png", hosts, { lookup: pub, fetchImpl: async () => res(200, { "content-type": "image/png" }, Buffer.from("<html>")) })));
  const okDl = await P.download("https://images.pokemontcg.io/a.png", hosts, { lookup: pub, fetchImpl: async () => res(200, { "content-type": "image/png" }) });
  t("download: geldige png", okDl.ext === ".png" && okDl.buf.length === PNG.length);

  // checks
  t("check: klein beeld afgewezen", P.checkErrors({ width: 600, height: 825, faces: 0, watermark: [] }).some(e => /te klein/.test(e)));
  t("check: gezicht afgewezen", P.checkErrors({ width: 1200, height: 1500, faces: 1, watermark: [] }).some(e => /gezicht/.test(e)));
  t("check: watermerk afgewezen", P.checkErrors({ width: 1200, height: 1500, faces: 0, watermark: ["getty"] }).some(e => /watermerk/.test(e)));
  t("check: schoon beeld ok", P.checkErrors({ width: 733, height: 1024, faces: 0, watermark: [] }).length === 0);

  // resolve: tier 2 kaartdatabase
  const calls = { dl: 0, card: 0 };
  const goodIo = info => ({
    download: async (url, h) => { calls.dl++; if (!P.hostOk(new URL(url).hostname, h)) throw new Error("host"); return { buf: PNG, ext: ".png", final_url: url }; },
    inspect: async () => info || { width: 733, height: 1024, faces: 0, watermark: [] },
    composeSlab: async (src, out) => { fs.copyFileSync(src, out); return { ok: true }; },
  });
  const cardImage = async c => { calls.card++; return { image_url: "https://images.scrydex.com/pokemon/sv1-1/large", source_page_url: "https://api.neuralabs.cloud/collectibles/v1/cards/sv1-1", card_id: c.card_id }; };
  const ncItem = { source: "NeuraCollectibles API", url: "https://api.neuralabs.cloud", card: { card_id: "sv1-1", name: "Sprigatito", set_name: "Scarlet & Violet" } };
  const dir1 = path.join(tmp, "a");
  let r = await P.resolve({ A: S, item: ncItem, layout: "signal", slot: "hook", setId: "t1", dataDir: dir1, ctx: { cardImage }, io: goodIo() });
  t("tier 2: kaartscan uit NC in slab-kader", r.record.policy_tier === 2 && r.record.source === "card_db" && r.record.frame === "slab" && /-slab\.png$/.test(r.file) && fs.existsSync(r.file));
  t("provenance: velden in manifest", ["source_page_url", "image_url", "policy_tier", "fetched_at"].every(k => r.record[k] != null) && r.record.credit === "scrydex");
  const idx = fs.readFileSync(path.join(dir1, "images", "index.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const side = JSON.parse(fs.readFileSync(path.join(dir1, "images", `${r.record.id}.json`), "utf8"));
  t("provenance: index.jsonl + sidecar", idx.some(x => x.status === "ok" && x.source_page_url && x.image_url && x.policy_tier === 2 && x.fetched_at) && side.image_url === r.record.image_url);
  t("caption-credit regel", P.creditLine([r.record]) === "image: scrydex" && P.creditLine([{ policy_tier: 3, source: "gallery" }]) === "");

  // afwijzing valt door naar tier 3/4
  for (const [name, info] of [["gezicht", { width: 1200, height: 1500, faces: 2, watermark: [] }], ["te klein", { width: 600, height: 825, faces: 0, watermark: [] }], ["watermerk", { width: 1200, height: 1500, faces: 0, watermark: ["shutterstock"] }]]) {
    const d = path.join(tmp, `rej-${name}`);
    r = await P.resolve({ A: S, item: ncItem, layout: "signal", slot: "hook", setId: "t2", dataDir: d, ctx: { cardImage }, io: goodIo(info) });
    const rejected = fs.readFileSync(path.join(d, "images", "index.jsonl"), "utf8").includes('"status":"rejected"');
    t(`afwijzing ${name}: patroon, gelogd, bestand weg`, r.record.source === "pattern" && r.record.policy_steps.some(s => s.tier === 2 && /afgewezen/.test(s.result)) && rejected && !fs.readdirSync(path.join(d, "images")).some(f => /\.png$/.test(f)));
  }

  // eigen foto wint
  calls.card = 0;
  r = await P.resolve({ A: S, item: ncItem, layout: "signal", slot: "hook", setId: "t3", dataDir: path.join(tmp, "b"), ctx: { cardImage, galleryMatch: async () => ({ file: "/x/own.jpg", record: { source: "gallery", file: "own.jpg", match: "card" } }) }, io: goodIo() });
  t("eigen foto (match) wint van tier 1 en 2", r.record.source === "gallery" && r.record.policy_tier === 3 && calls.card === 0);

  // persona alleen tier 3, number geen beeld
  calls.card = 0; calls.dl = 0;
  r = await P.resolve({ A: S, item: ncItem, layout: "persona", slot: "hook", setId: "t4", dataDir: path.join(tmp, "c"), ctx: { cardImage, tier4: async () => ({ file: "/x/nb.png", record: { source: "nano_banana_neutral" } }) }, io: goodIo() });
  t("persona: geen download, geen NB", r.record.source === "none" && calls.card === 0 && calls.dl === 0);
  r = await P.resolve({ A: S, item: ncItem, layout: "number", slot: "hook", setId: "t5", dataDir: path.join(tmp, "c"), ctx: { cardImage }, io: goodIo() });
  t("number: geen beeld", r.file === null && r.record.source === "none" && calls.card === 0);

  // outlet-bron: nooit downloaden
  calls.dl = 0;
  r = await P.resolve({ A: S, item: { source: "PokeGuardian", url: "https://www.pokeguardian.com/x", card: ncItem.card }, layout: "signal", slot: "hook", setId: "t6", dataDir: path.join(tmp, "d"), ctx: { cardImage }, io: goodIo() });
  t("outlet-bron: geen download, patroon", calls.dl === 0 && r.record.source === "pattern");

  // tier 4: eigen grafiek bij een reeks
  r = await P.resolve({ A: G, item: { source: "DefiLlama", series: [["Jan", 1], ["Feb", 2]] }, layout: "signal", slot: "hook", setId: "t7", dataDir: path.join(tmp, "e"), ctx: { tier4: async () => ({ chart: [["Jan", 1], ["Feb", 2]], record: { source: "svg_chart" } }) } });
  t("tier 4: SVG-grafiek bij reeks", r.chart && r.record.source === "svg_chart" && r.record.policy_tier === 4);

  // tier 1: officieel
  const off = { ...S, profile: { ...S.profile, image_policy: { sources: { "pokemon.com": { policy: "official", hosts: ["pokemon.com"], credit: "pokemon.com" } } } } };
  const page = '<meta property="og:image" content="https://assets.pokemon.com/press/a.jpg">';
  const offIo = { ...goodIo(), getPage: async () => page };
  r = await P.resolve({ A: off, item: { source: "pokemon.com", url: "https://www.pokemon.com/us/news/x" }, layout: "signal", slot: "hook", setId: "t8", dataDir: path.join(tmp, "f"), io: offIo });
  t("tier 1: og:image op eigen domein", r.record.policy_tier === 1 && r.record.source === "official" && r.record.source_page_url === "https://www.pokemon.com/us/news/x");
  r = await P.resolve({ A: off, item: { source: "pokemon.com", url: "https://www.pokeguardian.com/copy" }, layout: "signal", slot: "hook", setId: "t9", dataDir: path.join(tmp, "f"), io: offIo });
  t("tier 1: kopie op nieuwssite telt niet", r.record.source === "pattern" && r.record.policy_steps.some(s => /eigen domein/.test(s.result)));
  r = await P.resolve({ A: off, item: { source: "pokemon.com", url: "https://www.pokemon.com/us/news/y" }, layout: "signal", slot: "hook", setId: "t10", dataDir: path.join(tmp, "f"), io: { ...offIo, getPage: async () => '<meta property="og:image" content="https://i.ytimg.com/a.jpg">' } });
  t("tier 1: og:image op vreemde host geweigerd", r.record.source === "pattern");

  // pipeline: caption-credit + manifest
  const SP = NC.forAccount("slabhaus");
  const card = { layout: "signal", headline: "x", image_brief: "Sprigatito", caption: "line one\nwhat do you think link in bio\n#pokemontcg #psa10 #slabs #pokemoncards" };
  const m = { images: {}, log: [] };
  const imgs = await SP.imagesFor({ deps: { cardImage, imageIo: goodIo() }, m, card, plan: { layout: "signal", item: ncItem }, setId: "p1", hist: [], now: Date.now() });
  t("pipeline: caption eindigt op image-regel", card.caption.split("\n").pop() === "image: scrydex" && m.images.credit === "image: scrydex");
  t("pipeline: manifest + data-URI", m.images.hook.policy_tier === 2 && /^data:image\/png;base64,/.test(imgs.hook));

  // render: grafiek en patronen
  const html = s => nc.buildSlides({ layout: "signal", pill: "signal", headline: "x [a]1[/a]", payload: { title: "t", items: [] } }, s, "gh0stlayer").map(x => x.html || x).join("");
  t("render: grafiek in beeldzone", /zonechart/.test(html({ hook_series: [["Jan", 1], ["Feb", 2]] })));
  t("render: gh0stlayer grafieksilhouet zonder beeld", /chartpat/.test(html({})));

  // inspect.py op eigen fixtures (lokaal, geen netwerk)
  const py = (...a) => JSON.parse(execFileSync("python3", ["-I", "-S", path.join(__dirname, "..", "images", "inspect.py"), ...a], { encoding: "utf8", timeout: 180000 }).trim());
  const mk = `import sys; sys.path.insert(0,"/usr/lib/python3/dist-packages")
from PIL import Image, ImageDraw, ImageFont
Image.new("RGB",(1200,1500),(30,30,34)).save(sys.argv[1])
Image.new("RGB",(600,800),(30,30,34)).save(sys.argv[2])
im=Image.new("RGB",(1200,1500),(240,240,240)); d=ImageDraw.Draw(im); d.text((80,600),"shutterstock",fill=(0,0,0),font=ImageFont.load_default(size=120)); im.save(sys.argv[3])`;
  const [blank, small, wm] = ["blank.png", "small.png", "wm.png"].map(f => path.join(tmp, f));
  execFileSync("python3", ["-I", "-S", "-c", mk, blank, small, wm]);
  const ib = py("inspect", blank), is = py("inspect", small), iw = py("inspect", wm);
  t("inspect.py: leeg beeld schoon", ib.faces === 0 && !ib.watermark.length && P.checkErrors(ib).length === 0);
  t("inspect.py: klein beeld afgewezen", P.checkErrors(is).some(e => /te klein/.test(e)));
  t("inspect.py: watermerktekst gevonden", iw.watermark.includes("shutterstock"));
  const out = path.join(tmp, "slab.png");
  py("slab", small, out);
  t("inspect.py: slab-kader 1200x1500", py("inspect", out).width === 1200 && py("inspect", out).height === 1500);

  // nooit open web of beeldzoeker
  const src = fs.readFileSync(path.join(__dirname, "..", "images", "policy.js"), "utf8");
  t("geen zoekmachine of open web in beleid", !/google|bing|duckduckgo|serpapi|images\.search|tineye|yandex/i.test(src));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} FOUT` : "alles ok");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("FOUT", e.stack); process.exit(1); });
