// ── LISTINGS AUTOPILOT (X + Instagram) ──
// Posts the items an account has for sale, read from a JSON feed
// (channel.listings.feed_url), on fixed weekdays, and announces items that
// disappeared from the feed as SOLD (social proof for a trusted seller).
//
// Feed format: { ok, fresh_at, items: [{ id, name, short_name, grade, platform,
//   platform_label, marketplace_url, page_url, price: {amount, currency, usd},
//   image, video }] }. Items without a price are never posted.
//
// Media: an item with a video (e.g. a rotating render) becomes an mp4 in the
// house frame (ffmpeg); otherwise the image goes into card-template.js.
// Text: Claude writes it (fallback: a fixed sentence), the link is added by code.
// State per channel in data/community/listings-state.json.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const cardTemplate = require("./card-template");
const { zonedTime, localDay, cleanPostText, pickLeastUsed } = require("./social-autopilot");

const DEFAULTS = {
  enabled: false,
  feed_url: "",
  days: [1, 3, 5],          // weekdays with a listing post (0 = Sunday)
  window_start: "10:00",
  window_end: "21:00",
  mode: "auto",             // auto = scheduled straight away, review = draft
  sold_posts: true,         // announce items that left the feed
  sold_per_day: 2,
  link: "page",             // page = page_url of the item, marketplace = marketplace_url
  video: true,              // use the item's video when it has one
  check_every_min: 30,      // how often the feed is read
  language: "",             // empty = autopilot language
};
const MODEL = process.env.LISTINGS_AUTOPILOT_MODEL || process.env.SOCIAL_AUTOPILOT_MODEL || "claude-sonnet-5-5";
const MISSING_NEEDED = 2;            // consecutive checks without the item before it counts as sold
const MAX_STALE_MS = 3 * 3600e3;     // feed must have refreshed its source this recently
const SOLD_QUEUE_MAX_AGE_MS = 14 * 864e5;
const VIDEO_MAX = 60 * 1024 * 1024;
const IMAGE_MAX = 15 * 1024 * 1024;
const LOG_MAX = 40;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FONTS = path.join(__dirname, "assets", "fonts");

