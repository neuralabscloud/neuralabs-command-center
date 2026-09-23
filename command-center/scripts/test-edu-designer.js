// Offline tests for edu-designer.js — run: node scripts/test-edu-designer.js [--render]
const fs = require("fs");
const os = require("os");
const path = require("path");
const e = require("../edu-designer");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FOUT " + name); }
}

// ── text hygiene ──
check("em dash between words becomes a full stop", e.stripDashes("Leverage — use it carefully") === "Leverage. use it carefully");
check("number range keeps a hyphen", e.stripDashes("risk 1–2% per trade") === "risk 1-2% per trade");
check("no dashes left", !/[—–]/.test(e.stripDashes("a—b – c — d–e")));
check("image text loses links", !e.cleanImageText("see https://x.com/abc now").includes("http"));
check("image text loses handles", e.cleanImageText("by @trader_joe today") === "by today");
check("image text keeps emails-free words and caps length", e.cleanImageText("x".repeat(200), 28).length === 28);

// ── X search + ranking ──
// ── X post ──
{
  const base = { title: "Trading terms", items: [{ term: "SL", text: "Stop loss" }, { term: "TP", text: "Take profit" }, { term: "BE", text: "Break even" }], hashtags: ["#trading", "#crypto", "#btc", "#forex"] };
  const own = e.normalizeDesign({ ...base, caption: "c", x_post: "Save this cheat sheet — 3 terms every trader uses.\n\n#trading" });
  check("x_post kept and dashes stripped", own.x_post.startsWith("Save this cheat sheet") && !/[—–]/.test(own.x_post));
  const long = "Every trader needs these terms. ".repeat(12).trim();
  const fb = e.normalizeDesign({ ...base, caption: "Hook line here.\nValue line.\n" + long, x_post: long });
  check("too long x_post falls back to caption hook", fb.x_post.startsWith("Hook line here.\nValue line.") && e.xLength(fb.x_post) <= e.X_LIMIT);
  check("fallback adds hashtags", /\n\n#trading #crypto #btc$/.test(fb.x_post));
  const none = e.normalizeDesign({ ...base, caption: "" });
  check("no caption falls back to title", none.x_post.startsWith("Trading terms") && e.xLength(none.x_post) <= e.X_LIMIT);
  check("emoji count double", e.xLength("🔥a") === 3);
  check("prompt asks for x_post", e.systemPrompt({ language: "English" }).includes('"x_post"'));
}

const q = e.xSearchQuery(["trading terms", 'say "hi"']);
check("query has images filter and no retweets", q.includes("has:images") && q.includes("-is:retweet"));
check("query escapes quotes", !q.includes('"say "hi""'));
const resp = {
  data: [
    { id: "1", text: "Trading terms", author_id: "u1", attachments: { media_keys: ["m1"] }, public_metrics: { like_count: 50, retweet_count: 10, bookmark_count: 5 } },
    { id: "2", text: "No image", author_id: "u1", public_metrics: { like_count: 900 } },
    { id: "3", text: "Low likes", author_id: "u1", attachments: { media_keys: ["m3"] }, public_metrics: { like_count: 3 } },
    { id: "4", text: "Used before", author_id: "u2", attachments: { media_keys: ["m4"] }, public_metrics: { like_count: 400 } },
    { id: "5", text: "Big one", author_id: "u2", attachments: { media_keys: ["m5"] }, public_metrics: { like_count: 300, bookmark_count: 100 } },
    { id: "6", text: "Video", author_id: "u2", attachments: { media_keys: ["m6"] }, public_metrics: { like_count: 999 } },
  ],
  includes: {
    media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/a.jpg" }, { media_key: "m3", type: "photo", url: "u" }, { media_key: "m4", type: "photo", url: "u" }, { media_key: "m5", type: "photo", url: "https://pbs.twimg.com/b.jpg" }, { media_key: "m6", type: "video" }],
    users: [{ id: "u1", username: "a" }, { id: "u2", username: "b" }],
  },
};
const ranked = e.rankXPosts(resp, { usedIds: ["4"] });
check("ranking keeps photo posts with traction only", ranked.map(p => p.id).join(",") === "5,1");
check("ranked post has url and image", ranked[0].url.includes("/status/5") && ranked[0].image.startsWith("https://"));
check("empty response is fine", e.rankXPosts({}).length === 0);

// ── prompts ──
const sys = e.systemPrompt({ language: "Dutch" });
check("system prompt language", sys.includes("Dutch"));
check("system prompt forbids logos", /logo/i.test(sys));
const up = e.userPrompt({ focus: "forex", history: ["Trading terms"], xPosts: ranked, today: "Monday", hasReference: true });
check("user prompt carries focus, history and X", up.includes("forex") && up.includes("Trading terms") && up.includes("[X 1]"));
check("user prompt without X falls back to web", e.userPrompt({}).includes("web search"));

// ── parsing ──
const good = { topic: "Trading terms", format: "glossary", kicker: "Save this", title: "Trading terms you need to know", highlight: "need to know",
  items: [{ term: "ATH", text: "All time high" }, { term: "DCA", text: "Dollar cost averaging @someone" }, { term: "FOMO", text: "Fear of missing out https://x.co/1" }],
  caption: "Save this — you will need it.", hashtags: ["trading", "#crypto", "Crypto", "day-trading"],
  sources: [{ url: "https://x.com/a/status/99", platform: "x" }, { url: "javascript:alert(1)" }], why: "popular" };
const text = `Let me think {"not":"it"} ... here it is:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
check("extractJson finds the design", e.extractJson(text).title === good.title);
let threw = false; try { e.extractJson("no json here"); } catch { threw = true; }
check("extractJson throws without design", threw);
const d = e.normalizeDesign(good);
check("items cleaned of handles and links", !JSON.stringify(d.items).includes("@someone") && !JSON.stringify(d.items).includes("http"));
check("caption has no dashes", !/[—–]/.test(d.caption));
check("hashtags deduped and prefixed", d.hashtags.join(" ") === "#trading #crypto #daytrading");
check("only http sources kept", d.sources.length === 1 && d.sources[0].platform === "x");
check("highlight kept when inside title", d.highlight === "need to know");
check("bad highlight dropped", e.normalizeDesign({ ...good, highlight: "nope" }).highlight === "");
check("unknown format falls back", e.normalizeDesign({ ...good, format: "poem" }).format === "glossary");
threw = false; try { e.normalizeDesign({ ...good, items: good.items.slice(0, 2) }); } catch { threw = true; }
check("too few items rejected", threw);
check("generic feed url dropped", !e.isSpecificUrl("https://www.instagram.com/reels/") && e.isSpecificUrl("https://www.instagram.com/reel/abc123/") && !e.isSpecificUrl("javascript:alert(1)"));
check("topic trimmed on a word", e.wordTrim("Smart money trading abbreviations glossary with meanings", 40) === "Smart money trading abbreviations");
check("full caption ends with hashtags", e.fullCaption(d).endsWith("#daytrading"));

// ── history ──
const tasks = [{ engine: "edu", status: "completed", topic: "A", x_ids: ["1"] }, { engine: "nanobanana", status: "completed", description: "B" }, { engine: "edu", status: "failed", topic: "C" }];
check("recent topics only from completed edu", e.recentTopics(tasks).join() === "A");
check("used X ids collected", e.usedXIds(tasks).includes("1"));

// ── sizes + html ──
check("sizes parsed", e.sizesFor("portrait+story").join() === "portrait,story");
check("unknown size falls back", e.sizesFor("banner").join() === "portrait");
const html = e.buildHtml({ ...d, title: "<script>x</script> terms" }, { ...e.SIZES.portrait, hue: 276 });
check("html escapes text", !html.includes("<script>x</script>"));
check("html has no image or logo", !/<img\b/i.test(html) && !/logo/i.test(html.replace(/<style[\s\S]*?<\/style>/, "")));
check("html carries all items", d.items.every(it => html.includes(it.term)));
check("html uses brand hue", html.includes("276"));

(async () => {
  if (process.argv.includes("--render")) {
    const out = path.join(os.tmpdir(), `edu-test-${Date.now()}.png`);
    const r = await e.render(d, out, { size: "portrait", hue: 276 });
    check("render writes a png", fs.existsSync(out) && fs.statSync(out).size > 10000);
    check("render fits without overflow", r.fit && !r.fit.overflow);
    fs.rmSync(out, { force: true });
    await e.closeBrowser?.();
  }
  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})();
