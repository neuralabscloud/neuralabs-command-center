// UGC autopilot — pure helpers for the scheduled talking-avatar pipeline:
// the Marketeer writes a short testimonial script, the Content Creator picks an
// avatar + a matching voice, renders it (Higgsfield speak) and burns captions.
// Everything here is free of network and disk so it can be tested offline.

// ── Avatar + voice matching ─────────────────────────────────────────
// Gender comes from an explicit field when set, otherwise from the portrait
// prompt the avatar was generated with ("A 42-year-old man ...").
function inferGender(avatar) {
  const g = String((avatar && avatar.gender) || "").toLowerCase();
  if (g === "male" || g === "female") return g;
  const p = String((avatar && avatar.prompt) || "").toLowerCase();
  if (/\b(woman|women|female|girl|lady)\b/.test(p)) return "female";
  if (/\b(man|men|male|guy|boy|gentleman)\b/.test(p)) return "male";
  return "";
}

function inferAge(avatar) {
  if (avatar && Number(avatar.age) > 0) return Number(avatar.age);
  const m = String((avatar && avatar.prompt) || "").match(/(\d{2})[- ]year[- ]old/i);
  return m ? Number(m[1]) : 0;
}

// ElevenLabs age labels: young / middle_aged / old.
function ageBucket(age) {
  if (!age) return "";
  return age < 36 ? "young" : age < 60 ? "middle_aged" : "old";
}

