// Tests for users.js (team logins + access rules). No network, temp store.
const fs = require("fs");
const os = require("os");
const path = require("path");
const U = require("../users");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FOUT " + name); }
}
function throws(fn, name) { try { fn(); ok(false, name); } catch { ok(true, name); } }

// Passwords
const h = U.hashPassword("geheim123");
ok(/^scrypt\$/.test(h), "hash has scrypt prefix");
ok(U.verifyPassword("geheim123", h), "right password verifies");
ok(!U.verifyPassword("geheim124", h), "wrong password fails");
ok(!U.verifyPassword("x", "garbage"), "garbage hash fails");
ok(U.hashPassword("a") !== U.hashPassword("a"), "salted hashes differ");

// Store
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "users-test-"));
const file = path.join(dir, "users.json");
const store = U.createStore(file);
const u = store.create({ username: " Jane ", name: "Jane", password: "password1", tools: ["designer", "settings", "designer"] });
ok(u.username === "jane", "username normalised");
ok(JSON.stringify(u.tools) === '["designer"]', "unknown and duplicate tools dropped");
ok((fs.statSync(file).mode & 0o777) === 0o600, "users.json is mode 600");
ok(store.byUsername("JANE").id === u.id, "lookup is case-insensitive");
throws(() => store.create({ username: "jane", password: "password1" }), "duplicate username refused");
throws(() => store.create({ username: "ab", password: "password1" }), "short username refused");
throws(() => store.create({ username: "bob", password: "short" }), "short password refused");
ok(!("pw_hash" in U.publicUser(u)), "publicUser hides the hash");
const before = store.get(u.id).sessions_after;
store.update(u.id, { name: "Jane D" });
ok(store.get(u.id).sessions_after === before, "renaming keeps sessions");
store.update(u.id, { tools: ["designer", "content-creator"] });
ok(store.get(u.id).sessions_after > 0, "changing tools revokes sessions");
store.update(u.id, { password: "newpassword" });
ok(U.verifyPassword("newpassword", store.get(u.id).pw_hash), "password change works");
throws(() => store.update(u.id, { password: "x" }), "short new password refused");
store.update(u.id, { disabled: true });
ok(store.get(u.id).disabled === true, "disable works");
ok(store.update("nope", {}) === null, "update unknown id -> null");
ok(store.remove(u.id) && !store.get(u.id), "remove works");
ok(store.remove(u.id) === false, "remove twice -> false");

// Session tokens
ok(U.tokenUserId("abc.123") === null, "two-part token = owner");
ok(U.tokenUserId("abc.123.u_x") === "u_x", "three-part token carries user id");
ok(U.tokenTime(Date.now().toString(36) + ".x") > 0, "token time parses");

// Route rules
const both = ["designer", "content-creator"];
const r = (m, p, t = both) => U.routeRule(m, p, t).kind;
ok(r("GET", "/designer/tasks") === "list", "designer list filtered");
ok(r("GET", "/designer/tasks", ["content-creator"]) === "list", "content creator may read own designs (From Designer)");
ok(r("POST", "/designer/tasks", ["content-creator"]) === "deny", "content creator only cannot create designs");
ok(r("DELETE", "/designer/tasks/abc") === "own", "delete needs ownership");
ok(U.routeRule("DELETE", "/designer/tasks/a%20b", both).id === "a b", "id is decoded");
ok(r("POST", "/designer/edu/run") === "deny", "edu autopilot denied");
ok(r("POST", "/designer/edu/abc/x-post") === "deny", "posting to X denied");
ok(r("GET", "/designer/edu/status") === "stub", "edu status stubbed");
ok(r("POST", "/ugc/autopilot/run") === "deny", "UGC autopilot denied");
ok(r("POST", "/video/tools/youtube-cookies") === "deny", "cookie upload denied");
ok(r("GET", "/video/tools/youtube-cookies") === "allow", "cookie status allowed");
ok(r("POST", "/opusclip/tasks/x/clips/y/publish") === "deny", "OpusClip publish denied");
ok(r("POST", "/opusclip/tasks/x/clips/y/to-community") === "deny", "OpusClip to community denied");
ok(r("GET", "/opusclip/social-accounts") === "stub", "social accounts stubbed");
ok(r("GET", "/brands") === "stub", "owner brands stubbed");
ok(r("GET", "/brand") === "brand", "brand without links");
ok(r("GET", "/notifications") === "stub", "notifications stubbed");
for (const p of ["/users", "/settings", "/scheduled-tasks", "/community/tasks", "/agents/overview", "/growth/reports", "/media/list", "/settings/api-costs"]) {
  ok(r("GET", p) !== "allow" && r("GET", p) !== "list", "not open: GET " + p);
}
ok(r("GET", "/media/ugc/x.mp4") === "media", "media needs ownership");
ok(r("HEAD", "/video-outputs/x.mp4") === "media", "HEAD treated as GET");
ok(r("GET", "/ugc/tasks", ["designer"]) === "deny", "designer only: no UGC");
ok(r("GET", "/ugc/tasks", []) === "deny", "no tools: nothing");

// Pages
ok(U.pageFor("/designer.html", ["designer"]).ok, "own tool page allowed");
ok(!U.pageFor("/settings.html", ["designer"]).ok, "settings page blocked");
ok(U.pageFor("/", ["content-creator"]).redirect === "/content-creator.html", "root redirects to first tool");
ok(U.pageFor("/index.html", []).redirect === null, "no tools: no redirect target");

// Ownership + media paths
ok(U.isOwnedBy({ owner_user: "u1" }, "u1") && !U.isOwnedBy({}, "u1") && !U.isOwnedBy(null, "u1"), "isOwnedBy");
const paths = U.collectPaths({ a: "/media/x.png?v=1", b: [{ c: "/video-outputs/y.mp4" }], d: "https://x", e: 3 });
ok(paths.has("/media/x.png") && paths.has("/video-outputs/y.mp4") && paths.size === 2, "collectPaths finds local paths");

// Stamping
const now = Date.now();
const disk = [{ id: "old" }];
const items = [
  { id: "new", created_at: new Date(now).toISOString() },
  { id: "old" },
  { id: "stale", created_at: new Date(now - 2 * 3600e3).toISOString() },
  { id: "theirs", owner_user: "u9" },
  { id: "nodate" },
];
U.stampNew(items, disk, "u1", now);
ok(items[0].owner_user === "u1", "new item stamped");
ok(!items[1].owner_user, "item already on disk not stamped");
ok(!items[2].owner_user, "stale resurrected item not stamped");
ok(items[3].owner_user === "u9", "existing owner kept");
ok(items[4].owner_user === "u1", "new item without date stamped");

// Login limiter
const lim = U.createLoginLimiter({ max: 3, windowMs: 1000 });
for (let i = 0; i < 3; i++) lim.fail("ip", 0);
ok(lim.blocked("ip", 10), "blocked after max failures");
ok(!lim.blocked("ip", 2000), "unblocked after window");
lim.reset("ip");
ok(!lim.blocked("ip", 10), "reset clears");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} FOUT`);
process.exit(fail ? 1 : 0);
