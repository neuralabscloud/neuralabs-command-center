// Offline tests for ugc-autopilot.js — run: node scripts/test-ugc-autopilot.js
const u = require("../ugc-autopilot");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FOUT " + name); }
}

// ── gender / age ──
check("man from prompt", u.inferGender({ prompt: "A 42-year-old man with dark hair" }) === "male");
check("woman is not man", u.inferGender({ prompt: "A 45-year-old woman with a sleek blonde bob" }) === "female");
check("explicit field wins", u.inferGender({ gender: "male", prompt: "a woman" }) === "male");
check("unknown stays empty", u.inferGender({ prompt: "portrait, studio light" }) === "");
check("age from prompt", u.inferAge({ prompt: "A 27-year-old man" }) === 27);
check("age bucket", u.ageBucket(27) === "young" && u.ageBucket(45) === "middle_aged" && u.ageBucket(70) === "old");

// ── voice matching ──
const voices = [
  { voice_id: "f1", name: "F young", labels: { gender: "female", language: "en", age: "young", use_case: "conversational", accent: "american" } },
  { voice_id: "f2", name: "F mid", labels: { gender: "female", language: "en", age: "middle_aged", use_case: "social_media", accent: "american" } },
  { voice_id: "m1", name: "M young", labels: { gender: "male", language: "en", age: "young", use_case: "social_media", accent: "american" } },
  { voice_id: "m2", name: "M mid", labels: { gender: "male", language: "en", age: "middle_aged", use_case: "conversational", accent: "american" } },
  { voice_id: "m3", name: "M cartoon", labels: { gender: "male", language: "en", age: "young", use_case: "characters_animation", accent: "american" } },
  { voice_id: "n1", name: "Neutral", labels: { gender: "neutral", language: "en" } },
];
for (let i = 0; i < 20; i++) {
  const v = u.pickVoice(voices, { gender: "male", age: 20 + i * 2, seed: "av" + i });
  if (v.labels.gender !== "male") { check("male avatar never gets another voice", false); break; }
  if (i === 19) check("male avatar never gets another voice", true);
}
check("female avatar gets female voice", u.pickVoice(voices, { gender: "female", age: 30, seed: "x" }).labels.gender === "female");
check("age bucket preferred", u.pickVoice(voices, { gender: "male", age: 45, seed: "x" }).voice_id === "m2");
check("character voices skipped", !voices.filter(v => v.voice_id === "m3").some(() => u.pickVoice(voices, { gender: "male", age: 25, seed: "q" }).voice_id === "m3"));
check("same seed same voice", u.pickVoice(voices, { gender: "female", seed: "abc" }).voice_id === u.pickVoice(voices, { gender: "female", seed: "abc" }).voice_id);
check("no match returns null", u.pickVoice(voices.filter(v => v.labels.gender !== "male"), { gender: "male" }) === null);

// ── avatar rotation ──
const avatars = [
  { id: "a", status: "ready", image_url: "/a.png", prompt: "a man" },
  { id: "b", status: "ready", image_url: "/b.png", prompt: "a woman" },
  { id: "c", status: "ready", image_url: "/c.png", prompt: "a woman" },
  { id: "d", status: "processing", image_url: "", prompt: "a man" },
  { id: "e", status: "ready", image_url: "/e.png", prompt: "landscape" },
];
check("unused avatar first", ["c"].includes(u.pickAvatar(avatars, ["a", "b"]).id));
check("least recent when all used", u.pickAvatar(avatars, ["c", "a", "b"]).id === "b");
check("preferred id wins", u.pickAvatar(avatars, [], "a").id === "a");
check("not-ready and genderless skipped", !["d", "e"].includes(u.pickAvatar(avatars, ["a", "b", "c"]).id));

// ── script parsing ──
const reply = 'Sure!\n{"angle":"late entries fixed","hook":"I used to buy every top — honestly.","on_screen_hook":"Stop buying the top","script":"I used to buy every top — honestly. Then I found [this] tool.","caption":"This changed my entries – for real 👀","hashtags":["#trading","crypto tools","btc"]}';
const s = u.parseScriptJson(reply);
check("script without dashes", !/[—–]/.test(s.script) && !/[—–]/.test(s.caption) && !/[—–]/.test(s.hook));
check("brackets stripped from script", !/[\[\]]/.test(s.script));
check("hashtags cleaned", s.hashtags.join(",") === "trading,cryptotools,btc");
check("word count", s.words === u.countWords(s.script));
check("post caption has tags", u.postCaption(s).endsWith("#trading #cryptotools #btc"));
let threw = false; try { u.parseScriptJson("no json here"); } catch { threw = true; }
check("missing JSON throws", threw);

// ── captions ──
const al = { characters: [..."Hi there, you."], character_start_times_seconds: [], character_end_times_seconds: [] };
al.characters.forEach((_, i) => { al.character_start_times_seconds.push(i * 0.1); al.character_end_times_seconds.push(i * 0.1 + 0.1); });
const w = u.wordsFromAlignment(al);
check("alignment to words", w.map(x => x.text).join("|") === "Hi|there,|you.");
check("word timings", Math.abs(w[1].start - 0.3) < 1e-9 && Math.abs(w[2].end - 1.4) < 1e-9);
const ev = u.wordsEvenly("one two three four", 4);
check("even words cover duration", Math.abs(ev[ev.length - 1].end - 4) < 1e-9);
check("chunks max 3, break on comma", u.chunkWords(w).map(c => c.length).join(",") === "2,1");
check("ass time format", u.assTime(3723.456) === "1:02:03.46");
const ass = u.buildAss({ words: w, width: 720, height: 1280, hook: "Stop {buying} tops" });
check("ass has play res", ass.includes("PlayResX: 720") && ass.includes("PlayResY: 1280"));
check("hook line uppercased, braces stripped", ass.includes("STOP BUYING TOPS"));
check("one event per spoken word", (ass.match(/,Cap,/g) || []).length === 3);
check("current word highlighted", ass.includes("{\\c&H00E6FF&}HI{\\c&H00FFFFFF&} THERE,"));

console.log(`\n${pass} ok, ${fail} FOUT`);
process.exit(fail ? 1 : 0);