function hashString(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Pick a voice whose gender matches the avatar. `seed` (the avatar id) makes
// the choice stable, so the same face always gets the same voice.
function pickVoice(voices, { gender, age, seed = "" } = {}) {
  const list = (voices || []).filter(v => {
    const l = v.labels || {};
    if (gender && String(l.gender || "").toLowerCase() !== gender) return false;
    if (l.language && String(l.language).toLowerCase() !== "en") return false;
    return l.use_case !== "characters_animation";
  });
  if (!list.length) return null;
  const bucket = ageBucket(age);
  const score = (v) => {
    const l = v.labels || {};
    let s = 0;
    if (bucket && l.age === bucket) s += 3; // age outweighs style: a 45-year-old should not sound 20
    if (["conversational", "social_media"].includes(l.use_case)) s += 2;
    if (l.accent === "american") s += 1;
    return s;
  };
  const best = Math.max(...list.map(score));
  const top = list.filter(v => score(v) === best).sort((a, b) => String(a.voice_id).localeCompare(String(b.voice_id)));
  return top[hashString(seed) % top.length];
}

// Ready avatars with a known gender. A preferred id wins (even when excluded);
// otherwise the avatar used least recently (recentIds: newest first) so the feed
// rotates faces. Avatars with autopilot_exclude never enter the rotation.
function pickAvatar(avatars, recentIds = [], preferredId = "") {
  const ready = (avatars || []).filter(a => a.status === "ready" && a.image_url && inferGender(a));
  if (preferredId) {
    const hit = ready.find(a => a.id === preferredId);
    if (hit) return hit;
  }
  const usable = ready.filter(a => !a.autopilot_exclude);
  if (!usable.length) return null;
  const rank = (a) => { const i = recentIds.indexOf(a.id); return i === -1 ? Infinity : i; };
  return usable.slice().sort((a, b) => rank(b) - rank(a))[0];
}

// Short persona line for the script writer, taken from the portrait prompt.
function personaFor(avatar) {
  const gender = inferGender(avatar);
  const age = inferAge(avatar);
  const scene = String(avatar.prompt || "").replace(/\s+/g, " ").slice(0, 400);
  return `${avatar.name || "Avatar"}, ${age ? age + "-year-old " : ""}${gender || "person"}. Portrait: ${scene}`;
}

// ── Script writing ──────────────────────────────────────────────────
const WORDS_MIN = 38, WORDS_MAX = 72; // ≈ 15-30 s of natural speech

function buildScriptPrompt({ focus, persona, recentHooks = [], brandKnowledge = "", feedback = "", previous = "" }) {
  const avoid = recentHooks.filter(Boolean).slice(0, 12);
  return `You write scripts for short UGC talking-head videos (TikTok / Instagram Reels). A real-looking person talks straight into their phone camera.

WHAT TO PROMOTE
${focus || "The brand's main product(s), as described in the brand knowledge."}
The video is a personal recommendation: the speaker already uses the product, tells what it concretely helps them with, and recommends it to people like them. It must feel like a genuine creator talking to a friend, never like an ad read.
${brandKnowledge}

THE SPEAKER
${persona}
Write in their voice. Match age and vibe. First person.

LENGTH
Spoken length 15 to 30 seconds: ${WORDS_MIN + 7} to ${WORDS_MAX - 7} words, hard limits ${WORDS_MIN} and ${WORDS_MAX}.

RETENTION STRUCTURE
1. Hook (first sentence, under 2 seconds, max 10 words): a pattern interrupt. Use a bold claim, a confession, a "stop doing X", a surprising number that is allowed by the brand knowledge, or a question the viewer can't ignore. No greeting, no "hey guys", no brand name in the hook.
2. Open loop: tease the payoff so they keep watching.
3. The problem in one relatable sentence (the pain before the product).
4. The turn: one specific product or feature and exactly what it does for them. Concrete beats vague.
5. Proof in their own experience (a feeling or a routine change). Never invent results, returns, prices or features that are not in the brand knowledge. No promises of profit. No financial advice.
6. Soft CTA with a reason: e.g. "link's in my bio", "check it before your next trade".
Short spoken sentences, contractions, natural rhythm. Write numbers the way they are spoken.
Make it sound like a real person, not a script: an occasional natural filler ("honestly", "like", "I mean"), a self-correction or a short pause sentence is fine. The LAST sentence is the last thing said: no trailing "bye" or filler after the CTA.

STYLE RULES (hard)
- English only.
- Never use em dashes or en dashes anywhere. Use periods, commas or line breaks.
- No emojis and no hashtags inside the script.
- No stage directions, no brackets, no speaker labels. Only the words that are spoken.
${feedback ? `\nREVISION REQUEST FROM THE OWNER (follow this exactly):\n${feedback}\n${previous ? `Previous script that needs changing:\n${previous}\n` : ""}` : ""}${avoid.length ? `\nHOOKS ALREADY USED (write something clearly different):\n${avoid.map(h => "- " + h).join("\n")}\n` : ""}
OUTPUT
Return ONLY a JSON object, no prose around it:
{
  "angle": "3 to 6 words naming the angle",
  "hook": "the first sentence, exactly as spoken",
  "on_screen_hook": "max 6 words shown as a title for the first seconds, punchy, can differ from the spoken hook",
  "script": "the full spoken script including the hook",
  "caption": "Instagram Reels / TikTok caption: 1 to 3 short lines, each on its own line (newline between them), a curiosity line plus a CTA, max 220 characters, no dashes, max 2 emojis",
  "hashtags": ["5 to 8 relevant hashtags without the # sign"]
}`;
}

function stripDashes(s, replacement) {
  return String(s || "").replace(/\s*[—–]\s*/g, replacement);
}

function countWords(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

// Parse and clean the writer's JSON. Throws when the essentials are missing.
function parseScriptJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in script reply");
  const j = JSON.parse(raw.slice(start, end + 1));
  const script = stripDashes(j.script, ", ").replace(/[\[\]()*_#]/g, "").replace(/\s+/g, " ").trim();
  if (!script) throw new Error("script is empty");
  const tags = (Array.isArray(j.hashtags) ? j.hashtags : String(j.hashtags || "").split(/[\s,]+/))
    .map(t => String(t).replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean).slice(0, 8);
  const caption = stripDashes(j.caption, ". ").trim();
  return {
    angle: stripDashes(j.angle, " ").trim(),
    hook: stripDashes(j.hook || script.split(/(?<=[.!?])\s/)[0], ", ").trim(),
    on_screen_hook: stripDashes(j.on_screen_hook, " ").trim().split(/\s+/).slice(0, 7).join(" "),
    script,
    caption,
    hashtags: tags,
    words: countWords(script),
  };
}

// Every line its own paragraph: on X and Instagram single line breaks
// otherwise read as one crammed block.
function spaceLines(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/([^\n])\n(?=[^\n])/g, "$1\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function postCaption(s) {
  const tags = (s.hashtags || []).map(t => "#" + t).join(" ");
  return [spaceLines(s.caption), tags].filter(Boolean).join("\n\n");
}

// ── Captions ────────────────────────────────────────────────────────
// ElevenLabs /with-timestamps alignment → words with start/end seconds.
function wordsFromAlignment(al) {
  const chars = (al && al.characters) || [];
  const st = (al && al.character_start_times_seconds) || [];
  const en = (al && al.character_end_times_seconds) || [];
  const words = [];
  let cur = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { text: "", start: Number(st[i]) || 0, end: Number(en[i]) || 0 };
    cur.text += c;
    cur.end = Number(en[i]) || cur.end;
  }
  if (cur) words.push(cur);
  return words;
}

// Fallback without timestamps: spread words over the duration by length.
function wordsEvenly(script, duration) {
  const parts = String(script || "").trim().split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, w) => n + w.length + 1, 0) || 1;
  let t = 0;
  return parts.map(w => {
    const d = (duration * (w.length + 1)) / total;
    const word = { text: w, start: t, end: t + d };
    t += d;
    return word;
  });
}

