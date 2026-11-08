// Tests for listings-autopilot.js (no network). Run: node scripts/test-listings-autopilot.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../listings-autopilot");
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FOUT " + name); } };
const TZ = "Europe/Amsterdam";

// config / sanitize
const c0 = L.config({});
check("config default off, Mon/Wed/Fri", !c0.enabled && JSON.stringify(c0.days) === "[1,3,5]");
check("config rejects non-http feed", L.config({ listings: { feed_url: "file:///etc/passwd" } }).feed_url === "");
check("parseDays names + numbers + dedupe", JSON.stringify(L.parseDays("mon, wednesday 5 5 x 9")) === "[1,3,5]");
const sn = L.sanitize({ enabled: true, feed_url: "http://127.0.0.1:4000/api/collectibles", days: [2, 4], evil: 1, sold_per_day: 99 });
check("sanitize keeps fields, drops unknown", sn.enabled && sn.days.join() === "2,4" && !("evil" in sn));
check("sanitize clamps sold_per_day", sn.sold_per_day === 5);
check("config takes mark/hue from autopilot", L.config({ autopilot: { template_mark: "SH", template_hue: null } }).mark === "SH" && L.config({ autopilot: {} }).hue === 43);

// names, grades, prices
check("gradeShort PSA", L.gradeShort("PSA GEM-MT 10") === "PSA 10");
check("gradeShort CGC half", L.gradeShort("CGC 9.5 Mint+") === "CGC 9.5");
check("gradeShort empty", L.gradeShort("") === "");
check("displayName uses short name", L.displayName({ short_name: "Charizard ex", name: "x" }) === "Charizard ex");
const long = { short_name: "2023 Pokemon Japanese SV2a-Pokemon 151 #201/165 Charizard ex - Special Illustration Rare", name: "2023 Pokemon Japanese SV2a-Pokemon 151 #201/165 Charizard ex - Special Illustration Rare" };
check("displayName extracts from long title", L.displayName(long) === "Charizard ex");
check("displayName no dashes", !/[–—]/.test(L.displayName({ name: "Mew — Gold Star" })));
check("priceText rounds", L.priceText({ price: { usd: 735.4 } }) === "$735" && L.priceText({ price: { usd: 1250 } }) === "$1,250");
check("priceText small with cents", L.priceText({ price: { usd: 12.5 } }) === "$12.50");
check("priceText none", L.priceText({ price: null }) === "");
check("sellable needs price + media", L.sellable({ id: "a", price: { usd: 5 }, image: "https://x/i.png" }) && !L.sellable({ id: "a", price: null, image: "x" }) && !L.sellable({ id: "a", price: { usd: 5 } }));

// feed
const feedJson = { ok: true, fresh_at: new Date().toISOString(), items: [
  { id: "a", name: "A", price: { amount: 100, currency: "USD", usd: 100 }, image: "https://img/a.png", video: "https://v/a.mp4", page_url: "https://site.x/collectibles/a" },
  { id: "b", name: "B", price: { usd: 50 }, image: "/b.png", video: "https://v/b.webm" },
  { id: "c", name: "C", price: null, image: "https://img/c.png" },
  { name: "no id" },
] };
const feed = L.normaliseFeed(feedJson, "https://site.x/api/collectibles");
check("normaliseFeed drops items without id", feed.items.length === 3);
check("normaliseFeed resolves relative image", feed.items[1].image === "https://site.x/b.png");
check("normaliseFeed keeps only mp4 video", feed.items[0].video === "https://v/a.mp4" && feed.items[1].video === null);
check("feedTrustworthy ok", L.feedTrustworthy(feed, Date.now()) === null);
check("feedTrustworthy rejects stale", !!L.feedTrustworthy({ ...feed, fresh_at: Date.now() - 5 * 3600e3 }, Date.now()));
check("feedTrustworthy rejects empty", !!L.feedTrustworthy({ ok: true, fresh_at: Date.now(), items: [] }, Date.now()));

