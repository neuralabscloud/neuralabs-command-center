// node scripts/test-news-cards-accounts.js   (geen netwerk; schrijft alleen in een temp dir)
// Multi-account news cards: YAML-profielen, galerij-matcher, X-link ratio, X uit zonder creds, Slabhaus-validator.
const os = require("os"), fs = require("fs"), path = require("path");
process.env.NEWS_CARDS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nc-acc-test-"));
const accounts = require("../accounts");
const NC = require("../news-cards-pipeline");
const nc = require("../news-cards");
let fails = 0;
const t = (name, cond) => { console.log(`${cond ? "ok  " : "FOUT"} ${name}`); if (!cond) fails++; };

// YAML subset
const y = accounts.parse("a: 1\nb:\n  c: \"x\"\n  d: [1, 2]\nl:\n  - p\n  - {\"q\": 3}\ntxt: |\n  r1\n  r2\ne: true # comment\n");
t("yaml: scalars, nesting, lists, block", y.a === 1 && y.b.c === "x" && y.b.d[1] === 2 && y.l[1].q === 3 && y.txt === "r1\nr2" && y.e === true);
t("accounts: gh0stlayer + slabhaus", ["gh0stlayer", "slabhaus"].every(a => NC.accountIds().includes(a)));
let threw = false; try { accounts.load("../etc"); } catch { threw = true; }
t("accounts: pad-injectie geweigerd", threw);

const G = NC.forAccount("gh0stlayer"), S = NC.forAccount("slabhaus");
t("gh0stlayer blijft eigen map en media", G.DIR === process.env.NEWS_CARDS_DIR && G.MEDIA_REL === "/media/news-cards");
t("slabhaus: eigen map, media/cards/slabhaus, 3 per dag", S.DIR.endsWith("/slabhaus") && S.MEDIA_REL === "/media/cards/slabhaus" && S.config().platforms.instagram.max_per_day === 3 && S.account.profile.schedule.times.length === 3 && S.config().platforms.x.max_per_day === 3);
t("slabhaus: kanaal + Madrid 08:10", S.config().channel_id === "slabcok4gtn6" && S.account.profile.schedule.tz === "Europe/Madrid" && S.account.profile.schedule.times[0] === "08:10");
t("geen buffer/tiktok platforms", S.PLATFORMS.join() === "instagram,x" && G.PLATFORMS.join() === "instagram,x");
t("pills slabhaus zonder haus take", S.account.pills.length === 7 && !S.account.pills.includes("haus take") && S.account.pills.includes("pop report"));
{
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"].map((k, i) => ({ kind: "news", source: "PokeGuardian", url: `https://www.pokeguardian.com/${k}`, title: `Pokémon TCG set ${k} released with ${100 + i} cards`, summary: `pokemon tcg set release with ${100 + i} cards`, numbers: [String(100 + i)], published_at: new Date().toISOString(), entities: ["release"] }));
  const gItems = ["a", "b", "c", "d", "e", "f", "g", "h"].map((k, i) => ({ kind: "news", source: "CoinDesk", url: `https://www.coindesk.com/${k}`, title: `Bitcoin ETF inflows hit ${500 + i} million ${k}`, summary: `bitcoin etf inflows ${500 + i} million`, numbers: [String(500 + i)], published_at: new Date().toISOString(), entities: ["BTC"] }));
  const plan = nc.planDay(items, [], { count: 8, account: "slabhaus", minScore: 0, rand: () => 0 });
  t("slabhaus: nooit persona gepland", plan.length > 0 && plan.every(p => p.layout !== "persona"));
  t("slabhaus: dry-run layouts zonder persona", S.planLayouts(items, [], ["signal", "persona"], Date.now()).every(p => p.layout !== "persona"));
  const gp = nc.planDay(gItems, [], { count: 8, account: "gh0stlayer", minScore: 0, rand: () => 0 });
  t("gh0stlayer: persona blijft mogelijk", gp.some(p => p.layout === "persona"));
}

// galerij-matcher
const photos = [
  { file: "a.jpg", card: "Charizard", set: "Base Set", kind: "slab" },
  { file: "b.jpg", set: "Base Set", kind: "slab" },
  { file: "c.jpg", kind: "slab", generic: true },
  { file: "d.jpg", kind: "in_hand" },
];
t("galerij: kaartnaam wint", NC.pickGalleryPhoto(photos, "PSA 10 Charizard from Base Set").photo.file === "a.jpg");
t("galerij: setnaam match", NC.pickGalleryPhoto(photos, "Base Set turns 27", { exclude: ["a.jpg"] }).match === "set");
t("galerij: anders generieke slab", NC.pickGalleryPhoto(photos, "Delta Reign release").photo.file === "c.jpg");
t("galerij: in_hand voor haus take", NC.pickGalleryPhoto(photos, "x", { kinds: ["in_hand", "desk"] }).photo.file === "d.jpg");
t("galerij: leeg = pattern (null)", NC.pickGalleryPhoto([], "Charizard") === null);
t("galerij: lege map veilig", Array.isArray(NC.galleryPhotos(path.join(process.env.NEWS_CARDS_DIR, "nope"))));

// X: link ratio max 1 op 3, premium uit pair profile, X uit zonder creds
const now = Date.parse("2026-11-16T07:10:00Z");
const mkSet = (P, id, ms) => ({ id, created_at: new Date(ms).toISOString(), status: "rendered", layout: "number", pill: "pop report", posts: {}, log: [],
  item: { url: "https://example.org/a" }, validator: { ok: true },
  card: { headline: "h", x_hook: "hook", x_reply: "reply text from PokeGuardian", caption: "cap", payload: { title: "p" }, closer: { line: "c" } },
  slides: [1, 2].map(n => ({ slide: n, rel: `${P.MEDIA_REL}/set_${id}_slide_${n}.png` })) });
