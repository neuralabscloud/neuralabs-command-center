// Offline tests for growth-marketeer.js — run: node scripts/test-growth-marketeer.js
const g = require("../growth-marketeer");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FOUT " + name); }
}

// ── channel / level mapping ──
check("known channel kept", g.channel("meta_ads") === "meta_ads");
check("channel alias", g.channel("Email newsletter") === "newsletter" && g.channel("Twitter") === "x" && g.channel("UGC") === "ugc_video");
check("unknown channel is other", g.channel("carrier pigeon") === "other");
check("level normalised", g.level("HIGH") === "high" && g.level("Low") === "low" && g.level("??") === "medium");
check("quick win scores higher", g.ideaScore({ impact: "high", effort: "low" }) > g.ideaScore({ impact: "high", effort: "high" }));

// ── prompts ──
const sys = g.systemPrompt({ language: "Dutch" });
check("system prompt language", sys.includes("Write everything in Dutch"));
check("system prompt bans dashes", sys.includes("em dashes"));
const up = g.userPrompt({ goal: "100k users", focus: "", product: "", previous: [{ title: "Old idea", channel: "x", status: "done" }], today: "2026-09-22" });
check("user prompt has goal", up.includes("Goal: 100k users"));
check("user prompt has previous ideas", up.includes("[done] Old idea (x)"));
check("user prompt without previous has no feedback block", !g.userPrompt({ goal: "g", previous: [], today: "t" }).includes("earlier weeks"));

// ── JSON extraction ──
const reply = 'Let me search.Found it.\n```json\n{"headline":"Ride the ETF wave — now","summary":"s","ideas":[{"title":"Referral loop","channel":"affiliate","impact":"high","effort":"low","steps":["a","b"]},{"title":"Weekly newsletter","channel":"email","impact":"medium","effort":"medium"},{"title":"Big stunt","channel":"pr","impact":"high","effort":"high"},{"title":"Tiny tweak","channel":"product","impact":"low","effort":"low"}],"top3":["Big stunt"],"competitors":[{"name":"Rival","url":"https://r.io"}],"findings":[{"title":"f","detail":"d","source":"https://x"}],"gaps":[],"buzz":[{"title":"b","when":"oct"}]}\n```';
const raw = g.extractJson(reply);
check("json from fence", raw.headline.startsWith("Ride"));
check("json without fence", g.extractJson('text {"a":1} more').a === 1);
let threw = false; try { g.extractJson("no json"); } catch { threw = true; }
check("missing json throws", threw);

// ── normalisation ──
const r = g.normalizeReport(raw);
check("dashes stripped", !/[—–]/.test(r.headline));
check("ideas get ids and status", r.ideas[0].id === "i1" && r.ideas.every(i => i.status === "new"));
check("channels mapped", r.ideas[0].channel === "referral" && r.ideas[1].channel === "newsletter");
check("top3 honours model order first", r.top3[0] === "i3");
check("top3 filled with quick wins", r.top3.length === 3 && r.top3[1] === "i1");
check("competitor kept", r.competitors[0].name === "Rival");
check("empty arrays safe", Array.isArray(r.gaps) && r.gaps.length === 0);
threw = false; try { g.normalizeReport({ ideas: [] }); } catch { threw = true; }
check("report without ideas throws", threw);

// ── sources / queries ──
const blocks = [
  { type: "server_tool_use", name: "web_search", input: { query: "product reviews" } },
  { type: "web_search_tool_result", content: [{ url: "https://a", title: "A" }, { url: "https://a", title: "A" }, { url: "https://b" }] },
  { type: "web_search_tool_result", content: { type: "web_search_tool_result_error" } },
  { type: "text", text: "hello " }, { type: "text", text: "world" },
];
check("sources deduplicated", g.collectSources(blocks).length === 2 && g.collectSources(blocks)[1].title === "https://b");
check("queries collected", g.collectQueries(blocks).join() === "product reviews");
check("text joined", g.textOf(blocks) === "hello world");

// ── feedback + telegram ──
const prev = g.previousIdeas([{ ideas: [{ title: "A", channel: "x", status: "done" }] }, { ideas: [{ title: "B", channel: "seo" }] }]);
check("previous ideas carry status", prev.length === 2 && prev[1].status === "new");
check("previous ideas capped", g.previousIdeas([{ ideas: Array.from({ length: 50 }, (_, i) => ({ title: "t" + i, channel: "x" })) }], 10).length === 10);
r.sources = [{ url: "https://a" }];
const tg = g.telegramSummary(r, { url: "https://cc/marketing.html" });
check("telegram lists top 3", (tg.match(/^\d\. <b>/gm) || []).length === 3);
check("telegram has counts and link", tg.includes("4 ideas") && tg.includes("1 sources") && tg.endsWith("https://cc/marketing.html"));

console.log(`\n${pass} ok, ${fail} FOUT`);
process.exit(fail ? 1 : 0);
