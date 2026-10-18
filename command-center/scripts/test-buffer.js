// Pure helpers of buffer.js (no network). Run: node scripts/test-buffer.js
const b = require("../buffer");
let ok = 0, bad = 0;
const t = (name, cond) => { if (cond) { ok++; console.log("ok   " + name); } else { bad++; console.log("FOUT " + name); } };

t("summer time Amsterdam 18:00 = 16:00Z", b.zonedTime("2026-10-24", "18:00", "Europe/Amsterdam").toISOString() === "2026-10-24T16:00:00.000Z");
t("winter time Amsterdam 18:00 = 17:00Z", b.zonedTime("2026-10-25", "18:00", "Europe/Amsterdam").toISOString() === "2026-10-25T17:00:00.000Z");
t("UTC stays put", b.zonedTime("2026-01-05", "09:30", "UTC").toISOString() === "2026-01-05T09:30:00.000Z");
t("New York DST start", b.zonedTime("2026-03-08", "12:00", "America/New_York").toISOString() === "2026-03-08T16:00:00.000Z");

let c = b.configOf({});
t("config off by default", c.enabled === false && c.channels.length === 0 && c.time === "18:00");
c = b.configOf({ buffer: { enabled: "true", channels: "a, b,a", time: "9:15" } });
t("config from strings, deduped", c.enabled && c.channels.join() === "a,b" && c.time === "9:15");
t("bad time falls back", b.configOf({ buffer: { time: "late" } }).time === "18:00");

t("caption strips dashes", b.captionFor({ caption: "one — two – three" }) === "one , two , three");
t("caption falls back to line", b.captionFor({ caption_line: "hi" }) === "hi");
t("caption capped at 2200", b.captionFor({ caption: "x".repeat(3000) }).length === 2200);

const ig = b.metadataFor("instagram", {});
t("instagram is a reel to feed", ig.instagram.type === "reel" && ig.instagram.shouldShareToFeed === true && ig.instagram.isAiGenerated);
t("tiktok marked AI", b.metadataFor("tiktok", {}).tiktok.isAiGenerated === true);
const yt = b.metadataFor("youtube", { caption_line: "a — b" });
t("youtube title without dashes", yt.youtube.title === "a , b" && yt.youtube.isAiGenerated);
t("unknown service no metadata", b.metadataFor("mastodon", {}) === undefined);

const inp = b.postInput({ channelId: "c1", service: "instagram", slot: { caption: "hey" }, videoUrl: "https://x/v.mp4", dueAt: new Date("2026-10-19T16:00:00Z") });
t("post input custom scheduled", inp.mode === "customScheduled" && inp.schedulingType === "automatic" && inp.needsApproval === false);
t("post input video + due", inp.assets[0].video.url === "https://x/v.mp4" && inp.dueAt === "2026-10-19T16:00:00.000Z" && inp.metadata.instagram);

(async () => {
  const old = process.env.BUFFER_API_KEY; delete process.env.BUFFER_API_KEY;
  let msg = ""; try { await b.gql("{a}"); } catch (e) { msg = e.message; }
  t("no key fails clearly", /BUFFER_API_KEY/.test(msg));
  process.env.BUFFER_API_KEY = "k";
  const fake = async () => ({ ok: true, json: async () => ({ data: { createPost: { __typename: "InvalidInputError", message: "bad video" } } }) });
  msg = ""; try { await b.createPost({}, { fetchImpl: fake }); } catch (e) { msg = e.message; }
  t("createPost surfaces Buffer error", msg === "Buffer: bad video");
  const good = async (_u, o) => ({ ok: true, json: async () => ({ data: { createPost: { __typename: "PostActionSuccess", post: { id: "p1", auth: o.headers.Authorization } } } }) });
  const post = await b.createPost({}, { fetchImpl: good });
  t("createPost returns post with bearer", post.id === "p1" && post.auth === "Bearer k");
  if (old === undefined) delete process.env.BUFFER_API_KEY; else process.env.BUFFER_API_KEY = old;
  console.log(`\n${ok} ok, ${bad} FOUT`);
  process.exit(bad ? 1 : 0);
})();
