// Tests for x-replies.js (no network). Run: node scripts/test-x-replies.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const xr = require("../x-replies");
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FOUT " + name); } };

// config / sanitize
const d = xr.config({});
check("default off", d.enabled === false);
check("default limits", d.max_per_day === 20 && d.max_per_thread === 3 && d.max_per_author === 3 && d.interval_min === 10);
check("config clamps", xr.config({ replies: { max_per_day: 999, interval_min: 1 } }).max_per_day === 100 && xr.config({ replies: { interval_min: 1 } }).interval_min === 5);
const s = xr.sanitize({ enabled: true, max_per_day: "7", evil: 1, language: "Dutch<script>" });
check("sanitize keeps fields", s.enabled && s.max_per_day === 7);
check("sanitize drops unknown keys", !("evil" in s));
check("sanitize cleans language", s.language === "Dutchscript");

// query
check("query excludes our own replies", xr.buildReplyQuery("abc") === "to:abc is:reply -from:abc -is:retweet");

// preFilter
check("prefilter: normal question passes", xr.preFilter("@abc what grade did it get?") === null);
check("prefilter: emoji only", xr.preFilter("@abc 🔥🔥") !== null);
check("prefilter: link", xr.preFilter("look https://spam.io") !== null);
check("prefilter: contract address", xr.preFilter("buy 0x1234567890abcdef1234567890abcdef12345678") !== null);
check("prefilter: solana address", xr.preFilter("ape 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU") !== null);
check("prefilter: giveaway spam", xr.preFilter("Giveaway! check your DM") !== null);
check("prefilter: 100x shill", xr.preFilter("this coin will 100x") !== null);
check("prefilter: Dutch passes", xr.preFilter("Mooie kaart, wat is hij waard?") === null);

// parseReplies
const resp = {
  data: [
    { id: "105", text: "@me nice pull", author_id: "u2", conversation_id: "100", referenced_tweets: [{ type: "replied_to", id: "100" }] },
    { id: "103", text: "@me what set?", author_id: "u1", conversation_id: "100", referenced_tweets: [{ type: "replied_to", id: "100" }] },
    { id: "104", text: "@me reply to someone else", author_id: "u3", conversation_id: "100", referenced_tweets: [{ type: "replied_to", id: "999" }] },
    { id: "106", text: "self", author_id: "me1", conversation_id: "100", referenced_tweets: [{ type: "replied_to", id: "100" }] },
  ],
  includes: { users: [{ id: "u1", username: "alice", public_metrics: { followers_count: 50 }, description: "collector" }, { id: "u2", username: "bob" }] },
};
const pr = xr.parseReplies(resp, { meId: "me1", ourIds: new Set(["100"]) });
check("parse: only replies to our tweets, not ourselves", pr.length === 2);
check("parse: oldest first", pr[0].id === "103" && pr[1].id === "105");
check("parse: author fields", pr[0].author === "alice" && pr[0].followers === 50 && pr[0].author_bio === "collector");
check("parse: empty response", xr.parseReplies({}, { meId: "x", ourIds: new Set() }).length === 0);

