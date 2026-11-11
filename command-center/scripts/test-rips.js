// Pure helpers of rips.js (no network). Run: node scripts/test-rips.js
const R = require("../rips");
let ok = 0, bad = 0;
const t = (name, cond) => { if (cond) { ok++; console.log("ok   " + name); } else { bad++; console.log("FOUT " + name); } };

// ── planEdit ──
const base = { pullDur: 40, marketDur: 12, packStart: 2, revealT: 30, valueT: 6 };
let e = R.planEdit(base);
t("edit within 20..30 s", e.duration >= 20 && e.duration <= 30 && e.within_target);
t("loading sped up, max 2x", e.pull.speed > 1 && e.pull.speed <= 2);
t("last 2 s before reveal stay real time", e.pull.pFast === 28);
t("reveal hold 1.5 s before the cut", Math.abs(e.markers.t_cut - e.markers.t_reveal - 1.5) < 0.02);
t("value hold 2 s after a 1 s zoom", Math.abs(e.markers.t_end - e.markers.t_zoom_end - 2) < 0.02);
t("cut lands before the value", e.markers.t_value > e.markers.t_cut);
const long = R.planEdit({ ...base, pullDur: 200, revealT: 190 });
t("very long loading: capped at 2x and still ≤ 30 s", long.pull.speed === 2 && long.duration <= 30);
const short = R.planEdit({ pullDur: 8, marketDur: 10, packStart: 0, revealT: 5, valueT: 8 });
t("short clips stretch the market lead first", short.markers.t_value - short.markers.t_cut > 4);
t("reveal at the very end gets a freeze", R.planEdit({ ...base, revealT: 39.5 }).pull.holdFreeze > 0);
let threw = false; try { R.planEdit({ ...base, revealT: null }); } catch { threw = true; }
t("unknown reveal throws", threw);
t("shorter plan gives a shorter edit", R.planEdit(base, { max_duration: 25 }).duration <= 25);

const real = R.planEdit({ pullDur: 32, marketDur: 12, packStart: 3, revealT: 26, valueT: 5 });
t("real case (32 s pull) ends under 30 s", real.duration <= 29.95 && real.within_target);
// ── zoom ──
t("zoom 1.0 at the value", Math.abs(R.zoomAt(e.markers.t_value, e) - 1) < 1e-9);
t("zoom 1.6 after the zoom", Math.abs(R.zoomAt(e.markers.t_zoom_end + 0.5, e) - 1.6) < 1e-9);
t("zoom halfway is between", R.zoomAt(e.markers.t_value + 0.5, e) > 1.2 && R.zoomAt(e.markers.t_value + 0.5, e) < 1.4);

// ── outcome / numbers ──
const a = { pack_price: 25, market_value: 61.5, buyback: 22.5, grade: 9, card: "Charizard", set: "Base Set 1999" };
t("win outcome", R.outcome(a).kind === "win" && R.outcome(a).diff === 36.5);
t("loss outcome", R.outcome({ pack_price: 50, market_value: 20 }).kind === "loss");
t("unknown when a value is null", R.outcome({ pack_price: 25, market_value: null }).kind === "unknown");
t("num reads $1,234.50", R.num("$1,234.50") === 1234.5);
t("num null for text", R.num("n/a") === null);
const allowed = R.allowedNumbers(a);
t("allowed has pack, value, diff, year", ["25", "61.5", "36.5", "1999", "9"].every(x => allowed.has(x)));
t("invented number flagged", R.textIssues("worth 400 dollars", allowed).some(x => /400/.test(x)));
t("em dash flagged", R.textIssues("nice — pull", allowed).length === 1);
t("hollow superlative flagged", R.textIssues("an insane pull", allowed).length === 1);
t("v3 tags are ignored in numbers", R.numbersIn("[excited] 25 bucks").join() === "25");
t("fixMoney $61.5 -> $61.50", R.fixMoney("now $61.5, was $25 and $1,200.5") === "now $61.50, was $25 and $1,200.50");
t("fixMoney leaves $61.50 and 61.5", R.fixMoney("$61.50 or 61.5") === "$61.50 or 61.5");
t("allowed still accepts 61.50", R.textIssues(R.cleanText("worth $61.5"), allowed).length === 0);
t("stripDashes", R.stripDashes("a — b") === "a. b");

