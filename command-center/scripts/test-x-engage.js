// Tests for x-engage.js (no network). Run: node scripts/test-x-engage.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const xe = require("../x-engage");
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FOUT " + name); } };

(async () => {
  // config / sanitize
  const d = xe.config({});
  check("default off", d.enabled === false);
  check("default limits", d.per_day === 6 && d.min_likes === 100 && d.min_followers === 2000 && d.max_age_hours === 8 && d.expire_hours === 6);
  check("config clamps", xe.config({ engage: { per_day: 999, max_age_hours: 0.1 } }).per_day === 30 && xe.config({ engage: { max_age_hours: 0.1 } }).max_age_hours === 1);
  check("bad window falls back", xe.config({ engage: { window_start: "25:00" } }).window_start === "09:00");
  check("min_likes 0 is allowed", xe.config({ engage: { min_likes: 0 } }).min_likes === 0);
  const s = xe.sanitize({ enabled: true, per_day: "4", evil: 1, language: "Dutch<b>" });
  check("sanitize keeps fields", s.enabled === true && s.per_day === 4);
  check("sanitize drops unknown keys", !("evil" in s));
  check("sanitize cleans language", s.language === "Dutchb");
  check("sanitize merge keeps others (toggle)", xe.sanitize({ ...s, enabled: false }).per_day === 4);

  // window
  const w = xe.config({ engage: { window_start: "09:00", window_end: "22:00" } });
  check("inWindow inside", xe.inWindow(w, 10 * 60));
  check("inWindow before", !xe.inWindow(w, 8 * 60));
  check("inWindow at end is out", !xe.inWindow(w, 22 * 60));
  const night = xe.config({ engage: { window_start: "22:00", window_end: "02:00" } });
  check("inWindow over midnight", xe.inWindow(night, 23 * 60) && xe.inWindow(night, 60) && !xe.inWindow(night, 12 * 60));
  check("minutesLeft", xe.minutesLeft(w, 20 * 60) === 120);

  // gaps
  const g = xe.nextGapMs(w, 9 * 60, 0, () => 0.5); // 780 min / 6 = 130 min
  check("nextGap spreads over window", g === 130 * 60e3);
  check("nextGap minimum 15 min (with jitter)", xe.nextGapMs(w, 21 * 60 + 59, 5, () => 0) >= 15 * 0.6 * 60e3);

  // query
  const q = xe.buildEngageQuery("bitcoin OR btc", "ourbrand");
  check("query excludes replies/retweets", /-is:retweet/.test(q) && /-is:reply/.test(q));
  check("query excludes ourselves", /-from:ourbrand/.test(q));
  check("query excludes giveaways", /-giveaway/.test(q) && /-"free mint"/.test(q));

  // topics: least searched first, curated wins a tie
  const topics = [{ label: "A" }, { label: "B" }, { label: "Curated", curated: true }];
  const p1 = xe.pickTopics(topics, {}, 2, () => 0.5);
  check("pickTopics: curated first on tie", p1[0].label === "Curated" && p1.length === 2);
  const p2 = xe.pickTopics(topics, { Curated: 3, A: 1 }, 2, () => 0.5);
  check("pickTopics: least searched first", p2[0].label === "B" && p2[1].label === "A");

  // rankPosts
  const now = Date.parse("2026-11-10T12:00:00Z");
  const ago = (h) => new Date(now - h * 3.6e6).toISOString();
  const tw = (id, o = {}) => ({ id, author_id: o.author_id || "u1", text: o.text || "Interesting market take " + id, created_at: o.created_at || ago(1), public_metrics: { like_count: o.likes ?? 500, retweet_count: 10, reply_count: 20, impression_count: 10000 }, reply_settings: o.reply_settings, possibly_sensitive: o.sensitive });
  const users = [
    { id: "u1", username: "bigacct", name: "Big", public_metrics: { followers_count: 50000 } },
    { id: "u2", username: "small", name: "Small", public_metrics: { followers_count: 300 } },
    { id: "u3", username: "ourbrand", name: "Us", public_metrics: { followers_count: 9000 } },
    { id: "u4", username: "cooldown", name: "Cd", public_metrics: { followers_count: 9000 } },
  ];
  const resp = { data: [
    tw("1"), tw("2", { likes: 5000 }), tw("3", { likes: 50 }), tw("4", { author_id: "u2" }), tw("5", { author_id: "u3" }),
    tw("6", { created_at: ago(20) }), tw("7", { sensitive: true }), tw("8", { reply_settings: "following" }),
    tw("9", { text: "free mint is live now, CA 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }), tw("10", { author_id: "u4" }), tw("11"),
  ], includes: { users } };
  const ranked = xe.rankPosts(resp, { nowMs: now, cfg: d, curated: false, seen: ["11"], recentAuthors: { cooldown: ago(5) }, me: "ourbrand" });
  const ids = ranked.map(p => p.tweet_id);
  check("rank keeps good posts", ids.includes("1") && ids.includes("2"));
  check("rank: most engagement first", ids[0] === "2");
  check("rank drops low likes", !ids.includes("3"));
  check("rank drops small accounts", !ids.includes("4"));
  check("rank drops ourselves", !ids.includes("5"));
  check("rank drops old posts", !ids.includes("6"));
  check("rank drops sensitive", !ids.includes("7"));
  check("rank drops restricted replies", !ids.includes("8"));
  check("rank drops promo", !ids.includes("9"));
  check("rank: author cooldown", !ids.includes("10"));
  check("rank drops seen", !ids.includes("11"));
  check("rank keeps metrics + author", ranked[0].author === "bigacct" && ranked[0].metrics.likes === 5000);
  const cur = xe.rankPosts({ data: [tw("3", { likes: 50, author_id: "u2" })], includes: { users } }, { nowMs: now, cfg: d, curated: true, me: "ourbrand" });
  check("curated: lower like bar, no follower minimum", cur.length === 1);
  const oldCd = xe.rankPosts({ data: [tw("10", { author_id: "u4" })], includes: { users } }, { nowMs: now, cfg: d, curated: false, recentAuthors: { cooldown: ago(100) } });
  check("cooldown expires after 72 h", oldCd.length === 1);

  // card + keyboard
  const card = xe.cardText({ name: "gh<0>st" }, { author: "a<b", followers: 12345, metrics: { likes: 1500, reposts: 3, replies: 4 }, their_text: "x < y & z", text: "our <reply>", url: "https://x.com/a/status/1", expire_hours: 6, created_at: new Date().toISOString(), topic: "BTC" });
  check("card escapes html", card.includes("gh&lt;0&gt;st") && card.includes("x &lt; y &amp; z") && card.includes("our &lt;reply&gt;"));
  check("card compacts numbers", card.includes("12.3k followers") && card.includes("❤ 1.5k"));
  const kb = xe.keyboard("ch1", { id: "p1", tweet_id: "555", text: "hi & bye?" });
  const cbs = JSON.stringify(kb);
  check("keyboard has done/no/edit", cbs.includes("xe:ok:ch1:p1") && cbs.includes("xe:no:ch1:p1") && cbs.includes("xe:ed:ch1:p1"));
  check("keyboard has pre-filled X reply link", kb.inline_keyboard[0][0].url === "https://x.com/intent/post?in_reply_to=555&text=hi%20%26%20bye%3F");
  check("intent uses edited text", xe.intentUrl({ tweet_id: "1", text: "a" }, "b c").endsWith("text=b%20c"));
  check("callback data within 64 bytes", kb.inline_keyboard.flat().every(b => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64));
  check("compact", xe.compact(999) === "999" && xe.compact(1000) === "1k" && xe.compact(2500000) === "2.5M");

  // runtime with mocks
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xe-"));
  const channel = { id: "ch1", name: "ourbrandlayer", platform: "twitter", engage: { enabled: true, min_likes: 100 }, autopilot: { topics: ["Bitcoin: bitcoin OR btc", "Ethereum: ethereum"], voice: "crypto trader" } };
  const tgCalls = [], posts = [];
  let searches = 0, lookups = 0, lastTweet = null;
  const twitterApi = async (method, url, creds, opts) => {
    if (method === "GET" && url.includes("conversation_id")) { lookups++; return { data: [{ id: "999", referenced_tweets: [{ type: "replied_to", id: lastTweet }] }] }; }
    if (method === "GET") { searches++; return resp; }
    posts.push(opts.json); return { data: { id: "999" } };
  };
  let claudeAnswer = { choice: 0, text: "Funding flipped negative while price held — that is the tell.", reason: "best" };
  const anthropic = { messages: { create: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "submit_engage", input: claudeAnswer }] }) } };
  const bot = xe.createEngage({
    dataDir: dir, tz: "Europe/Amsterdam", readChannels: () => [channel],
    twitterApi, twitterCredsFor: () => ({ fingerprint: "f1" }), twitterVerify: async () => ({ id: "u3", username: "ourbrand" }),
    twitterWeightedLength: (t) => t.length, anthropic, brandKnowledge: () => "",
    tg: async (m, b) => { tgCalls.push([m, b]); return { ok: true, result: { message_id: 77 } }; }, chatId: "123", notify: () => {}, log: () => {},
  });
  const r = await bot.runNow(channel);
  check("runNow proposes", r.proposed === true && r.proposal.status === "pending");
  check("searched 2 topics", searches === 2);
  check("proposal text has no dashes", !/[—–]/.test(r.proposal.text));
  check("telegram card sent with buttons", tgCalls[0][0] === "sendMessage" && tgCalls[0][1].parse_mode === "HTML" && JSON.stringify(tgCalls[0][1].reply_markup).includes("xe:ok:ch1:"));
  const st1 = bot.status(channel);
  check("status shows pending + count", st1.pending.length === 1 && st1.proposed_today === 1 && !!st1.next_at);
  check("nothing posted before approval", posts.length === 0);

  const pid = r.proposal.id;
  lastTweet = r.proposal.tweet_id;
  check("proposal knows our handle", r.proposal.as === "ourbrand");
  check("card links to pre-filled reply", JSON.stringify(tgCalls[0][1].reply_markup).includes("intent/post?in_reply_to=" + r.proposal.tweet_id));
  check("card has open-post fallback + copyable reply", JSON.stringify(tgCalls[0][1].reply_markup).includes("Open post") && tgCalls[0][1].text.includes("<code>"));
  check("edit: callback opens edit", await bot.handleCallback({ id: "c1", data: `xe:ed:ch1:${pid}`, message: { chat: { id: 123 } } }));
  check("edit: text consumed", await bot.handleText(123, "Edited reply here"));
  check("edit: stored", bot.status(channel).pending[0].text === "Edited reply here");
  check("other text not consumed", !(await bot.handleText(123, "hello")));

  lastTweet = "nope";
  await bot.handleCallback({ id: "c1b", data: `xe:ok:ch1:${pid}`, message: { chat: { id: 123 } } });
  check("done without our reply on X stays pending", bot.status(channel).pending.length === 1 && bot.status(channel).pending[0].status === "pending");
  check("done without reply shows alert", tgCalls.some(([m, b]) => m === "answerCallbackQuery" && b.show_alert && /no reply/.test(b.text)));
  lastTweet = r.proposal.tweet_id;
  await bot.handleCallback({ id: "c2", data: `xe:ok:ch1:${pid}`, message: { chat: { id: 123 } } });
  check("done does not post via API (X refuses)", posts.length === 0);
  check("done looks up our hand-posted reply", lookups === 2);
  check("edited card links edited text", tgCalls.filter(([m]) => m === "sendMessage").some(([, b]) => JSON.stringify(b.reply_markup || {}).includes("Edited%20reply%20here")));
  const st2 = bot.status(channel);
  check("status: posted", st2.posted_today === 1 && st2.recent[0].status === "posted" && st2.recent[0].reply_url === "https://x.com/ourbrand/status/999");
  check("card closed with link", tgCalls.some(([m, b]) => m === "editMessageReplyMarkup" && JSON.stringify(b).includes("status/999")));
  let threw = false;
  try { await bot.approve("ch1", pid); } catch { threw = true; }
  check("no double done", threw && lookups === 2);
  check("ourReplies feeds x-replies", bot.ourReplies(channel)[0].id === "999");

  // skip
  const r2 = await bot.runNow(channel);
  check("second proposal skips author in cooldown", !r2.proposed || r2.proposal.author !== "bigacct");
  if (r2.proposed) {
    await bot.handleCallback({ id: "c3", data: `xe:no:ch1:${r2.proposal.id}` });
    check("skip marks skipped", bot.status(channel).recent[0].status === "skipped");
  }

  // Claude skips everything
  claudeAnswer = { choice: -1, text: "", reason: "all drama" };
  fs.rmSync(path.join(dir, "community"), { recursive: true, force: true });
  const r3 = await bot.runNow(channel);
  check("skip-all gives no proposal", r3.proposed === false && /drama/.test(r3.reason));

  // expiry
  claudeAnswer = { choice: 0, text: "Good point on liquidity.", reason: "ok" };
  fs.rmSync(path.join(dir, "community"), { recursive: true, force: true });
  const r4 = await bot.runNow(channel);
  const sf = path.join(dir, "community", "engage-state.json");
  const all = JSON.parse(fs.readFileSync(sf, "utf8"));
  all.ch1.proposals[0].expires_at = new Date(Date.now() - 1000).toISOString();
  all.ch1.next_at = new Date(Date.now() + 3.6e6).toISOString();
  fs.writeFileSync(sf, JSON.stringify(all));
  await bot.tick();
  check("tick expires old proposals", bot.status(channel).recent.some(p => p.id === r4.proposal.id && p.status === "expired"));

  // tick respects disabled
  const before = searches;
  channel.engage.enabled = false;
  await bot.tick();
  check("tick idle when disabled", searches === before);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
