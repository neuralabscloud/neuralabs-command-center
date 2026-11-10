// ── INSTAGRAM AUTO-REPLIES ────────────────────
// Per channel with ig_replies.enabled (and an Instagram account on
// channel.instagram.account_id): every few minutes, read the comments under
// our own recent Instagram posts and let Claude answer the ones worth an answer.
// Same logic as the X auto-replies (x-replies.js): prefilter, limits per day /
// person / thread, skip spam and trolls, never invent facts.
// Instagram only allows replies to comments on our OWN media (Graph API
// instagram_manage_comments); commenting on other accounts is not possible.
// State lives in data/community/ig-replies-state.json.

const fs = require("fs");
const path = require("path");
const { preFilter, cleanReply, localDay } = require("./x-replies");

const GRAPH = "https://graph.facebook.com/v21.0";
const DEFAULTS = {
  enabled: false,
  max_per_day: 30,
  max_per_user: 3,     // per person per day
  max_per_thread: 3,   // our replies under one comment
  interval_min: 15,
  language: "",        // empty = language of the comment
};
const MODEL = process.env.IG_REPLIES_MODEL || process.env.X_REPLIES_MODEL || process.env.SOCIAL_AUTOPILOT_MODEL || "claude-sonnet-5-5";
const MEDIA_DAYS = 14;        // posts older than this are not checked
const COMMENT_MAX_AGE_H = 72; // comments older than this are left alone
const FIRST_LOOKBACK_H = 6;   // first run: only answer what came in the last 6 hours
const MAX_CLAUDE_PER_CHECK = 6;
const MAX_REPLY_LEN = 300;
const LOG_MAX = 40;

function config(channel) {
  const c = { ...DEFAULTS, ...(channel && channel.ig_replies || {}) };
  const int = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v) || d)));
  c.enabled = !!c.enabled;
  c.max_per_day = int(c.max_per_day, 1, 200, DEFAULTS.max_per_day);
  c.max_per_user = int(c.max_per_user, 1, 20, DEFAULTS.max_per_user);
  c.max_per_thread = int(c.max_per_thread, 1, 20, DEFAULTS.max_per_thread);
  c.interval_min = int(c.interval_min, 5, 240, DEFAULTS.interval_min);
  c.language = String(c.language || "").replace(/[^\p{L} ()-]/gu, "").slice(0, 30);
  const acc = channel && channel.instagram && channel.instagram.account_id;
  c.account_id = /^ig_\d+$/.test(String(acc || "")) ? String(acc) : "";
  return c;
}

function sanitize(input) {
  const c = config({ ig_replies: input && typeof input === "object" ? input : {} });
  const { enabled, max_per_day, max_per_user, max_per_thread, interval_min, language } = c;
  return { enabled, max_per_day, max_per_user, max_per_thread, interval_min, language };
}

const lc = (s) => String(s || "").toLowerCase();

