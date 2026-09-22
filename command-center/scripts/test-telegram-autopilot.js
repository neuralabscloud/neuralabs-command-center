// Offline tests for telegram-autopilot.js — run: node scripts/test-telegram-autopilot.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const t = require("../telegram-autopilot");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FOUT " + name); }
}

// ── config ──
const cfg = t.config({ autopilot: { enabled: true, posts_per_day: 40, offer: "7-day free trial", cta_url: "https://example.com", cta_label: "Start your trial", product: "Pro" } });
check("config merges defaults", cfg.window_start === "09:00" && cfg.language === "English" && Array.isArray(cfg.angles));
check("posts per day clamped", cfg.posts_per_day === 6 && t.config({ autopilot: { posts_per_day: 0 } }).posts_per_day >= 1);

// ── HTML cleaning ──
const h = t.toTelegramHtml('<b>Hook — here</b>\n\nRead <a href="https://x.io">this</a> https://spam.io now <script>x</script> & **bold** <h1>t</h1>');
check("dashes removed", !/[—–]/.test(h));
check("links and urls stripped", !h.includes("href") && !h.includes("spam.io"));
check("unsupported tags dropped", !h.includes("<script>") && !h.includes("<h1>"));
check("ampersand escaped", h.includes("&amp;"));
check("markdown bold converted", h.includes("<b>bold</b>"));
check("allowed tags kept", h.startsWith("<b>Hook. here</b>"));
check("unbalanced tags repaired", t.balanceTags("<b>open <i>x</b>") .split("<").length - 1 === t.balanceTags("<b>open <i>x</b>").split(">").length - 1 && !/<i>[^<]*<\/b>/.test(t.balanceTags("<b>open <i>x</b>")));
check("visible length ignores tags", t.visibleLength("<b>abc</b> &amp;") === 5);

// ── offer detection ──
check("offer found", t.mentionsOffer("Try it free, 7 days trial on us", "7-day free trial"));
check("offer number required", !t.mentionsOffer("Try the free trial", "7-day free trial"));
check("number alone not enough", !t.mentionsOffer("7 signals today", "7 dagen gratis trial"));
check("dutch offer matched", t.mentionsOffer("Zit bij Premium, <b>7 dagen gratis</b> te proberen", "7 dagen gratis trial"));
check("empty offer always fine", t.mentionsOffer("anything", ""));

// ── composing ──
const post = t.composePost("<b>Hook</b>\n\nBody with a 7-day free trial.", cfg);
check("link at the very bottom", post.trim().endsWith('👉 <a href="https://example.com">Start your trial</a>'));
check("no extra offer line when mentioned", !post.includes("🎁"));
const post2 = t.composePost("<b>Hook</b>\n\nNo offer here.", cfg);
check("offer line added when missing", post2.includes("🎁 <b>7-day free trial</b>") && post2.indexOf("🎁") < post2.indexOf("👉"));
check("cta label falls back to product", t.ctaBlock({ cta_url: "https://e.com", product: "Pro" }).includes(">Pro</a>"));
check("cta url escaped", t.ctaBlock({ cta_url: 'https://e.com/?a=1&b="2"', cta_label: "x" }).includes("&amp;b=&quot;2&quot;"));

// ── angles + prompts ──
check("least used angle first", t.pickAngle({ angles: ["a", "b", "c"] }, { a: 2, b: 0, c: 1 }) === "b");
check("builtin angles when empty", t.BUILTIN_ANGLES.includes(t.pickAngle({ angles: [] }, {})));
const sys = t.systemPrompt({ ...cfg, language: "Dutch" }, { brandName: "Acme", knowledge: "KNOWLEDGE" });
check("system prompt: language, offer, no links, no dashes", sys.includes("Write in Dutch") && sys.includes("ALWAYS mention the 7-day free trial") && sys.includes("Do NOT write any link") && sys.includes("NEVER use em dashes"));
check("system prompt carries brand knowledge", sys.includes("KNOWLEDGE"));
const up = t.userPrompt({ angle: "A1", today: "Monday", recent: ["<b>Old hook</b> text"], marketHooks: true });
check("user prompt has angle, recent posts, search hint", up.includes("A1") && up.includes("- Old hook text") && up.includes("web search"));

// ── full run with a fake Claude ──
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgap-"));
  fs.mkdirSync(path.join(dir, "community"));
  const channel = { id: "c1", name: "Chan", platform: "telegram", enabled: true, autopilot: { enabled: true, offer: "7-day free trial", cta_url: "https://example.com", cta_label: "Start", market_hooks: false } };
  const tasks = [];
  const calls = [];
  const replies = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "u1", name: "submit_post", input: { post_html: "<b>Hook</b> without the offer", hook: "h" } }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "u2", name: "submit_post", input: { post_html: "<b>Hook</b>\n\nNow with a 7 day free trial 🚀", hook: "h2" } }] },
  ];
  const anthropic = { messages: { create: async (req) => { calls.push(req); return replies[calls.length - 1]; } } };
  const ap = t.createTelegramAutopilot({
    dataDir: dir, readChannels: () => [channel], readTasks: () => tasks, addTask: x => tasks.push(x),
    anthropic, brand: () => ({ company_name: "Acme" }), notify: () => {}, log: () => {},
  });
  ap.runNow(channel, "review");
  for (let i = 0; i < 50 && ap.busy(); i++) await new Promise(r => setTimeout(r, 10));
  check("fix round asked when offer missing", calls.length === 2 && JSON.stringify(calls[1].messages).includes("does not mention"));
  check("no web search tool when market hooks off", !calls[0].tools.some(x => x.type && x.type.startsWith("web_search")));
  const task = tasks[0];
  check("draft task created", task && task.status === "draft" && task.parse_mode === "HTML" && task.autopilot === true);
  check("task ends with link", task && task.text.endsWith('👉 <a href="https://example.com">Start</a>'));
  const st = ap.status(channel);
  check("status records the run", st.last_run.status === "done" && st.last_run.task_id === task.id);
  check("angle counted", Object.values(st.angle_counts).reduce((a, b) => a + b, 0) === 1);

  // missing link fails loudly
  const noLink = { ...channel, id: "c2", autopilot: { enabled: true } };
  ap.runNow(noLink, "review");
  for (let i = 0; i < 50 && ap.busy(); i++) await new Promise(r => setTimeout(r, 10));
  check("run without link fails", ap.status(noLink).last_run.status === "failed" && /link/i.test(ap.status(noLink).last_run.error));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})();
