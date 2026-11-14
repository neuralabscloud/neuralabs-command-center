// Tests for x-pairs.js (hook + reply pairs). No network.
// Run: node scripts/test-x-pairs.js
const X = require("../x-pairs");
const ig = require("../instagram-publish");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FOUT " + name); }
}
function hasErr(res, re) { return res.errors.some(e => re.test(e)); }

const HOOK = "Most collectors skip the cheapest protection they have.\n\n3 checks I run before I buy any slab\n👇";
const GOOD_REPLIES = [
  "1. Cert lookup on the grader site, matched to the label.\n2. Case edges for cracks or reseal marks.\n3. Photos of the back in daylight.",
  "Which one do you skip most often?",
];
const base = { premium: false, formula: "numbered_promise", pillar: "buying", allowLink: false, history: [] };

// ---------- validator: happy path ----------
let r = X.validatePair({ hook: HOOK, replies: GOOD_REPLIES }, base);
ok(r.ok, "valid non-premium pair passes (" + r.errors.join("; ") + ")");

const premiumReply = GOOD_REPLIES.join("\n\n");
r = X.validatePair({ hook: HOOK, replies: [premiumReply] }, { ...base, premium: true });
ok(r.ok, "valid premium pair (one reply) passes");
r = X.validatePair({ hook: HOOK, replies: GOOD_REPLIES }, { ...base, premium: true });
ok(hasErr(r, /must be one reply/), "premium with 2 replies is rejected");

// ---------- dashes / caps / superlative / bait ----------
r = X.validatePair({ hook: HOOK.replace("cheapest", "cheapest — and"), replies: GOOD_REPLIES }, base);
ok(hasErr(r, /dash/), "em dash rejected");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0].replace("Photos", "Photos – always"), GOOD_REPLIES[1]] }, base);
ok(hasErr(r, /dash/), "en dash rejected");
r = X.validatePair({ hook: HOOK.replace("cheapest", "CHEAPEST"), replies: GOOD_REPLIES }, base);
ok(hasErr(r, /ALL-CAPS/), "ALL-CAPS word rejected");
r = X.validatePair({ hook: HOOK.replace("slab", "PSA slab"), replies: [GOOD_REPLIES[0].replace("Cert", "$BTC cert"), GOOD_REPLIES[1]] }, base);
ok(!hasErr(r, /ALL-CAPS/), "allowlisted caps (PSA) and cashtags pass");
ok(X.capsViolations("GM fam", ["GM"]).length === 0, "capsExtra extends the allowlist");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0] + "\nThis is a game changer.", GOOD_REPLIES[1]] }, base);
ok(hasErr(r, /superlative/), "hollow superlative rejected");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0], "Follow for more. Which one do you skip?"] }, base);
ok(hasErr(r, /bait/), "engagement bait rejected");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0], "This is guaranteed to rise. Agree?"] }, { ...base, banned: ["\\bguaranteed\\b"] });
ok(hasErr(r, /banned/), "per-account banned pattern rejected");

// ---------- hook rules ----------
r = X.validatePair({ hook: "Most collectors skip this.\n3 checks I run 👇", replies: GOOD_REPLIES }, base);
ok(hasErr(r, /own line/), "👇 not on its own line rejected");
r = X.validatePair({ hook: "3 checks I run before I buy\n👇", replies: GOOD_REPLIES }, base);
ok(hasErr(r, /pointer line/), "hook without idea + pointer line rejected");
r = X.validatePair({ hook: "x".repeat(198) + "\n3 checks\n👇", replies: GOOD_REPLIES }, base);
ok(hasErr(r, /max 200/), "hook over 200 chars rejected");
r = X.validatePair({ hook: HOOK.replace("protection", "protection 🔥"), replies: GOOD_REPLIES }, base);
ok(hasErr(r, /single/), "second emoji in hook rejected");
r = X.validatePair({ hook: HOOK.replace("slab", "slab https://example.com"), replies: GOOD_REPLIES }, base);
ok(hasErr(r, /hook contains a link/), "link in hook rejected");
r = X.validatePair({ hook: HOOK.replace("slab", "slab #pokemon"), replies: GOOD_REPLIES }, base);
ok(hasErr(r, /hook contains a hashtag/), "hashtag in hook rejected");
r = X.validatePair({ hook: HOOK.replace("slab", "slab @someone"), replies: GOOD_REPLIES }, base);
ok(hasErr(r, /@mention/), "@mention in hook rejected");
r = X.validatePair({ hook: HOOK.replace("Most collectors", "Acme users"), replies: GOOD_REPLIES }, { ...base, forbiddenHook: ["Acme"] });
ok(hasErr(r, /hook names "Acme"/), "forbidden brand in hook rejected");

