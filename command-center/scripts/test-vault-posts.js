// node scripts/test-vault-posts.js  (no network: everything external is mocked)
const fs = require("fs");
const os = require("os");
const path = require("path");
const v = require("../vault-posts");

let fails = 0;
function check(name, cond) { console.log(`${cond ? "ok" : "FOUT"} ${name}`); if (!cond) fails++; }

const cy = {
  id: "cy:abc", name: "2023 Pokémon Scarlet & Violet 151 #199/165 Charizard ex (Special Illustration Rare) CGC 10", short_name: "Charizard ex",
  grade: "CGC 10", platform: "courtyard", platform_label: "Courtyard", marketplace_url: "https://courtyard.io/asset/abc", page_url: "https://slabhaus.example/c/abc",
  price: { amount: 630, currency: "USD", usd: 630 }, image: "https://static.courtyard.io/graded-cards-renders/CGC%206109945209/nft_image.jpg",
  details: { card: "Charizard ex", set: "Scarlet & Violet 151 - MEW EN", year: 2023, number: "199/165", variant: "Special Illustration Rare (Holo)", grader: "CGC", grade: "10", cert: "6109945209", pop: null, listed_at: "2026-11-12T14:36:46Z" },
};
const cc = {
  id: "sol:mint", name: "Magneton", short_name: "Magneton", grade: "PSA 10", platform: "collectorcrypt", platform_label: "Collector Crypt",
  marketplace_url: "https://collectorcrypt.com/assets/solana/mint", price: { amount: 172, currency: "USD", usd: 172 },
  image: "https://d1xpxki1g4htqu.cloudfront.net/AHypD2Rw-0boR71KEBWHyGG_MAqgbyKfwECzUPCgDUs",
  details: { card: "Magneton", set: "Pokemon Svp EN-SV Black Star Promo", year: 2024, number: "159", grader: "PSA", grade: "10", cert: "116667981", pop: 8597, listed_at: null },
};

// record
const r1 = v.buildRecord(cy);
check("record: card/set/year/grade/cert from the inventory", r1.card === "Charizard ex" && r1.set === "Scarlet & Violet 151" && r1.year === 2023 && r1.grader === "CGC" && r1.grade === "10" && r1.cert === "6109945209");
check("record: price from the feed", r1.price_text === "$630" && r1.show_price === true);
check("record: no pop when the platform gives none", r1.pop === null);
const r2 = v.buildRecord(cc);
check("record: set cleaned (no dash, no EN-SV code)", r2.set === "SV Black Star Promo");
check("record: pop from the platform", r2.pop === 8597);
check("record: show_price override per cert", v.buildRecord(cc, { "116667981": { show_price: false } }).show_price === false);
const noDetails = v.buildRecord({ ...cy, details: null });
check("record: cert + grader fall back to the Courtyard photo URL", noDetails.cert === "6109945209" && noDetails.grader === "CGC");
check("record: incomplete record is refused", v.recordProblems(v.buildRecord({ ...cc, details: null, image: "https://x.example/a.jpg" }), "listing").some(p => /cert/.test(p)));
check("record: listing needs a price", v.recordProblems(v.buildRecord({ ...cy, price: null }), "listing").some(p => /price/.test(p)));

// photo source: own slab photo of exactly this cert, never another source
check("photo: Courtyard render of this cert", (v.photoSource(r1) || {}).source === "courtyard");
check("photo: Courtyard render of another cert refused", v.photoSource({ ...r1, cert: "123456789" }) === null);
check("photo: Collector Crypt photo of the NFT", (v.photoSource(r2) || {}).source === "collectorcrypt");
check("photo: card database image refused", v.photoSource({ ...r2, image: "https://images.pokemontcg.io/sv3pt5/199_hires.png" }) === null);
check("photo: OpenSea image refused", v.photoSource({ ...r1, platform_id: "opensea", image: "https://i2c.seadn.io/x.png" }) === null);
check("photo: gallery photo tagged with the cert wins", (v.photoSource(r1, [{ file: "a.jpg", path: "/g/a.jpg", cert: "6109945209" }]) || {}).kind === "gallery");

