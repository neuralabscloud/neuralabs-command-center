// Tests for instagram-publish.js (no network). Run: node scripts/test-instagram-publish.js
const ig = require("../instagram-publish");
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FOUT " + name); } };

// caption
const c1 = ig.caption("Big pull today.\n\nGrab yours: https://example.com/tcg\n", { hashtags: "#pokemon #tcg" });
check("caption strips links", !/https?:/.test(c1));
check("caption adds link in bio", c1.includes("Link in bio"));
check("caption appends hashtags", c1.endsWith("#pokemon #tcg"));
check("caption without link has no link-in-bio", !ig.caption("plain text").includes("Link in bio"));
check("caption no triple newlines", !/\n{3,}/.test(ig.caption("a\n\n\n\nb https://x.y\n\n\nc")));
check("caption skips hashtag already in text", ig.caption("love #Pokemon", { hashtags: "#pokemon #tcg" }).match(/#pokemon/gi).length === 1);
const many = Array.from({ length: 40 }, (_, i) => "#t" + i).join(" ");
check("caption max 30 hashtags", (ig.caption("x #a #b", { hashtags: many }).match(/#\w+/g) || []).length === 30);
check("caption max 2200 chars", ig.caption("x".repeat(3000)).length === 2200);

// parseHashtags / sanitize / config
check("parseHashtags cleans + dedupes", JSON.stringify(ig.parseHashtags("#Poke, poke tcg;#a-b")) === JSON.stringify(["Poke", "tcg", "ab"]));
const s = ig.sanitize({ enabled: true, account_id: "ig_123", which: "promo", hashtags: "pokemon tcg", evil: 1 });
check("sanitize keeps fields", s.enabled && s.account_id === "ig_123" && s.which === "promo" && s.hashtags === "#pokemon #tcg");
check("sanitize drops unknown keys", !("evil" in s));
check("sanitize rejects bad account id", ig.sanitize({ account_id: "../x" }).account_id === "");
check("sanitize default which = all", ig.sanitize({}).which === "all");
check("config disabled without account", !ig.config({ instagram: { enabled: true } }).enabled);

// shouldCrosspost
const ch = { platform: "twitter", instagram: { enabled: true, account_id: "ig_1", which: "all" } };
const t = { id: "a", media_path: "/media/autopilot-a.png" };
check("crosspost: image post on enabled channel", ig.shouldCrosspost(t, ch));
check("crosspost: not without image", !ig.shouldCrosspost({ id: "b" }, ch));
check("crosspost: not for video", !ig.shouldCrosspost({ media_path: "/media/x.mp4" }, ch));
check("crosspost: not twice", !ig.shouldCrosspost({ ...t, instagram: { status: "pending" } }, ch));
check("crosspost: not for telegram channel", !ig.shouldCrosspost(t, { ...ch, platform: "telegram" }));
check("crosspost: off when disabled", !ig.shouldCrosspost(t, { ...ch, instagram: { ...ch.instagram, enabled: false } }));
const promoCh = { ...ch, instagram: { ...ch.instagram, which: "promo" } };
check("crosspost promo-only skips normal", !ig.shouldCrosspost(t, promoCh));
check("crosspost promo-only takes promo", ig.shouldCrosspost({ ...t, promo: true }, promoCh));
check("crosspost: not when instagram_ok false (reaction/off-niche)", !ig.shouldCrosspost({ ...t, instagram_ok: false }, ch));
check("crosspost: promo ignores instagram_ok false", ig.shouldCrosspost({ ...t, promo: true, instagram_ok: false }, ch));
check("crosspost: old tasks without the flag still go", ig.shouldCrosspost({ ...t }, ch) && ig.skipReason(t, ch) === null);
check("skipReason explains a gated post", /X only/.test(ig.skipReason({ ...t, instagram_ok: false }, ch) || ""));
check("skipReason silent when IG off or already handled", ig.skipReason({ ...t, instagram_ok: false }, { ...ch, instagram: { enabled: false } }) === null && ig.skipReason({ ...t, instagram_ok: false, instagram: { status: "skipped" } }, ch) === null);
check("imagePathOf rejects traversal", ig.imagePathOf({ media_path: "/media/../../.env.png" }) === null);
check("imagePathOf takes first of media_paths", ig.imagePathOf({ media_paths: ["/media/a.jpg"] }) === "/media/a.jpg");

// padTarget
check("pad: 4:5 fits", ig.padTarget(1080, 1350) === null);
check("pad: square fits", ig.padTarget(1080, 1080) === null);
const tall = ig.padTarget(1080, 1920);
check("pad: 9:16 padded to 4:5", tall && tall.height === 1920 && tall.width === 1536);
const wide = ig.padTarget(3000, 1000);
check("pad: very wide padded", wide && wide.width === 3000 && wide.width / wide.height <= 1.91);

// publishImage with a fake Graph API
(async () => {
  const calls = [];
  let polls = 0;
  const fake = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? Object.fromEntries(opts.body) : null });
    const j = d => ({ ok: true, json: async () => d });
    if (opts.method === "POST" && url.endsWith("/media")) return j({ id: "C1" });
    if (url.includes("/C1?")) return j({ status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" });
    if (url.endsWith("/media_publish")) return j({ id: "M1" });
    if (url.includes("/M1?")) return j({ permalink: "https://www.instagram.com/p/abc/" });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const r = await ig.publishImage({ fetch: fake, igUserId: "17", token: "tok", imageUrl: "https://h/i.jpg", caption: "hi", sleep: async () => {} });
  check("publish returns media id + permalink", r.media_id === "M1" && r.permalink === "https://www.instagram.com/p/abc/");
  check("publish sends image_url + caption", calls[0].body.image_url === "https://h/i.jpg" && calls[0].body.caption === "hi");
  check("publish waits for FINISHED", polls === 2);
  check("publish uses creation_id", calls.find(c => c.url.endsWith("/media_publish")).body.creation_id === "C1");

  const errFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Only photo or video can be accepted as media type.", code: 9004 } }) });
  let msg = "";
  try { await ig.publishImage({ fetch: errFetch, igUserId: "1", token: "t", imageUrl: "u", caption: "c" }); } catch (e) { msg = e.message; }
  check("publish surfaces Graph error", msg.includes("Only photo") && msg.includes("9004"));

  const errStatus = async (url, o) => ({ ok: true, json: async () => (o.method === "POST" ? { id: "C2" } : { status_code: "ERROR", status: "bad image" }) });
  msg = "";
  try { await ig.publishImage({ fetch: errStatus, igUserId: "1", token: "t", imageUrl: "u", caption: "c", sleep: async () => {} }); } catch (e) { msg = e.message; }
  check("publish fails on container ERROR", msg.includes("error") && msg.includes("bad image"));

  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})();