// ---------- counts ----------
r = X.validatePair({ hook: HOOK, replies: ["1. One.\n2. Two.", "Which one do you skip?"] }, base);
ok(hasErr(r, /promises 3, payload delivers 2/), "count mismatch rejected");
r = X.validatePair({ hook: HOOK, replies: ["1. One.\n2. Two.\n4. Four.", "Which one?"] }, base);
ok(hasErr(r, /not 1\.\.n/), "numbering gap rejected");
r = X.validatePair({ hook: "Most collectors skip this.\n\nWhat I check first\n👇", replies: ["Cert lookup first. Then the case.", "What do you check?"] }, base);
ok(hasErr(r, /must promise a count/), "numbered_promise without a count rejected");
ok(X.hookCount("five mistakes I made") === 5, "hookCount reads number words");
ok(X.hookCount("3 red flags in a listing") === 3, "hookCount reads digits");
ok(X.hookCount("a thing I learned") === null, "hookCount null without a count");
ok(X.payloadCount(["1. a\n2) b", "3/ c"]) === 3, "payloadCount counts across replies");

// ---------- lengths ----------
r = X.validatePair({ hook: HOOK, replies: ["1. " + "a".repeat(290), "2. b\n3. c", "Which?"] }, base);
ok(hasErr(r, /max 280/), "non-premium reply over 280 rejected");
r = X.validatePair({ hook: HOOK, replies: ["1. a", "2. b", "3. c", "x", "Which?"] }, base);
ok(hasErr(r, /max 4/), "more than 4 replies rejected");
r = X.validatePair({ hook: HOOK, replies: ["1. a\n2. b\n3. c\n" + "z".repeat(1200) + "\nWhich?"] }, { ...base, premium: true });
ok(hasErr(r, /max 1200/), "premium payload over 1200 rejected");
ok(X.weightedLength("see https://example.com/a/very/long/path/that/goes/on") === 4 + 23, "URLs count as 23 chars");

// ---------- closing question ----------
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0], "That is all."] }, base);
ok(hasErr(r, /closing question/), "missing closing question rejected");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0], "Which one do you skip?\n#pokemon #tcg"] }, base);
ok(r.ok, "hashtags on last line after the question pass");

// ---------- links / hashtags ----------
const linkReply = [GOOD_REPLIES[0], "Which one do you skip?\nhttps://example.com/profile"];
r = X.validatePair({ hook: HOOK, replies: linkReply }, base);
ok(hasErr(r, /cadence/), "link when cadence forbids it rejected");
r = X.validatePair({ hook: HOOK, replies: linkReply }, { ...base, allowLink: true, allowedLinks: ["https://example.com/profile"] });
ok(r.ok, "allowed link passes when cadence allows (" + r.errors.join("; ") + ")");
r = X.validatePair({ hook: HOOK, replies: linkReply }, { ...base, allowLink: true, allowedLinks: ["https://other.com"] });
ok(hasErr(r, /link not allowed/), "link outside the allowlist rejected");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0] + "\nhttps://a.com https://b.com", "Which?"] }, { ...base, allowLink: true });
ok(hasErr(r, /more than 1 link/), "two links rejected");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0], "Which one?\n#a #b #c"] }, base);
ok(hasErr(r, /max 2/), "3 hashtags rejected");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0] + "\n#early", "Which one?"] }, base);
ok(hasErr(r, /last line/), "hashtag before the last line rejected");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0], "Acme helps with this. Which one?"] }, { ...base, brandName: "Acme", allowBrand: false });
ok(hasErr(r, /may not mention Acme/), "brand mention outside cadence rejected");
r = X.validatePair({ hook: HOOK, replies: [GOOD_REPLIES[0], "Acme helps with this. Which one?"] }, { ...base, brandName: "Acme", allowBrand: true });
ok(r.ok, "brand mention passes when cadence allows");

// ---------- numbers from the API ----------
const priceReply = ["1. Last sale was $412.\n2. Pop is 1,204.\n3. Up 18% in 30 days.", "Would you hold it?"];
r = X.validatePair({ hook: HOOK, replies: priceReply }, { ...base, numbersFromApi: true, facts: { last: 412, pop: 1204, pct: 18.2 } });
ok(r.ok, "numbers that are in the facts pass (" + r.errors.join("; ") + ")");
r = X.validatePair({ hook: HOOK, replies: priceReply }, { ...base, numbersFromApi: true, facts: { last: 412 } });
ok(hasErr(r, /not in the API data/), "invented numbers rejected");
ok(X.ungroundedNumbers("Released in 1999, 3 copies", {}).length === 0, "years and small counts are not claims");
ok(X.ungroundedNumbers("ratio 0.42 means 42% gem rate", { r: 0.42 }).length === 0, "ratio fact grounds its percentage");

