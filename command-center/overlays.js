// Overlay library: media files (logo, badge, frame, sticker, short clip) that
// get composited onto finished videos. Each overlay says for which video types
// it may be used. Selection is strict: an overlay is only ever used on a type
// that is ticked on it. No ticked type = never used. No fallback to other types.
"use strict";

// Video types that have a finishing step where overlays are applied.
const VIDEO_TYPES = {
  ugc: "UGC / talking avatar videos",
  character_batch: "gh0stlayer weekly batch clips",
};

const POSITIONS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right", "full"];
const MODES = ["always", "rotate"]; // always = on every video of the type; rotate = one per video from the pool
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const VIDEO_EXT = [".mp4", ".mov", ".webm"];
const MAX_PER_VIDEO = 3;

function kindOf(file) {
  const ext = String(file || "").toLowerCase().match(/\.[a-z0-9]+$/);
  if (!ext) return "";
  if (IMAGE_EXT.includes(ext[0])) return ext[0] === ".gif" ? "gif" : "image";
  if (VIDEO_EXT.includes(ext[0])) return "video";
  return "";
}

function num(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Clean user input (create/patch). Unknown types are dropped, so a typo can
// never widen where an overlay is used.
function normalize(input, prev = {}) {
  const b = input || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const o = { ...prev };
  if (has("name")) o.name = String(b.name || "").trim().slice(0, 80) || prev.name || "overlay";
  if (has("allowed_types")) {
    let t = b.allowed_types;
    if (typeof t === "string") t = t.split(",");
    o.allowed_types = [...new Set((Array.isArray(t) ? t : []).map(x => String(x).trim()).filter(x => VIDEO_TYPES[x]))];
  }
  if (has("position")) o.position = POSITIONS.includes(b.position) ? b.position : (prev.position || "top-right");
  if (has("mode")) o.mode = MODES.includes(b.mode) ? b.mode : (prev.mode || "always");
  if (has("scale")) o.scale = num(b.scale, prev.scale ?? 20, 5, 100);         // % of video width
  if (has("margin")) o.margin = num(b.margin, prev.margin ?? 4, 0, 20);       // % of video width
  if (has("opacity")) o.opacity = num(b.opacity, prev.opacity ?? 1, 0.05, 1);
  if (has("start")) o.start = num(b.start, prev.start ?? 0, 0, 600);           // seconds
  if (has("duration")) o.duration = num(b.duration, prev.duration ?? 0, 0, 600); // 0 = till the end
  if (has("enabled")) o.enabled = b.enabled === true || b.enabled === "true" || b.enabled === "1" || b.enabled === 1;
  return o;
}

function defaults() {
  return { allowed_types: [], position: "top-right", mode: "always", scale: 20, margin: 4, opacity: 1, start: 0, duration: 0, enabled: true };
}

// The overlays for one video of `type`. Only enabled overlays that list the
// type. All "always" ones, plus one from the "rotate" pool (least recently
// used first, random among equals).
function pickOverlays(list, type, { rand = Math.random, exists = () => true } = {}) {
  if (!VIDEO_TYPES[type]) return [];
  const ok = (Array.isArray(list) ? list : []).filter(o => o && o.enabled !== false
    && Array.isArray(o.allowed_types) && o.allowed_types.includes(type) && kindOf(o.file) && exists(o));
  const always = ok.filter(o => o.mode !== "rotate");
  const pool = ok.filter(o => o.mode === "rotate");
  const out = always.slice(0, MAX_PER_VIDEO);
  if (pool.length && out.length < MAX_PER_VIDEO) {
    const t = (o) => (o.last_used_at ? Date.parse(o.last_used_at) || 0 : 0);
    const min = Math.min(...pool.map(t));
    const cands = pool.filter(o => t(o) === min);
    out.push(cands[Math.floor(rand() * cands.length) % cands.length]);
  }
  return out;
}

function xyFor(position, marginPx) {
  const m = Math.round(marginPx);
  const X = { left: `${m}`, center: "(W-w)/2", right: `W-w-${m}` };
  const Y = { top: `${m}`, center: "(H-h)/2", bottom: `H-h-${m}` };
  const map = {
    "top-left": ["left", "top"], top: ["center", "top"], "top-right": ["right", "top"],
    left: ["left", "center"], center: ["center", "center"], right: ["right", "center"],
    "bottom-left": ["left", "bottom"], bottom: ["center", "bottom"], "bottom-right": ["right", "bottom"],
    full: ["center", "center"],
  };
  const [x, y] = map[position] || map["top-right"];
  return { x: X[x], y: Y[y] };
}

// ffmpeg arguments for: main video + overlays (+ optional extra video filter
// such as the ASS captions, applied last so captions sit on top).
// overlays: [{ path, kind, position, scale, margin, opacity, start, duration }]
function buildFfmpegArgs({ input, output, overlays = [], width = 1080, height = 1920, duration = 0, tailFilter = "", audio = "aac" }) {
  const args = ["-y", "-i", input];
  const parts = [];
  let prev = "[0:v]";
  overlays.forEach((o, i) => {
    const idx = i + 1;
    if (o.kind === "video") {
      if (/\.webm$/i.test(o.path)) args.push("-c:v", "libvpx-vp9"); // keeps the alpha channel
      args.push("-i", o.path);
    } else if (o.kind === "gif") args.push("-ignore_loop", "0", "-i", o.path);
    else args.push("-loop", "1", "-i", o.path);
    const start = Number(o.start) || 0;
    const end = Number(o.duration) > 0 ? start + Number(o.duration) : 0;
    const w = Math.max(2, Math.round(width * (Number(o.scale) || 20) / 100 / 2) * 2);
    const scale = o.position === "full" ? `scale=${width}:${height}:force_original_aspect_ratio=decrease` : `scale=${w}:-2`;
    const alpha = Number(o.opacity) < 1 ? `,colorchannelmixer=aa=${Number(o.opacity).toFixed(2)}` : "";
    const shift = start > 0 ? `,setpts=PTS-STARTPTS+${start}/TB` : ",setpts=PTS-STARTPTS";
    parts.push(`[${idx}:v]format=rgba,${scale}${alpha}${shift}[ov${idx}]`);
    const { x, y } = xyFor(o.position, width * (Number(o.margin) || 0) / 100);
    const enable = end ? `:enable='between(t,${start},${end})'` : (start ? `:enable='gte(t,${start})'` : "");
    const out = `[v${idx}]`;
    parts.push(`${prev}[ov${idx}]overlay=x=${x}:y=${y}:eof_action=pass:format=auto${enable}${out}`);
    prev = out;
  });
  if (tailFilter) { parts.push(`${prev}${tailFilter}[vout]`); prev = "[vout]"; }
  if (parts.length) args.push("-filter_complex", parts.join(";"), "-map", prev);
  else args.push("-map", "0:v");
  args.push("-map", "0:a?");
  if (duration > 0) args.push("-t", String(Math.round(duration * 1000) / 1000));
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p");
  if (audio === "copy") args.push("-c:a", "copy"); else args.push("-c:a", "aac", "-b:a", "160k");
  args.push("-movflags", "+faststart", output);
  return args;
}

module.exports = { VIDEO_TYPES, POSITIONS, MODES, MAX_PER_VIDEO, IMAGE_EXT, VIDEO_EXT, kindOf, normalize, defaults, pickOverlays, xyFor, buildFfmpegArgs };