// ── validateScript ──
const m = e.markers;
const good = { segments: [
  { start: 0, text: "Twenty five dollar pack." },
  { start: 2, text: "Loading the slab now." },
  { start: R.r2(m.t_reveal + 0.4), text: "[excited] Charizard, PSA 9." },
  { start: R.r2(m.t_cut), text: "Checking PriceTool." },
  { start: R.r2(m.t_value + 0.2), text: "Market value 61.5, up 36.5 on the pack." },
  { start: R.r2(m.t_end - 2), text: "So, vault it or sell it back?" },
] };
const v0 = R.validateScript(good, { edit: e, analysis: a, toolName: "PriceTool" });
t("good script passes", v0.length === 0 || (console.log(v0), false));
const bad1 = JSON.parse(JSON.stringify(good)); bad1.segments[2].start = R.r2(m.t_reveal - 0.2);
t("talking in the silence window fails", R.validateScript(bad1, { edit: e, analysis: a, toolName: "PriceTool" }).some(x => /silence|reaction/.test(x)));
const bad2 = JSON.parse(JSON.stringify(good)); bad2.segments[5].text = "Thanks for watching.";
t("missing closing line fails", R.validateScript(bad2, { edit: e, analysis: a }).some(x => /vault it/.test(x)));
const bad3 = JSON.parse(JSON.stringify(good)); bad3.segments[3].text = "Buy now on the site.";
t("buy CTA fails", R.validateScript(bad3, { edit: e, analysis: a }).some(x => /call to action/.test(x)));
const bad4 = JSON.parse(JSON.stringify(good)); bad4.segments[3].text = "Checking the price.";
t("tool not named at the cut fails", R.validateScript(bad4, { edit: e, analysis: a, toolName: "PriceTool" }).some(x => /naming/.test(x)));
const bad5 = JSON.parse(JSON.stringify(good)); bad5.segments[0].text = "This is a really long hook that never ends at all";
t("long hook fails", R.validateScript(bad5, { edit: e, analysis: a }).some(x => /hook/.test(x)));
const unk = { ...a, market_value: null };
const bad6 = JSON.parse(JSON.stringify(good)); bad6.segments[4].text = "Nice profit here.";
t("claiming profit with unknown value fails", R.validateScript(bad6, { edit: e, analysis: unk }).some(x => /unknown/.test(x)));

// ── captions ──
const words = R.wordsFromAlignment({ characters: [..."[excited] big pull here, wow"], character_start_times_seconds: [...Array(28).keys()].map(i => i * 0.1), character_end_times_seconds: [...Array(28).keys()].map(i => i * 0.1 + 0.08) }, 2);
t("alignment offset applied", words[0].start >= 2);
const clean = R.dropTagWords(words);
t("v3 tag words dropped", clean.every(w => !/excited/.test(w.text)) && clean[0].text === "big");
t("chunks max 3 words", R.chunkWords(clean, 3).every(c => c.length <= 3));
const ass = R.buildCaptionsAss({ words, raiseAt: 3.8 });
t("ass has lower third and raised style", /Style: Low/.test(ass) && /Style: High/.test(ass));
t("ass raises after raiseAt", /,High,,/.test(ass) && /,Low,,/.test(ass));
t("ass highlights active word", /\\c&H00E6FF&/.test(ass));
t("assTime format", R.assTime(65.5) === "0:01:05.50");