// ---------- similarity ----------
const prevText = [HOOK, ...GOOD_REPLIES].join("\n");
r = X.validatePair({ hook: HOOK, replies: GOOD_REPLIES }, { ...base, history: [{ pillar: "buying", formula: "numbered_promise", text: prevText, at: "2026-11-01" }] });
ok(hasErr(r, /too similar/), "near-duplicate of a recent pair rejected");
r = X.validatePair({ hook: HOOK, replies: GOOD_REPLIES }, { ...base, history: [{ pillar: "other", formula: "numbered_promise", text: prevText }] });
ok(!hasErr(r, /too similar/), "same text but other pillar is not a duplicate");
ok(X.similarity("a b c d e", "a b c d e") === 1 && X.similarity("a b c", "x y z") === 0, "similarity bounds");

// ---------- cadence / picking ----------
ok(X.cadenceAllows([], "has_media", 1 / 3), "cadence allows with empty history");
ok(!X.cadenceAllows([{ has_media: false }, { has_media: true }], "has_media", 1 / 3), "1 in 3: blocked when one of last 2 had it");
ok(X.cadenceAllows([{ has_media: false }, { has_media: false }, { has_media: true }], "has_media", 1 / 3), "1 in 3: allowed after 2 without");
ok(!X.cadenceAllows([{ has_link: true }], "has_link", 0.25), "1 in 4: blocked right after a link");
ok(!X.cadenceAllows([], "x", 0), "ratio 0 never allows");
let repeats = 0;
for (let i = 0; i < 500; i++) { const f = X.pickFormula("contrarian", { contrarian: 50 }); if (f === "contrarian") repeats++; }
ok(repeats === 0, "pickFormula never repeats the last formula (500 tries)");
const seq = [0.1, 0.99]; let si = 0;
const exp = X.weightedPick(["a", "b"], { a: 100, b: 0.05 }, () => seq[si++ % 2]);
ok(exp === "b", "weightedPick explores below the 15% threshold");
ok(X.weightedPick(["a", "b"], { a: 100, b: 0.05 }, () => 0.5) === "a", "weightedPick exploits above the threshold");
ok(X.EXPLORATION >= 0.15, "exploration is at least 15%");
const pp = X.pickPillar([{ id: "a" }, { id: "b" }, { id: "c" }], ["a", "b"], {}, () => 0.5);
ok(pp === "c", "pickPillar avoids the last two pillars");

// ---------- learning ----------
const s = X.scorePair({ hook: { impression_count: 1000, like_count: 10, reply_count: 5 }, reply: { impression_count: 200 } });
ok(s && s.engagement === 0.02 && s.depth === 0.2 && s.score === 0.4, "scorePair: engagement + reply depth");
ok(X.scorePair(null) === null, "scorePair null without metrics");
const pairs = [
  { formula: "a", score: { score: 2 } }, { formula: "a", score: { score: 2 } },
  { formula: "b", score: { score: 0.5 } }, { formula: "b", score: { score: 0.5 } },
  { formula: "c", score: { score: 1 } },
];
const w = X.reweight(pairs, "formula", ["a", "b", "c", "d"]);
ok(w.a > 1 && w.b < 1, "reweight boosts winners and lowers losers");
ok(w.c === 1 && w.d === 1, "reweight leaves keys with < 2 scored pairs at 1");
const wc = X.reweight([{ formula: "a", score: { score: 100 } }, { formula: "a", score: { score: 100 } }, { formula: "b", score: { score: 0.001 } }, { formula: "b", score: { score: 0.001 } }], "formula", ["a", "b"]);
ok(wc.a <= 3 && wc.b >= 0.3, "reweight clamps to 0.3..3");

// ---------- splitThread / profiles ----------
const parts = X.splitThread(["a".repeat(200), "b".repeat(200), "c".repeat(50)].join("\n\n"));
ok(parts.length === 2 && parts.every(p => X.weightedLength(p) <= 280), "splitThread keeps parts <= 280");
ok(X.profileFor({ ch1: { enabled: false } }, { id: "ch1" }) === null, "disabled profile = null");
const prof = X.profileFor({ ch1: { premium: true, per_day: 99, formulas: ["contrarian", "nope"] } }, { id: "ch1" });
ok(prof && prof.premium && prof.per_day === 99 ? false : true, "profile per_day is clamped");
ok(X.profileFor({ ch1: { per_day: 2, formulas: ["contrarian", "nope"] } }, { id: "ch1" }).formulas.length === 1, "unknown formulas are dropped");
ok(Object.keys(X.FORMULAS).length === 6, "six formulas");