// Groups of max 3 words; a sentence end or comma closes a group early.
function chunkWords(words, max = 3) {
  const chunks = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= max || /[.!?,;:]$/.test(w.text)) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function assEscape(s) {
  return String(s).replace(/\\/g, "").replace(/[{}]/g, "").replace(/\n/g, " ");
}

// Word-by-word captions (TikTok style): chunks of up to 3 words in bold caps,
// the word being spoken highlighted, a short pop on each new chunk. Optional
// title with the hook at the top for the first seconds.
function buildAss({ words, width = 1080, height = 1920, hook = "", hookSeconds = 3, font = "Montserrat ExtraBold", highlight = "&H00E6FF&" }) {
  const fs = Math.round(width * 0.078);
  const outline = Math.max(3, Math.round(width * 0.006));
  const hookFs = Math.round(width * 0.062);
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${font},${fs},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},${Math.round(outline / 2)},2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${Math.round(height * 0.3)},1`,
    `Style: Hook,${font},${hookFs},&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,${Math.round(hookFs * 0.35)},0,8,${Math.round(width * 0.1)},${Math.round(width * 0.1)},${Math.round(height * 0.13)},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (hook) {
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(hookSeconds)},Hook,,0,0,0,,{\\fad(0,250)}${assEscape(hook).toUpperCase()}`);
  }
  const chunks = chunkWords(words || []);
  chunks.forEach((chunk, ci) => {
    const next = chunks[ci + 1];
    const chunkEnd = next ? Math.min(next[0].start, chunk[chunk.length - 1].end + 0.6) : chunk[chunk.length - 1].end + 0.4;
    chunk.forEach((w, wi) => {
      const start = w.start;
      const end = wi < chunk.length - 1 ? chunk[wi + 1].start : chunkEnd;
      if (end <= start) return;
      const text = chunk.map((x, xi) => {
        const t = assEscape(x.text).toUpperCase();
        return xi === wi ? `{\\c${highlight}}${t}{\\c&H00FFFFFF&}` : t;
      }).join(" ");
      const pop = wi === 0 ? "{\\fscx112\\fscy112\\t(0,90,\\fscx100\\fscy100)}" : "";
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${pop}${text}`);
    });
  });
  return lines.join("\n") + "\n";
}