// Comments of one media item → things that may need an answer, oldest first.
// Top-level comments from others: always a candidate. A reply inside a thread
// from someone else: only when we already spoke in that thread or they tag us.
function candidates(media, comments, { me, handled = [], sinceMs, nowMs }) {
  const done = new Set(handled.map(String));
  const out = [];
  for (const c of comments || []) {
    const replies = (c.replies && c.replies.data) || [];
    const ourCount = replies.filter(r => lc(r.username) === lc(me)).length;
    const thread = [{ username: c.username, text: c.text || "" }, ...replies.map(r => ({ username: r.username, text: r.text || "" }))];
    const base = { media_id: media.id, caption: String(media.caption || ""), permalink: media.permalink || "", parent_id: c.id, our_count: ourCount };
    const fresh = (ts) => {
      const t = Date.parse(ts || 0);
      return t > sinceMs && nowMs - t < COMMENT_MAX_AGE_H * 3.6e6;
    };
    if (lc(c.username) !== lc(me) && !done.has(String(c.id)) && fresh(c.timestamp)) {
      // already answered by us (by hand or earlier) → not a candidate
      if (!ourCount) out.push({ ...base, id: c.id, username: c.username, text: c.text || "", timestamp: c.timestamp, nested: false, thread: thread.slice(0, 1) });
    }
    replies.forEach((r, i) => {
      if (lc(r.username) === lc(me) || done.has(String(r.id)) || !fresh(r.timestamp)) return;
      const weSpokeBefore = replies.slice(0, i).some(x => lc(x.username) === lc(me));
      const tagsUs = me && new RegExp(`@${me.replace(/[.]/g, "\\.")}\\b`, "i").test(r.text || "");
      if (!weSpokeBefore && !tagsUs) return;
      if (replies.slice(i + 1).some(x => lc(x.username) === lc(me))) return; // answered already
      out.push({ ...base, id: r.id, username: r.username, text: r.text || "", timestamp: r.timestamp, nested: true, thread: thread.slice(0, i + 2) });
    });
  }
  return out.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

// Text that goes to Instagram: cleaned, and in a thread addressed with @user
// (Instagram replies are one level deep, so nested answers go under the parent).
function finalText(text, c) {
  let t = cleanReply(text).slice(0, MAX_REPLY_LEN);
  if (!t) return "";
  if (c.nested && c.username && !t.toLowerCase().startsWith("@" + lc(c.username))) t = `@${c.username} ${t}`;
  return t;
}

function isPermissionError(msg) {
  return /\(#10\)|\(#200\)|permission|not authorized|instagram_manage_comments/i.test(String(msg || ""));
}

function createIgReplies(deps) {
  const {
    dataDir, tz, readChannels, readSocial, anthropic, brandKnowledge, notify,
    fetchImpl = (...a) => fetch(...a),
    log = (m) => console.log("[IG-REPLIES]", m),
  } = deps;
  const stateFile = path.join(dataDir, "community", "ig-replies-state.json");
  let busy = null;

  function loadState() {
    try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; }
  }
  function mutate(channelId, fn) {
    const all = loadState();
    const st = all[channelId] || {};
    const out = fn(st);
    all[channelId] = st;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, stateFile);
    return out === undefined ? st : out;
  }
  function rollDay(st) {
    const day = localDay(new Date(), tz);
    if (st.day !== day) { st.day = day; st.sent_today = 0; st.per_user = {}; }
  }
  function pushLog(st, e) {
    st.log = [{ at: new Date().toISOString(), ...e }, ...(st.log || [])].slice(0, LOG_MAX);
  }

  function account(cfg) {
    const rows = readSocial();
    const row = (Array.isArray(rows) ? rows : []).find(a => a.id === cfg.account_id);
    if (!row || !row.ig_user_id || !row.page_access_token) throw new Error("Instagram account not connected (Settings → Meta)");
    return { igId: String(row.ig_user_id), token: row.page_access_token, username: row.username || "" };
  }

  async function graph(method, p, token, params = {}) {
    const qs = new URLSearchParams({ ...params, access_token: token });
    const url = `${GRAPH}/${p}${method === "GET" ? "?" + qs : ""}`;
    const r = await fetchImpl(url, method === "GET" ? {} : { method, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: qs.toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`Graph: ${(j.error && j.error.message) || r.status}`);
    return j;
  }

  async function decide(channel, cfg, c) {
    const voice = (channel.autopilot && channel.autopilot.voice) || "a knowledgeable account in its niche";
    const tool = {
      name: "submit_reply",
      description: "Answer the comment, or skip it.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["reply", "skip"] },
          text: { type: "string", description: `Our reply, max ${MAX_REPLY_LEN} characters, or empty when skipping.` },
          reason: { type: "string", description: "One short sentence: why reply or skip." },
        },
        required: ["action", "text", "reason"],
        additionalProperties: false,
      },
    };
    const thread = c.thread.slice(0, -1).map(t => `@${t.username}: ${String(t.text).replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
    const prompt = `You run the comments of an Instagram account. Voice: ${voice}
${brandKnowledge ? brandKnowledge(channel) : ""}

Someone commented on our post. Decide whether to answer and, if so, write the answer. Always answer by calling the submit_reply tool.

Our post caption:
"""
${c.caption.replace(/\s+/g, " ").slice(0, 600)}
"""
${thread ? `\nThread so far:\n${thread}\n` : ""}
New comment from @${c.username}:
"""
${c.text}
"""

Skip (action "skip") when the comment is: spam, a bot, a scam or shill, "DM us", a collab or promo offer, only emojis or tags, a troll or insult, political, sexual, asking for money or personal data, or when there is nothing useful to add (a plain compliment may get a short warm thanks, but skipping is fine too).

Rules for a reply:
- Answer their actual point or question, like a real person behind the account. Short: 1 to 2 sentences, max ${MAX_REPLY_LEN} characters.
- ${cfg.language ? `Write in ${cfg.language}.` : "Write in the language of their comment."}
- NEVER use em dashes or en dashes. No links, no hashtags, at most 1 emoji. Do not start with their @handle.
- Only state facts that are in our caption, the thread or the account knowledge above. Never invent numbers, prices, dates or features. If you do not know, say so honestly or ask them back.
- No financial advice, no price predictions, no promises. Do not promote products unless they ask about them ("link in bio" is fine when they ask where to find something).
- Never argue. Disagreement can be answered calmly with one point, or skipped.`;
    const messages = [{ role: "user", content: prompt }];
    for (let attempt = 0; attempt < 2; attempt++) {
      const msg = await anthropic.messages.create({
        model: MODEL, max_tokens: 2000, tools: [tool],
        tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages,
      });
      const use = msg.content.find(b => b.type === "tool_use");
      if (!use) {
        if (attempt === 0 && msg.stop_reason !== "refusal") {
          messages.push({ role: "assistant", content: msg.content });
          messages.push({ role: "user", content: "Answer only by calling the submit_reply tool." });
          continue;
        }
        return { action: "skip", text: "", reason: "model gave no answer" };
      }
      const out = use.input || {};
      if (out.action !== "reply") return { action: "skip", text: "", reason: out.reason || "skipped" };
      const text = cleanReply(out.text);
      if (text && text.length <= MAX_REPLY_LEN) return { action: "reply", text, reason: out.reason || "" };
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: `Too long (${text.length}) or empty. Resubmit, max ${MAX_REPLY_LEN} characters.`, is_error: true }] });
    }
    return { action: "skip", text: "", reason: "reply stayed too long" };
  }

  async function check(channel) {
    const cfg = config(channel);
    if (!cfg.account_id) throw new Error("no Instagram account on this channel (Instagram cross-post section)");
    const acc = account(cfg);
    const nowMs = Date.now();
    let st = mutate(channel.id, s => {
      rollDay(s);
      if (!s.since) s.since = new Date(nowMs - FIRST_LOOKBACK_H * 3.6e6).toISOString();
    });
    const me = acc.username;
    const media = await graph("GET", `${acc.igId}/media`, acc.token, { fields: "id,caption,timestamp,permalink,comments_count", limit: "20" });
    const recent = (media.data || []).filter(m => m.comments_count > 0 && nowMs - Date.parse(m.timestamp) < MEDIA_DAYS * 864e5);
    let list = [];
    for (const m of recent) {
      const cs = await graph("GET", `${m.id}/comments`, acc.token, { fields: "id,text,username,timestamp,replies{id,username,text,timestamp}", limit: "50" });
      list = list.concat(candidates(m, cs.data || [], { me, handled: st.handled || [], sinceMs: Date.parse(st.since), nowMs }));
    }
    let replied = 0, skipped = 0, calls = 0;
    for (const c of list) {
      st = loadState()[channel.id] || {};
      const userKey = lc(c.username);
      const handled = (reason, action = "skip") => mutate(channel.id, s => {
        s.handled = [...(s.handled || []), String(c.id)].slice(-5000);
        pushLog(s, { action, to: c.username, comment: c.text.slice(0, 200), reason, permalink: c.permalink });
      });
      if ((st.sent_today || 0) >= cfg.max_per_day) break;
      const pre = preFilter(c.text);
      if (pre) { handled(pre); skipped++; continue; }
      if (c.our_count >= cfg.max_per_thread) { handled("thread limit"); skipped++; continue; }
      if (((st.per_user || {})[userKey] || 0) >= cfg.max_per_user) { handled("limit for this person today"); skipped++; continue; }
      if (calls >= MAX_CLAUDE_PER_CHECK) break; // rest next check
      calls++;
      const d = await decide(channel, cfg, c);
      if (d.action !== "reply") { handled(d.reason); skipped++; continue; }
      const text = finalText(d.text, c);
      try {
        const res = await graph("POST", `${c.parent_id}/replies`, acc.token, { message: text });
        mutate(channel.id, s => {
          rollDay(s);
          s.sent_today = (s.sent_today || 0) + 1;
          s.per_user = { ...(s.per_user || {}), [userKey]: ((s.per_user || {})[userKey] || 0) + 1 };
          s.handled = [...(s.handled || []), String(c.id)].slice(-5000);
          pushLog(s, { action: "replied", to: c.username, comment: c.text.slice(0, 200), text, reply_id: res.id || null, permalink: c.permalink });
        });
        replied++;
        log(`${channel.name}: answered @${c.username} (${c.id})`);
      } catch (e) {
        if (isPermissionError(e.message)) throw e;
        handled(`post failed: ${String(e.message).slice(0, 150)}`, "failed");
      }
    }
    return { checked: list.length, replied, skipped, media: recent.length };
  }

  async function tick() {
    if (busy) return;
    for (const channel of readChannels()) {
      if (channel.enabled === false) continue;
      const cfg = config(channel);
      if (!cfg.enabled || !cfg.account_id) continue;
      const st = loadState()[channel.id] || {};
      if (st.last_check && Date.now() - Date.parse(st.last_check) < cfg.interval_min * 60e3) continue;
      if (st.blocked_until && Date.parse(st.blocked_until) > Date.now()) continue;
      busy = { channel_id: channel.id, at: new Date().toISOString() };
      try {
        const r = await check(channel);
        mutate(channel.id, s => { s.last_check = new Date().toISOString(); s.last_result = r; s.last_error = null; s.errors = 0; s.needs_scope = false; });
      } catch (e) {
        const msg = String(e.message).slice(0, 300);
        const perm = isPermissionError(msg);
        const s = mutate(channel.id, x => {
          x.last_check = new Date().toISOString();
          x.last_error = msg;
          x.errors = (x.errors || 0) + 1;
          x.needs_scope = perm;
          // a missing permission does not fix itself: back off for 6 h
          if (perm) x.blocked_until = new Date(Date.now() + 6 * 3.6e6).toISOString();
        });
        log(`${channel.name}: ${msg}`);
        if (notify && (s.errors === 3 || (perm && s.errors === 1))) {
          notify(`⚠️ Instagram auto-replies (${channel.name}) ${perm ? "need permission" : "failed 3 times in a row"}`,
            (perm ? "Reconnect Meta in Settings and allow comment management. " : "") + msg.slice(0, 200).replace(/</g, "&lt;"), "warning");
        }
      } finally { busy = null; }
    }
  }

  async function runNow(channel) {
    if (busy) throw new Error("Instagram auto-replies are busy");
    busy = { channel_id: channel.id, at: new Date().toISOString() };
    try {
      const r = await check(channel);
      mutate(channel.id, s => { s.last_check = new Date().toISOString(); s.last_result = r; s.last_error = null; s.errors = 0; s.needs_scope = false; s.blocked_until = null; });
      return r;
    } catch (e) {
      mutate(channel.id, s => { s.last_error = String(e.message).slice(0, 300); s.needs_scope = isPermissionError(e.message); });
      throw e;
    } finally { busy = null; }
  }

  function status(channel) {
    const s = loadState()[channel.id] || {};
    const cfg = config(channel);
    const today = s.day === localDay(new Date(), tz);
    return {
      config: cfg,
      sent_today: today ? (s.sent_today || 0) : 0,
      last_check: s.last_check || null,
      last_result: s.last_result || null,
      last_error: s.last_error || null,
      needs_scope: !!s.needs_scope,
      next_check: s.last_check ? new Date(Date.parse(s.last_check) + cfg.interval_min * 60e3).toISOString() : null,
      log: (s.log || []).slice(0, 15),
      running: !!(busy && busy.channel_id === channel.id),
    };
  }

  return { tick, runNow, status, busy: () => busy };
}

module.exports = { createIgReplies, DEFAULTS, MODEL, config, sanitize, candidates, finalText, isPermissionError };