// ---------- profiles file ----------
try {
  const profiles = require("../data/x-pair-profiles.json");
  const ids = Object.keys(profiles).filter(k => !k.startsWith("_"));
  ok(ids.length >= 1, "profiles file has at least one account");
  for (const id of ids) {
    const p = profiles[id];
    ok(Array.isArray(p.pillars) && p.pillars.length >= 1, `profile ${id}: has pillars`);
    ok(Number(p.per_day) >= 1, `profile ${id}: per_day set`);
  }
} catch (e) {
  ok(true, "no local profiles file (repo copy): skipped");
}

// ---------- publishPair ----------
(async () => {
  const fake = (failReplies = 0, opts = {}) => {
    const calls = []; let n = 0, fails = 0;
    const api = async (method, url, body) => {
      calls.push({ method, url, body });
      if (method === "DELETE") return { data: { deleted: true } };
      n++;
      if (n === 1) return { data: { id: "H" } };
      if (body.reply && fails < failReplies) {
        fails++;
        const e = new Error("boom"); if (opts.status) { e.status = opts.status; e.resetAt = opts.resetAt; } throw e;
      }
      return { data: { id: "R" + n } };
    };
    return { api, calls };
  };
  let t = 0;
  const clock = () => t;
  const wait = async ms => { t += ms; waits.push(ms); };
  let waits = [];

  // success
  let f = fake();
  let res = await X.publishPair({ hookBody: { text: "hook" }, replies: ["r1", "r2"], api: f.api, wait, clock });
  ok(res.hook_id === "H" && res.reply_ids.length === 2, "publishPair posts hook + 2 replies");
  ok(f.calls[1].body.reply.in_reply_to_tweet_id === "H" && f.calls[2].body.reply.in_reply_to_tweet_id === res.reply_ids[0], "replies chain to the previous post");

  // one transient failure → retry works
  t = 0; waits = [];
  f = fake(1);
  res = await X.publishPair({ hookBody: { text: "hook" }, replies: ["r1"], api: f.api, wait, clock });
  ok(res.reply_ids.length === 1 && waits.length === 1, "transient reply failure is retried");

  // permanent failure → 3 retries, then delete hook
  t = 0; waits = [];
  f = fake(99);
  let err = null;
  try { await X.publishPair({ hookBody: { text: "hook" }, replies: ["r1"], api: f.api, wait, clock }); } catch (e) { err = e; }
  const replyTries = f.calls.filter(c => c.method === "POST" && c.body.reply).length;
  ok(err && err.final, "permanent failure throws a final error");
  ok(replyTries === 4, "reply tried once + 3 retries (" + replyTries + ")");
  ok(t <= 120000, "retries stay within 2 minutes (" + t + " ms)");
  ok(f.calls.some(c => c.method === "DELETE" && c.url.endsWith("/H")), "hook is deleted after the final failure");
  ok(err && /deleted/.test(err.message), "error says the hook was deleted");

  // second reply fails → first reply and hook deleted
  t = 0; waits = [];
  let n2 = 0; const calls2 = [];
  const api2 = async (method, url, body) => {
    calls2.push({ method, url });
    if (method === "DELETE") return {};
    n2++;
    if (n2 === 1) return { data: { id: "H" } };
    if (n2 === 2) return { data: { id: "R1" } };
    throw new Error("nope");
  };
  try { await X.publishPair({ hookBody: { text: "h" }, replies: ["a", "b"], api: api2, wait, clock }); } catch (e) { err = e; }
  const dels = calls2.filter(c => c.method === "DELETE").map(c => c.url.split("/").pop());
  ok(dels.join(",") === "R1,H", "earlier replies and the hook are deleted, newest first");

  // 429 waits until the reset header (but never beyond the 2 min window)
  t = 0; waits = [];
  f = fake(1, { status: 429, resetAt: 30000 });
  res = await X.publishPair({ hookBody: { text: "hook" }, replies: ["r1"], api: f.api, wait, clock });
  ok(waits[0] >= 30000, "429 waits until the reset time (" + waits[0] + " ms)");
  t = 0; waits = [];
  f = fake(1, { status: 429, resetAt: 10 * 60000 });
  err = null;
  try { await X.publishPair({ hookBody: { text: "hook" }, replies: ["r1"], api: f.api, wait, clock }); } catch (e) { err = e; }
  ok(err && err.final && waits.length === 0, "429 with a reset beyond 2 min fails fast and cleans up");

  // ---------- Instagram skip ----------
  const ch = { platform: "twitter", instagram: { enabled: true, account_id: "ig_123", which: "all" } };
  const task = { media_path: "/media/pairs/x.png", pair: true };
  ok(!ig.shouldCrosspost(task, ch), "pairs are not cross-posted to Instagram");
  ok(/pair/.test(ig.skipReason(task, ch) || ""), "skipReason explains the pair skip");
  ok(ig.shouldCrosspost({ media_path: "/media/x.png" }, ch), "normal image posts still cross-post");

  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})();
