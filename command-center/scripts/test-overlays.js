// Tests for overlays.js (pure, no network, no ffmpeg).
"use strict";
const ov = require("../overlays");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok   " + m); } else { fail++; console.log("FOUT " + m); } };

// kindOf
ok(ov.kindOf("a.png") === "image", "png = image");
ok(ov.kindOf("a.GIF") === "gif", "gif = gif");
ok(ov.kindOf("a.webm") === "video", "webm = video");
ok(ov.kindOf("a.svg") === "", "svg niet toegestaan");
ok(ov.kindOf("noext") === "", "zonder extensie = leeg");

// normalize
const n = ov.normalize({ allowed_types: ["ugc", "bogus", "ugc"], scale: 500, opacity: -1, position: "nope", mode: "x", enabled: "false" }, ov.defaults());
ok(JSON.stringify(n.allowed_types) === '["ugc"]', "onbekende types vallen weg, dubbel weg");
ok(n.scale === 100 && n.opacity === 0.05, "scale/opacity begrensd");
ok(n.position === "top-right" && n.mode === "always", "ongeldige positie/modus = vorige");
ok(n.enabled === false, "enabled 'false' = false");
ok(JSON.stringify(ov.normalize({ allowed_types: "ugc,character_batch" }).allowed_types) === '["ugc","character_batch"]', "types als komma-string");
ok(ov.normalize({ allowed_types: [] }).allowed_types.length === 0, "lege types blijven leeg");
const keep = ov.normalize({ name: "x" }, { allowed_types: ["ugc"], scale: 30 });
ok(keep.scale === 30 && keep.allowed_types[0] === "ugc", "patch laat andere velden staan");

// pickOverlays: strict per type
const L = [
  { id: "a", file: "a.png", allowed_types: ["ugc"], mode: "always", enabled: true },
  { id: "b", file: "b.png", allowed_types: ["character_batch"], mode: "always", enabled: true },
  { id: "c", file: "c.png", allowed_types: [], mode: "always", enabled: true },
  { id: "d", file: "d.png", allowed_types: ["ugc"], mode: "always", enabled: false },
  { id: "e", file: "e.mp4", allowed_types: ["ugc"], mode: "rotate", enabled: true, last_used_at: "2026-11-10T00:00:00Z" },
  { id: "f", file: "f.webm", allowed_types: ["ugc"], mode: "rotate", enabled: true },
  { id: "g", file: "g.svg", allowed_types: ["ugc"], mode: "always", enabled: true },
];
const u = ov.pickOverlays(L, "ugc", { rand: () => 0 }).map(o => o.id);
ok(u.includes("a"), "ugc: always-overlay mee");
ok(!u.includes("b"), "ugc: overlay van ander type NIET mee");
ok(!u.includes("c"), "overlay zonder types nooit gebruikt");
ok(!u.includes("d"), "uitgeschakelde overlay niet mee");
ok(!u.includes("g"), "onbekend bestandstype niet mee");
ok(u.includes("f") && !u.includes("e"), "rotate: minst recent gebruikte wint");
ok(u.length === 2, "rotate: precies één uit de pool");
const cb = ov.pickOverlays(L, "character_batch").map(o => o.id);
ok(cb.length === 1 && cb[0] === "b", "character_batch krijgt alleen zijn eigen overlay");
ok(ov.pickOverlays(L, "aigen").length === 0, "onbekend videotype = niets");
ok(ov.pickOverlays(L, "ugc", { exists: o => o.id !== "a" }).every(o => o.id !== "a"), "ontbrekend bestand wordt overgeslagen");
ok(ov.pickOverlays([], "ugc").length === 0, "lege lijst = niets");
const many = Array.from({ length: 6 }, (_, i) => ({ id: "m" + i, file: "m.png", allowed_types: ["ugc"], mode: "always" }));
ok(ov.pickOverlays(many, "ugc").length === ov.MAX_PER_VIDEO, "max overlays per video");

// xyFor
ok(ov.xyFor("top-right", 40).x === "W-w-40" && ov.xyFor("top-right", 40).y === "40", "rechtsboven");
ok(ov.xyFor("bottom", 10).x === "(W-w)/2", "onder midden");
ok(ov.xyFor("bottom", 10).y === "H-h-10", "onder");

// buildFfmpegArgs
const args = ov.buildFfmpegArgs({
  input: "in.mp4", output: "out.mp4", width: 1080, height: 1920,
  overlays: [
    { path: "/x/logo.png", kind: "image", position: "top-right", scale: 20, margin: 4, opacity: 0.8, start: 0, duration: 0 },
    { path: "/x/s.webm", kind: "video", position: "bottom", scale: 50, margin: 2, opacity: 1, start: 2, duration: 3 },
  ],
  duration: 12.3456, tailFilter: "ass=x.ass",
});
const fc = args[args.indexOf("-filter_complex") + 1];
ok(args.includes("-loop") && args.includes("libvpx-vp9"), "afbeelding loopt, webm met vp9-decoder");
ok(/scale=216:-2/.test(fc), "breedte = 20% van 1080");
ok(/colorchannelmixer=aa=0\.80/.test(fc), "opacity toegepast");
ok(/between\(t,2,5\)/.test(fc), "tijdvenster start 2 + 3 s");
ok(/\[v2\]ass=x\.ass\[vout\]/.test(fc), "captions komen als laatste (bovenop)");
ok(args[args.indexOf("-map") + 1] === "[vout]", "eindlabel wordt gemapt");
ok(args.includes("0:a?"), "audio optioneel gemapt");
ok(args[args.indexOf("-t") + 1] === "12.346", "lengte begrensd op de hoofdvideo");
ok(args[args.length - 1] === "out.mp4", "output als laatste");
const plain = ov.buildFfmpegArgs({ input: "i", output: "o" });
ok(!plain.includes("-filter_complex") && plain.includes("0:v"), "zonder overlays geen filter");
ok(ov.buildFfmpegArgs({ input: "i", output: "o", audio: "copy" }).join(" ").includes("-c:a copy"), "audio copy-optie");

// trim (in-point) for video overlays
const tr = ov.buildFfmpegArgs({ input: "i", output: "o", overlays: [{ path: "/x/c.mp4", kind: "video", position: "full", scale: 100, opacity: 1, start: 9, duration: 8, trim: 1 }] });
const tfc = tr[tr.indexOf("-filter_complex") + 1];
ok(/\[1:v\]trim=start=1,format=rgba/.test(tfc), "video-overlay begint 1 s later (trim)");
ok(/between\(t,9,17\)/.test(tfc), "cutaway-venster 9 t/m 17 s");
const ti = ov.buildFfmpegArgs({ input: "i", output: "o", overlays: [{ path: "/x/l.png", kind: "image", trim: 2 }] });
ok(!/trim=/.test(ti[ti.indexOf("-filter_complex") + 1]), "trim geldt niet voor afbeeldingen");
ok(ov.normalize({ trim: 3 }).trim === 3, "trim via normalize");

console.log(`\n${pass} ok, ${fail} FOUT`);
process.exit(fail ? 1 : 0);
