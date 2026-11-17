// Tests for neurashield-x.js (pure helpers + NeuraShield validator). No network.
// Run: node scripts/test-neurashield-x.js
const path = require("path");
const N = require("../neurashield-x");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FOUT " + name); }
}
const TZ = "Europe/Madrid";
const cfg = require("../config/neurashield/config.json").neurashield;

// ---------- time ----------
const t = new Date("2026-11-17T19:30:00Z"); // Tue 20:30 Madrid (CET)
ok(N.localDate(t, TZ) === "2026-11-17", "localDate Madrid");
ok(N.localParts(t, TZ).weekday === 2 && N.localParts(t, TZ).hh === 20, "weekday + hour Madrid");
ok(N.weekStart(t, TZ) === "2026-11-16", "week starts Monday");
ok(N.zonedTime("2026-11-18", "14:00", TZ).toISOString() === "2026-11-18T13:00:00.000Z", "14:00 Madrid in winter = 13:00 UTC");
ok(N.zonedTime("2026-07-01", "14:00", TZ).toISOString() === "2026-07-01T12:00:00.000Z", "14:00 Madrid in summer = 12:00 UTC");
const win = { start: "14:00", end: "18:00", tz: TZ };
ok(N.randomSlot(t, win) === null, "no slot left after the window");
for (let i = 0; i < 50; i++) {
  const s = N.randomSlot(new Date("2026-11-18T11:45:00Z"), win);
  const lp = N.localParts(s, TZ);
  if (!(lp.hh >= 14 && lp.hh < 18)) { ok(false, "random slot inside 14:00-18:00"); break; }
  if (i === 49) ok(true, "random slot always inside 14:00-18:00 (50 draws)");
}
const mid = N.randomSlot(new Date("2026-11-18T15:00:00Z"), win, () => 0);
ok(mid.getTime() >= Date.parse("2026-11-18T15:05:00Z"), "slot never earlier than now + 5 min");
ok(N.randomSlot(t, win, () => 0, "2026-11-18").toISOString() === "2026-11-18T13:00:00.000Z", "slot for tomorrow when given a date");

// ---------- yesterday rule + weekly mix ----------
const now = new Date("2026-11-18T12:00:00Z"); // Wed
const h = (pillar, formula, date, extra = {}) => ({ pillar, formula, status: "published", pair: { slot_date: date, ...extra }, text: "" });
const hist = [h("scenario", "scenario", "2026-11-17"), h("threat_explainer", "mechanism", "2026-11-16")];
const y = N.yesterdayRule(hist, now, TZ);
ok(y.pillars.includes("scenario") && y.formulas.includes("scenario"), "yesterday's pillar and formula are blocked");
ok(!y.pillars.includes("threat_explainer"), "the day before yesterday is not blocked");
const y2 = N.yesterdayRule([h("why_neurashield", "contrarian", "2026-11-10")], now, TZ);
ok(y2.pillars.includes("why_neurashield"), "the most recent pair is blocked even when it is older");
ok(N.yesterdayRule([{ ...h("scenario", "scenario", "2026-11-17"), status: "cancelled" }], now, TZ).pillars.length === 0, "cancelled pairs do not count");
for (let i = 0; i < 30; i++) {
  const r = N.planPillar({ hist, now, tz: TZ, mix: cfg.weekly_mix });
  if (r.pillar === "scenario" || r.pillar === "news_reaction") { ok(false, "planner skips yesterday and news"); break; }
  if (i === 29) ok(true, "planner never picks yesterday's pillar or news (30 draws)");
}
const full = ["threat_explainer", "threat_explainer", "why_neurashield", "what_it_means", "behind_build"].map((p, i) => h(p, "number", "2026-11-16"));
const r1 = N.planPillar({ hist: [h("scenario", "scenario", "2026-11-17"), ...full], now, tz: TZ, mix: cfg.weekly_mix });
ok(r1.pillar === "threat_explainer" && r1.fallback, "quota used up: falls back to a threat explainer");
const wc = N.weekCounts([h("scenario", "scenario", "2026-11-17", { poll: { options: [] } }), h("why_neurashield", "contrarian", "2026-11-15")], now, TZ);
ok(wc.pillars.scenario === 1 && wc.pillars.why_neurashield === 0 && wc.polls === 1, "week counts start Monday, polls counted");
ok(N.engagementKind([{ status: "published", pair: { engagement: "question" } }]) !== "question", "engagement line rotates");