const xs = [];
const deps = (creds) => ({
  channel: () => ({ id: "slabcok4gtn6", autopilot: { mode: "auto" } }),
  addXTask: f => { xs.push(f); return { id: "x" + xs.length, ...f }; },
  xCredsOk: () => creds, notify: () => {},
});
(async () => {
  const off = mkSet(S, "n0", now);
  await S.schedulePublish({ deps: deps(false), m: off, nowMs: now });
  t("X uit zonder creds, met reden; IG gaat door", off.posts.x.status === "off" && /credentials/.test(off.posts.x.reason) && off.posts.instagram.status === "scheduled" && xs.length === 0);
  const links = [];
  for (let i = 1; i <= 6; i++) {
    const m = mkSet(S, "l" + i, now + i * 864e5);
    await S.schedulePublish({ deps: deps(true), m, nowMs: now + i * 864e5 });
    links.push(!!m.posts.x.link);
  }
  const withLink = links.filter(Boolean).length;
  t(`X-link max 1 op 3 sets (${links.map(l => l ? "L" : "-").join("")})`, withLink <= 2 && !links.some((l, i) => l && (links[i - 1] || links[i - 2])));
  t("X-reply blijft binnen 280 tekens", xs.every(x => (x.pair.replies[0] || "").length <= 280));
  t("X premium uit pair profile (slabhaus false)", xs.every(x => x.pair.premium === false));
  t("X task krijgt news_account", xs.every(x => x.news_account === "slabhaus"));

  // Slabhaus-validator
  const item = { kind: "metric", title: "Salazzle ex PSA 10 pop", numbers: [{ raw: "29", value: 29 }], entities: ["pop", "psa"] };
  const good = {
    layout: "number", pill: "pop report", headline: "[p]Salazzle ex[/p] now has [a]29[/a] PSA 10 copies", number: "29", unit: "PSA 10 copies",
    payload: { title: "The pop so far", items: [{ title: "29 PSA 10", body: "The PSA 10 count for Salazzle ex rose to 29." }, { title: "Graded copies", body: "Most copies landed one grade lower." }, { title: "Source", body: "NeuraCollectibles API pop data." }] },
    closer: { line: "Gem copies stay scarce.", question: "Did you send any in?" },
    caption: "salazzle ex has 29 psa 10 copies so far\ndid you send one in? link in bio\n#pokemontcg #psa10 #slabs #pokemoncards",
    x_hook: "Salazzle ex now has 29 PSA 10 copies 👇", x_reply: "Salazzle ex PSA 10 count is now 29. Source: NeuraCollectibles", image_brief: "Salazzle ex from Perfect Order",
  };
  const vg = nc.validateCard(good, item, "slabhaus");
  t(`validator: nette Slabhaus-kaart ok${vg.ok ? "" : " (" + vg.errors.join("; ") + ")"}`, vg.ok);
  const bad = (patch) => nc.validateCard({ ...good, ...patch }, item, "slabhaus");
  t("validator: investeringsframing", !bad({ closer: { line: "A great investment for your portfolio.", question: "Agree?" } }).ok);
  t("validator: verkoper genoemd", !bad({ x_reply: "Sold by @dealer99 yesterday. Source: PokeGuardian" }).ok);
  t("validator: graden van foto", !bad({ closer: { line: "Centering looks like a PSA 10 from the photo.", question: "Agree?" } }).ok);
  t("validator: verkeerde hashtags", !bad({ caption: "salazzle ex has 29 psa 10 copies\ndid you send one in?\n#pokemon #tcg" }).ok);
  t("validator: headline > 70 tekens", !bad({ headline: "[p]Salazzle ex[/p] now has [a]29[/a] PSA 10 copies according to the latest report today" }).ok);
  t("validator: getal niet in payload", !bad({ headline: "[p]Salazzle ex[/p] now has [a]31[/a] PSA 10 copies" }).ok);
  t("validator: caption zonder link in bio", !bad({ caption: "salazzle ex has 29 psa 10 copies\ndid you send one in?\n#pokemontcg #psa10 #slabs #pokemoncards" }).ok);
  t("validator: em dash", !bad({ closer: { line: "Gem copies — scarce.", question: "Did you?" } }).ok);
  t("validator: gh0stlayer-regels ongewijzigd (hashtags vrij)", nc.account("gh0stlayer").profile.voice.hashtags === undefined);

  // pop bars: 6..10, 10-bar goud
  const svg = nc.popBarsSvg({ 6: 4, 7: 3, 8: 8, 9: 36, 10: 29 });
  const rects = svg.match(/<rect[^>]*>/g) || [];
  const theme = fs.readFileSync(path.join(__dirname, "..", "templates", "cards", "themes", "slabhaus.css"), "utf8");
  t("pop bars: 5 balken (6 t/m 10), alleen de 10 in accent", rects.length === 5 && rects.filter(r => /var\(--accent\)/.test(r)).length === 1 && /var\(--accent\)/.test(rects[4]));
  t("slabhaus accent is goud", /--accent:\s*#e8b43a/i.test(theme));

  t("panel per account gescheiden", G.panel(30).length === 0 && S.panel(30).length === 7 && S.panel(30).every(p => p.account === "slabhaus"));
  fs.rmSync(process.env.NEWS_CARDS_DIR, { recursive: true, force: true });
  console.log(fails ? `${fails} FOUT` : "alles ok");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("FOUT", e.stack); process.exit(1); });
