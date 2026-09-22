// ── SOCIAL MEDIA AUTOPILOT (Telegram) ─────────
// Per Telegram channel: plan N promo posts per day at a random moment inside a
// time window. For each slot Claude writes a post that reads like a real person
// wrote it, hooks into the product (or a broader trader pain / market moment)
// and always mentions the offer. The call-to-action link is appended by code as
// clickable HTML at the bottom, so it can never be forgotten or mistyped.
// The post is queued as a community task; processCommunityTasks() publishes it.
// State lives in data/community/telegram-autopilot-state.json.

const fs = require("fs");
const path = require("path");
const { localDay, zonedTime, planSlots } = require("./social-autopilot");

const DEFAULTS = {
  enabled: false,
  mode: "auto",            // auto = post straight away, review = land as draft
  posts_per_day: 1,
  window_start: "09:00",
  window_end: "20:00",
  language: "English",
  product: "",             // what the posts sell, e.g. "Premium"
  offer: "",               // mentioned in every post, e.g. "7-day free trial"
  cta_url: "",             // link at the bottom of every post
  cta_label: "",           // clickable text for that link
  audience: "",            // who reads the channel
  voice: "",               // optional description of the writer
  angles: [],              // optional hooks to rotate; empty = built-in set
  market_hooks: true,      // allow a quick web search for today's market news
};

const MODEL = process.env.TELEGRAM_AUTOPILOT_MODEL || "claude-opus-5-5";
const MAX_SEARCHES = 3;
const MAX_BODY = 900;
const LATE_LIMIT_MS = 3 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 15 * 60 * 1000;
const MAX_TRIES = 3;

// Generic hooks; the product details come from brand knowledge.
const BUILTIN_ANGLES = [
  "A personal observation about a mistake most traders keep making, and what fixes it",
  "A short, honest story from a trader's week (a loss, a doubt, a lesson) that leads to the product",
  "A contrarian take that makes the reader stop scrolling",
  "One concrete feature of the product and the exact problem it solves",
  "A direct question to the reader about their own trading habits",
  "Before and after: trading on gut feeling versus trading with structure and data",
  "Today's market moment as the hook, then why this is when you want better tools",
  "What you get on day one of the trial, very concretely",
  "Fear of missing out on the move versus having a plan before it happens",
  "Why the free version or YouTube tips stop being enough after a while",
];

const ALLOWED_TAGS = ["b", "i", "u", "s", "code"];

// ── pure helpers (exported for tests) ─────────
function config(channel) {
  const c = { ...DEFAULTS, ...(channel && channel.autopilot || {}) };
  c.posts_per_day = Math.min(6, Math.max(1, Number(c.posts_per_day) || DEFAULTS.posts_per_day));
  if (!/^\d{2}:\d{2}$/.test(c.window_start)) c.window_start = DEFAULTS.window_start;
  if (!/^\d{2}:\d{2}$/.test(c.window_end)) c.window_end = DEFAULTS.window_end;
  if (!Array.isArray(c.angles)) c.angles = String(c.angles || "").split("\n");
  c.angles = c.angles.map(a => String(a).trim()).filter(Boolean);
  for (const k of ["product", "offer", "cta_url", "cta_label", "audience", "voice", "language"]) c[k] = String(c[k] || "").trim();
  if (!c.language) c.language = DEFAULTS.language;
  c.market_hooks = c.market_hooks !== false;
  return c;
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

// Model output → safe Telegram HTML: only simple formatting tags survive,
// markdown bold becomes <b>, no links, never em/en dashes (house rule).
function toTelegramHtml(text) {
  let s = String(text || "")
    .replace(/\r/g, "")
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s*[—–]\s*/g, ". ")
    .replace(/\.\s*\.(?!\.)/g, ".");
  // protect allowed tags, escape the rest
  const keep = [];
  s = s.replace(/<\/?([a-z]+)\s*>/gi, (m, tag) => {
    if (!ALLOWED_TAGS.includes(tag.toLowerCase())) return "";
    keep.push(m.toLowerCase().replace(/\s/g, ""));
    return `\u0000${keep.length - 1}\u0000`;
  });
  s = s.replace(/<[^>]*>/g, "");
  s = escHtml(s).replace(/&quot;/g, '"');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<i>$1</i>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
  s = balanceTags(s);
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Drop unmatched open/close tags so Telegram never rejects the message.
function balanceTags(s) {
  const stack = [];
  const out = [];
  const re = /<(\/?)([a-z]+)>/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    out.push(s.slice(last, m.index));
    last = re.lastIndex;
    const [, close, tag] = m;
    if (!close) { stack.push({ tag, pos: out.length }); out.push(m[0]); }
    else {
      const i = stack.map(x => x.tag).lastIndexOf(tag);
      if (i === -1) continue;
      for (const x of stack.splice(i)) if (x.tag !== tag) out[x.pos] = "";
      out.push(m[0]);
    }
  }
  out.push(s.slice(last));
  for (const x of stack) out[x.pos] = "";
  return out.join("");
}