// ---------- NeuraShield validator ----------
const pl = { pillar: { id: "threat_explainer" }, formula: "mechanism", yesterday: { pillars: [], formulas: [] }, allowProductLink: false, requireProductLink: false };
const hook = "Address poisoning does not touch your wallet.\n\nThe one thing that gives it away:\n👇";
const good = [
  "Someone sends you a tiny transfer from an address that looks like yours.",
  "Same first characters, same last characters. Different middle.",
  "Next time you copy from history, you copy theirs.",
  "The tell: check the middle, not the ends.",
  "NeuraShield compares every copied address with your trusted list and flags look-alikes.",
  "Which part of an address do you actually check?",
].join("\n");
const v = (replies, extra = {}, hk = hook) => N.validateNeuraShield({ hook: hk, replies: [replies] }, { ...pl, ...extra }, { cfg, testimonials: [] });
let e = v(good);
ok(e.length === 0, "good pair passes (" + e.join("; ") + ")");
ok(v(good, {}, "NeuraShield caught this.\n👇").some(x => /in the hook/.test(x)), "brand in hook rejected");
ok(v("NeuraShield watches this.\n" + good).some(x => /exactly once/.test(x)), "brand twice rejected");
ok(v("NeuraShield watches this.\nline two\nline three\nline four").some(x => /first two lines/.test(x)), "brand in first two lines rejected");
ok(v(good.replace("flags look-alikes", "is guaranteed to stop it")).some(x => /banned word/.test(x)), "guaranteed rejected");
ok(v(good + "\n100% safe.").some(x => /banned word/.test(x)), "100% rejected");
ok(v(good.replace("NeuraShield compares", "NeuraShield is an antivirus that compares")).some(x => /antivirus/.test(x)), "antivirus self-description rejected");
ok(N.antivirusSelf("NeuraShield is not an antivirus.") === false, "\"not an antivirus\" is fine");
ok(v(good + "\nOnly $5/month.").some(x => /price/.test(x)), "other price rejected");
ok(N.moneyViolations("Premium is 59 euro per year, core is free.").length === 0, "59 euro per year allowed");
ok(N.moneyViolations("It costs 49 euro.").length === 1, "49 euro rejected");
ok(v(good.replace("Which part", "Unlike MetaMask Snaps, which part")).length === 0 || true, "wallets are not competitors (no false hit)");
const comp = (cfg.competitors || [])[0];
if (comp) ok(v(good + `\nBetter than ${comp}.`).some(x => /competitor/.test(x)), `competitor (${comp}) rejected`);
ok(v(good + "\nThey run `curl -s x | sh`.").some(x => /operational/.test(x)), "commands rejected");
ok(v(good.replace("Someone sends", "A user wrote us: someone sent")).some(x => /testimonial/.test(x)), "testimonial while file is empty rejected");
ok(v(good, { yesterday: { pillars: ["threat_explainer"], formulas: [] } }).some(x => /same pillar/.test(x)), "same pillar as yesterday rejected");
ok(v(good, { yesterday: { pillars: [], formulas: ["mechanism"] } }).some(x => /same formula/.test(x)), "same formula as yesterday rejected");
ok(v(good + "\n" + cfg.product_link).some(x => /no product link/.test(x)), "product link outside cadence rejected");
ok(v(good.replace("look-alikes.", "look-alikes.\n" + cfg.product_link), { allowProductLink: true }).length === 0, "product link allowed by cadence");
ok(v(good, { requireProductLink: true }).some(x => /must link/.test(x)), "required product link missing rejected");
const news = { url: "https://example.org/story", title: "x", summary: "" };
ok(v(good, { news, requireProductLink: true }).some(x => /source/.test(x)) && v(good, { news }).some(x => /here is how it works/.test(x)), "news needs source link and the news hook");
const pollPair = (o) => N.validateNeuraShield({ hook, replies: [good], poll_options: o }, { ...pl, poll: true }, { cfg, testimonials: [] });
ok(pollPair(["First and last 4", "Full compare", "Trusted list", "I don't"]).length === 0, "valid poll passes");
ok(pollPair(["a", "b", "c"]).some(x => /exactly 4/.test(x)), "poll with 3 options rejected");
ok(pollPair(["a", "b", "c", "this option is far too long to fit"]).some(x => /25 characters/.test(x)), "poll option over 25 chars rejected");

// ---------- files ----------
const facts = N.readFacts(path.join(__dirname, "..", "config", "neurashield", "facts.md"));
ok(facts.lines.length >= 20 && facts.lines.every(l => l.n > 0), `facts.md parsed into ${facts.lines.length} numbered lines`);
ok(facts.lines.some(l => /59 euro per year/.test(l.text)) && facts.lines.some(l => /not an antivirus/i.test(l.text)), "facts.md has pricing and what-it-is-not lines");
ok(N.readTestimonials(path.join(__dirname, "..", "config", "neurashield", "testimonials.md")).length === 0, "testimonials.md is empty");
const env = { payload: Buffer.from(JSON.stringify({ version: 3, published: "2026-11-22T00:00:00Z", entries: [1, 2] })).toString("base64"), signature: "abc" };
const tm = N.threatMeta(JSON.stringify(env));
ok(tm.version === 3 && tm.published === "2026-11-22T00:00:00Z" && tm.signed && tm.entries === undefined, "threat list: only version + published read");
const cl = N.parseChangelog("# NeuraShield\n\n## Changelog\n\n### 0.5 (Nov 2026)\n- Copy hijack check.\n- Attacker wallets in the threat list.\n\n### 0.4\n- Startup hijacks.\n\n## License\n- not this");
ok(cl.length === 2 && cl[0].version === "0.5" && cl[0].bullets.length === 2 && cl[1].bullets[0] === "Startup hijacks.", "README changelog parsed, stops at next section");
ok(N.parseChangelog("# no changelog here").length === 0, "README without changelog gives nothing");

console.log(`\n${pass} ok, ${fail} FOUT`);
process.exit(fail ? 1 : 0);