// ── NeuraShield preset ──────────────────────────────────────────────
// Weekly UGC about NeuraShield. Every video tells one personal story (rotating,
// least recently used first) and then explains what NeuraShield does. FACTS is
// the ONLY source of claims the writer may use (from neuralabscapital.com/neurashield).
const NEURASHIELD_FACTS = `NEURASHIELD FACTS (the only claims you may make):
- NeuraShield is a small macOS menu-bar app (about 1.5 MB). Works on macOS 13 or newer, Apple silicon and Intel. Free download at neuralabscapital.com/neurashield. Trusted by 700+ crypto users. Windows version is coming soon (not available yet).
- Guards (all free):
  * Fake installers: warns when an app is a look-alike of Zoom, Teams, Ledger Live, Trezor Suite, TradingView, MetaTrader, ChatGPT or Telegram, by checking the Apple Developer ID and notarization before you open it.
  * Clipboard: catches "ClickFix" tricks (a website telling you to paste a command in Terminal) and base64 commands; clears seed phrases and private keys from the clipboard after 60 seconds; warns when a wallet address in the clipboard is swapped (clipper malware, address poisoning) by checking it against your trusted addresses; flags look-alike meeting links.
  * Startup hijacks: shows new LaunchAgents, login items, shell profile and git hook changes, removable in one click.
  * Fake password prompts: calls out fake macOS password pop-ups.
- Tools: Check a link, Check a file, Exposure scan, Trusted addresses (5 free), and the free "I think this Mac is infected" incident check (deletes nothing, writes a report).
- Privacy: nothing leaves your Mac. The free version makes no network connections.
- Premium (EUR 9.99 a month or 59.99 a year) adds a tampered-wallet-app guard and includes NeuraTrade. You do NOT need Premium to be protected; all core guards are free.
NEVER SAY: that it stops all malware or makes you 100% safe, that it is an antivirus or replaces one (it works alongside antivirus), real-time scanning, that it works on iPhone, Android, Windows or in the browser, that Premium is needed for safety, any number or result not listed here, or that NeuraShield could have recovered lost funds.`;

const NEURASHIELD_STORIES = [
  { id: "fake_zoom", title: "Hacked via a fake Zoom installer",
    story: "Got a 'meeting invite' from a so-called investor, the link said Zoom needed an update, downloaded the installer, typed the Mac password. A few days later the hot wallet was drained. Wishes they had known NeuraShield checks installers (Developer ID, notarization) and flags Zoom look-alikes." },
  { id: "clickfix", title: "ClickFix: pasted a command into Terminal",
    story: "A website showed a fake 'verify you are human' check and told them to paste a line into Terminal. They did it without thinking. That command installed a stealer. NeuraShield flags ClickFix commands and base64 commands in the clipboard before you paste them." },
  { id: "clipper", title: "Wallet address swapped in the clipboard",
    story: "Copied their own exchange deposit address, pasted it, sent the funds. The address had been swapped by clipper malware, the first and last characters looked the same. Money gone. NeuraShield checks clipboard addresses against your trusted addresses and warns when one is swapped." },
  { id: "fake_password", title: "Fake macOS password prompt",
    story: "A pop-up that looked exactly like macOS asked for the Mac password 'to finish an update'. It was fake and gave a stealer what it needed to open the keychain. NeuraShield calls out fake password prompts." },
  { id: "seed_clipboard", title: "Seed phrase left in the clipboard",
    story: "Copied a seed phrase once to back it up and forgot it was still in the clipboard. Something on the Mac read it later. NeuraShield clears seed phrases and private keys from the clipboard after 60 seconds." },
  { id: "launchagent", title: "Something hiding in startup",
    story: "The Mac felt normal, but a hidden LaunchAgent started every time they logged in and kept stealing sessions. They only found it weeks later. NeuraShield shows new LaunchAgents and login items and removes them in one click." },
  { id: "fake_meeting", title: "Look-alike meeting link",
    story: "A 'Teams' link from a recruiter on Telegram was one letter off. It asked to install an app to join. NeuraShield flags look-alike meeting links and fake Teams installers." },
  { id: "near_miss", title: "The near miss",
    story: "Was about to install a 'Ledger Live update' from a link in an email. NeuraShield popped up and said the app was not from the real developer. Deleted it. Tells the story of how close it was, from the point of view of someone who now uses it daily." },
  { id: "friend_hacked", title: "My friend got hacked, so I installed it",
    story: "A close friend lost their savings after downloading a fake TradingView installer. The speaker got scared, checked their own Mac with the free 'I think this Mac is infected' check and now keeps NeuraShield in the menu bar." },
];