// cleanReply
check("clean: no dashes", !/[—–]/.test(xr.cleanReply("Great card — love it")));
check("clean: no links", !/https?:/.test(xr.cleanReply("see https://x.com/a ok")));
check("clean: no hashtags", !/#/.test(xr.cleanReply("nice #cards pull")));
check("clean: no leading mention", xr.cleanReply("@bob thanks!") === "thanks!");
check("clean: strips quotes", xr.cleanReply("\"Thanks\"") === "Thanks");

// limitHit
const cfg = xr.config({ replies: { max_per_day: 2, max_per_thread: 1, max_per_author: 1 } });
check("limit: none", xr.limitHit({ count_today: 0 }, cfg, { conversation_id: "c", author_id: "a" }) === null);
check("limit: day", xr.limitHit({ count_today: 2 }, cfg, { conversation_id: "c", author_id: "a" }) === "daily max reached");
check("limit: thread", xr.limitHit({ threads: { "c:a": 1 } }, cfg, { conversation_id: "c", author_id: "a" }) === "thread max reached");
check("limit: author", xr.limitHit({ authors_today: { a: 1 } }, cfg, { conversation_id: "d", author_id: "a" }) === "max per person today");

// runtime with fakes
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xr-"));
  const channel = { id: "ch1", name: "Test", platform: "twitter", enabled: true, replies: { enabled: true, max_per_day: 5 }, autopilot: { voice: "collector" } };
  const tasks = [{ id: "t1", channel_id: "ch1", status: "published", message_id: "100", text: "Charizard PSA 10 sold for a record.", published_at: new Date().toISOString(), source: { text: "Record sale" } }];
  const posted = [], prompts = [];
  let searchResp = resp, decideAction = "reply";
  const deps = {
    dataDir: dir, tz: "UTC", readChannels: () => [channel], readTasks: () => tasks,
    twitterCredsFor: () => ({ fingerprint: "fp" }),
    twitterVerify: async () => ({ id: "me1", username: "me" }),
    twitterWeightedLength: (t) => t.length,
    brandKnowledge: () => "", autopilotConfig: (c) => c.autopilot, notify: () => {}, log: () => {},
    twitterApi: async (method, url, _c, opts) => {
      if (method === "GET") { check("search uses query", decodeURIComponent(url.replace(/\+/g, " ")).includes("to:me is:reply")); return { ...searchResp, meta: { newest_id: "106" } }; }
      posted.push(opts.json); return { data: { id: "200" + posted.length } };
    },
    anthropic: { messages: { create: async (req) => {
      prompts.push(req.messages[0].content);
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "x", name: "submit_reply", input: { action: decideAction, text: "PSA 10 — the base set one!", reason: "question" } }] };
    } } },
  };
  const bot = xr.createReplies(deps);
  const r1 = await bot.runNow(channel);
  check("run: found 2", r1.found === 2);
  check("run: answered 2", r1.replied === 2 && posted.length === 2);
  check("run: reply targets their tweet", posted[0].reply.in_reply_to_tweet_id === "103");
  check("run: posted text cleaned", !/[—–]/.test(posted[0].text));
  check("run: prompt has our post", prompts[0].includes("Charizard PSA 10"));
  check("run: prompt has their reply", prompts[0].includes("what set?"));
  const st = bot.status(channel);
  check("status: today counted", st.today === 2);
  check("status: log has replies", st.log.length === 2 && st.log[0].action === "reply");
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "community", "replies-state.json"), "utf8")).ch1;
  check("state: since_id moved", raw.since_id === "106");
  check("state: our replies stored", raw.ours.length === 2);
  check("state: thread count", raw.threads["100:u1"] === 1 && raw.threads["100:u2"] === 1);

  // second run: same response, nothing new
  posted.length = 0;
  const r2 = await bot.runNow(channel);
  check("run 2: no double replies", r2.replied === 0 && posted.length === 0);

  // reply to our reply → answered with thread context
  searchResp = { data: [{ id: "300", text: "@me which edition though?", author_id: "u1", conversation_id: "100", referenced_tweets: [{ type: "replied_to", id: "2001" }] }], includes: { users: [{ id: "u9", username: "carol" }] } };
  searchResp.data[0].author_id = "u9";
  const r3 = await bot.runNow(channel);
  check("run 3: answers reply to our reply", r3.replied === 1);
  check("run 3: prompt shows our earlier reply", prompts[prompts.length - 1].includes("Our reply:"));

  // skip decision
  decideAction = "skip"; posted.length = 0;
  searchResp = { data: [{ id: "400", text: "@me you are a clown", author_id: "u7", conversation_id: "100", referenced_tweets: [{ type: "replied_to", id: "100" }] }], includes: { users: [] } };
  const r4 = await bot.runNow(channel);
  check("run 4: skip posts nothing", r4.replied === 0 && posted.length === 0);
  check("run 4: skip logged", bot.status(channel).log[0].action === "skip");

  // X refuses (403) → logged as skip, no throw
  decideAction = "reply";
  searchResp = { data: [{ id: "500", text: "@me good one", author_id: "u8", conversation_id: "100", referenced_tweets: [{ type: "replied_to", id: "100" }] }], includes: { users: [] } };
  deps.twitterApi = async (method, url) => { if (method === "GET") return { ...searchResp, meta: { newest_id: "500" } }; throw new Error("X API: 403 Reply to this conversation is not allowed"); };
  const bot2 = xr.createReplies(deps);
  let threw = false; try { await bot2.runNow(channel); } catch { threw = true; }
  check("403: no throw", !threw);
  check("403: logged as skip", /X refused/.test(bot2.status(channel).log[0].reason));

  // disabled channel → tick does nothing
  let called = 0; deps.twitterApi = async () => { called++; return {}; };
  const bot3 = xr.createReplies({ ...deps, readChannels: () => [{ ...channel, replies: { enabled: false } }] });
  await bot3.tick();
  check("tick: disabled channel untouched", called === 0);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})();
