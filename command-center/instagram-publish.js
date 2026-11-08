// ── INSTAGRAM CROSS-POST ──
// An X channel can copy its image posts to a connected Instagram Business
// account (Graph API content publishing). Pure helpers + the publish call;
// the worker in api-server.js decides when to run it.
//
// Channel config: channel.instagram = { enabled, account_id, which, hashtags }
//   account_id  id of an "instagram" row in social-connections.json (ig_<id>)
//   which       "all" = every X post with an image, "promo" = only promo posts
//   hashtags    extra hashtags for Instagram (X posts carry few or none)

const GRAPH = "https://graph.facebook.com/v21.0";
const CAPTION_MAX = 2200;   // Instagram caption limit
const HASHTAG_MAX = 30;     // Instagram rejects more than 30 hashtags
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

function parseHashtags(s) {
  const out = [];
  for (const raw of String(s || "").split(/[\s,;]+/)) {
    const tag = raw.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!tag) continue;
    if (!out.some(t => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out.slice(0, HASHTAG_MAX);
}

function config(channel) {
  const raw = (channel && channel.instagram) || {};
  const account_id = /^ig_\d+$/.test(String(raw.account_id || "")) ? String(raw.account_id) : "";
  return {
    enabled: !!raw.enabled && !!account_id,
    account_id,
    which: raw.which === "promo" ? "promo" : "all",
    hashtags: parseHashtags(raw.hashtags).map(t => "#" + t).join(" "),
  };
}

// Only the fields we accept from the UI; anything else is dropped.
function sanitize(input) {
  const c = config({ instagram: input });
  return { enabled: !!(input && input.enabled), account_id: c.account_id, which: c.which, hashtags: c.hashtags };
}

function imagePathOf(task) {
  const p = task && (task.media_path || (Array.isArray(task.media_paths) && task.media_paths[0]));
  return p && IMAGE_RE.test(p) && /^\/media\/[\w./-]+$/.test(p) && !p.includes("..") ? p : null;
}

function shouldCrosspost(task, channel) {
  const cfg = config(channel);
  if (!cfg.enabled || !channel || channel.platform !== "twitter") return false;
  if (task.instagram) return false;            // already queued, done or failed
  if (!imagePathOf(task)) return false;        // Instagram needs an image
  if (task.instagram_ok === false && !task.promo) return false; // reaction/off-niche: X only
  return cfg.which === "all" || !!task.promo;
}

// Waarom een post die anders mee zou gaan bewust NIET naar Instagram gaat
// (reactie op een tweet of buiten de niche, zo beoordeeld bij het schrijven).
function skipReason(task, channel) {
  if (!task || task.instagram || task.promo || task.instagram_ok !== false) return null;
  const cfg = config(channel);
  if (!cfg.enabled || !channel || channel.platform !== "twitter" || cfg.which !== "all" || !imagePathOf(task)) return null;
  return "reaction to a tweet or off-niche (X only)";
}

// X text → Instagram caption. Links are not clickable on Instagram, so they
// are removed and replaced by one "link in bio" line; hashtags go at the end.
function caption(text, { hashtags = "" } = {}) {
  let body = String(text || "");
  const hadLink = /https?:\/\/\S+/i.test(body);
  body = body.replace(/https?:\/\/\S+/gi, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const present = new Set((body.match(/#[\p{L}\p{N}_]+/gu) || []).map(t => t.toLowerCase()));
  const room = HASHTAG_MAX - present.size;
  const extra = String(hashtags || "").split(/\s+/).filter(t => t && !present.has(t.toLowerCase())).slice(0, Math.max(0, room));
  const parts = [body];
  if (hadLink) parts.push("🔗 Link in bio");
  if (extra.length) parts.push(extra.join(" "));
  return parts.filter(Boolean).join("\n\n").slice(0, CAPTION_MAX);
}

// Instagram accepts aspect ratios from 4:5 (0.8) to 1.91:1. Returns the canvas
// to pad to (centered, black), or null when the image already fits.
function padTarget(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  if (r < 0.8) return { width: Math.ceil(h * 0.8), height: h };
  if (r > 1.91) return { width: w, height: Math.ceil(w / 1.91) };
  return null;
}

async function graph(fetchFn, method, url, params) {
  const body = method === "POST" ? new URLSearchParams(params) : undefined;
  const r = await fetchFn(method === "GET" ? `${url}?${new URLSearchParams(params)}` : url, { method, body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const e = d.error || {};
    throw new Error(`Instagram: ${e.error_user_msg || e.message || "HTTP " + r.status}${e.code ? ` (code ${e.code})` : ""}`);
  }
  return d;
}

// Container → wait until processed → publish → permalink.
async function publishImage({ fetch: fetchFn = fetch, igUserId, token, imageUrl, caption: text, pollMs = 3000, maxWaitMs = 90000, sleep }) {
  const wait = sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const c = await graph(fetchFn, "POST", `${GRAPH}/${igUserId}/media`, { image_url: imageUrl, caption: text, access_token: token });
  if (!c.id) throw new Error("Instagram: no container id");
  for (let waited = 0; ; waited += pollMs) {
    const s = await graph(fetchFn, "GET", `${GRAPH}/${c.id}`, { fields: "status_code,status", access_token: token });
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`Instagram: media ${s.status_code.toLowerCase()} (${s.status || "no detail"})`);
    if (waited >= maxWaitMs) throw new Error("Instagram: media still processing after " + Math.round(maxWaitMs / 1000) + " s");
    await wait(pollMs);
  }
  const p = await graph(fetchFn, "POST", `${GRAPH}/${igUserId}/media_publish`, { creation_id: c.id, access_token: token });
  let permalink = null;
  try { permalink = (await graph(fetchFn, "GET", `${GRAPH}/${p.id}`, { fields: "permalink", access_token: token })).permalink || null; } catch { /* optional */ }
  return { media_id: p.id, permalink };
}

module.exports = { GRAPH, config, sanitize, parseHashtags, imagePathOf, shouldCrosspost, skipReason, caption, padTarget, publishImage };