// chips + templates
const chipsL = v.chipsHtml(r1, "listing");
check("chips listing: grader+grade (grade gold) and cert, no pop chip without pop", /CGC <b>10<\/b>/.test(chipsL) && /cert 6109945209/.test(chipsL) && !/pop/.test(chipsL));
check("chips listing: pop chip when available", /pop 8,597/.test(v.chipsHtml(r2, "listing")));
const chipsS = v.chipsHtml({ ...r1, sold_at: "2026-11-17T10:00:00Z" }, "sold");
check("chips sold: sold date + via platform", /sold 17 nov/.test(chipsS) && /via Courtyard/.test(chipsS) && !/cert/.test(chipsS));
const htmlL = v.slideHtml(r1, "listing", "data:image/png;base64,AAAA", "slabhaus");
check("listing template: for sale pill, asking price, link in bio", /for sale/.test(htmlL) && /asking/.test(htmlL) && /\$630/.test(htmlL) && /Courtyard · link in bio/.test(htmlL) && /class="vglow"/.test(htmlL));
const htmlS = v.slideHtml({ ...r1, sold_at: "2026-11-17T10:00:00Z" }, "sold", "data:image/png;base64,AAAA", "slabhaus");
check("sold template: stamp, sold for, next drop, no glow", /class="stamp"/.test(htmlS) && /sold for/.test(htmlS) && /turn on notifications/.test(htmlS) && !/class="vglow"/.test(htmlS));
const htmlH = v.slideHtml({ ...r1, show_price: false }, "sold", "data:image/png;base64,AAAA", "slabhaus");
check("sold template: show_price false → from the vault, no price", /from the vault/.test(htmlH) && !/\$630/.test(htmlH));
check("template: HTML in a record is escaped", !/<script>/.test(v.slideHtml({ ...r1, card: "<script>x</script>" }, "listing", "", "slabhaus")));

// copy validator
const tags = "#pokemontcg #psa10 #slabs #pokemoncards";
const good = { ig_caption: `charizard ex cgc 10 in the vault\nspecial illustration rare from scarlet & violet 151, link in bio\n${tags}`, x_hook: "charizard ex CGC 10 from scarlet & violet 151. asking $630" };
check("copy: good listing copy passes", v.validateCopy(good, r1, "listing", "slabhaus").length === 0);
const bad = (patch, kind = "listing", rec = r1) => v.validateCopy({ ...good, ...patch }, rec, kind, "slabhaus");
check("copy: em dash refused", bad({ x_hook: "charizard ex CGC 10 — asking $630" }).length > 0);
check("copy: spaced hyphen refused", bad({ x_hook: "charizard ex CGC 10 - asking $630" }).length > 0);
check("copy: caps outside the allowlist refused", bad({ x_hook: "charizard ex CGC 10. HUGE card, asking $630" }).length > 0);
check("copy: investment framing refused", bad({ x_hook: "charizard ex CGC 10, a great investment at $630" }).length > 0);
check("copy: pressure line refused", bad({ x_hook: "charizard ex CGC 10. last one, don't miss out" }).length > 0);
check("copy: invented number refused", bad({ x_hook: "charizard ex CGC 10, only 12 exist. asking $630" }).length > 0);
check("copy: URL refused", bad({ x_hook: "charizard ex CGC 10 https://courtyard.io/x" }).length > 0);
check("copy: IG caption must be lowercase", bad({ ig_caption: good.ig_caption.replace("charizard", "Charizard") }).length > 0);
check("copy: IG caption must be 3 lines", bad({ ig_caption: `charizard ex cgc 10\n${tags}` }).length > 0);
check("copy: IG caption needs link in bio", bad({ ig_caption: `charizard ex cgc 10 in the vault\nfrom scarlet & violet 151\n${tags}` }).length > 0);
check("copy: IG caption hashtags exactly the four", bad({ ig_caption: good.ig_caption.replace("#slabs", "#cards") }).length > 0);
const soldGood = { ig_caption: `charizard ex cgc 10 found a new home\nthank you to the buyer, next drop soon\n${tags}`, x_hook: "charizard ex CGC 10 found a new home. thank you, next drop soon" };
check("copy: good sold copy passes", v.validateCopy(soldGood, r1, "sold", "slabhaus").length === 0);
check("copy: sold needs next drop soon", v.validateCopy({ ...soldGood, ig_caption: soldGood.ig_caption.replace("next drop soon", "more soon") }, r1, "sold", "slabhaus").length > 0);
check("copy: hidden price may not appear", v.validateCopy({ ...soldGood, x_hook: "charizard ex CGC 10 sold for $630. thank you" }, { ...r1, show_price: false }, "sold", "slabhaus").length > 0);
check("copy: fallback listing copy passes the validator", v.validateCopy(v.fallbackCopy(r2, "listing", "slabhaus"), r2, "listing", "slabhaus").length === 0);
check("copy: fallback sold copy passes the validator", v.validateCopy(v.fallbackCopy(r1, "sold", "slabhaus"), r1, "sold", "slabhaus").length === 0);
check("x reply: listing URL in the reply", v.xReply(r1) === "courtyard: https://courtyard.io/asset/abc");

