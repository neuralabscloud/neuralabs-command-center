// ── X ENGAGE (review) ─────────────────────────
// Per X channel with engage.enabled: a few times a day, spread over a window,
// find a fresh viral or interesting post in the channel's niche (the topics and
// curated accounts of the autopilot), let Claude pick the best one and write a
// reply that adds something, and send it to Telegram as a review card.
// Nothing is posted until a human taps Approve (X automation rules do not allow
// automated replies to people based on keyword searches; a human in the loop is
// what keeps this allowed). Pending proposals expire after a few hours.
// State lives in data/community/engage-state.json.

const fs = require("fs");
const path = require("path");
const { parseTopics, parseAccounts, accountTopics, scoreTweet, isPromo } = require("./social-autopilot");
const { cleanReply, localDay } = require("./x-replies");

const DEFAULTS = {
  enabled: false,
  per_day: 6,             // proposals per day
  window_start: "09:00",
  window_end: "22:00",
  min_likes: 100,         // curated accounts need a quarter of this
  min_followers: 2000,    // curated accounts: no minimum
  max_age_hours: 8,
  expire_hours: 6,        // unanswered proposals expire (a late reply on a viral post is useless)
  language: "",           // empty = language of the post
};
const MODEL = process.env.X_ENGAGE_MODEL || process.env.X_REPLIES_MODEL || process.env.SOCIAL_AUTOPILOT_MODEL || "claude-sonnet-5-5";
const MAX_PENDING = 3;            // no new proposals while this many wait for a decision
const TOPICS_PER_RUN = 2;         // searches per run
const SEARCH_RESULTS = 15;
const SHORTLIST = 5;
const AUTHOR_COOLDOWN_H = 72;     // do not reply to the same person again within 3 days
const RETRY_EMPTY_MIN = 30;       // nothing usable found: try again after this
const MAX_REPLY_LEN = 240;
const LOG_MAX = 40;
const QUERY_MAX = 512;

// ── pure helpers (exported for tests) ─────────
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function config(channel) {
  const c = { ...DEFAULTS, ...(channel && channel.engage || {}) };
  const int = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v) || d)));
  c.enabled = !!c.enabled;
  c.per_day = int(c.per_day, 1, 30, DEFAULTS.per_day);
  c.window_start = HHMM.test(c.window_start) ? c.window_start : DEFAULTS.window_start;
  c.window_end = HHMM.test(c.window_end) ? c.window_end : DEFAULTS.window_end;
  c.min_likes = int(c.min_likes, 0, 1e6, DEFAULTS.min_likes);
  if (Number(channel && channel.engage && channel.engage.min_likes) === 0) c.min_likes = 0;
  c.min_followers = Math.min(1e8, Math.max(0, Math.round(Number(c.min_followers))));
  if (!Number.isFinite(c.min_followers)) c.min_followers = DEFAULTS.min_followers;
  c.max_age_hours = int(c.max_age_hours, 1, 48, DEFAULTS.max_age_hours);
  c.expire_hours = int(c.expire_hours, 1, 48, DEFAULTS.expire_hours);
  c.language = String(c.language || "").replace(/[^\p{L} ()-]/gu, "").slice(0, 30);
  return c;
}