// ── post text / X ──
const post = R.buildPostTxt({ captionLine: "Charizard PSA 9 from a 25 dollar pack — vault or sell?", lines: ["Vaulted cards are listed for sale, link in bio.", "Market value via PriceTool.", "AI voice."], hashtags: ["pokemon", "#PSA", "tcg", "pokemontcg", "slabs", "extra"] });
t("post has 5 hashtags", (post.match(/#/g) || []).length === 5);
t("post has disclosure lines", /AI voice\./.test(post) && /link in bio/.test(post));
t("post caption has no dash", !/[–—]/.test(post));
let threw2 = false; try { R.buildPostTxt({ captionLine: "x", hashtags: ["a1", "b2"] }); } catch { threw2 = true; }
t("fewer than 5 hashtags throws", threw2);
t("weighted length: emoji 2, url 23", R.weightedLength("ab🔥 https://example.com/x") === 2 + 2 + 1 + 23);
const longPost = "W".repeat(250) + " end of line\nAI voice.\n\n#one #two #three #four #five";
const x1 = R.trimForX(longPost);
t("X trim ≤ 280", R.weightedLength(x1) <= 280);
t("X trim drops hashtags first", !/#five/.test(x1));
t("X trim keeps the disclosure", /AI voice\./.test(x1));
t("X trim keeps whole words", /…/.test(x1) ? !/\bWWWW…/.test(x1.replace(/W{250}/, "")) : true);
t("short post unchanged", R.trimForX("hi\n\n#a #b") === "hi\n\n#a #b");
const x2 = R.trimForX("word ".repeat(80).trim() + "\nAI voice.\n\n#a1 #b2 #c3 #d4 #e5");
t("long caption cut on a word boundary", /word…/.test(x2) && !/#a1/.test(x2) && R.weightedLength(x2) <= 280);

// ── revisions ──
t("closeSteps script → downstream", R.closeSteps(["script"]).join() === "script,voice,mix,captions,final,post");
t("closeSteps caption only", R.closeSteps(["post"]).join() === "post");
t("closeSteps keeps STEPS order", R.closeSteps(["final", "edit"])[0] === "edit");
const ch = R.applyChips(R.DEFAULT_PLAN, ["shorter", "calmer"]);
t("chips shorter + calmer", ch.plan.max_duration === 25 && ch.plan.tone === "calm" && ch.steps.includes("edit"));
t("different voice take bumps seed", R.applyChips(R.DEFAULT_PLAN, ["different_voice_take"]).plan.voice_seed === 2);
t("longer value zoom", R.applyChips(R.DEFAULT_PLAN, ["longer_value_zoom"]).plan.value_hold === 3.5);
t("unknown chip ignored", R.applyChips(R.DEFAULT_PLAN, ["nope"]).steps.length === 0);
t("every chip is defined", Object.keys(R.CHIPS).length === 7);

// ── status machine ──
t("processing → ready_for_review", R.canMove("processing", "ready_for_review"));
t("failed → processing (retry)", R.canMove("failed", "processing"));
t("published → uploaded not allowed", !R.canMove("published", "uploaded"));

// ── redaction ──
const red = R.makeRedactor({ ELEVENLABS_API_KEY: "abcdef1234567890", OTHER: "visible-value-123" });
t("env secret redacted", !red("key abcdef1234567890 here").includes("abcdef1234567890"));
t("non secret kept", red("visible-value-123").includes("visible-value-123"));
t("access_token query redacted", red("https://graph.facebook.com/x?access_token=EAAB123456&y=1").includes("access_token=***"));
t("bearer redacted", red("Authorization: Bearer abc.def.ghi") === "Authorization: Bearer ***");
t("anthropic key redacted", red("sk-ant-api03-xyz") === "sk-ant-***");
t("mask keeps 4+4", R.mask("EAABxxxxxxxxxxxxZZZZ") === "EAAB…ZZZZ" && R.mask("short") === "***");

console.log(`\n${ok} ok, ${bad} FOUT`);
process.exit(bad ? 1 : 0);