// Least recently used story (recentIds newest first). A preferred id wins.
function pickStory(recentIds = [], preferredId = "", stories = NEURASHIELD_STORIES) {
  if (preferredId) { const hit = stories.find(s => s.id === preferredId); if (hit) return hit; }
  const rank = (s) => { const i = recentIds.indexOf(s.id); return i === -1 ? Infinity : i; };
  return stories.slice().sort((a, b) => rank(b) - rank(a))[0];
}

// Scene prompt for the talking-avatar render: handheld phone selfie, real room,
// natural light, so it reads as a real person and not a studio avatar.
function sceneFor(avatar, story) {
  const worried = story && story.id !== "near_miss";
  return [
    "Ultra realistic handheld vertical smartphone selfie video, filmed by the person themself at arm's length.",
    "Natural daylight from a window, real lived-in room at home, slight natural handheld camera sway, subtle autofocus.",
    `The person talks directly into the phone camera like a real creator, ${worried ? "sincere and a bit frustrated, telling a personal story" : "relieved and honest, telling a personal story"}.`,
    "Natural blinking, small head movements, natural micro expressions, realistic skin texture, lips in sync with speech.",
    "No text, no subtitles, no logos, no studio lighting, no background music.",
  ].join(" ");
}

// Talking-avatar renders: microphones and other props must stay put. Kling
// otherwise glues a mic to the head and it moves along with it (16-11).
const STILL_PROPS = "Any microphone, mic stand, pop filter, headphones on a stand or other object in the scene stays completely still and fixed in place, it is not attached to the person and does not move with the head or body.";
function withStillProps(prompt) {
  const p = String(prompt || "").trim();
  if (!p || p.includes(STILL_PROPS)) return p;
  return p + " " + STILL_PROPS;
}

function neurashieldFocus(story) {
  return `NeuraShield, a free macOS security app for crypto users (neuralabscapital.com/neurashield).
THE STORY THIS VIDEO TELLS (first person, as if it happened to the speaker or someone close to them): ${story.title}. ${story.story}
Structure: start with the moment it went wrong (or almost did), make the viewer feel it, then explain in plain words what NeuraShield does that would have caught it (one or two concrete guards), mention it is free and stays on your Mac, end with a soft CTA ("link's in my bio" or "it's free, just get it").
Do not dramatise beyond the story. Do not name a real person. Do not give amounts unless they are vague ("my savings", "everything on that wallet").
${NEURASHIELD_FACTS}`;
}

// Where the overlay library clip plays as a cutaway: from ~38% of the speech
// for up to 8 s, and always ending at least 3 s before the last word so the
// speaker closes the video on camera.
function overlayCutaway(speechEnd, { at = 0.38, maxLen = 8, tail = 3, minLen = 2.5 } = {}) {
  const end = Number(speechEnd) || 0;
  if (end <= 0) return null;
  const start = Math.max(1.5, Math.round(end * at * 10) / 10);
  const len = Math.min(maxLen, end - tail - start);
  if (len < minLen) return null;
  return { start, duration: Math.round(len * 10) / 10 };
}

// Final video length: right after the last spoken word (no dead air).
function trimEnd(words, pad = 0.15) {
  const w = (words || []).filter(x => Number.isFinite(x.end));
  if (!w.length) return 0;
  return Math.round((w[w.length - 1].end + pad) * 1000) / 1000;
}

module.exports = {
  inferGender, inferAge, ageBucket, pickVoice, pickAvatar, personaFor,
  buildScriptPrompt, parseScriptJson, postCaption, spaceLines, countWords, stripDashes,
  wordsFromAlignment, wordsEvenly, chunkWords, buildAss, assTime,
  WORDS_MIN, WORDS_MAX,
  NEURASHIELD_FACTS, NEURASHIELD_STORIES, pickStory, sceneFor, STILL_PROPS, withStillProps, neurashieldFocus, overlayCutaway, trimEnd,
};
