// ── X AUTO-REPLIES ────────────────────────────
// Per X channel with replies.enabled: every few minutes look for new replies
// to our own posts (search "to:<me> is:reply", since_id so nothing is read
// twice), let Claude decide per reply whether to answer, and answer in the same
// thread with the context of our post. Spam, bots, trolls and scams are skipped.
// Limits: max per day, max of our replies per conversation, max per person.
// State (since_id, counts, recent log) lives in data/community/replies-state.json.

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  enabled: false,
  max_per_day: 20,
  max_per_thread: 3,      // our replies to one person in one conversation
  max_per_author: 3,      // our replies per person per day
  interval_min: 10,
  language: "",           // empty = answer in the language of the reply
};
const MODEL = process.env.X_REPLIES_MODEL || process.env.SOCIAL_AUTOPILOT_MODEL || "claude-sonnet-5-5";
const MAX_PER_TICK = 6;           // Claude calls per channel per check
const FIRST_LOOKBACK_H = 6;       // first run: only replies of the last hours
const OUR_POSTS_DAYS = 7;         // search/recent only reaches 7 days back
const MAX_REPLY_LEN = 240;
const LOG_MAX = 40;
const SPAM_RE = /\b(giveaways?|airdrops?|presales?|whitelist|free mint|claim (now|your)|dm (me|us)|check (my|your) (dm|inbox)|link in (my )?bio|telegram group|whatsapp|discord\.gg|referral|promo code|onlyfans|crypto recovery|recover (your )?(funds|wallet)|\d{3,}x|100x|send me|wallet address)\b/i;
const CA_RE = /\b(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/;

// ── pure helpers (exported for tests) ─────────
function config(channel) {
  const c = { ...DEFAULTS, ...(channel && channel.replies || {}) };
  c.enabled = !!c.enabled;
  c.max_per_day = Math.min(100, Math.max(1, Math.round(Number(c.max_per_day) || DEFAULTS.max_per_day)));
  c.max_per_thread = Math.min(10, Math.max(1, Math.round(Number(c.max_per_thread) || DEFAULTS.max_per_thread)));
  c.max_per_author = Math.min(10, Math.max(1, Math.round(Number(c.max_per_author) || DEFAULTS.max_per_author)));
  c.interval_min = Math.min(120, Math.max(5, Math.round(Number(c.interval_min) || DEFAULTS.interval_min)));
  c.language = String(c.language || "").replace(/[^\p{L} ()-]/gu, "").slice(0, 30);
  return c;
}

function sanitize(input) {
  const c = config({ replies: input && typeof input === "object" ? input : {} });
  return { enabled: c.enabled, max_per_day: c.max_per_day, max_per_thread: c.max_per_thread, max_per_author: c.max_per_author, interval_min: c.interval_min, language: c.language };
}

function buildReplyQuery(username) {
  return `to:${username} is:reply -from:${username} -is:retweet`;
}

// Cheap filter before Claude: no letters, links/contract addresses, spam phrases.
function preFilter(text) {
  const t = String(text || "").replace(/(^|\s)@\w+/g, " ").trim();
  if (!/\p{L}{2,}/u.test(t)) return "no words (emoji/tag only)";
  if (/https?:\/\/\S+/i.test(t)) return "contains a link";
  if (CA_RE.test(t)) return "contains an address";
  if (SPAM_RE.test(t)) return "spam phrase";
  return null;
}

// Search response → replies to one of our tweets, oldest first.
function parseReplies(resp, { meId, ourIds }) {
  const users = new Map(((resp && resp.includes && resp.includes.users) || []).map(u => [u.id, u]));
  return ((resp && resp.data) || [])
    .map(t => {
      const parent = (t.referenced_tweets || []).find(r => r.type === "replied_to");
      const u = users.get(t.author_id) || {};
      return {
        id: t.id, text: String(t.text || ""), conversation_id: t.conversation_id, author_id: t.author_id,
        author: u.username || null, author_name: u.name || "", author_bio: String(u.description || "").slice(0, 200),
        followers: (u.public_metrics && u.public_metrics.followers_count) || 0,
        parent_id: parent ? parent.id : null, created_at: t.created_at, lang: t.lang || null,
      };
    })
    .filter(r => r.author_id !== meId && r.parent_id && ourIds.has(r.parent_id))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

function cleanReply(text) {
  return String(text || "")
    .replace(/\s*[—–]\s*(\S)?/g, (_, c) => ". " + (c ? c.toUpperCase() : ""))
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|\s)#\w+/g, "$1")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^(@\w+\s*)+/, "")          // X adds the mention itself
    .replace(/\.\s*\./g, ".")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function localDay(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// One back-and-forth = one conversation with one person.
const threadKey = (r) => `${r.conversation_id}:${r.author_id}`;

// Which limit (if any) stops a reply to this person in this thread.
function limitHit(st, cfg, r) {
  if ((st.count_today || 0) >= cfg.max_per_day) return "daily max reached";
  if (((st.threads || {})[threadKey(r)] || 0) >= cfg.max_per_thread) return "thread max reached";
  if (((st.authors_today || {})[r.author_id] || 0) >= cfg.max_per_author) return "max per person today";
  return null;
}

// ── runtime ───────────────────────────────────
function createReplies(deps) {
  const {
    dataDir, tz, readChannels, readTasks, twitterApi, twitterCredsFor, twitterVerify,
    twitterWeightedLength, anthropic, brandKnowledge, autopilotConfig, notify,
    log = (m) => console.log("[X-REPLIES]", m),
  } = deps;
  const stateFile = path.join(dataDir, "community", "replies-state.json");
  let busy = null;

  function loadState() {
    try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; }
  }
  function mutate(channelId, fn) {
    const all = loadState();
    const st = all[channelId] || {};
    fn(st);
    all[channelId] = st;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, stateFile);
    return st;
  }
  function rollDay(st) {
    const day = localDay(new Date(), tz);
    if (st.day !== day) { st.day = day; st.count_today = 0; st.authors_today = {}; }
  }

  // Our tweets that people can reply to: published posts (last 7 days) + our own replies.
  function ourTweets(channel, st) {
    const map = new Map();
    const cutoff = Date.now() - OUR_POSTS_DAYS * 864e5;
    for (const t of readTasks()) {
      if (t.channel_id !== channel.id || t.status !== "published" || !t.message_id) continue;
      if (Date.parse(t.published_at || t.created_at || 0) < cutoff) continue;
      map.set(String(t.message_id), { kind: "post", text: t.text || "", source: t.source && t.source.text || "", root: String(t.message_id) });
    }
    for (const o of st.ours || []) map.set(o.id, { kind: "reply", text: o.text, root: o.conversation_id, to_text: o.to_text, to_author: o.to_author });
    // replies we placed elsewhere (x-engage): answer people who react to those too
    for (const o of (deps.extraOurTweets ? deps.extraOurTweets(channel) : []) || []) {
      if (!o || !o.id || Date.parse(o.at || 0) < cutoff) continue;
      if (!map.has(String(o.id))) map.set(String(o.id), { kind: "reply", text: o.text, root: o.conversation_id, to_text: o.to_text, to_author: o.to_author });
    }
    return map;
  }

  async function me(channel, creds) {
    const st = loadState()[channel.id] || {};
    if (st.me && st.me.fingerprint === creds.fingerprint && Date.now() - Date.parse(st.me.at) < 864e5) return st.me;
    const u = await twitterVerify(creds);
    const m = { id: u.id, username: u.username, fingerprint: creds.fingerprint, at: new Date().toISOString() };
    mutate(channel.id, s => { s.me = m; });
    return m;
  }

  async function decide(channel, cfg, r, ours, rootPost) {
    const ap = autopilotConfig ? autopilotConfig(channel) : {};
    const voice = ap.voice || "a knowledgeable account in its niche";
    const thread = [];
    if (rootPost) thread.push(`Our post: ${rootPost.text}`);
    const parent = ours.get(r.parent_id);
    if (parent && parent.kind === "reply") {
      if (parent.to_text) thread.push(`@${parent.to_author || "someone"}: ${parent.to_text}`);
      thread.push(`Our reply: ${parent.text}`);
    }
    const tool = {
      name: "submit_reply",
      description: "Answer the reply, or skip it.",
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
    const prompt = `You run the replies of an X account. Voice: ${voice}
${brandKnowledge ? brandKnowledge(channel) : ""}

Someone replied to us. Decide whether to answer and, if so, write the answer. Always answer by calling the submit_reply tool.

Thread so far:
${thread.join("\n")}
${rootPost && rootPost.source ? `\n(Background only, the post we wrote ours about, the reader may not have seen it: ${rootPost.source.replace(/\s+/g, " ").slice(0, 300)})\n` : ""}
New reply from @${r.author || "user"}${r.author_name ? ` (${r.author_name})` : ""}, ${r.followers} followers${r.author_bio ? `, bio: ${r.author_bio.replace(/\s+/g, " ")}` : ""}:
"""
${r.text}
"""

Skip (action "skip") when the reply is: spam, a bot, a scam or shill, a giveaway, "check your DM", only emojis or tags, a troll or insult, political, sexual, asking for money or personal data, or when there is nothing useful to add (a plain "nice" or "agreed" may get a short warm thanks, but skipping is fine too).

Rules for a reply:
- Stay in the context of our post and the thread. Answer their actual point or question, like a real person from the community. Short: 1 to 2 sentences, max ${MAX_REPLY_LEN} characters.
- ${cfg.language ? `Write in ${cfg.language}.` : "Write in the language of their reply."}
- NEVER use em dashes or en dashes. No links, no hashtags, at most 1 emoji. Do not start with their @handle.
- Only state facts that are in our post, the background or the account knowledge above. Never invent numbers, prices, dates or features. If you do not know, say so honestly or ask them back.
- No financial advice, no price predictions, no promises. Do not promote products unless they ask about them.
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
      out.text = cleanReply(out.text);
      const len = twitterWeightedLength(out.text);
      if (out.text && len <= 280) return out;
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: `Too long (${len}). Resubmit, max ${MAX_REPLY_LEN} characters.`, is_error: true }] });
    }
    return { action: "skip", text: "", reason: "reply stayed too long" };
  }

  function pushLog(st, entry) {
    st.log = [{ at: new Date().toISOString(), ...entry }, ...(st.log || [])].slice(0, LOG_MAX);
  }

  async function check(channel) {
    const cfg = config(channel);
    const creds = twitterCredsFor(channel);
    const m = await me(channel, creds);
    let st = mutate(channel.id, s => { rollDay(s); });
    const ours = ourTweets(channel, st);
    if (!ours.size) { mutate(channel.id, s => { s.last_check = new Date().toISOString(); s.last_error = null; }); return { found: 0, replied: 0 }; }

    const params = new URLSearchParams({
      query: buildReplyQuery(m.username),
      max_results: "50",
      expansions: "author_id",
      "tweet.fields": "conversation_id,author_id,created_at,referenced_tweets,lang",
      "user.fields": "username,name,description,public_metrics",
    });
    if (st.since_id) params.set("since_id", st.since_id);
    else params.set("start_time", new Date(Date.now() - FIRST_LOOKBACK_H * 3.6e6).toISOString().replace(/\.\d+Z$/, "Z"));
    const resp = await twitterApi("GET", `https://api.x.com/2/tweets/search/recent?${params}`, creds);
    const newest = resp && resp.meta && resp.meta.newest_id;
    const replies = parseReplies(resp, { meId: m.id, ourIds: new Set(ours.keys()) });
    const done = new Set(st.handled || []);
    let replied = 0, calls = 0;

    for (const r of replies) {
      if (done.has(r.id)) continue;
      st = loadState()[channel.id] || st;
      const mark = (entry) => mutate(channel.id, s => {
        s.handled = [...(s.handled || []), r.id].slice(-3000);
        pushLog(s, { tweet_id: r.id, from: r.author, their_text: r.text.slice(0, 280), ...entry });
      });
      const limit = limitHit(st, cfg, r);
      if (limit) { if (limit === "daily max reached") break; mark({ action: "skip", reason: limit }); continue; }
      const pre = preFilter(r.text);
      if (pre) { mark({ action: "skip", reason: pre }); continue; }
      if (calls >= MAX_PER_TICK) break; // the rest waits for the next check (since_id stays behind)
      calls++;
      const root = ours.get(r.conversation_id) || ours.get((ours.get(r.parent_id) || {}).root);
      const d = await decide(channel, cfg, r, ours, root && root.kind === "post" ? root : null);
      if (d.action !== "reply") { mark({ action: "skip", reason: d.reason }); continue; }
      try {
        const res = await twitterApi("POST", "https://api.x.com/2/tweets", creds, { json: { text: d.text, reply: { in_reply_to_tweet_id: r.id } } });
        const id = res && res.data && res.data.id;
        replied++;
        mutate(channel.id, s => {
          rollDay(s);
          s.count_today = (s.count_today || 0) + 1;
          const k = threadKey(r);
          s.threads = Object.fromEntries(Object.entries({ ...(s.threads || {}), [k]: ((s.threads || {})[k] || 0) + 1 }).slice(-2000));
          s.authors_today = { ...(s.authors_today || {}), [r.author_id]: ((s.authors_today || {})[r.author_id] || 0) + 1 };
          if (id) s.ours = [...(s.ours || []), { id, conversation_id: r.conversation_id, text: d.text, to_text: r.text.slice(0, 280), to_author: r.author, at: new Date().toISOString() }].slice(-500);
        });
        mark({ action: "reply", text: d.text, reply_id: id || null, reason: d.reason });
        log(`${channel.name}: replied to @${r.author} (${r.id})`);
      } catch (e) {
        // X blocks some replies (the author limited who can reply, or the post is gone): skip, no alarm.
        if (/403|not allowed|restricted|deleted|not found|reply/i.test(e.message)) { mark({ action: "skip", reason: `X refused: ${e.message.slice(0, 120)}` }); continue; }
        throw e;
      }
    }
    // since_id only moves past what we have handled, so replies left over by MAX_PER_TICK come back next time.
    const pending = replies.filter(r => !(loadState()[channel.id]?.handled || []).includes(r.id));
    mutate(channel.id, s => {
      if (!pending.length && newest) s.since_id = newest;
      else if (pending.length) {
        const before = BigInt(pending[0].id) - 1n;
        if (!s.since_id || BigInt(s.since_id) < before) s.since_id = before.toString();
      }
      s.last_check = new Date().toISOString();
      s.last_error = null; s.errors = 0;
    });
    return { found: replies.length, replied };
  }

  async function tick() {
    if (busy) return;
    for (const channel of readChannels()) {
      if (channel.platform !== "twitter" || channel.enabled === false) continue;
      const cfg = config(channel);
      if (!cfg.enabled) continue;
      const st = loadState()[channel.id] || {};
      if (st.last_check && Date.now() - Date.parse(st.last_check) < cfg.interval_min * 60e3) continue;
      busy = { channel_id: channel.id, at: new Date().toISOString() };
      try {
        await check(channel);
      } catch (e) {
        const s = mutate(channel.id, x => {
          x.last_check = new Date().toISOString();
          x.last_error = String(e.message).slice(0, 300);
          x.errors = (x.errors || 0) + 1;
        });
        log(`${channel.name}: ${e.message}`);
        if (s.errors === 3 && notify) notify(`⚠️ X auto-replies (${channel.name}) failed 3 times in a row: ${String(e.message).slice(0, 200)}`);
      } finally {
        busy = null;
      }
    }
  }

  async function runNow(channel) {
    if (busy) throw new Error("Auto-replies are busy");
    busy = { channel_id: channel.id, at: new Date().toISOString() };
    try { return await check(channel); } finally { busy = null; }
  }

  function status(channel) {
    const s = loadState()[channel.id] || {};
    const today = s.day === localDay(new Date(), tz);
    return {
      config: config(channel),
      username: s.me && s.me.username || null,
      today: today ? (s.count_today || 0) : 0,
      last_check: s.last_check || null,
      last_error: s.last_error || null,
      log: (s.log || []).slice(0, 15),
      running: !!(busy && busy.channel_id === channel.id),
    };
  }

  return { tick, runNow, status, busy: () => busy };
}

module.exports = { createReplies, DEFAULTS, MODEL, config, sanitize, buildReplyQuery, preFilter, parseReplies, cleanReply, limitHit, localDay };