// sold detection
const t0 = Date.now();
let d = L.diffFeed({}, feed, t0);
check("diff seeds known items", Object.keys(d.items).length === 3 && d.sold.length === 0);
const without = { ...feed, items: feed.items.filter(i => i.id !== "a") };
d = L.diffFeed(d.items, without, t0 + 1);
check("first miss is not sold yet", d.sold.length === 0 && d.items.a.missing === 1);
const back = L.diffFeed(d.items, feed, t0 + 2);
check("reappearing resets the count", back.items.a.missing === 0 && back.sold.length === 0);
d = L.diffFeed(d.items, without, t0 + 3);
check("second miss in a row = sold", d.sold.length === 1 && d.sold[0].id === "a" && !d.items.a);
const noPrice = L.diffFeed(L.diffFeed(L.diffFeed({}, feed, t0).items, { ...feed, items: feed.items.filter(i => i.id !== "c") }, t0).items, { ...feed, items: feed.items.filter(i => i.id !== "c") }, t0);
check("item without price is never 'sold'", noPrice.sold.length === 0);
const many = { ok: true, fresh_at: Date.now(), items: ["p", "q", "r", "s"].map(id => ({ id, name: id, price: { usd: 10 }, image: "https://i/" + id })) };
let dm = L.diffFeed({}, L.normaliseFeed(many), t0);
const one = L.normaliseFeed({ ...many, items: many.items.slice(0, 1) });
dm = L.diffFeed(dm.items, one, t0); dm = L.diffFeed(dm.items, one, t0);
check("mass disappearance is suspicious, nothing sold", dm.suspicious && dm.sold.length === 0);

// planning
const cfg = L.config({ listings: { enabled: true, feed_url: "http://x/f", days: [1, 3, 5] } });
check("weekdayOf: 2026-11-09 is Monday", L.weekdayOf("2026-11-09", TZ) === 1);
check("planSlot null on Sunday", L.planSlot(cfg, "2026-11-08", TZ) === null);
const slot = L.planSlot(cfg, "2026-11-09", TZ, () => 0.5);
const local = new Date(slot).toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false });
check("planSlot inside window on Monday", local >= "10:00" && local < "21:00");
check("inWindow", L.inWindow(cfg, Date.parse(slot), TZ) && !L.inWindow(cfg, Date.parse("2026-11-09T22:30:00Z"), TZ));

// pick
const items = feed.items;
check("pickListing skips no-price items", L.pickListing(items, {}, null, () => 0.1).id !== "c");
check("pickListing least posted first", L.pickListing(items, { a: 3 }, null).id === "b");
check("pickListing not the same as last", L.pickListing(items, { b: 0, a: 0 }, "b", () => 0).id === "a");
check("pickListing single item may repeat", L.pickListing([items[0]], {}, "a").id === "a");

// text / links
const fb = L.fallbackText("listing", { name: "Pikachu", short_name: "Pikachu", grade: "PSA 10", price: { usd: 200 }, platform_label: "Courtyard" });
check("fallback listing has price + no dashes", fb.includes("$200") && !/[–—]/.test(fb));
check("fallback sold says sold", /SOLD/.test(L.fallbackText("sold", { name: "X", short_name: "X" })));
check("overviewUrl strips the item", L.overviewUrl({ page_url: "https://s.xyz/collectibles/abc" }) === "https://s.xyz/collectibles");
check("linkFor page vs marketplace", L.linkFor("listing", { page_url: "p", marketplace_url: "m" }, { link: "page" }) === "p" && L.linkFor("listing", { page_url: "p", marketplace_url: "m" }, { link: "marketplace" }) === "m");
check("link none = no link", L.linkFor("listing", { page_url: "p" }, L.sanitize({ link: "none" })) === "" && L.linkFor("sold", { page_url: "https://s/c/a" }, { link: "none" }) === "");
check("hslHex gold", /^0x[0-9a-f]{6}$/.test(L.hslHex(43, 78, 57)));
const va = L.videoArgs({ src: "in.mp4", out: "o.mp4", line1File: "l1", line2File: "l2", markFile: "mk", hasMark: true });
check("videoArgs 1080x1350 + faststart + no audio", va.join(" ").includes("pad=1080:1350") && va.includes("+faststart") && va.includes("-an"));
check("videoArgs uses textfile (no text injection)", !va.join(" ").includes("text='"));

