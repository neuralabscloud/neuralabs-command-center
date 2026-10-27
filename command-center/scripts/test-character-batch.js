// Offline tests for character-batch.js — run: node scripts/test-character-batch.js
const cb = require("../character-batch");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FOUT " + name); }
}

// ── time / schedule ──
{
  const sunMadridSummer = new Date("2026-10-11T08:00:00Z"); // 10:00 CEST
  const w = cb.comingWeek(sunMadridSummer, "Europe/Madrid");
  check("coming week starts Monday after a Sunday run", w[0].date === "2026-10-12" && w[0].day === "Monday");
  check("coming week ends Sunday", w[6].date === "2026-10-18" && w[6].day === "Sunday" && w.length === 7);
  check("run on a Monday plans next Monday", cb.comingWeek(new Date("2026-10-12T10:00:00Z"), "Europe/Madrid")[0].date === "2026-10-19");
  check("iso week", cb.isoWeek("2026-10-12") === "2026-W42" && cb.isoWeek("2027-01-01") === "2026-W53");
  check("batch id", cb.batchId("nova", "2026-10-12") === "nova-2026-W42");
  const s = { enabled: true, tz: "Europe/Madrid", hour: 10, minute: 0, days: ["sun"], catchup_min: 120 };
  check("due at 10:00 Madrid in summer (08:00 UTC)", cb.scheduleDue(s, sunMadridSummer));
  check("not due at 10:00 UTC in summer", !cb.scheduleDue(s, new Date("2026-10-11T12:30:00Z")));
  check("due at 10:00 Madrid in winter (09:00 UTC)", cb.scheduleDue(s, new Date("2026-11-01T09:00:00Z")));
  check("not due an hour early in winter", !cb.scheduleDue(s, new Date("2026-11-01T08:00:00Z")));
  check("catch-up window fires late", cb.scheduleDue(s, new Date("2026-10-11T09:45:00Z")));
  check("not on a Saturday", !cb.scheduleDue(s, new Date("2026-10-10T08:00:00Z")));
  check("once per local day", !cb.scheduleDue({ ...s, last_run: "2026-10-11T08:00:30Z" }, new Date("2026-10-11T08:30:00Z")));
  check("disabled never fires", !cb.scheduleDue({ ...s, enabled: false }, sunMadridSummer));
  const utc = { enabled: true, hour: 7, minute: 0, days: ["mon"] };
  check("schedule without tz stays UTC, exact minute", cb.scheduleDue(utc, new Date("2026-10-12T07:00:20Z")) && !cb.scheduleDue(utc, new Date("2026-10-12T07:01:00Z")));
}

// ── history ──
{
  const ms = [
    { week_start: "2026-10-05", next_outfit: 3, created_at: "2026-10-04", slots: [{ city: "Tokyo" }, { city: "Dubai" }] },
    { week_start: "2026-09-07", next_outfit: 1, created_at: "2026-09-06", slots: [{ city: "Lisbon" }] },
    { week_start: "2026-10-05", dry_run: true, next_outfit: 0, created_at: "2026-10-10", slots: [{ city: "Paris" }] },
  ];
  const rc = cb.recentCities(ms, "2026-10-12");
  check("recent cities from the last 4 weeks", rc.includes("Tokyo") && rc.includes("Dubai"));
  check("older than 4 weeks is allowed again", !rc.includes("Lisbon"));
  check("dry runs do not count", !rc.includes("Paris"));
  check("outfit rotation continues from last real batch", cb.nextOutfitStart(ms, 4) === 3);
  check("no history starts at 0", cb.nextOutfitStart([], 4) === 0);
  check("outfit i mod N", [0, 1, 2, 3, 4, 5, 6].map(i => cb.outfitFor(i, 3, 4)).join("") === "3012301");
}

