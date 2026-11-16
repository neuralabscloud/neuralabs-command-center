// node scripts/test-news-cards-pipeline.js   (geen netwerk; schrijft alleen in een temp dir)
const os = require("os"), fs = require("fs"), path = require("path");
process.env.NEWS_CARDS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nc-test-"));
const P = require("../news-cards-pipeline");
const nc = require("../news-cards");
const ev = require("../sources/evergreen");
let fails = 0;
const t = (name, cond) => { console.log(`${cond ? "ok  " : "FOUT"} ${name}`); if (!cond) fails++; };

const now = Date.parse("2026-11-16T07:30:00Z");
const pool = ev.load();
const plans = P.planLayouts(pool, [], ["signal", "number", "versus", "persona"], now);
t("planLayouts: elke layout een item (evergreen)", plans.length === 4 && plans.map(p => p.layout).join() === "signal,number,versus,persona");
t("planLayouts: geen item dubbel", new Set(plans.map(p => p.item.id)).size === 4);

const stills = [{ id: "a", prompt: "front view" }, { id: "b", prompt: "three-quarter view, night" }, { id: "c", prompt: "three quarter view" }];
t("persona: three-quarter voorkeur", P.pickPersonaStill(stills, [], now, 14, () => 0).id === "b");
const hist = [{ created_at: new Date(now - 3 * 864e5).toISOString(), persona_still: "b" }];
t("persona: 14 dagen rotatie", P.pickPersonaStill(stills, hist, now, 14, () => 0).id === "c");
const histOld = [{ created_at: new Date(now - 20 * 864e5).toISOString(), persona_still: "b" }];
t("persona: na 14 dagen weer vrij", P.pickPersonaStill(stills, histOld, now, 14, () => 0).id === "b");

t("pill uit opties", P.pillOptions(pool[0], "signal").includes(P.pickPill(pool[0], "signal", {}, () => 0)));
t("localDay Madrid", P.localDay(new Date("2026-11-16T23:30:00Z"), "Europe/Madrid") === "2026-11-17");

// schedulePublish met nep-deps
const mkSet = id => ({ id, created_at: new Date(now).toISOString(), status: "rendered", layout: "number", pill: "signal", posts: {}, log: [],
  item: { url: "https://example.org/a" }, validator: { ok: true },
  card: { headline: "Fees fell to **3.125** BTC", x_hook: "hook 👇", x_reply: "reply", caption: "cap", payload: { title: "p" }, closer: { line: "c" } },
  slides: [1, 2, 3].map(n => ({ slide: n, rel: `/media/news-cards/set_${id}_slide_${n}.png` })) });
const calls = { x: [], buf: [] };
const deps = mode => ({
  channel: () => ({ id: "ch1", autopilot: { mode } }),
  addXTask: f => { calls.x.push(f); return { id: "x" + calls.x.length, ...f }; },
  shareUrls: async m => m.slides.map(s => `https://h/${s.slide}.jpg`),
  bufferPost: async i => { calls.buf.push(i); return { id: "b1", status: "scheduled" }; },
  notify: () => {},
});
(async () => {
  const m = mkSet("s1");
  await P.schedulePublish({ deps: deps("auto"), m, nowMs: now });
  t("auto: alle drie platforms ingepland", m.posts.instagram.status === "scheduled" && m.posts.x.status === "scheduled" && m.posts.tiktok.status === "queued");
  t("auto: X task scheduled met pair hook+reply", calls.x[0].status === "scheduled" && calls.x[0].pair.hook === "hook 👇" && calls.x[0].pair.replies[0] === "reply");
  t("auto: X alleen slide 1", calls.x[0].media_paths.length === 1 && /slide_1/.test(calls.x[0].media_paths[0]));
  t("IG 18:30 Madrid = 17:30 UTC", m.posts.instagram.due_at === "2026-11-16T17:30:00.000Z");
  const bi = calls.buf[0];
  t("TikTok Buffer: 3 beelden, AI-label, customScheduled", bi.assets.length === 3 && bi.metadata?.tiktok?.isAiGenerated === true && bi.mode === "customScheduled");

  const m2 = mkSet("s2");
  await P.schedulePublish({ deps: deps("auto"), m: m2, nowMs: now + 3600e3 });
  t("cadence: tweede set dezelfde dag overgeslagen", m2.posts.instagram.status === "skipped" && !m2.posts.x?.task_id);

  const m3 = mkSet("s3");
  await P.schedulePublish({ deps: deps("review"), m: m3, nowMs: now + 3 * 864e5 });
  t("niet-auto: IG wacht op goedkeuring, X draft, geen Buffer", m3.posts.instagram.status === "awaiting_approval" && calls.x[1].status === "draft" && calls.buf.length === 1);

  const m4 = mkSet("s4");
  await P.schedulePublish({ deps: deps("auto"), m: m4, only: ["instagram"], immediate: true, nowMs: now + 5 * 864e5 });
  t("only instagram + immediate: alleen IG, nu", Object.keys(m4.posts).join() === "instagram" && m4.posts.instagram.due_at === new Date(now + 5 * 864e5).toISOString());

  t("setScore IG + X", P.setScore({ metrics: { instagram: { h72: { reach: 100, likes: 10, comments: 0, saved: 0, shares: 0 } }, x: { score: { score: 0.5 } } } }) === 0.75);
  t("panel toont sets", P.panel(30).length === 4 && P.panel(30)[0].slides.length === 3);
  fs.rmSync(process.env.NEWS_CARDS_DIR, { recursive: true, force: true });
  console.log(fails ? `${fails} FOUT` : "alles ok");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("FOUT", e.stack); process.exit(1); });