// runner: a full listing + sold cycle with fakes
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listings-"));
  const tasks = [];
  let feedNow = JSON.parse(JSON.stringify(feedJson)); feedNow.items[1].image = "https://img/b.png";
  const png = Buffer.alloc(4000, 1);
  const fakeFetch = async (url) => {
    if (url.includes("/api/collectibles")) return { ok: true, json: async () => ({ ...feedNow, fresh_at: new Date().toISOString() }) };
    return { ok: true, arrayBuffer: async () => png };
  };
  const ran = [], calls = [];
  const channel = { id: "ch1", name: "test", platform: "twitter", listings: { enabled: true, feed_url: "http://127.0.0.1:4000/api/collectibles", days: [0, 1, 2, 3, 4, 5, 6], window_start: "00:00", window_end: "23:59" }, autopilot: { template_mark: "MARK" } };
  const bot = L.createListings({
    dataDir: dir, mediaDir: path.join(dir, "media"), tz: TZ,
    readChannels: () => [channel], addTask: t => tasks.push(t), twitterWeightedLength: s => s.length,
    anthropic: { messages: { create: async (req) => { calls.push(req); return calls.length === 1 ? { content: [{ type: "text", text: "Sure." }] } : { content: [{ type: "tool_use", id: "u1", input: { post_text: "Fresh slab for $100 — grab it" } }] }; } } },
    fetch: fakeFetch, run: async (cmd, args) => { ran.push(cmd); fs.writeFileSync(args[args.length - 1], "mp4"); return ""; }, log: m => { if (/failed/.test(m)) console.log("   log: " + m); },
  });
  // card-template render needs playwright; stub it for the test
  require("../card-template").render = async (_o, out) => { fs.writeFileSync(out, "png"); };
  await bot.refresh(channel);
  check("refresh lists sellable items", bot.status(channel).items.length === 2);
  await new Promise((ok, no) => { bot.runNow(channel, { kind: "listing", mode: "review", item_id: "a" }); const iv = setInterval(() => { if (!bot.busy()) { clearInterval(iv); ok(); } }, 10); });
  const t = tasks[0];
  check("listing task is a draft with video", t && t.status === "draft" && t.listing && t.media_path === `/media/listings/listing-${t.id}.mp4` && ran.includes("ffmpeg"));
  check("no forced tool_choice (400 on newer models)", calls.every(c => c.tool_choice.type === "auto"));
  check("text without tool call gets a retry", calls.length === 2 && t.text_by === "claude");
  check("listing text: dashes cleaned, link added", t && !/[–—]/.test(t.text) && t.text.endsWith("https://site.x/collectibles/a"));
  check("listing counted", JSON.parse(fs.readFileSync(path.join(dir, "community", "listings-state.json"), "utf8")).ch1.posted_counts.a === 1);
  // item b has no video → card
  await new Promise(ok => { bot.runNow(channel, { kind: "listing", mode: "review", item_id: "b" }); const iv = setInterval(() => { if (!bot.busy()) { clearInterval(iv); ok(); } }, 10); });
  check("image-only item becomes a card", tasks[1] && tasks[1].image_method === "listing-card" && tasks[1].media_path.endsWith(".png"));
  // a disappears twice → sold queued
  feedNow.items = feedNow.items.filter(i => i.id !== "a");
  await bot.refresh(channel); await bot.refresh(channel);
  check("sold item queued", bot.status(channel).sold_queue.map(i => i.id).join() === "a");
  await bot.tick(Date.now());
  const sold = tasks.find(x => x.sold);
  check("tick posts the sold item (auto)", sold && sold.status === "scheduled" && /SOLD/.test(sold.image_headline) && sold.text.endsWith("https://site.x/collectibles"));
  check("sold queue emptied + marked posted", bot.status(channel).sold_queue.length === 0 && bot.status(channel).sold[0].posted);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FOUT runner crashed: " + e.stack); process.exit(1); });