// ── concepts ──
const payload = {
  character: { name: "nova", face: "short silver hair and a small scar over his left eyebrow" },
  forbidden_names: ["BrandX"],
};
const week = cb.comingWeek(new Date("2026-10-11T08:00:00Z"), "Europe/Madrid");
const outfits = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];
function raw(i, o = {}) {
  const types = ["transformation", "transformation", "phone_location", "phone_location", "other", "other", "other"];
  return {
    slot: i + 1, city: ["Tokyo", "Seoul", "Zurich", "Cape Town", "Oslo", "Lima", "Hanoi"][i], scene_type: types[i], devices: ["phone"],
    still_scene: "He stands on a rooftop at blue hour, 50mm lens, his phone in hand showing a dark trading chart.",
    camera_move: "slow push-in", light: "blue hour neon",
    beats: { "0-2": "He looks at the phone", "2-5": "He scrolls the chart", "5-8": "He looks up at the skyline" },
    onscreen_text: "", caption_line: "Patience Pays The Patient", question: "where do you trade from", hashtags: ["trading", "#bitcoin", "#defi", "#tradinglifestyle"],
    music: "deep electronic pulse", sfx: "wind, distant traffic", ...o,
  };
}
const ctx = { week, outfits, outfitStart: 2, payload };
const concepts = Array.from({ length: 7 }, (_, i) => cb.normalizeConcept(raw(i), i, ctx));
{
  const c = concepts[0], r = cb.rulesFor(payload);
  check("still prompt starts with the fixed prefix", c.start_frame_prompt.startsWith(r.still_prefix));
  check("still prompt ends with the fixed suffix", c.start_frame_prompt.endsWith(r.still_suffix));
  check("still prompt repeats the face + outfit sentence", c.start_frame_prompt.includes("He has short silver hair") && c.start_frame_prompt.includes(r.outfit_phrase));
  check("phone rule added", c.start_frame_prompt.includes(r.phone) && c.video_prompt.includes(r.phone));
  check("laptop rule only when a laptop is in shot", !c.start_frame_prompt.includes(r.laptop));
  check("laptop detected from the text", cb.normalizeConcept(raw(0, { devices: [], still_scene: "He sits at a laptop in a cafe." }), 0, ctx).devices.includes("laptop"));
  check("video prompt opener", c.video_prompt.startsWith("Cinematic but realistic footage, slow push-in, blue hour neon, subtle film grain."));
  check("video prompt beats in order", /0 to 2 s:.*2 to 5 s:.*5 to 8 s:/.test(c.video_prompt));
  check("objects sentence", c.video_prompt.includes("Only the objects already in the scene exist; light, hologram and energy effects may grow out of them."));
  check("no-text line without onscreen text", c.video_prompt.includes(r.no_text));
  check("audio line last", c.video_prompt.endsWith(r.audio.replace("{music}", "deep electronic pulse").replace("{sfx}", "wind, distant traffic")));
  const t = cb.normalizeConcept(raw(0, { onscreen_text: "risk first — always" }), 0, ctx);
  check("text line with exact text, dashes stripped", t.video_prompt.includes("reading exactly: risk first always.") && !t.video_prompt.includes(r.no_text));
  check("caption is 3 lines lowercase", c.caption.split("\n").length === 3 && c.caption === c.caption.toLowerCase());
  check("question gets a question mark", c.caption.split("\n")[1] === "where do you trade from?");
  check("4 hashtags with #", c.caption.split("\n")[2] === "#trading #bitcoin #defi #tradinglifestyle");
  check("outfit index continues the rotation", concepts.map(x => x.outfit).join("") === "CDABCDA");
  check("music_sfx combined", c.music_sfx === "deep electronic pulse · wind, distant traffic");
  check("dates from the coming week", concepts[6].date === "2026-10-18" && concepts[6].day === "Sunday");
  check("valid set passes", cb.validateConcepts(concepts, { forbidden: payload.forbidden_names, payload }).length === 0);
}

// ── validation ──
{
  const v = (list, o = {}) => cb.validateConcepts(list, { payload, forbidden: payload.forbidden_names, ...o });
  const mk = (fn) => Array.from({ length: 7 }, (_, i) => cb.normalizeConcept(fn(i), i, ctx));
  check("too much on-screen text", v(mk(i => raw(i, { onscreen_text: i < 3 ? "stay calm" : "" }))).some(e => /on-screen text/.test(e)));
  check("too few transformations", v(mk(i => raw(i, { scene_type: i === 0 ? "transformation" : raw(i).scene_type === "transformation" ? "other" : raw(i).scene_type }))).some(e => /transformation/.test(e)));
  check("too few phone locations", v(mk(i => raw(i, { scene_type: raw(i).scene_type === "phone_location" ? "other" : raw(i).scene_type }))).some(e => /phone-trading/.test(e)));
  check("recent city rejected", v(concepts, { recent: ["tokyo"] }).some(e => /Tokyo was used/.test(e)));
  check("driving rejected", v(mk(i => raw(i, i === 2 ? { still_scene: "He is driving with his phone on the dash." } : {}))).some(e => /driving/.test(e)));
  check("caption line max 6 words", v(mk(i => raw(i, i === 1 ? { caption_line: "one two three four five six seven" } : {}))).some(e => /max 6/.test(e)));
  check("forbidden name rejected", v(mk(i => raw(i, i === 4 ? { still_scene: "A BrandX hoodie on a chair, phone in hand." } : {}))).some(e => /forbidden/.test(e)));
  check("numbers in on-screen text rejected", v(mk(i => raw(i, i === 0 ? { onscreen_text: "up 300 percent" } : {}))).some(e => /numbers/.test(e)));
  check("wrong count", v(concepts.slice(0, 6)).some(e => /exactly 7/.test(e)));
  check("missing beat", v(mk(i => raw(i, i === 3 ? { beats: { "0-2": "x", "2-5": "y" } } : {}))).some(e => /beats/.test(e)));
}

