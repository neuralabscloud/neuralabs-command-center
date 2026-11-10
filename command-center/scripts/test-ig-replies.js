// Tests for ig-replies.js (no network). Run: node scripts/test-ig-replies.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const ig = require("../ig-replies");
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FOUT " + name); } };

(async () => {
  // config / sanitize
  const d = ig.config({});
  check("default off", d.enabled === false);
  check("default limits", d.max_per_day === 30 && d.max_per_user === 3 && d.max_per_thread === 3 && d.interval_min === 15);
  check("account from cross-post section", ig.config({ instagram: { account_id: "ig_123" } }).account_id === "ig_123");
  check("bad account id ignored", ig.config({ instagram: { account_id: "../x" } }).account_id === "");
  check("interval clamps", ig.config({ ig_replies: { interval_min: 1 } }).interval_min === 5);
  const s = ig.sanitize({ enabled: true, max_per_day: "9", evil: 1, account_id: "ig_1" });
  check("sanitize keeps fields", s.enabled === true && s.max_per_day === 9);
  check("sanitize drops unknown keys + account", !("evil" in s) && !("account_id" in s));

  // candidates
  const now = Date.parse("2026-11-10T12:00:00Z");
  const ago = (h) => new Date(now - h * 3.6e6).toISOString();
  const media = { id: "m1", caption: "New PSA 10 Charizard in the vault", permalink: "https://instagram.com/p/x" };
  const comments = [
    { id: "c1", username: "fan", text: "What did it grade?", timestamp: ago(1) },
    { id: "c2", username: "our.brand", text: "our own comment", timestamp: ago(1) },
    { id: "c3", username: "old", text: "old comment", timestamp: ago(100) },
    { id: "c4", username: "answered", text: "nice", timestamp: ago(2), replies: { data: [{ id: "r1", username: "our.brand", text: "thanks!", timestamp: ago(1.5) }] } },
    { id: "c5", username: "asker", text: "price?", timestamp: ago(3), replies: { data: [
      { id: "r2", username: "our.brand", text: "@asker not for sale yet", timestamp: ago(2.5) },
      { id: "r3", username: "asker", text: "when then?", timestamp: ago(2) },
    ] } },
    { id: "c6", username: "x", text: "hi", timestamp: ago(3), replies: { data: [
      { id: "r4", username: "stranger", text: "random chat", timestamp: ago(2) },
      { id: "r5", username: "tagger", text: "@our.brand is this real?", timestamp: ago(1) },
    ] } },
    { id: "c7", username: "done", text: "already handled", timestamp: ago(1) },
    { id: "c8", username: "before", text: "before since", timestamp: ago(10) },
  ];
  const cand = ig.candidates(media, comments, { me: "our.brand", handled: ["c7"], sinceMs: now - 6 * 3.6e6, nowMs: now });
  const ids = cand.map(c => c.id);
  check("top-level comment is candidate", ids.includes("c1"));
  check("own comment skipped", !ids.includes("c2"));
  check("old comment skipped", !ids.includes("c3") && !ids.includes("c8"));
  check("already answered thread skipped", !ids.includes("c4"));
  check("follow-up after our reply is candidate", ids.includes("r3"));
  check("nested reply goes under parent", cand.find(c => c.id === "r3").parent_id === "c5" && cand.find(c => c.id === "r3").nested);
  check("random nested chat skipped", !ids.includes("r4"));
  check("nested tag of us is candidate", ids.includes("r5"));
  check("handled skipped", !ids.includes("c7"));
  check("top-level c6 itself also candidate", ids.includes("c6"));
  check("oldest first", Date.parse(cand[0].timestamp) <= Date.parse(cand[cand.length - 1].timestamp));
  check("thread context included", cand.find(c => c.id === "r3").thread.length === 3);
  check("caption carried", cand[0].caption.includes("Charizard"));

  // finalText
  check("finalText cleans dashes", !/[—–]/.test(ig.finalText("Sure — next week", { nested: false })));
  check("finalText adds @ in thread", ig.finalText("next week", { nested: true, username: "asker" }) === "@asker next week");
  check("finalText no double @", ig.finalText("@asker next week", { nested: true, username: "asker" }) === "@asker next week");
  check("finalText caps length", ig.finalText("a".repeat(500), { nested: false }).length <= 300);
  check("finalText empty stays empty", ig.finalText("", { nested: true, username: "x" }) === "");

  check("permission error detected", ig.isPermissionError("Graph: (#10) Application does not have permission for this action"));
  check("other error not permission", !ig.isPermissionError("Graph: rate limit"));

  // runtime with mocked Graph + Claude
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igr-"));
  const channel = { id: "ch2", name: "brand", platform: "twitter", instagram: { enabled: true, account_id: "ig_42" }, ig_replies: { enabled: true, max_per_user: 1 } };
  const nowIso = (h) => new Date(Date.now() - h * 3.6e6).toISOString();
  const live = [
    { id: "k1", username: "fan", text: "What did it grade?", timestamp: nowIso(1) },
    { id: "k2", username: "fan", text: "And the other one?", timestamp: nowIso(0.5) },
    { id: "k3", username: "spam", text: "Giveaway! check your DM", timestamp: nowIso(0.7) },
    { id: "k4", username: "troll", text: "fake slab lol", timestamp: nowIso(0.6) },
  ];
  const posted = [];
  let denyPost = false;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? new URLSearchParams(opts.body) : null;
    let j;
    if (u.pathname.endsWith("/ig_4242/media")) j = { data: [{ id: "m1", caption: "PSA 10 Charizard", timestamp: nowIso(5), permalink: "https://instagram.com/p/x", comments_count: 4 }, { id: "m0", caption: "old", timestamp: nowIso(24 * 30), comments_count: 3 }] };
    else if (u.pathname.endsWith("/m1/comments")) j = { data: live };
    else if (u.pathname.endsWith("/replies") && opts.method === "POST") {
      if (denyPost) return { ok: false, status: 403, json: async () => ({ error: { message: "(#10) Application does not have permission for this action" } }) };
      posted.push({ parent: u.pathname.split("/").slice(-2)[0], message: body.get("message") }); j = { id: "rep" + posted.length };
    } else j = { error: { message: "unexpected " + u.pathname } };
    return { ok: !j.error, status: j.error ? 400 : 200, json: async () => j };
  };
  let claudeCalls = 0;
  const anthropic = { messages: { create: async (req) => {
    claudeCalls++;
    const troll = /fake slab/.test(req.messages[0].content);
    const input = troll ? { action: "skip", text: "", reason: "troll" } : { action: "reply", text: "PSA 10 — gem mint!", reason: "question" };
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "submit_reply", input }] };
  } } };
  const notes = [];
  const bot = ig.createIgReplies({
    dataDir: dir, tz: "Europe/Amsterdam", readChannels: () => [channel],
    readSocial: () => [{ id: "ig_42", ig_user_id: "ig_4242", username: "our.brand", page_access_token: "tok" }],
    anthropic, brandKnowledge: () => "", notify: (...a) => notes.push(a), fetchImpl, log: () => {},
  });
  const r = await bot.runNow(channel);
  check("check finds candidates", r.checked === 4);
  check("one reply posted (per-user limit 1)", r.replied === 1 && posted.length === 1);
  check("reply goes to the comment id", posted[0].parent === "k1");
  check("reply cleaned (no dash)", !/[—–]/.test(posted[0].message));
  check("spam prefiltered without Claude", claudeCalls === 2);
  const st = bot.status(channel);
  check("status counts", st.sent_today === 1 && st.log.some(l => l.action === "replied" && l.to === "fan"));
  check("troll skipped and logged", st.log.some(l => l.to === "troll" && /troll/.test(l.reason)));
  const r2 = await bot.runNow(channel);
  check("second check: nothing new", r2.checked === 0 && posted.length === 1);

  // permission error → needs_scope
  live.push({ id: "k5", username: "newfan", text: "Where can I buy it?", timestamp: nowIso(0.1) });
  denyPost = true;
  let threw = false;
  try { await bot.runNow(channel); } catch { threw = true; }
  check("permission error throws", threw);
  check("needs_scope set", bot.status(channel).needs_scope === true);

  // no account → clear error
  let err = "";
  try { await bot.runNow({ ...channel, instagram: {} }); } catch (e) { err = e.message; }
  check("no account gives clear error", /no Instagram account/.test(err));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