function visibleLength(html) {
  return String(html || "").replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot);/g, "x").length;
}

// Does the text mention the offer? Every number in the offer must appear, plus
// at least one of its meaningful words (so "7 dagen gratis" matches
// "probeer het 7 dagen" but not "7 signalen").
function mentionsOffer(text, offer) {
  const o = String(offer || "").toLowerCase();
  if (!o.trim()) return true;
  const t = String(text || "").toLowerCase().replace(/<[^>]+>/g, " ");
  const nums = o.match(/\d+/g) || [];
  const words = (o.match(/[\p{L}]{4,}/gu) || []);
  if (nums.some(n => !new RegExp(`(^|\\D)${n}(\\D|$)`).test(t))) return false;
  return !words.length || words.some(w => t.includes(w.slice(0, Math.max(4, w.length - 2))));
}

function ctaBlock(cfg) {
  if (!cfg.cta_url) return "";
  const label = cfg.cta_label || cfg.product || cfg.cta_url;
  return `👉 <a href="${escHtml(cfg.cta_url)}">${escHtml(label)}</a>`;
}

// Final post: body, optional offer line (only when the body forgot it), link.
function composePost(body, cfg) {
  const parts = [body.trim()];
  if (cfg.offer && !mentionsOffer(body, cfg.offer)) parts.push(`🎁 <b>${escHtml(cfg.offer)}</b>`);
  const cta = ctaBlock(cfg);
  if (cta) parts.push(cta);
  return parts.filter(Boolean).join("\n\n");
}

// Least used angle first; ties broken randomly.
function pickAngle(cfg, counts = {}, rand = Math.random) {
  const list = cfg.angles.length ? cfg.angles : BUILTIN_ANGLES;
  return list.map(a => ({ a, n: counts[a] || 0, r: rand() })).sort((x, y) => x.n - y.n || x.r - y.r)[0].a;
}

function systemPrompt(cfg, { brandName = "", knowledge = "" } = {}) {
  const who = cfg.voice || `a real trader from the ${brandName || "team"}, who uses the product every day and talks to the community like a friend, not like a brand`;
  return `You write one Telegram post for a trading community channel. You are ${who}.

Goal of every post: make the reader want to try ${cfg.product || "the product"}${cfg.offer ? ` and start the ${cfg.offer}` : ""}. Trigger them: curiosity, recognition of their own pain, a little fear of missing out, a clear payoff. Hook them to the product itself or to a broader trader theme that naturally leads to it.

How it must read:
- Write in ${cfg.language}, the way people actually talk and type in a Telegram group. Natural, warm, confident, a bit personal. Short sentences. First person is fine.
- It must NOT sound like an ad or like AI. No corporate phrases, no hype words, no "Discover now", no "Unlock", no "game changer", no exclamation marks in every sentence.
- Structure for a phone screen: a strong first line (the hook, in <b>bold</b>), then 2 to 4 short paragraphs or a few lines, with white space between them. 2 to 4 emojis in total, used like a person would, not as bullets on every line. Optionally one short list with • bullets.
- ${cfg.offer ? `ALWAYS mention the ${cfg.offer} once, naturally, near the end (in bold is fine).` : "End with a light nudge to take action."}
- End with one short, natural nudge to take action. Do NOT write any link or URL: the link is added below your text automatically.
- Formatting: Telegram HTML only: <b>, <i>, <u>. No markdown, no headings, no hashtags.
- NEVER use em dashes or en dashes. Use periods, commas, colons or a new line.
- Maximum 700 characters.

Honesty rules:
- Only use product facts from the brand knowledge. Never invent features, numbers, results, testimonials, user counts or prices.
- No financial advice, no promises of profit or returns. Frame it as tools, structure, insight and discipline.
- If you mention the market, only use facts you actually found in a search today. Otherwise keep it general.
${knowledge ? `\n${knowledge}` : ""}`;
}