// ── pure helpers ──────────────────────────────
function parseDays(v) {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const s = String(raw).trim().toLowerCase();
    if (!s) continue;
    const n = /^\d$/.test(s) ? Number(s) : WEEKDAYS.indexOf(s.slice(0, 3));
    if (n >= 0 && n <= 6 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function config(channel) {
  const raw = (channel && channel.listings) || {};
  const ap = (channel && channel.autopilot) || {};
  const c = { ...DEFAULTS, ...raw };
  c.enabled = !!raw.enabled;
  c.feed_url = /^https?:\/\/[^\s]+$/i.test(String(c.feed_url || "")) ? String(c.feed_url) : "";
  c.days = parseDays(raw.days ?? DEFAULTS.days);
  if (!/^\d{2}:\d{2}$/.test(c.window_start)) c.window_start = DEFAULTS.window_start;
  if (!/^\d{2}:\d{2}$/.test(c.window_end)) c.window_end = DEFAULTS.window_end;
  c.mode = c.mode === "review" ? "review" : "auto";
  c.sold_posts = raw.sold_posts !== false;
  c.sold_per_day = Math.min(5, Math.max(1, Number(c.sold_per_day) || DEFAULTS.sold_per_day));
  c.link = ["marketplace", "none"].includes(c.link) ? c.link : "page";
  c.video = raw.video !== false;
  c.check_every_min = Math.min(240, Math.max(10, Number(c.check_every_min) || DEFAULTS.check_every_min));
  c.language = String(c.language || ap.language || "English").slice(0, 40);
  c.voice = String(ap.voice || "").slice(0, 600);
  c.mark = String(ap.template_mark || "").slice(0, 30);
  c.hue = Number.isFinite(+ap.template_hue) && ap.template_hue !== null && ap.template_hue !== "" ? +ap.template_hue : 43;
  return c;
}

// Only what the UI may set.
function sanitize(input) {
  const i = input || {};
  const c = config({ listings: { ...i, enabled: !!i.enabled } });
  return {
    enabled: c.enabled, feed_url: c.feed_url, days: c.days,
    window_start: c.window_start, window_end: c.window_end, mode: c.mode,
    sold_posts: c.sold_posts, sold_per_day: c.sold_per_day, link: c.link, video: c.video,
    check_every_min: c.check_every_min, language: String(i.language || "").slice(0, 40),
  };
}

function priceUsd(item) {
  const p = item && item.price;
  const n = p && (Number(p.usd) || Number(p.amount));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function priceText(item) {
  const n = priceUsd(item);
  if (!n) return "";
  return "$" + (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n % 1 ? 2 : 0));
}

// "PSA GEM-MT 10" → "PSA 10", "CGC PRISTINE 10" → "CGC 10".
function gradeShort(grade) {
  const g = String(grade || "");
  const m = g.match(/\b(PSA|CGC|BGS|SGC|TAG|ACE|BECKETT)\b\D{0,20}?(\d{1,2}(?:\.5)?)\b/i);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : g.replace(/\s+/g, " ").trim().slice(0, 20);
}

// Readable card name: the feed's short name, or the bit after "#123/165" in a long title.
function displayName(item) {
  const short = String(item.short_name || "").trim();
  if (short && short.length <= 32) return short;
  const name = String(item.name || short);
  const m = name.match(/#[\w/]+\s+(.+?)(?:\s+-\s+|\s*\(|$)/);
  const pick = (m ? m[1] : name).replace(/[–—]/g, " ").replace(/\s+/g, " ").trim();
  return pick.split(" ").slice(0, 5).join(" ");
}

function sellable(item) {
  return !!(item && item.id && priceUsd(item) > 0 && (item.image || item.video));
}

// Relative media links in a feed resolve against the feed URL.
function resolveUrl(u, base) {
  if (!u) return null;
  try { const r = new URL(String(u), base); return /^https?:$/.test(r.protocol) ? r.href : null; } catch { return null; }
}

function normaliseFeed(json, feedUrl) {
  const items = Array.isArray(json && json.items) ? json.items : [];
  return {
    ok: !!(json && json.ok),
    fresh_at: json && json.fresh_at ? Date.parse(json.fresh_at) || 0 : 0,
    items: items.filter(i => i && i.id).map(i => ({
      id: String(i.id), name: String(i.name || ""), short_name: String(i.short_name || ""),
      grade: i.grade ? String(i.grade) : "", platform: String(i.platform || ""),
      platform_label: String(i.platform_label || i.platform || ""),
      marketplace_url: resolveUrl(i.marketplace_url, feedUrl), page_url: resolveUrl(i.page_url, feedUrl),
      price: i.price && typeof i.price === "object" ? { amount: Number(i.price.amount) || 0, currency: String(i.price.currency || "USD"), usd: Number(i.price.usd) || 0 } : null,
      image: resolveUrl(i.image, feedUrl), video: /\.mp4(\?|$)/i.test(String(i.video || "")) ? resolveUrl(i.video, feedUrl) : null,
    })),
  };
}

// Can we trust this read to decide that items are gone?
function feedTrustworthy(feed, now) {
  if (!feed.ok || !feed.items.length) return "feed not ok or empty";
  if (!feed.fresh_at || now - feed.fresh_at > MAX_STALE_MS) return "feed source is stale";
  return null;
}

// Compare the known items with a fresh feed. Returns the new map + items that
// are now considered sold (missing MISSING_NEEDED checks in a row, last seen with a price).
function diffFeed(known, feed, now) {
  const next = {};
  const sold = [];
  const present = new Set(feed.items.map(i => i.id));
  const iso = new Date(now).toISOString();
  for (const it of feed.items) {
    const old = known[it.id] || {};
    next[it.id] = { ...it, first_seen: old.first_seen || iso, last_seen: iso, missing: 0, had_price: priceUsd(it) > 0 };
  }
  const knownPriced = Object.values(known).filter(k => k.had_price && !k.sold_at);
  const goneNow = knownPriced.filter(k => !present.has(k.id));
  // Half of the priced items gone in one read smells like a broken source, not a sales day.
  const suspicious = knownPriced.length >= 3 && goneNow.length / knownPriced.length > 0.5;
  for (const k of Object.values(known)) {
    if (present.has(k.id)) continue;
    if (!k.had_price) continue;                      // never sold anything we did not list
    const missing = suspicious ? (k.missing || 0) : (k.missing || 0) + 1;
    if (missing >= MISSING_NEEDED) sold.push({ ...k, missing, sold_at: iso });
    else next[k.id] = { ...k, missing };
  }
  return { items: next, sold, suspicious };
}

// One listing slot on a listing weekday, random inside the window.
function weekdayOf(day, tz) {
  return zonedTime(day, "12:00", tz).getUTCDay();
}
function planSlot(cfg, day, tz, rand = Math.random) {
  if (!cfg.days.includes(weekdayOf(day, tz))) return null;
  const from = zonedTime(day, cfg.window_start, tz).getTime();
  const to = zonedTime(day, cfg.window_end, tz).getTime();
  if (to <= from) return null;
  return new Date(from + (to - from) * (0.05 + 0.8 * rand())).toISOString();
}
function inWindow(cfg, now, tz) {
  const day = localDay(now, tz);
  return now >= zonedTime(day, cfg.window_start, tz).getTime() && now < zonedTime(day, cfg.window_end, tz).getTime();
}

// Least posted first, never the item of the previous listing post (unless it is the only one).
function pickListing(items, counts = {}, lastId = null, rand = Math.random) {
  const ok = items.filter(sellable);
  const pool = ok.length > 1 ? ok.filter(i => i.id !== lastId) : ok;
  const id = pickLeastUsed(pool.map(i => i.id), counts, rand);
  return pool.find(i => i.id === id) || null;
}

// Fixed text when Claude is unavailable (no dashes, link added later).
function fallbackText(kind, item) {
  const name = `${displayName(item)}${item.grade ? " " + gradeShort(item.grade) : ""}`;
  if (kind === "sold") return cleanPostText(`SOLD ✅\n\n${name} found a new home.\n\nThanks for trusting us. More slabs in the vault.`);
  return cleanPostText(`Fresh in the vault 🔥\n\n${name}\n\nAvailable now for ${priceText(item)} on ${item.platform_label || "the marketplace"}.`);
}

// Overview page for sold posts: the page_url minus the item part.
function overviewUrl(item) {
  const u = item.page_url || "";
  return u.replace(/\/[^/]+\/?$/, "") || u || null;
}

function linkFor(kind, item, cfg) {
  if (cfg.link === "none") return "";
  if (kind === "sold") return overviewUrl(item);
  return cfg.link === "marketplace" ? (item.marketplace_url || item.page_url) : (item.page_url || item.marketplace_url);
}

function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, "0");
  return `0x${f(0)}${f(8)}${f(4)}`;
}

// ffmpeg arguments: video centred on a 1080×1350 dark canvas, headline above, mark below.
function videoArgs({ src, out, line1File, line2File, markFile, hue = 43, line2Len = 20, hasMark = false }) {
  const fs2 = Math.max(30, Math.min(54, Math.floor(1000 / (Math.max(1, line2Len) * 0.6))));
  const gold = hslHex(hue, 78, 57);
  const display = path.join(FONTS, "Montserrat-ExtraBold.ttf");
  const body = path.join(FONTS, "Inter-Bold.ttf");
  const filters = [
    "scale=1080:1080:force_original_aspect_ratio=decrease",
    "pad=1080:1350:(ow-iw)/2:200+(1080-ih)/2:color=0x0E0F13",
    "fps=30", "format=yuv420p",
    `drawtext=fontfile=${display}:textfile=${line1File}:fontcolor=${gold}:fontsize=72:x=(w-text_w)/2:y=42`,
    `drawtext=fontfile=${body}:textfile=${line2File}:fontcolor=white:fontsize=${fs2}:x=(w-text_w)/2:y=132`,
  ];
  if (hasMark) filters.push(`drawtext=fontfile=${display}:textfile=${markFile}:fontcolor=0x8A8F99:fontsize=34:x=(w-text_w)/2:y=1296`);
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-t", "30", "-vf", filters.join(","),
    "-map", "0:v:0", "-an", "-dn", "-sn", "-map_metadata", "-1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out];
}

// ── the runner ────────────────────────────────
function createListings(deps) {
  const {
    dataDir, mediaDir, tz = "Europe/Amsterdam",
    readChannels, addTask, anthropic, twitterWeightedLength,
    brandKnowledge = () => "", notify = () => {},
    fetch: fetchFn = fetch,
    run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { timeout: 180000 }, (e, so, se) => e ? no(new Error(String(se || e.message).slice(0, 300))) : ok(String(so)))),
    log = (...a) => console.log("[LISTINGS]", ...a),
  } = deps;
  const STATE_FILE = path.join(dataDir, "community", "listings-state.json");
  const OUT_DIR = path.join(mediaDir, "listings");
  let busy = null;

  function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
  function saveState(s) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  }
  function mutate(channelId, fn) {
    const s = loadState();
    s[channelId] = s[channelId] || {};
    const r = fn(s[channelId]);
    saveState(s);
    return r;
  }
  const addLog = (st, entry) => { st.log = [{ at: new Date().toISOString(), ...entry }, ...(st.log || [])].slice(0, LOG_MAX); };

  async function readFeed(cfg) {
    const r = await fetchFn(cfg.feed_url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
    return normaliseFeed(await r.json(), cfg.feed_url);
  }

  // Read the feed, update known items, queue sold posts.
  async function check(channel, cfg, now = Date.now()) {
    let feed;
    try { feed = await readFeed(cfg); }
    catch (e) {
      mutate(channel.id, st => { st.last_check = new Date(now).toISOString(); st.last_error = String(e.message).slice(0, 200); });
      return null;
    }
    const why = feedTrustworthy(feed, now);
    return mutate(channel.id, st => {
      st.last_check = new Date(now).toISOString();
      st.feed_count = feed.items.filter(sellable).length;
      if (why) { st.last_error = why; return feed; }
      st.last_error = null;
      const first = !st.items;
      const d = diffFeed(st.items || {}, feed, now);
      st.items = d.items;
      if (d.suspicious) addLog(st, { action: "warn", note: "many items gone at once, not counted as sold" });
      if (!first) for (const s of d.sold) {
        st.sold = [{ id: s.id, name: displayName(s), grade: gradeShort(s.grade), price: priceText(s), at: s.sold_at, posted: false }, ...(st.sold || [])].slice(0, 50);
        addLog(st, { action: "sold-detected", item: displayName(s) });
        if (cfg.sold_posts) st.sold_queue = [...(st.sold_queue || []), s];
      }
      return feed;
    });
  }

  async function download(url, max) {
    if (!/^https:\/\//i.test(url || "")) throw new Error("media url must be https");
    const r = await fetchFn(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; listings-bot)" }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`media HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > max) throw new Error("media too large");
    if (buf.length < 1000) throw new Error("media empty");
    return buf;
  }

  async function makeVideo(kind, item, cfg, id) {
    const tmp = path.join(OUT_DIR, ".tmp-" + id);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const src = path.join(tmp, "src.mp4");
      fs.writeFileSync(src, await download(item.video, VIDEO_MAX));
      const line2 = `${displayName(item)}${item.grade ? "  " + gradeShort(item.grade) : ""}`;
      fs.writeFileSync(path.join(tmp, "l1.txt"), kind === "sold" ? "SOLD" : `FOR SALE  ${priceText(item)}`);
      fs.writeFileSync(path.join(tmp, "l2.txt"), line2);
      fs.writeFileSync(path.join(tmp, "mk.txt"), cfg.mark || " ");
      const file = `${kind}-${id}.mp4`;
      await run("ffmpeg", videoArgs({
        src, out: path.join(OUT_DIR, file), line1File: path.join(tmp, "l1.txt"), line2File: path.join(tmp, "l2.txt"),
        markFile: path.join(tmp, "mk.txt"), hue: cfg.hue, line2Len: line2.length, hasMark: !!cfg.mark,
      }));
      return { path: `/media/listings/${file}`, method: `${kind}-video` };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function makeCard(kind, item, cfg, id) {
    const buf = await download(item.image, IMAGE_MAX);
    const name = `${displayName(item)}${item.grade ? " " + gradeShort(item.grade) : ""}`;
    const headline = kind === "sold" ? `Sold: ${name}` : `${name} for ${priceText(item)}`;
    const file = `${kind}-${id}.png`;
    await cardTemplate.render({ imageBuf: buf, headline, mark: cfg.mark, hue: cfg.hue }, path.join(OUT_DIR, file));
    return { path: `/media/listings/${file}`, method: `${kind}-card` };
  }

  async function makeMedia(kind, item, cfg, id) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    if (cfg.video && item.video) {
      try { return await makeVideo(kind, item, cfg, id); }
      catch (e) { log(`video for ${displayName(item)} failed, using the image: ${e.message}`); }
    }
    if (item.image) return makeCard(kind, item, cfg, id);
    throw new Error("item has no usable image or video");
  }

  async function writeText(channel, cfg, kind, item, link, recent) {
    const linkLen = link ? 25 : 0;
    const maxText = 270 - linkLen;
    const price = priceText(item);
    const tool = {
      name: "submit_post", description: "Submit the post.", strict: true,
      input_schema: {
        type: "object",
        properties: { post_text: { type: "string", description: `The post without any link, max ${maxText - 20} characters.` } },
        required: ["post_text"], additionalProperties: false,
      },
    };
    const facts = [
      `Card: ${item.name}`, `Short name: ${displayName(item)}`,
      item.grade ? `Grade: ${item.grade}` : "", `Marketplace: ${item.platform_label || item.platform}`,
      kind === "listing" ? `Price: ${price}` : `Status: SOLD (it was listed at ${price})`,
    ].filter(Boolean).join("\n");
    const task = kind === "sold"
      ? `Announce that this item from our own collection is SOLD. Goal: show we are a trusted seller with real sales. Thank the buyer without naming anyone, celebrate briefly and point people to what is still available (the link to our vault is added below automatically). Do not mention the price.`
      : `Announce that this item from our own collection is for sale. Name the card and grade, the price (${price}) exactly as written, and where it is listed. Give one short reason a collector would want it, only from the facts below or general well-known knowledge about this card. Then a short call to action (the link is added below automatically).`;
    const messages = [{ role: "user", content: `You write posts for an X account. Voice: ${cfg.voice || "a knowledgeable collector account"}
${brandKnowledge(channel)}

${task}
Write in ${cfg.language}. Always answer by calling the submit_post tool.

Facts (never invent anything beyond these: no population counts, no sales history, no value predictions):
"""
${facts}
"""

Rules:
- 2 to 5 short lines, plain text, max ${maxText - 20} characters, a blank line between lines. At most 1 hashtag and 2 emojis.
- NEVER use em dashes or en dashes. Use periods, colons or line breaks.
- No URLs, no "link below", no financial advice, no "investment", no "guaranteed", no price predictions.
${recent.length ? `\nRecent posts of this kind (use different wording and a different opening):\n${recent.map(t => "- " + t.replace(/\s+/g, " ").slice(0, 200)).join("\n")}` : ""}` }];
    for (let attempt = 0; attempt < 3; attempt++) {
      // Geforceerde tool_choice geeft een 400 op claude-sonnet-5-5 en nieuwer: dus auto + duidelijke opdracht.
      const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 3000, tools: [tool], tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages });
      const use = msg.content.find(b => b.type === "tool_use");
      if (!use) {
        messages.push({ role: "assistant", content: msg.content });
        messages.push({ role: "user", content: "Answer only by calling the submit_post tool." });
        continue;
      }
      const text = cleanPostText(String((use.input || {}).post_text || ""));
      let problem = "";
      if (!text) problem = "The post is empty.";
      else if (kind === "listing" && !text.includes(price.replace(/\.00$/, ""))) problem = `The post must contain the price exactly as "${price}".`;
      const full = link ? `${text}\n\n${link}` : text;
      const len = twitterWeightedLength(full);
      if (!problem && len > 280) problem = `Too long (${len} of 280 with the link). Make it shorter.`;
      if (!problem) return full;
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: problem + " Resubmit.", is_error: true }] });
    }
    throw new Error("Claude's post did not pass the checks");
  }

  function recentTexts(channelId, kind) {
    const st = loadState()[channelId] || {};
    return (st.recent || []).filter(r => r.kind === kind).slice(0, 4).map(r => r.text);
  }

  async function produce(channel, { kind, mode, item_id, trigger = "schedule" }) {
    if (busy) throw new Error(`Listings autopilot is busy (${busy.step})`);
    busy = { channel_id: channel.id, kind, step: "reading feed", started_at: new Date().toISOString() };
    const cfg = config(channel);
    try {
      let item;
      if (kind === "sold") {
        const st = loadState()[channel.id] || {};
        const q = st.sold_queue || [];
        item = item_id ? q.find(i => i.id === item_id) : q[0];
        if (!item) throw new Error("no sold item waiting");
      } else {
        const feed = await check(channel, cfg);
        if (!feed) throw new Error("feed could not be read");
        const st = loadState()[channel.id] || {};
        item = item_id ? feed.items.find(i => i.id === item_id && sellable(i)) : pickListing(feed.items, st.posted_counts || {}, st.last_listing_id);
        if (!item) throw new Error(item_id ? "item not in the feed (or no price)" : "no item with a price in the feed");
      }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      busy.step = item.video && cfg.video ? "rendering video" : "rendering card";
      const media = await makeMedia(kind, item, cfg, id);
      busy.step = "writing post";
      const link = linkFor(kind, item, cfg);
      let text, textBy = "claude";
      try { text = await writeText(channel, cfg, kind, item, link, recentTexts(channel.id, kind)); }
      catch (e) {
        log(`${channel.name}: Claude text failed (${e.message}), using the fixed text`);
        const t = fallbackText(kind, item);
        text = link ? `${t}\n\n${link}` : t;
        textBy = "fallback";
      }
      const nowIso = new Date().toISOString();
      const task = {
        id, channel_id: channel.id,
        status: mode === "review" ? "draft" : "scheduled",
        created_at: nowIso, updated_at: nowIso, scheduled_at: nowIso, scheduled_local: null,
        archetype: kind === "sold" ? "Listings · Sold" : "Listings · For sale", trigger_word: null,
        media_path: media.path, media_paths: [media.path],
        text, published_at: null, message_id: null, attempts: 0, error: null,
        autopilot: true, listing: kind === "listing", sold: kind === "sold",
        topic: kind === "sold" ? "Sold" : "For sale", image_method: media.method,
        image_headline: kind === "sold" ? "SOLD" : `FOR SALE ${priceText(item)}`,
        instagram_ok: true, text_by: textBy,
        listing_item: { id: item.id, name: displayName(item), grade: gradeShort(item.grade), price: priceText(item), platform: item.platform_label, url: item.marketplace_url, page_url: item.page_url },
        reason: kind === "sold" ? `${displayName(item)} left the listings: sold post` : `Listing post for ${displayName(item)} (${priceText(item)})`,
      };
      addTask(task);
      mutate(channel.id, st => {
        st.recent = [{ kind, text, at: nowIso }, ...(st.recent || [])].slice(0, 12);
        if (kind === "listing") {
          st.posted_counts = { ...(st.posted_counts || {}), [item.id]: ((st.posted_counts || {})[item.id] || 0) + 1 };
          st.last_listing_id = item.id;
          if (st.slot && trigger === "schedule") st.slot.status = "done";
        } else {
          st.sold_queue = (st.sold_queue || []).filter(i => i.id !== item.id);
          st.sold = (st.sold || []).map(s => s.id === item.id ? { ...s, posted: true, task_id: id } : s);
          const day = localDay(new Date(), tz);
          st.sold_today = st.sold_today && st.sold_today.day === day ? { day, n: st.sold_today.n + 1 } : { day, n: 1 };
        }
        addLog(st, { action: kind, item: displayName(item), task_id: id, media: media.method, mode, trigger });
      });
      log(`${channel.name}: queued ${kind} ${id} (${displayName(item)}, ${media.method}, ${mode})`);
      return { task };
    } catch (e) {
      mutate(channel.id, st => {
        addLog(st, { action: "error", kind, error: String(e.message).slice(0, 200), trigger });
        if (kind === "listing" && st.slot && trigger === "schedule") {
          st.slot.tries = (st.slot.tries || 0) + 1;
          if (st.slot.tries >= 3) st.slot.status = "failed";
          else st.slot.at = new Date(Date.now() + 15 * 60e3).toISOString();
        }
        if (kind === "sold" && trigger === "schedule") {
          const q = st.sold_queue || [];
          if (q[0]) { q[0].tries = (q[0].tries || 0) + 1; if (q[0].tries >= 3) st.sold_queue = q.slice(1); }
        }
      });
      if (trigger === "schedule") notify(`🏷 Listings post failed (${channel.name})`, String(e.message).slice(0, 300), "danger");
      throw e;
    } finally {
      busy = null;
    }
  }

  async function tickChannel(channel, now) {
    const cfg = config(channel);
    if (!cfg.enabled || !cfg.feed_url) return;
    const st0 = loadState()[channel.id] || {};
    if (!st0.last_check || now - Date.parse(st0.last_check) >= cfg.check_every_min * 60e3) await check(channel, cfg, now);
    const day = localDay(new Date(now), tz);
    const st = mutate(channel.id, s => {
      if (s.slot_day !== day) { s.slot_day = day; const at = planSlot(cfg, day, tz); s.slot = at ? { at, status: "pending" } : null; }
      s.sold_queue = (s.sold_queue || []).filter(i => now - Date.parse(i.sold_at || 0) < SOLD_QUEUE_MAX_AGE_MS);
      return s;
    });
    if (busy) return;
    const soldToday = st.sold_today && st.sold_today.day === day ? st.sold_today.n : 0;
    if (cfg.sold_posts && (st.sold_queue || []).length && soldToday < cfg.sold_per_day && inWindow(cfg, now, tz)) {
      await produce(channel, { kind: "sold", mode: cfg.mode }).catch(() => {});
      return;
    }
    if (st.slot && st.slot.status === "pending" && Date.parse(st.slot.at) <= now) {
      if (!inWindow(cfg, now, tz)) { mutate(channel.id, s => { if (s.slot) s.slot.status = "skipped"; addLog(s, { action: "skipped", note: "slot missed (outside window)" }); }); return; }
      await produce(channel, { kind: "listing", mode: cfg.mode }).catch(() => {});
    }
  }

  async function tick(now = Date.now()) {
    for (const channel of readChannels()) {
      if (channel.platform !== "twitter" || channel.enabled === false || !channel.listings) continue;
      try { await tickChannel(channel, now); } catch (e) { log(`${channel.name}: ${e.message}`); }
    }
  }

  function runNow(channel, { kind, mode, item_id } = {}) {
    if (busy) throw new Error(`Listings autopilot is busy (${busy.step})`);
    const cfg = config(channel);
    if (!cfg.feed_url) throw new Error("Set a feed URL first");
    const k = kind === "sold" ? "sold" : "listing";
    if (k === "sold" && !(loadState()[channel.id]?.sold_queue || []).length && !item_id) throw new Error("No sold item waiting");
    produce(channel, { kind: k, mode: mode === "auto" ? "auto" : "review", item_id, trigger: "manual" })
      .catch(e => log(`${channel.name}: manual ${k} failed: ${e.message}`));
  }

  async function refresh(channel) {
    const cfg = config(channel);
    if (!cfg.feed_url) throw new Error("Set a feed URL first");
    await check(channel, cfg);
    return status(channel);
  }

  function status(channel) {
    const s = loadState()[channel.id] || {};
    const items = Object.values(s.items || {}).filter(sellable).map(i => ({
      id: i.id, name: displayName(i), grade: gradeShort(i.grade), price: priceText(i), platform: i.platform_label,
      video: !!i.video, posted: (s.posted_counts || {})[i.id] || 0,
    }));
    return {
      config: config(channel), slot: s.slot || null, last_check: s.last_check || null, last_error: s.last_error || null,
      items, sold: s.sold || [], sold_queue: (s.sold_queue || []).map(i => ({ id: i.id, name: displayName(i), sold_at: i.sold_at })),
      log: s.log || [], running: busy && busy.channel_id === channel.id ? busy : null,
    };
  }

  return { tick, runNow, refresh, status, busy: () => busy };
}

module.exports = {
  DEFAULTS, config, sanitize, parseDays, priceUsd, priceText, gradeShort, displayName, sellable,
  resolveUrl, normaliseFeed, feedTrustworthy, diffFeed, weekdayOf, planSlot, inWindow, pickListing,
  fallbackText, overviewUrl, linkFor, hslHex, videoArgs, createListings, MISSING_NEEDED,
};