// ── parsing ──
{
  const j = cb.extractJson('Thinking first {not json} ok.\n```json\n{"concepts":[{"slot":1,"city":"a {b}"}]}\n```');
  check("extracts JSON after prose and braces in strings", j.concepts[0].city === "a {b}");
  let threw = false; try { cb.extractJson("no json here"); } catch { threw = true; }
  check("throws without JSON", threw);
  check("stripDashes leaves no dashes", !/[—–]/.test(cb.stripDashes("calm — focused – done")));
}

// ── errors + backoff ──
{
  check("insufficient balance detected", cb.isInsufficientBalance("Insufficient credits") && cb.isInsufficientBalance("HTTP 402 Payment Required"));
  check("moderation detected", cb.isModeration("status nsfw") && cb.isModeration("ip_detected"));
  check("transient detected", cb.isTransient("HTTP 503") && cb.isTransient("fetch failed") && !cb.isTransient("invalid prompt"));
}

(async () => {
  let n = 0;
  const r = await cb.withBackoff(async () => { if (++n < 3) throw new Error("HTTP 503"); return "ok"; }, { sleep: async () => {} });
  check("backoff retries transient errors", r === "ok" && n === 3);
  n = 0;
  let err = null;
  try { await cb.withBackoff(async () => { n++; throw new Error("invalid input"); }, { sleep: async () => {} }); } catch (e) { err = e; }
  check("no retry on a hard error", err && n === 1);
  const waits = [];
  try { await cb.withBackoff(async () => { throw new Error("timeout"); }, { tries: 3, base: 100, sleep: async (ms) => waits.push(ms), onRetry: () => {} }); } catch {}
  check("backoff doubles", waits.join(",") === "100,200");

  // ── wachten op de Higgsfield-top-up ──
  const br = cb.balanceRetry({});
  check("balance retry default: elke 10 min, max 60 min", br.everyMs === 600000 && br.maxMs === 3600000 && br.rounds === 6);
  const br2 = cb.balanceRetry({ balance_retry_every_min: "5", balance_retry_max_min: "30" });
  check("balance retry leest de payload (ook als tekst)", br2.everyMs === 300000 && br2.rounds === 6);
  check("balance retry 0 = uit", cb.balanceRetry({ balance_retry_max_min: 0 }).rounds === 0);
  check("balance retry negeert onzin", cb.balanceRetry({ balance_retry_every_min: "x", balance_retry_max_min: -5 }).rounds === 6);
  check("balance retry interval nooit onder 1 min", cb.balanceRetry({ balance_retry_every_min: 0 }).everyMs === 60000);
  check("Higgsfield-saldofout wordt herkend", cb.isInsufficientBalance('Higgsfield reported "failed": Your credit balance is too low to complete this request. Please top up your balance and try again'));

  // ── manifest + telegram ──
  const m = {
    batch_id: "nova-2026-W42", title: "Weekly character batch", week_start: "2026-10-12", week_end: "2026-10-18",
    concepts_cost: { usd: 0.4, priced: true }, stopped: "Higgsfield balance too low: no video for slot 7.",
    slots: [
      { slot: 1, day: "Monday", city: "Tokyo", status: "done", video_url: "/video-outputs/a.mp4", still_cost: { usd: 0.15 }, video_cost: { usd: 3.7 } },
      { slot: 2, day: "Tuesday", city: "Seoul & Co", status: "video_failed", error: "Generation failed", still_cost: { usd: 0.15 }, video_cost: { usd: 0, priced: false } },
      { slot: 7, day: "Sunday", city: "Hanoi", status: "skipped_balance" },
    ],
  };
  const tc = cb.totalCost(m);
  check("total cost sums stills, videos and concepts", tc.usd === 4.4 && tc.priced === false);
  const tg = cb.telegramSummary(m, "https://cc.example.com/");
  check("telegram has one row per slot", tg.split("\n").filter(l => /^(✅|❌|💸)/.test(l)).length === 3);
  check("telegram link is absolute", tg.includes('href="https://cc.example.com/video-outputs/a.mp4"'));
  check("telegram escapes html", tg.includes("Seoul &amp; Co"));
  check("telegram lists failures and stop", tg.includes("slot 2: Generation failed") && tg.includes("balance too low"));
  check("telegram total cost", tg.includes("$4.40"));
  check("default resolution is 720p", cb.DEFAULTS.resolution === "720p" && cb.DEFAULTS.duration === 8);

  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})();
