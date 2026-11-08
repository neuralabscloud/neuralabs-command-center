// Pure-function tests for social-autopilot.js. No network.
// Run: node scripts/test-social-autopilot.js
const ap = require("../social-autopilot");
let pass = 0, fail = 0;
const check = (name, cond) => ok(cond, name);
const ok = (cond, name) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FOUT " + name); } };

// cleanPostText: no em/en dashes, no links
ok(!/[—–]/.test(ap.cleanPostText("BTC holds 100k — bulls in control – for now")), "cleanPostText strips em/en dashes");
ok(ap.cleanPostText("Big move — watch this") === "Big move. Watch this", "cleanPostText replaces dash with period");
ok(!/https?:/.test(ap.cleanPostText("Read this https://t.co/abc now")), "cleanPostText strips links");
ok(ap.cleanPostText('"quoted"') === "quoted", "cleanPostText strips wrapping quotes");
ok(ap.cleanPostText("Line one.\nLine two.\nLine three.") === "Line one.\n\nLine two.\n\nLine three.", "cleanPostText: each line its own paragraph");
ok(ap.cleanPostText("A\r\n\r\n\r\nB") === "A\n\nB", "cleanPostText: CRLF and extra blank lines collapse to one blank line");

// isPromo
ok(ap.isPromo("Huge GIVEAWAY, retweet to win"), "isPromo: giveaway");
ok(ap.isPromo("Next 100x gem, presale live"), "isPromo: presale/100x");
ok(ap.isPromo("$AB $BC $CD $DE $EF $FG moon"), "isPromo: cashtag spam");
ok(!ap.isPromo("Bitcoin ETF inflows hit a new weekly high"), "isPromo: normal news passes");

// parseTopics
const t = ap.parseTopics(["Bitcoin: (bitcoin OR $BTC)", "solana has:images", ""]);
ok(t.length === 2 && t[0].label === "Bitcoin" && t[0].query === "(bitcoin OR $BTC)", "parseTopics: label + query");
ok(t[1].label === "solana has:images" && t[1].query === "solana has:images", "parseTopics: operator colon is not a label");

// buildQuery
const q = ap.buildQuery("bitcoin", "me");
ok(q.includes("has:images") && q.includes("-is:retweet") && q.includes("lang:en") && q.includes("-from:me"), "buildQuery adds filters");

// planSlots
const from = Date.parse("2026-09-22T06:00:00Z"), to = Date.parse("2026-09-22T21:00:00Z");
const slots = ap.planSlots(8, from, to, () => 0.5);
ok(slots.length === 8, "planSlots: count");
ok(slots.every(s => Date.parse(s) >= from && Date.parse(s) <= to), "planSlots: inside window");
ok(slots.every((s, i) => i === 0 || s > slots[i - 1]), "planSlots: ascending");
ok(ap.planSlots(5, to, from).length === 0, "planSlots: empty window");

// zonedTime (DST)
ok(ap.zonedTime("2026-07-01", "08:00", "Europe/Amsterdam").toISOString() === "2026-07-01T06:00:00.000Z", "zonedTime: summer time");
ok(ap.zonedTime("2026-12-01", "08:00", "Europe/Amsterdam").toISOString() === "2026-12-01T07:00:00.000Z", "zonedTime: winter time");
ok(ap.localDay(new Date("2026-09-21T23:30:00Z"), "Europe/Amsterdam") === "2026-09-22", "localDay: past midnight local");

// nearestAspect
ok(ap.nearestAspect(1200, 675) === "16:9", "nearestAspect: 16:9");
ok(ap.nearestAspect(1080, 1350) === "4:5", "nearestAspect: 4:5");
ok(ap.nearestAspect(1000, 1000) === "1:1", "nearestAspect: square");
ok(ap.nearestAspect(0, 0) === "16:9", "nearestAspect: unknown");