// config
const ch = { id: "c1", name: "slab", platform: "twitter", listings: { enabled: true, window_start: "10:00", vault: { enabled: true } } };
const cfg = v.vaultConfig(ch);
check("config: defaults cap 2/day, sold delay 120 min", cfg.daily_cap === 2 && cfg.sold_delay_min === 120 && cfg.sold_comment === "sold, thank you");

// queue: cap + overflow + publish (mocked)
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
  const calls = { ig: [], comment: [], x: [], deleted: 0 };
  const vault = v.createVault({
    dataDir: tmp, mediaDir: path.join(tmp, "media"), tz: "Europe/Amsterdam",
    igImage: async (c, png, caption, id) => { calls.ig.push({ png, caption }); return { media_id: "m" + calls.ig.length, permalink: "https://www.instagram.com/p/X" + calls.ig.length }; },
    igComment: async (c, mediaId, text) => { calls.comment.push({ mediaId, text }); return { id: "c1" }; },
    addXTask: (t) => { calls.x.push(t); return { id: "t" + calls.x.length, ...t }; },
    log: () => {}, notify: () => {},
  });
  const mk = (id, kind, item, listed, due) => ({ id, channel_id: "c1", kind, item_id: item.id, record: { ...v.buildRecord(item), listed_at: listed }, listed_at: listed, png: "/x.png", rel: "/media/vault-posts/x.png", copy: { ig_caption: "c", x_hook: "h", x_reply: kind === "listing" ? "courtyard: https://courtyard.io/asset/abc" : null }, status: "queued", due_at: due, ig: { status: "pending" }, x: { status: "pending" }, comment: kind === "sold" ? { status: "pending" } : null });
  const st = path.join(tmp, "vault-posts", "state.json");
  fs.mkdirSync(path.dirname(st), { recursive: true });
  const noon = Date.parse("2026-11-17T12:00:00+01:00");
  fs.writeFileSync(st, JSON.stringify({ posts: [
    mk("a", "listing", cy, "2026-11-12T10:00:00Z", "2026-11-17T09:00:00Z"),
    mk("b", "listing", cc, "2026-11-10T10:00:00Z", "2026-11-17T09:30:00Z"),
    mk("c", "listing", { ...cy, id: "cy:def" }, "2026-11-11T10:00:00Z", "2026-11-17T10:00:00Z"),
  ] }));
  const first = vault.eligible(vault.load(), ch, noon).map(p => p.id);
  check("cap: only 2 per day, oldest listing date first", first.join(",") === "b,c");
  await vault.tick([ch], noon);
  const s1 = vault.load();
  check("cap: third post waits (queued) after 2 released", s1.posts.find(p => p.id === "a").status === "queued" && s1.posts.filter(p => p.status === "published").length === 2);
  check("publish: Instagram single image per post", calls.ig.length === 2);
  check("publish: X hook + reply with the listing link, no IG cross-post", calls.x.length === 2 && calls.x[0].pair && calls.x[0].pair.replies[0].startsWith("courtyard: https://") && calls.x[0].instagram.status === "skipped" && calls.x[0].text === "h");
  check("publish: permalink stored", s1.posts.find(p => p.id === "b").ig.permalink === "https://www.instagram.com/p/X1");
  check("overflow: nothing more today", vault.eligible(vault.load(), ch, noon + 3600e3).length === 0);
  const nextNight = Date.parse("2026-11-18T07:00:00+01:00"), nextMorning = Date.parse("2026-11-18T10:05:00+01:00");
  check("overflow: next day waits for the posting window", vault.eligible(vault.load(), ch, nextNight).length === 0);
  check("overflow: next day inside the window it goes", vault.eligible(vault.load(), ch, nextMorning).map(p => p.id).join() === "a");
  // sold: comment on the Instagram listing post of the same slab
  const s2 = vault.load();
  s2.posts.push(mk("d", "sold", cc, "2026-11-10T10:00:00Z", "2026-11-18T10:00:00+01:00"));
  fs.writeFileSync(st, JSON.stringify(s2));
  await vault.tick([ch], nextMorning);
  const d = vault.load().posts.find(p => p.id === "d");
  check("sold: comment 'sold, thank you' on our listing media", calls.comment.length === 1 && calls.comment[0].mediaId === "m1" && calls.comment[0].text === "sold, thank you" && d.comment.status === "posted");
  check("sold: X task without a link reply", !calls.x.find(t => t.vault_post_id === "d").pair);
  check("never deletes: no delete call in the module", !/\bDELETE\b|deleteTweet|\/delete/.test(fs.readFileSync(path.join(__dirname, "..", "vault-posts.js"), "utf8")));
  check("no Buffer: module does not touch Buffer", !/buffer\.com|require\(["']\.\/buffer|bufferApi/i.test(fs.readFileSync(path.join(__dirname, "..", "vault-posts.js"), "utf8")));
  // review mode: draft is not released until approved
  const s3 = vault.load();
  s3.posts.push({ ...mk("e", "listing", cy, "2026-11-01T00:00:00Z", "2026-11-19T09:00:00Z"), status: "draft" });
  fs.writeFileSync(st, JSON.stringify(s3));
  const day3 = Date.parse("2026-11-19T11:00:00+01:00");
  check("review: draft is not released", !vault.eligible(vault.load(), ch, day3).some(p => p.id === "e"));
  vault.approve("e");
  check("review: approved draft is released", vault.eligible(vault.load(), ch, Date.parse("2026-11-21T11:00:00+01:00")).some(p => p.id === "e"));
  // IG failure: retried, not lost
  const vf = v.createVault({ dataDir: tmp, mediaDir: path.join(tmp, "media"), igImage: async () => { throw new Error("boom"); }, igComment: async () => ({}), addXTask: t => ({ id: "tx" }), log: () => {}, notify: () => {} });
  const s4 = vf.load(); s4.posts = [mk("f", "listing", cy, "2026-11-01T00:00:00Z", "2026-11-20T09:00:00Z")]; fs.writeFileSync(st, JSON.stringify(s4));
  await vf.tick([ch], Date.parse("2026-11-20T11:00:00+01:00"));
  const f = vf.load().posts[0];
  check("instagram failure: retry scheduled, X still queued", f.ig.status === "retry" && f.status === "publishing" && f.x.status === "queued");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} FOUT` : "all ok");
  process.exit(fails ? 1 : 0);
})();