function userPrompt({ angle, today, recent = [], audience = "", marketHooks = false }) {
  return `Today is ${today}.
${audience ? `Audience: ${audience}\n` : ""}Angle for today's post: ${angle}
${marketHooks ? "You may do one or two quick web searches for today's crypto market news if the angle benefits from a fresh hook. Skip searching if it does not help.\n" : ""}${recent.length ? `\nOur recent posts in this channel (do not repeat their hook, opening words or structure):\n${recent.map(t => "- " + t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").slice(0, 220)).join("\n")}\n` : ""}
Submit the post with the submit_post tool.`;
}

// ── the autopilot itself ──────────────────────
function createTelegramAutopilot(deps) {
  const {
    dataDir, tz = "Europe/Amsterdam",
    readChannels, readTasks, addTask,
    anthropic, brand, notify,
    brandKnowledge = () => "",
    log = (...a) => console.log("[TG-AUTOPILOT]", ...a),
  } = deps;
  const STATE_FILE = path.join(dataDir, "community", "telegram-autopilot-state.json");
  let busy = null;

  function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
  }
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
  {
    const s = loadState();
    for (const st of Object.values(s)) for (const sl of st.slots || []) if (sl.status === "running") sl.status = "pending";
    saveState(s);
  }

  function ensurePlan(channel, st, now) {
    const cfg = config(channel);
    const day = localDay(now, tz);
    const key = `${day}|${cfg.posts_per_day}|${cfg.window_start}|${cfg.window_end}`;
    if (st.plan_key === key) return false;
    const keep = st.day === day ? (st.slots || []).filter(s => s.status !== "pending") : [];
    const produced = keep.filter(s => s.status === "done" || s.status === "running").length;
    const start = zonedTime(day, cfg.window_start, tz).getTime();
    let end = zonedTime(day, cfg.window_end, tz).getTime();
    if (end <= start) end = zonedTime(day, "23:59", tz).getTime();
    const from = Math.max(start, now.getTime() + 2 * 60 * 1000);
    const fresh = planSlots(Math.max(0, cfg.posts_per_day - produced), from, end).map(at => ({ at, status: "pending" }));
    st.day = day;
    st.plan_key = key;
    st.slots = [...keep, ...fresh].sort((a, b) => a.at.localeCompare(b.at));
    return true;
  }

  function activeChannels() {
    return readChannels().filter(c => c.platform === "telegram" && c.enabled !== false && c.autopilot && c.autopilot.enabled);
  }

  async function tick() {
    if (busy) return;
    const now = new Date();
    const channels = activeChannels();
    const s = loadState();
    let changed = false;
    const activeIds = new Set(channels.map(c => c.id));
    for (const [id, st] of Object.entries(s)) if (!activeIds.has(id) && st.plan_key) { st.plan_key = null; changed = true; }
    for (const c of channels) {
      s[c.id] = s[c.id] || {};
      if (ensurePlan(c, s[c.id], now)) changed = true;
    }
    if (changed) saveState(s);

    for (const c of channels) {
      const due = (s[c.id].slots || []).find(sl => sl.status === "pending" && Date.parse(sl.at) <= now.getTime());
      if (!due) continue;
      const slotAt = due.at;
      const slot = fn => mutate(c.id, st => { const sl = (st.slots || []).find(x => x.at === slotAt); return sl ? fn(sl) : false; });
      if (now.getTime() - Date.parse(slotAt) > LATE_LIMIT_MS) {
        slot(sl => { sl.status = "skipped"; sl.error = "Missed (server was offline)"; });
        continue;
      }
      slot(sl => { sl.status = "running"; });
      try {
        const { task } = await produce(c, { mode: config(c).mode, trigger: "schedule" });
        slot(sl => Object.assign(sl, { status: "done", task_id: task.id, error: null }));
      } catch (e) {
        const final = slot(sl => {
          sl.tries = (sl.tries || 0) + 1;
          sl.error = String(e.message).slice(0, 300);
          if (sl.tries < MAX_TRIES) { sl.status = "pending"; sl.at = new Date(Date.now() + RETRY_DELAY_MS).toISOString(); return false; }
          sl.status = "failed";
          return true;
        });
        log(`${c.name}: slot failed: ${e.message}`);
        if (final) notify(`✈️ Telegram autopilot failed (${escHtml(c.name)})`, escHtml(String(e.message).slice(0, 300)), "danger");
      }
      return;
    }
  }

  function recentPosts(channelId) {
    return readTasks()
      .filter(t => t.channel_id === channelId && t.text && ["published", "scheduled", "draft"].includes(t.status))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 10).map(t => t.text);
  }

  async function writePost(channel, cfg, angle) {
    const brandName = (brand() || {}).company_name || "";
    const tool = {
      name: "submit_post",
      description: "Submit the finished Telegram post (without the link).",
      input_schema: {
        type: "object",
        properties: {
          post_html: { type: "string", description: "The post in Telegram HTML (<b>, <i>, <u> only), no link." },
          hook: { type: "string", description: "The hook in a few words, for the log." },
        },
        required: ["post_html", "hook"],
      },
    };
    const tools = [tool];
    if (cfg.market_hooks) tools.unshift({ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES });
    const today = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
    const messages = [{ role: "user", content: userPrompt({ angle, today, recent: recentPosts(channel.id), audience: cfg.audience, marketHooks: cfg.market_hooks }) }];
    const system = systemPrompt(cfg, { brandName, knowledge: brandKnowledge(channel) });

    let fixes = 0;
    for (let turn = 0; turn < 6; turn++) {
      const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 4000, system, tools, messages });
      const use = msg.content.find(b => b.type === "tool_use" && b.name === "submit_post");
      if (!use) {
        messages.push({ role: "assistant", content: msg.content });
        if (msg.stop_reason !== "pause_turn") messages.push({ role: "user", content: "Now submit the post with the submit_post tool." });
        continue;
      }
      const body = toTelegramHtml(use.input?.post_html);
      const problems = [];
      if (!body) problems.push("The post is empty.");
      if (visibleLength(body) > MAX_BODY) problems.push(`The post is ${visibleLength(body)} characters; keep it under 700.`);
      if (cfg.offer && !mentionsOffer(body, cfg.offer)) problems.push(`The post does not mention the ${cfg.offer}. Mention it once, naturally.`);
      if (!problems.length || fixes >= 1) {
        if (visibleLength(body) > MAX_BODY) throw new Error("Post stayed too long");
        return { body, hook: String(use.input?.hook || "").slice(0, 120) };
      }
      fixes++;
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: problems.join(" ") + " Resubmit.", is_error: true }] });
    }
    throw new Error("Claude returned no post");
  }

  async function produce(channel, { mode, trigger }) {
    if (busy) throw new Error(`Telegram autopilot is busy (${busy.step})`);
    busy = { channel_id: channel.id, step: "writing post", started_at: new Date().toISOString(), trigger };
    const record = patch => mutate(channel.id, st => { st.last_run = { ...(st.last_run || {}), ...patch }; });
    record({ at: busy.started_at, trigger, mode, status: "running", error: null, task_id: null });
    try {
      const cfg = config(channel);
      if (!cfg.cta_url) throw new Error("No link configured for this channel");
      const angle = pickAngle(cfg, (loadState()[channel.id] || {}).angle_counts || {});
      const post = await writePost(channel, cfg, angle);
      const now = new Date().toISOString();
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const task = {
        id, channel_id: channel.id,
        status: mode === "review" ? "draft" : "scheduled",
        created_at: now, updated_at: now, scheduled_at: now, scheduled_local: null,
        archetype: "Autopilot", trigger_word: null,
        media_path: null, media_paths: [],
        text: composePost(post.body, cfg), parse_mode: "HTML",
        published_at: null, message_id: null, attempts: 0, error: null,
        autopilot: true, angle, hook: post.hook,
      };
      addTask(task);
      mutate(channel.id, st => { st.angle_counts = { ...(st.angle_counts || {}), [angle]: ((st.angle_counts || {})[angle] || 0) + 1 }; });
      record({ status: "done", task_id: task.id, finished_at: new Date().toISOString() });
      log(`${channel.name}: queued ${task.id} (${post.hook || angle})`);
      return { task };
    } catch (e) {
      record({ status: "failed", error: String(e.message).slice(0, 300), finished_at: new Date().toISOString() });
      throw e;
    } finally {
      busy = null;
    }
  }

  function runNow(channel, mode) {
    if (busy) throw new Error(`Telegram autopilot is busy (${busy.step})`);
    produce(channel, { mode: mode === "review" ? "review" : "auto", trigger: "manual" })
      .catch(e => log(`${channel.name}: manual run failed: ${e.message}`));
  }

  function status(channel) {
    const s = loadState()[channel.id] || {};
    return {
      config: config(channel),
      day: s.day || null,
      slots: s.slots || [],
      last_run: s.last_run || null,
      running: busy && busy.channel_id === channel.id ? busy : null,
      angle_counts: s.angle_counts || {},
    };
  }

  return { tick, runNow, status, busy: () => busy };
}

module.exports = {
  createTelegramAutopilot, DEFAULTS, MODEL, BUILTIN_ANGLES,
  config, toTelegramHtml, balanceTags, visibleLength, mentionsOffer, ctaBlock, composePost, pickAngle,
  systemPrompt, userPrompt,
};