// config defaults are white-label (no topics, no style)
const c = ap.config({});
ok(c.topics.length === 0 && c.style_prompt === "" && c.enabled === false, "config: neutral defaults");
ok(ap.config({ autopilot: { posts_per_day: 99, topics: "a\nb" } }).posts_per_day === 24, "config: posts_per_day capped");
ok(ap.config({ autopilot: { topics: "a\n\nb" } }).topics.length === 2, "config: topics from text");

// rankCandidates
const now = Date.parse("2026-09-22T12:00:00Z");
const resp = {
  data: [
    { id: "1", author_id: "u1", text: "BTC breaks out", created_at: "2026-09-22T10:00:00Z", public_metrics: { like_count: 500, retweet_count: 50 }, attachments: { media_keys: ["m1"] } },
    { id: "2", author_id: "u2", text: "ETH chart", created_at: "2026-09-22T02:00:00Z", public_metrics: { like_count: 600, retweet_count: 10 }, attachments: { media_keys: ["m2"] } },
    { id: "3", author_id: "u3", text: "Giveaway! RT to win", created_at: "2026-09-22T11:00:00Z", public_metrics: { like_count: 900 }, attachments: { media_keys: ["m3"] } },
    { id: "4", author_id: "u4", text: "Video only", created_at: "2026-09-22T11:00:00Z", public_metrics: { like_count: 900 }, attachments: { media_keys: ["m4"] } },
    { id: "5", author_id: "u5", text: "Too small", created_at: "2026-09-22T11:00:00Z", public_metrics: { like_count: 3 }, attachments: { media_keys: ["m5"] } },
    { id: "6", author_id: "u6", text: "Old news", created_at: "2026-09-19T11:00:00Z", public_metrics: { like_count: 5000 }, attachments: { media_keys: ["m6"] } },
    { id: "7", author_id: "u7", text: "Used before", created_at: "2026-09-22T11:00:00Z", public_metrics: { like_count: 900 }, attachments: { media_keys: ["m7"] } },
    { id: "8", author_id: "u8", text: "Author used today", created_at: "2026-09-22T11:00:00Z", public_metrics: { like_count: 900 }, attachments: { media_keys: ["m8"] } },
  ],
  includes: {
    media: ["m1", "m2", "m3", "m5", "m6", "m7", "m8"].map(k => ({ media_key: k, type: "photo", url: `https://pbs.twimg.com/${k}.jpg`, width: 1200, height: 675 }))
      .concat([{ media_key: "m4", type: "video" }]),
    users: [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ id: "u" + i, username: "user" + i })),
  },
};
const ranked = ap.rankCandidates(resp, { nowMs: now, minLikes: 20, maxAgeHours: 36, usedSources: ["7"], usedAuthors: ["USER8"] });
ok(ranked.map(r => r.tweet_id).join(",") === "1,2", "rankCandidates: filters promo/video/likes/age/used/author");
ok(ranked[0].tweet_id === "1", "rankCandidates: fresher post with fewer likes ranks higher (velocity)");
ok(ranked[0].image.endsWith("m1.jpg") && ranked[0].author === "user1", "rankCandidates: image + author attached");

