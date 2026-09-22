// Pure-function tests for social-autopilot.js. No network.
// Run: node scripts/test-social-autopilot.js
const ap = require("../social-autopilot");
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FOUT " + name); } };

// cleanPostText: no em/en dashes, no links
ok(!/[—–]/.test(ap.cleanPostText("BTC holds 100k — bulls in control – for now")), "cleanPostText strips em/en dashes");
ok(ap.cleanPostText("Big move — watch this") === "Big move. Watch this", "cleanPostText replaces dash with period");
ok(!/https?:/.test(ap.cleanPostText("Read this https://t.co/abc now")), "cleanPostText strips links");
ok(ap.cleanPostText('"quoted"') === "quoted", "cleanPostText strips wrapping quotes");

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

console.log(`\n${pass} ok, ${fail} FOUT`);
process.exit(fail ? 1 : 0);