function sanitize(input) {
  const c = config({ engage: input && typeof input === "object" ? input : {} });
  const { enabled, per_day, window_start, window_end, min_likes, min_followers, max_age_hours, expire_hours, language } = c;
  return { enabled, per_day, window_start, window_end, min_likes, min_followers, max_age_hours, expire_hours, language };
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
function minutesNow(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}
function inWindow(cfg, nowMin) {
  const a = toMin(cfg.window_start), b = toMin(cfg.window_end);
  return a <= b ? nowMin >= a && nowMin < b : nowMin >= a || nowMin < b;
}
function minutesLeft(cfg, nowMin) {
  const b = toMin(cfg.window_end);
  return (b - nowMin + 1440) % 1440;
}

// Spread the remaining proposals over what is left of the window, with jitter.
function nextGapMs(cfg, nowMin, proposedToday, rand = Math.random) {
  const left = Math.max(1, cfg.per_day - proposedToday);
  const mins = Math.max(15, minutesLeft(cfg, nowMin) / left);
  return Math.round(mins * (0.6 + 0.8 * rand()) * 60e3);
}

function buildEngageQuery(query, ownUsername) {
  return `(${query}) -is:retweet -is:reply -is:nullcast lang:en -giveaway -airdrop -presale -whitelist -"free mint"${ownUsername ? ` -from:${ownUsername}` : ""}`;
}

// Topics in the order to search: the least searched today first; curated wins a tie.
function pickTopics(topics, counts = {}, n = TOPICS_PER_RUN, rand = Math.random) {
  return topics
    .map(t => ({ t, c: counts[t.label] || 0, cur: t.curated ? 0 : 1, r: rand() }))
    .sort((a, b) => a.c - b.c || a.cur - b.cur || a.r - b.r)
    .slice(0, n).map(x => x.t);
}

// Search response → usable posts, best first.
function rankPosts(resp, { nowMs, cfg, curated, seen = [], recentAuthors = {}, me }) {
  const users = new Map(((resp && resp.includes && resp.includes.users) || []).map(u => [u.id, u]));
  const seenSet = new Set(seen.map(String));
  const out = [];
  for (const t of (resp && resp.data) || []) {
    if (seenSet.has(String(t.id)) || t.possibly_sensitive) continue;
    if (t.reply_settings && t.reply_settings !== "everyone") continue; // we could not reply anyway
    const u = users.get(t.author_id) || {};
    const author = u.username || "";
    if (!author || (me && author.toLowerCase() === me.toLowerCase())) continue;
    const last = recentAuthors[author.toLowerCase()];
    if (last && nowMs - Date.parse(last) < AUTHOR_COOLDOWN_H * 3.6e6) continue;
    const m = t.public_metrics || {};
    if ((m.like_count || 0) < (curated ? Math.floor(cfg.min_likes / 4) : cfg.min_likes)) continue;
    const followers = u.public_metrics && u.public_metrics.followers_count;
    if (!curated && cfg.min_followers && followers != null && followers < cfg.min_followers) continue;
    if (nowMs - Date.parse(t.created_at || 0) > cfg.max_age_hours * 3.6e6) continue;
    if (isPromo(t.text)) continue;
    out.push({
      tweet_id: String(t.id), author, author_name: u.name || "", followers: followers || 0,
      text: String(t.text || ""), created_at: t.created_at, lang: t.lang || null,
      metrics: { likes: m.like_count || 0, reposts: m.retweet_count || 0, replies: m.reply_count || 0, views: m.impression_count || 0 },
      score: scoreTweet(t, nowMs),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

const compact = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(n || 0);
const escHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cardText(channel, p) {
  const ageH = Math.max(0, (Date.now() - Date.parse(p.created_at || Date.now())) / 3.6e6);
  return [
    `🔥 <b>Reply proposal · ${escHtml(channel.name)}</b>${p.topic ? ` · ${escHtml(p.topic)}` : ""}`,
    `@${escHtml(p.author)} (${compact(p.followers)} followers) · ❤ ${compact(p.metrics.likes)} · 🔁 ${compact(p.metrics.reposts)} · 💬 ${compact(p.metrics.replies)} · ${ageH < 1 ? Math.round(ageH * 60) + " min" : ageH.toFixed(1) + " h"} old`,
    "",
    `<i>${escHtml(p.their_text.slice(0, 700))}</i>`,
    "",
    `💬 <b>Our reply</b> (tap to copy):`,
    `<code>${escHtml(p.text)}</code>`,
    "",
    `<a href="${escHtml(p.url)}">Open the post on X</a> · expires in ${p.expire_hours} h`,
    `📲 opens X with this reply ready${p.as ? ` (be logged in as <b>@${escHtml(p.as)}</b>)` : ""}, tap Reply there, then ✔ Done here.`,
    `Empty screen in X? Tap the reply above to copy it, tap 🔗 Open post, reply there and paste.`,
  ].join("\n");
}

// X's API refuses replies to posts that don't mention us, so the reply is posted by hand
// through X's own compose screen, pre-filled with the text and the post to reply to.
const intentUrl = (p, text) => `https://x.com/intent/post?in_reply_to=${encodeURIComponent(p.tweet_id)}&text=${encodeURIComponent(text != null ? text : p.text || "")}`;

const keyboard = (channelId, p) => ({
  inline_keyboard: [
    [{ text: "📲 Reply on X (pre-filled)", url: intentUrl(p) }, { text: "🔗 Open post", url: p.url || `https://x.com/i/status/${p.tweet_id}` }],
    [
      { text: "✔ Done", callback_data: `xe:ok:${channelId}:${p.id}` },
      { text: "❌ Skip", callback_data: `xe:no:${channelId}:${p.id}` },
      { text: "✏ Edit", callback_data: `xe:ed:${channelId}:${p.id}` },
    ],
  ],
});

// ── runtime ───────────────────────────────────
function createEngage(deps) {
  const {
    dataDir, tz, readChannels, twitterApi, twitterCredsFor, twitterVerify, twitterWeightedLength,
    anthropic, brandKnowledge, tg, chatId, notify,
    log = (m) => console.log("[X-ENGAGE]", m),
  } = deps;
  const stateFile = path.join(dataDir, "community", "engage-state.json");
  const editState = new Map(); // telegram chat → { channelId, pid }
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
    if (st.day !== day) { st.day = day; st.proposed_today = 0; st.posted_today = 0; st.topic_counts = {}; st.next_at = null; }
  }
  const channelById = (id) => readChannels().find(c => c.id === id);

  async function me(channel, creds) {
    const st = loadState()[channel.id] || {};
    if (st.me && st.me.fingerprint === creds.fingerprint && Date.now() - Date.parse(st.me.at) < 864e5) return st.me;
    const u = await twitterVerify(creds);
    const m = { id: u.id, username: u.username, fingerprint: creds.fingerprint, at: new Date().toISOString() };
    mutate(channel.id, s => { s.me = m; });
    return m;
  }

  function topicsOf(channel, username) {
    const ap = channel.autopilot || {};
    return [...accountTopics(parseAccounts(ap.accounts), username), ...parseTopics(ap.topics)]
      .filter(t => buildEngageQuery(t.query, username).length <= QUERY_MAX);
  }

  async function search(creds, topic, cfg, m, st) {
    const params = new URLSearchParams({
      query: buildEngageQuery(topic.query, m.username),
      max_results: String(SEARCH_RESULTS),
      sort_order: "relevancy",
      start_time: new Date(Date.now() - cfg.max_age_hours * 3.6e6).toISOString().replace(/\.\d+Z$/, "Z"),
      expansions: "author_id",
      "tweet.fields": "public_metrics,created_at,possibly_sensitive,reply_settings,lang",
      "user.fields": "username,name,public_metrics",
    });
    const resp = await twitterApi("GET", `https://api.x.com/2/tweets/search/recent?${params}`, creds);
    return rankPosts(resp, { nowMs: Date.now(), cfg, curated: !!topic.curated, seen: st.seen || [], recentAuthors: st.authors || {}, me: m.username })
      .map(p => ({ ...p, topic: topic.label }));
  }

  async function write(channel, cfg, shortlist) {
    const ap = channel.autopilot || {};
    const voice = ap.voice || "a knowledgeable account in its niche";
    const tool = {
      name: "submit_engage",
      description: "Pick one post and write our reply, or skip all of them.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          choice: { type: "integer", description: "Number of the chosen post, or -1 to skip all." },
          text: { type: "string", description: `Our reply, max ${MAX_REPLY_LEN} characters. Empty when skipping.` },
          reason: { type: "string", description: "One short sentence: why this post and this reply (or why skip)." },
        },
        required: ["choice", "text", "reason"],
        additionalProperties: false,
      },
    };
    const list = shortlist.map((p, i) => `[${i}] @${p.author} (${p.followers} followers, ${p.metrics.likes} likes, ${p.metrics.replies} replies, topic ${p.topic}):\n${p.text.replace(/\s+/g, " ").slice(0, 600)}`).join("\n\n");
    const prompt = `You do the community engagement of an X account. Voice: ${voice}
${brandKnowledge ? brandKnowledge(channel) : ""}

Below are fresh, popular posts from our niche. Pick the ONE where a reply from us adds the most and is most likely to be seen (popular, fresh, a real point or question we can add to). Then write that reply. A human reviews it before it is posted. Always answer by calling the submit_engage tool.

${list}

Rules for the reply:
- Add something: a sharp observation, context, a relevant point from the post, a good follow-up question, or a light take. Like a real person from the community, not a brand.
- No generic praise ("Great post!", "This!", "So true"). No self-promotion: never mention our account, product, links or "check our page".
- 1 to 2 sentences, max ${MAX_REPLY_LEN} characters. ${cfg.language ? `Write in ${cfg.language}.` : "Write in the language of the post."}
- NEVER use em dashes or en dashes. No links, no hashtags, at most 1 emoji. Do not start with their @handle.
- Only state facts that are in the post or the account knowledge above. Never invent numbers, prices, dates or news.
- No financial advice, no price predictions, no promises.
- Choose -1 (skip all) when every post is politics, a tragedy, drama or a fight, a scam or shill, sexual, or when we have nothing useful to add.`;

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
          messages.push({ role: "user", content: "Answer only by calling the submit_engage tool." });
          continue;
        }
        return { choice: -1, reason: "model gave no answer" };
      }
      const out = use.input || {};
      const choice = Number.isInteger(out.choice) ? out.choice : -1;
      if (choice < 0 || choice >= shortlist.length) return { choice: -1, reason: out.reason || "skipped" };
      const text = cleanReply(out.text);
      const len = twitterWeightedLength(text);
      if (text && len <= 280) return { choice, text, reason: out.reason || "" };
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: `Too long (${len}) or empty. Resubmit, max ${MAX_REPLY_LEN} characters.`, is_error: true }] });
    }
    return { choice: -1, reason: "reply stayed too long" };
  }

  function pushLog(st, entry) {
    st.log = [{ at: new Date().toISOString(), ...entry }, ...(st.log || [])].slice(0, LOG_MAX);
  }

  async function sendCard(channel, p) {
    if (!tg || !chatId) return null;
    const r = await tg("sendMessage", { chat_id: chatId, text: cardText(channel, p), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard(channel.id, p) });
    return r && r.ok && r.result ? r.result.message_id : null;
  }
  async function closeCard(p, label, url) {
    if (!tg || !chatId || !p.tg_msg_id) return;
    const btn = url ? { text: label, url } : { text: label, callback_data: "xe:noop" };
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: p.tg_msg_id, reply_markup: { inline_keyboard: [[btn]] } }).catch(() => {});
  }

  // One run: search → shortlist → Claude → proposal + Telegram card.
  async function find(channel, { manual = false } = {}) {
    const cfg = config(channel);
    const creds = twitterCredsFor(channel);
    const m = await me(channel, creds);
    let st = mutate(channel.id, s => { rollDay(s); });
    const topics = pickTopics(topicsOf(channel, m.username), st.topic_counts || {});
    if (!topics.length) throw new Error("no topics or curated accounts on the autopilot of this channel");

    let pool = [];
    for (const t of topics) {
      pool = pool.concat(await search(creds, t, cfg, m, st));
      mutate(channel.id, s => { s.topic_counts = { ...(s.topic_counts || {}), [t.label]: ((s.topic_counts || {})[t.label] || 0) + 1 }; });
    }
    const uniq = new Map();
    for (const p of pool.sort((a, b) => b.score - a.score)) if (!uniq.has(p.tweet_id)) uniq.set(p.tweet_id, p);
    const shortlist = [...uniq.values()].slice(0, SHORTLIST);
    const topicNames = topics.map(t => t.label).join(", ");
    const nowMin = minutesNow(new Date(), tz);

    if (!shortlist.length) {
      mutate(channel.id, s => {
        s.next_at = new Date(Date.now() + RETRY_EMPTY_MIN * 60e3).toISOString();
        pushLog(s, { action: "none", reason: `nothing usable in ${topicNames}` });
      });
      return { proposed: false, reason: "nothing usable found" };
    }

    const d = await write(channel, cfg, shortlist);
    mutate(channel.id, s => { s.seen = [...(s.seen || []), ...shortlist.map(p => p.tweet_id)].slice(-3000); });
    if (d.choice < 0) {
      mutate(channel.id, s => {
        s.next_at = new Date(Date.now() + RETRY_EMPTY_MIN * 60e3).toISOString();
        pushLog(s, { action: "none", reason: `skipped ${shortlist.length} posts (${topicNames}): ${d.reason}` });
      });
      return { proposed: false, reason: d.reason };
    }

    const c = shortlist[d.choice];
    const p = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      status: "pending", created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + cfg.expire_hours * 3.6e6).toISOString(), expire_hours: cfg.expire_hours,
      tweet_id: c.tweet_id, url: `https://x.com/${c.author}/status/${c.tweet_id}`, conversation_id: c.tweet_id,
      author: c.author, author_name: c.author_name, followers: c.followers, metrics: c.metrics, created_at_post: c.created_at,
      their_text: c.text.slice(0, 1000), topic: c.topic, text: d.text, reason: d.reason, manual, as: m.username || null,
    };
    const tgId = await sendCard(channel, { ...p, created_at: c.created_at }).catch(e => { log(`telegram card failed: ${e.message}`); return null; });
    p.tg_msg_id = tgId;
    mutate(channel.id, s => {
      rollDay(s);
      s.proposed_today = (s.proposed_today || 0) + 1;
      s.next_at = new Date(Date.now() + nextGapMs(cfg, nowMin, s.proposed_today)).toISOString();
      s.proposals = [p, ...(s.proposals || [])].slice(0, 200);
      s.authors = { ...(s.authors || {}), [c.author.toLowerCase()]: new Date().toISOString() };
    });
    log(`${channel.name}: proposal ${p.id} → @${c.author} (${c.tweet_id})`);
    return { proposed: true, proposal: p };
  }

  function getProposal(channelId, pid) {
    return ((loadState()[channelId] || {}).proposals || []).find(p => p.id === pid) || null;
  }
  function update(channelId, pid, patch) {
    return mutate(channelId, s => {
      const p = (s.proposals || []).find(x => x.id === pid);
      if (p) Object.assign(p, patch);
      return p ? { ...p } : null;
    });
  }

  // Find the reply we just posted by hand (for the link + so auto-replies can follow it up).
  async function findOurReply(channel, creds, username, p) {
    try {
      const q = encodeURIComponent(`from:${username} conversation_id:${p.conversation_id || p.tweet_id}`);
      const r = await twitterApi("GET", `https://api.x.com/2/tweets/search/recent?query=${q}&max_results=10&tweet.fields=referenced_tweets,created_at`, creds);
      const hit = ((r && r.data) || []).find(t => (t.referenced_tweets || []).some(x => x.type === "replied_to" && x.id === p.tweet_id));
      return hit ? hit.id : null;
    } catch (e) { log(`find own reply: ${e.message}`); return undefined; }
  }

  // Done: the reply was posted by hand via the pre-filled X link. Text = the version used.
  async function approve(channelId, pid, text, force = false) {
    const channel = channelById(channelId);
    if (!channel) throw new Error("channel not found");
    const p = getProposal(channelId, pid);
    if (!p) throw new Error("proposal not found");
    if (p.status !== "pending") throw new Error(`already ${p.status}`);
    const body = text != null ? cleanReply(text) : p.text;
    if (!body) throw new Error("empty reply");
    update(channelId, pid, { status: "posting" });
    const creds = twitterCredsFor(channel);
    let id = null, username = p.as, looked = false;
    try { const m = await me(channel, creds); username = m.username; id = await findOurReply(channel, creds, m.username, p); looked = id !== undefined; id = id || null; } catch (e) { log(`done lookup: ${e.message}`); }
    if (looked && !id && !force) {
      update(channelId, pid, { status: "pending" });
      throw new Error(`no reply from @${username} found on X yet. Post it first (or wait a few seconds), then tap Done again`);
    }
    const url = id ? `https://x.com/${username}/status/${id}` : null;
    const done = mutate(channelId, s => {
      rollDay(s);
      s.posted_today = (s.posted_today || 0) + 1;
      const q = (s.proposals || []).find(x => x.id === pid);
      Object.assign(q, { status: "posted", text: body, reply_id: id, reply_url: url, posted_by_hand: true, decided_at: new Date().toISOString(), error: null });
      pushLog(s, { action: "posted", to: p.author, tweet_id: p.tweet_id, text: body });
      return { ...q };
    });
    await closeCard(done, url ? "✅ Posted · open on X" : "✔ Done", url);
    log(`${channel.name}: reply to @${p.author} marked done${id ? ` (${id})` : ""}`);
    return done;
  }

  async function skip(channelId, pid) {
    const p = getProposal(channelId, pid);
    if (!p) throw new Error("proposal not found");
    if (p.status !== "pending") throw new Error(`already ${p.status}`);
    const done = update(channelId, pid, { status: "skipped", decided_at: new Date().toISOString() });
    mutate(channelId, s => pushLog(s, { action: "skipped", to: p.author, tweet_id: p.tweet_id }));
    await closeCard(done, "❌ Skipped");
    return done;
  }

  async function expireOld() {
    const all = loadState();
    for (const [channelId, st] of Object.entries(all)) {
      for (const p of st.proposals || []) {
        if (p.status !== "pending" || Date.parse(p.expires_at) > Date.now()) continue;
        const done = update(channelId, p.id, { status: "expired", decided_at: new Date().toISOString() });
        await closeCard(done, "⌛ Expired");
      }
    }
  }

  // Telegram button → true when handled.
  async function handleCallback(cq) {
    const data = String(cq.data || "");
    if (!data.startsWith("xe:")) return false;
    const [, action, channelId, pid] = data.split(":");
    const answer = (text, alert) => tg("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: !!alert });
    if (action === "noop") { await answer(); return true; }
    try {
      if (action === "ok") {
        await approve(channelId, pid);
        await answer("✔ Marked as done");
      } else if (action === "no") {
        await skip(channelId, pid);
        await answer("❌ Skipped");
      } else if (action === "ed") {
        const p = getProposal(channelId, pid);
        if (!p || p.status !== "pending") { await answer(p ? `Already ${p.status}` : "Not found", true); return true; }
        editState.set(String(cq.message && cq.message.chat && cq.message.chat.id || chatId), { channelId, pid, at: Date.now() });
        await answer("Send the new reply text");
        await tg("sendMessage", { chat_id: chatId, text: `✏ Send the new reply to @${p.author} as a message. /cancel to stop.\n\nCurrent:\n${p.text}` });
      } else await answer();
    } catch (e) {
      await answer(`⚠ ${String(e.message).slice(0, 190)}`, true).catch(() => {});
    }
    return true;
  }

  // Telegram text while an edit is open → true when consumed.
  async function handleText(fromChat, text) {
    const e = editState.get(String(fromChat));
    if (!e) return false;
    editState.delete(String(fromChat));
    if (Date.now() - e.at > 30 * 60e3) return false;
    if (text === "/cancel") { await tg("sendMessage", { chat_id: chatId, text: "Edit cancelled." }); return true; }
    const p = getProposal(e.channelId, e.pid);
    const channel = channelById(e.channelId);
    if (!p || !channel || p.status !== "pending") { await tg("sendMessage", { chat_id: chatId, text: "That proposal is no longer open." }); return true; }
    const body = cleanReply(text);
    const len = twitterWeightedLength(body);
    if (!body || len > 280) { await tg("sendMessage", { chat_id: chatId, text: `Too long (${len}/280). Tap ✏ Edit again.` }); return true; }
    await closeCard(p, "✏ Edited (see below)");
    const tgId = await sendCard(channel, { ...p, text: body, created_at: p.created_at_post || p.created_at });
    update(e.channelId, e.pid, { text: body, tg_msg_id: tgId, edited: true });
    return true;
  }

  async function tick() {
    if (busy) return;
    await expireOld().catch(e => log(`expire: ${e.message}`));
    const nowMin = minutesNow(new Date(), tz);
    for (const channel of readChannels()) {
      if (channel.platform !== "twitter" || channel.enabled === false) continue;
      const cfg = config(channel);
      if (!cfg.enabled || !inWindow(cfg, nowMin)) continue;
      const st = mutate(channel.id, s => { rollDay(s); });
      if ((st.proposed_today || 0) >= cfg.per_day) continue;
      if ((st.proposals || []).filter(p => p.status === "pending").length >= MAX_PENDING) continue;
      if (st.next_at && Date.parse(st.next_at) > Date.now()) continue;
      if (!st.next_at) {
        // first time today: start at a random moment within the first gap, not right away
        mutate(channel.id, s => { s.next_at = new Date(Date.now() + nextGapMs(cfg, nowMin, 0) * Math.random()).toISOString(); });
        continue;
      }
      busy = { channel_id: channel.id, at: new Date().toISOString() };
      try {
        await find(channel);
        mutate(channel.id, s => { s.last_run = new Date().toISOString(); s.last_error = null; s.errors = 0; });
      } catch (e) {
        const s = mutate(channel.id, x => {
          x.last_run = new Date().toISOString();
          x.last_error = String(e.message).slice(0, 300);
          x.errors = (x.errors || 0) + 1;
          x.next_at = new Date(Date.now() + RETRY_EMPTY_MIN * 60e3).toISOString();
        });
        log(`${channel.name}: ${e.message}`);
        if (s.errors === 3 && notify) notify(`⚠️ X engage (${channel.name}) failed 3 times in a row`, String(e.message).slice(0, 200).replace(/</g, "&lt;"), "warning");
      } finally {
        busy = null;
      }
    }
  }

  async function runNow(channel) {
    if (busy) throw new Error("Engage is busy");
    busy = { channel_id: channel.id, at: new Date().toISOString() };
    try {
      const r = await find(channel, { manual: true });
      mutate(channel.id, s => { s.last_run = new Date().toISOString(); s.last_error = null; });
      return r;
    } finally { busy = null; }
  }

  function status(channel) {
    const s = loadState()[channel.id] || {};
    const today = s.day === localDay(new Date(), tz);
    const props = s.proposals || [];
    return {
      config: config(channel),
      username: s.me && s.me.username || null,
      proposed_today: today ? (s.proposed_today || 0) : 0,
      posted_today: today ? (s.posted_today || 0) : 0,
      next_at: s.next_at || null,
      last_run: s.last_run || null,
      last_error: s.last_error || null,
      pending: props.filter(p => p.status === "pending"),
      recent: props.filter(p => p.status !== "pending").slice(0, 10),
      log: (s.log || []).slice(0, 15),
      running: !!(busy && busy.channel_id === channel.id),
    };
  }

  // Our posted engage replies: x-replies uses these to answer people who react to them.
  function ourReplies(channel) {
    return ((loadState()[channel.id] || {}).proposals || [])
      .filter(p => p.status === "posted" && p.reply_id)
      .map(p => ({ id: p.reply_id, conversation_id: p.conversation_id, text: p.text, to_text: p.their_text.slice(0, 280), to_author: p.author, at: p.decided_at }));
  }

  return { tick, runNow, status, approve, skip, handleCallback, handleText, ourReplies, busy: () => busy };
}

module.exports = {
  createEngage, DEFAULTS, MODEL, config, sanitize, inWindow, minutesLeft, nextGapMs, buildEngageQuery,
  pickTopics, rankPosts, cardText, keyboard, compact, intentUrl,
};