// broader search: stricter shill filters, follower floor, per-topic cap
ok(ap.isPromo("New gem on Arc CA: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), "isPromo: contract address");
ok(ap.isPromo("Mint is live now, don't miss it"), "isPromo: mint live");
ok(!ap.isPromo("Circle minted another $500M USDC on Arc today"), "isPromo: mint news passes");
ok(!ap.isPromo("$BTC and $ETH both reclaim key levels"), "isPromo: two cashtags pass");
ok(q.includes("-giveaway") && q.includes("-airdrop") && q.includes("-is:nullcast"), "buildQuery: excludes giveaway/airdrop/promoted");
ok(ap.config({}).min_followers === 1000 && ap.config({ autopilot: { min_followers: 0 } }).min_followers === 0, "config: min_followers default + off");
const resp2 = JSON.parse(JSON.stringify(resp));
resp2.includes.users[0].public_metrics = { followers_count: 120 };
resp2.includes.users[1].public_metrics = { followers_count: 50000 };
ok(ap.rankCandidates(resp2, { nowMs: now, minLikes: 20, maxAgeHours: 36, minFollowers: 1000 }).map(r => r.tweet_id).sort().join(",") === "2,7,8", "rankCandidates: small account dropped, unknown followers kept");
const pool = [
  ...[1, 2, 3, 4, 5].map(i => ({ tweet_id: "a" + i, topic: "Arc", score: 100 - i })),
  { tweet_id: "b1", topic: "Bitcoin", score: 10 }, { tweet_id: "b2", topic: "Bitcoin", score: 9 },
  { tweet_id: "e1", topic: "Ethereum", score: 5 }, { tweet_id: "a1", topic: "Arc", score: 99 },
];
const pick = ap.pickCandidates(pool, 6, 3);
ok(pick.length === 6 && pick.filter(c => c.topic === "Arc").length === 3, "pickCandidates: noisy topic capped at 3");
ok(pick.some(c => c.topic === "Ethereum") && new Set(pick.map(c => c.tweet_id)).size === 6, "pickCandidates: other topics get in, no duplicates");

// curated accounts + lower default depth
ok(ap.config({}).search_depth === 20, "config: search_depth default 20");
ok(ap.parseAccounts("@glassnode, https://x.com/lookonchain/status/1 WatcherGuru\n@GLASSNODE bad-handle! waytoolonghandle123").join(",") === "glassnode,lookonchain,WatcherGuru", "parseAccounts: @, urls, commas, dedupe, invalid dropped");
ok(ap.config({ autopilot: { accounts: ["@a_b"] } }).accounts[0] === "a_b", "config: accounts normalised");
const many = Array.from({ length: 60 }, (_, i) => "account_" + String(i).padStart(4, "0"));
const groups = ap.accountTopics(many, "me");
ok(groups.length > 1 && groups.every(g => ap.buildQuery(g.query, "me").length <= 512), "accountTopics: split to fit 512-char query limit");
ok(groups.flatMap(g => g.query.split(" OR ")).length === 60 && groups.every(g => g.curated), "accountTopics: every account once, marked curated");
ok(ap.accountTopics(["a", "b"], "me").length === 1 && ap.accountTopics(["a"], "me")[0].label === "Curated", "accountTopics: one group is labelled Curated");
ok(ap.accountTopics([], "me").length === 0, "accountTopics: none without accounts");

// card template (image_mode "template")
const ct = require("../card-template");
ok(ct.cleanHeadline("Same Venusaur — $75 to $1,086.") === "Same Venusaur $75 to $1,086.", "cleanHeadline: dashes stripped");
ok(ct.cleanHeadline("a b c d e f g h i j k").split(" ").length === 9, "cleanHeadline: max 9 words");
const html = ct.buildHtml({ imageDataUri: "data:image/png;base64,AA", headline: "<b>x</b>", mark: "SLAB", fonts: false });
ok(html.includes("&lt;b&gt;x&lt;/b&gt;") && !html.includes("<b>x</b>"), "buildHtml: headline escaped");
ok(html.includes(">SLAB<") && !ct.buildHtml({ imageDataUri: "x", headline: "h", fonts: false }).includes('class="mark"'), "buildHtml: wordmark optional");
ok(ct.mimeOf(Buffer.from([0x89, 0x50, 0, 0])) === "image/png" && ct.mimeOf(Buffer.from([0xff, 0xd8, 0, 0])) === "image/jpeg", "mimeOf: png/jpeg");
ok(ap.config({ autopilot: { image_mode: "template", template_mark: "MYBRAND" } }).image_mode === "template", "config: image_mode template kept");
ok(ap.config({ autopilot: { image_mode: "weird" } }).image_mode === "ai_card", "config: unknown image_mode falls back to ai_card");

// daily promo slot
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
for (let n = 2; n <= 10; n++) {
  const pp = ap.pickPromoSlots(n, 1, Math.random);
  ok(pp.length === 1 && pp[0] > 0 && pp[0] < n, `pickPromoSlots: 1 of ${n}, never the first slot`);
}
const p3 = ap.pickPromoSlots(8, 3, Math.random);
ok(p3.length === 3 && new Set(p3).size === 3 && p3.every(i => i >= 0 && i < 8), "pickPromoSlots: 3 distinct, in range");
ok(ap.pickPromoSlots(1, 1, Math.random).length === 1, "pickPromoSlots: single slot day still gets its promo");
ok(ap.pickPromoSlots(5, 0, Math.random).length === 0, "pickPromoSlots: zero promos");
ok(ap.pickLeastUsed(["a", "b", "c"], { a: 2, b: 0, c: 1 }, seq(0)) === "b", "pickLeastUsed: least used wins");
ok(ap.pickLeastUsed([], {}, Math.random) === null || ap.pickLeastUsed([], {}, Math.random) === undefined, "pickLeastUsed: empty list");
ok(ap.config({ autopilot: { promo_enabled: true, promo_product: "P" } }).promo_enabled === false, "config: promo off without facts");
const pc = ap.config({ autopilot: { posts_per_day: 2, promo_enabled: true, promo_product: "P", promo_facts: "f", promo_per_day: 9,
  promo_link: "javascript:alert(1)", promo_images: ["/media/promo/a.png", "/media/../x.png", "https://evil/x.png", "/media/b c.png"] } });
ok(pc.promo_enabled === true && pc.promo_per_day === 2, "config: promo on, per_day capped at posts_per_day");
ok(pc.promo_link === "", "config: non-http promo link dropped");
ok(pc.promo_images.length === 1 && pc.promo_images[0] === "/media/promo/a.png", "config: only clean /media/ promo images kept");

// image mode + headline fallback (readable images, also for Instagram)
check("image_mode default ai_card", ap.config({ autopilot: {} }).image_mode === "ai_card");
check("image_mode keeps ai / template", ap.config({ autopilot: { image_mode: "ai" } }).image_mode === "ai" && ap.config({ autopilot: { image_mode: "template" } }).image_mode === "template");
check("image_mode unknown falls back", ap.config({ autopilot: { image_mode: "x" } }).image_mode === "ai_card");
check("ensureHeadline keeps Claude's own", ap.ensureHeadline("Rails first. Flow second.", "whatever") === "Rails first. Flow second.");
const fh = ap.ensureHeadline("", "Support for a rail is not usage of a rail. Crypto.com's app does more.\n\n#BTC");
check("ensureHeadline falls back to first sentence", fh === "Support for a rail is not usage");
check("ensureHeadline strips dashes, hashtags, links", !/[–—#]|http/.test(ap.ensureHeadline("", "Big move — $BTC https://x.y #crypto")));

// variety: one queue, curated only wins ties; formats cap per day
{
  const sa = require("../social-autopilot");
  const cur = [{ label: "Curated", curated: true }], tp = [{ label: "Market" }, { label: "Vintage" }];
  const q0 = sa.orderQueue(cur, tp, {}, {}, () => 0.5);
  check("orderQueue: curated first on a fresh day", q0[0].label === "Curated");
  const q1 = sa.orderQueue(cur, tp, { Curated: 1 }, {}, () => 0.5);
  check("orderQueue: curated after unused topics once it posted", q1[2].label === "Curated");
  const q2 = sa.orderQueue(cur, tp, { Curated: 3, Market: 1, Vintage: 1 }, {}, () => 0.5);
  check("orderQueue: curated with 3 posts goes last", q2[q2.length - 1].label === "Curated" && q2.length === 3);
  const q3 = sa.orderQueue(cur, tp, { Market: 0 }, { Vintage: 2 }, () => 0.5);
  check("orderQueue: rejects push a topic back", q3[q3.length - 1].label === "Vintage");
  check("formatsFull: cap per day", JSON.stringify(sa.formatsFull({ spotlight: sa.MAX_PER_FORMAT, market: 1 })) === JSON.stringify(["spotlight"]));
  check("FORMATS niche neutral (no pokemon)", !/pokemon|crypto/i.test(JSON.stringify(sa.FORMATS)));
}
console.log(`\n${pass} ok, ${fail} FOUT`);
process.exit(fail ? 1 : 0);
