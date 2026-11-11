// Rip shorts pipeline: upload → normalize → analyze → edit → script → voice →
// mix → captions → final → post, plus review, revisions and publishing
// (Instagram Reels via the Graph API, X via the v2 chunked upload).
// Pure helpers live in rips.js. Brand specifics come from data/rips-config.json.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const R = require("./rips");

const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB
const UPLOAD_EXT = new Set(["mp4", "mov"]);
const W = 1080, H = 1920, FPS = 30;
const VISION_MODEL = () => process.env.RIPS_VISION_MODEL || "claude-sonnet-5-5";
const SCRIPT_MODEL = () => process.env.RIPS_SCRIPT_MODEL || "claude-opus-5-5";
const PLAN_KEYS = Object.keys(R.DEFAULT_PLAN);

function createRips(deps) {
  const {
    rootDir, anthropic, apiUsage, readChannels, readSocial, writeSocial,
    twitterCreds, twitterApi, twitterUploadFile, twitterUsageSummary, bumpTwitterUsage,
    knownPublicOrigin, sessionSecret, sendTelegram, writeEnvFile, fontsDir, listElevenVoices,
    GRAPH = "https://graph.facebook.com/v21.0",
  } = deps;

  const DATA = path.join(rootDir, "data");
  const BASE = path.join(DATA, "rips");
  const UPLOADS = path.join(BASE, "uploads");
  const OUT = path.join(BASE, "out");
  const JOBS_FILE = path.join(DATA, "rips-tasks.json");
  const CONFIG_FILE = path.join(DATA, "rips-config.json");
  const LOG_FILE = path.join(rootDir, "logs", "rips.log");
  const TOKEN_FILE = path.join(BASE, "ig-token-status.json");
  for (const d of [BASE, UPLOADS, OUT]) fs.mkdirSync(d, { recursive: true });

  let redact = R.makeRedactor(process.env);
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${redact(msg)}\n`;
    try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line); } catch {}
  };

  function config() {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
    return {
      brand: "", tool_name: "", channel_id: "", ig_account: "", voice_env: "RIPS_VOICE_ID",
      voice_hint: "", logo_path: "", hashtag_pool: [], post_lines: ["AI voice."], niche: "trading card pack openings",
      ...c,
    };
  }

  // ── job store ──────────────────────────────────────────────────────────
  function readJobs() { try { return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8")); } catch { return []; } }
  function writeJobs(jobs) { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); }
  function getJob(id) { return readJobs().find(j => j.id === id) || null; }
  function updateJob(id, fn) {
    const jobs = readJobs(); const j = jobs.find(x => x.id === id);
    if (!j) return null;
    fn(j); j.updated_at = new Date().toISOString();
    writeJobs(jobs); return j;
  }
  function jobLog(id, msg) {
    log(`${id} ${msg}`);
    updateJob(id, j => { j.log = [...(j.log || []), { t: new Date().toISOString(), msg: redact(msg) }].slice(-50); });
  }
  function setStatus(id, status, extra = {}) {
    return updateJob(id, j => {
      if (j.status !== status && !R.canMove(j.status, status)) log(`${id} unusual status move ${j.status} → ${status}`);
      j.status = status; Object.assign(j, extra);
    });
  }
  const genId = () => "rip_" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
  const workDir = (id) => path.join(BASE, id);
  const vDir = (id, n) => path.join(BASE, id, `v${n}`);
  const outDir = (id, n) => path.join(OUT, id, `v${n}`);
  const finalPath = (id, n) => path.join(outDir(id, n), `${id}_final.mp4`);
  const version = (j, n) => (j.versions || []).find(v => v.n === Number(n));

  // ── process helpers ────────────────────────────────────────────────────
  function run(cmd, args, { timeout = 15 * 60 * 1000, stdout = false } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      const out = []; let outLen = 0; let err = "";
      p.stdout.on("data", d => { if (stdout && outLen < 200e6) { out.push(d); outLen += d.length; } });
      p.stderr.on("data", d => { err += d; if (err.length > 30e6) err = err.slice(-20e6); });
      const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeout);
      p.on("error", e => { clearTimeout(timer); reject(e); });
      p.on("close", code => {
        clearTimeout(timer);
        if (code === 0) return resolve({ stderr: err, stdout: Buffer.concat(out) });
        const tail = err.trim().split("\n").slice(-4).join(" | ");
        reject(new Error(`${cmd} failed (${code}): ${redact(tail)}`));
      });
    });
  }
  const ff = (args, opts) => run("ffmpeg", ["-hide_banner", "-y", "-nostdin", ...args], opts);

  async function probe(file) {
    const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { stdout: true, timeout: 60000 });
    const d = JSON.parse(stdout.toString() || "{}");
    const v = (d.streams || []).find(s => s.codec_type === "video");
    const a = (d.streams || []).find(s => s.codec_type === "audio");
    let w = v ? Number(v.width) : 0, h = v ? Number(v.height) : 0;
    const rot = Math.abs(Number((v && v.tags && v.tags.rotate) || (v && (v.side_data_list || []).find(s => s.rotation != null) || {}).rotation || 0));
    if (rot === 90 || rot === 270) [w, h] = [h, w];
    return { width: w, height: h, duration: Number((d.format && d.format.duration) || (v && v.duration) || 0), hasAudio: !!a, hasVideo: !!v };
  }

  // ── Claude helper ──────────────────────────────────────────────────────
  function parseJson(text) {
    const s = String(text || "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("no JSON object in reply");
    return JSON.parse(s.slice(a, b + 1));
  }
  async function claudeJson({ model, system, content, maxTokens = 8000 }) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const stream = anthropic.messages.stream({
          model, max_tokens: maxTokens, thinking: { type: "adaptive" }, system,
          messages: [{ role: "user", content: attempt ? [...content, { type: "text", text: "Reply with one JSON object only." }] : content }],
        });
        const msg = await stream.finalMessage();
        const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        return parseJson(text);
      } catch (e) { lastErr = e; log(`claude ${model} attempt ${attempt + 1} failed: ${e.message}`); }
    }
    throw lastErr;
  }
  const img = (file) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(file).toString("base64") } });

  // ── uploads ────────────────────────────────────────────────────────────
  const upMeta = (id) => path.join(UPLOADS, `${id}.json`);
  function readUpload(id) {
    if (!/^up_[a-z0-9]+$/.test(String(id))) return null;
    try { return JSON.parse(fs.readFileSync(upMeta(id), "utf8")); } catch { return null; }
  }
  function writeUpload(u) { fs.writeFileSync(upMeta(u.id), JSON.stringify(u, null, 2)); }

  // ══════════════════════════════════════════════════════════════════════
  // Pipeline steps
  // ══════════════════════════════════════════════════════════════════════

  async function cropDetect(file, info) {
    const ss = Math.max(0, info.duration / 2 - 5);
    const { stderr } = await ff(["-ss", String(ss), "-t", "10", "-i", file, "-vf", "cropdetect=24:2:0", "-f", "null", "-"], { timeout: 120000 });
    const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    if (!all.length) return null;
    const [, cw, ch, cx, cy] = all[all.length - 1].map(Number);
    if (cw < 64 || ch < 64) return null;
    // only crop real bars (more than 2% of a side)
    if (cw >= info.width * 0.98 && ch >= info.height * 0.98) return null;
    return { w: cw, h: ch, x: cx, y: cy };
  }

  async function normalizeClip(src, dst, wav, label) {
    const info = await probe(src);
    if (!info.hasVideo || !(info.duration > 1)) throw new Error(`${label} clip has no usable video`);
    const crop = await cropDetect(src, info);
    const cw = crop ? crop.w : info.width, chh = crop ? crop.h : info.height;
    const pre = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "";
    let vf;
    if (chh >= cw) {
      vf = `[0:v]${pre}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p[v]`;
    } else {
      vf = `[0:v]${pre}split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:2,eq=brightness=-0.08[bg];` +
        `[b]scale=${W}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS},format=yuv420p[v]`;
    }
    await ff(["-i", src, "-filter_complex", vf, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", dst]);
    if (info.hasAudio) {
      await ff(["-i", src, "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", wav]);
    } else {
      await ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(info.duration), "-c:a", "pcm_s16le", wav]);
    }
    const out = await probe(dst);
    return { source: { width: info.width, height: info.height, duration: R.r2(info.duration), has_audio: info.hasAudio }, crop, layout: chh >= cw ? "cover" : "blur_bg", duration: R.r2(out.duration) };
  }

  async function stepNormalize(job) {
    const wd = workDir(job.id); fs.mkdirSync(wd, { recursive: true });
    const res = {};
    for (const kind of ["pull", "market"]) {
      res[kind] = await normalizeClip(job.uploads[kind].path, path.join(wd, `${kind}.mp4`), path.join(wd, `${kind}.wav`), kind);
      jobLog(job.id, `normalize ${kind}: ${res[kind].layout}, ${res[kind].duration}s${res[kind].crop ? ", cropped bars" : ""}`);
    }
    updateJob(job.id, j => { j.normalized = res; });
  }

  async function sceneChanges(file) {
    const { stderr } = await ff(["-i", file, "-vf", "scdet=t=8", "-f", "null", "-"], { timeout: 300000 });
    const t = [...stderr.matchAll(/lavfi\.scd\.time[:=]\s*([\d.]+)/g)].map(m => R.r2(Number(m[1])));
    return [...new Set(t)].slice(0, 60);
  }

  async function audioOnsets(wav) {
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", wav, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { stdout: true, timeout: 120000 });
    const win = 400; const rms = [];
    for (let i = 0; i + win * 2 <= stdout.length; i += win * 2) {
      let s = 0; for (let k = 0; k < win; k++) { const v = stdout.readInt16LE(i + k * 2) / 32768; s += v * v; }
      rms.push(Math.sqrt(s / win));
    }
    const onsets = [];
    for (let i = 10; i < rms.length; i++) {
      const prev = rms.slice(i - 10, i).reduce((a, b) => a + b, 0) / 10;
      if (rms[i] > 0.02 && rms[i] > prev * 2.5 && (!onsets.length || i * 0.05 - onsets[onsets.length - 1].t > 0.4)) onsets.push({ t: R.r2(i * 0.05), level: R.r2(rms[i]) });
    }
    return onsets.sort((a, b) => b.level - a.level).slice(0, 25).sort((a, b) => a.t - b.t);
  }

  async function extractFrames(file, dir, prefix, { from = 0, dur, fps, width }) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.startsWith(prefix + "_")) fs.unlinkSync(path.join(dir, f));
    await ff(["-ss", String(from), ...(dur ? ["-t", String(dur)] : []), "-i", file, "-vf", `fps=${fps},scale=${width}:-2`, "-q:v", "4", path.join(dir, `${prefix}_%03d.jpg`)], { timeout: 300000 });
    return fs.readdirSync(dir).filter(f => f.startsWith(prefix + "_")).sort()
      .map((f, i) => ({ file: path.join(dir, f), t: R.r2(from + i / fps) }));
  }
  async function frameAt(file, t, out, width = 720) {
    await ff(["-ss", String(Math.max(0, t)), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", out], { timeout: 60000 });
    return { file: out, t: R.r2(t) };
  }
  const framesContent = (frames) => frames.flatMap(f => [{ type: "text", text: `frame t=${f.t.toFixed(2)}s` }, img(f.file)]);

  const NULL_RULE = "Any value you cannot read clearly on screen MUST be null. Never guess or invent a number, name or grade.";

  async function analyzePull(job, cfg) {
    const wd = workDir(job.id); const fd = path.join(wd, "frames");
    const file = path.join(wd, "pull.mp4");
    const dur = (await probe(file)).duration;
    const scenes = await sceneChanges(file);
    const onsets = await audioOnsets(path.join(wd, "pull.wav"));
    const fps1 = Math.min(1, 90 / dur);
    const p1 = await extractFrames(file, fd, "p1", { fps: fps1, width: 360 });
    const system = `You analyze screen recordings of ${cfg.niche}. The recording shows a digital pack opening: loading screens, the pack, then the card reveal (the moment the pulled card is first fully visible). ${NULL_RULE} Reply with one JSON object.`;
    const a1 = await claudeJson({
      model: VISION_MODEL(), system, maxTokens: 6000,
      content: [
        { type: "text", text: `Pull clip, ${R.r2(dur)} s. Scene changes at: ${scenes.join(", ") || "none"}. Loud audio onsets at: ${onsets.map(o => o.t).join(", ") || "none"}.\nFrames follow.` },
        ...framesContent(p1),
        { type: "text", text: `Return {"pack_start": seconds when the pack opening starts (after menus/loading) or null, "reveal_t": seconds when the pulled card is first fully visible or null, "platform": "courtyard" | "collector_crypt" | null}` },
      ],
    });
    let reveal = R.num(a1.reveal_t);
    if (reveal == null) throw new Error("could not find the card reveal in the pull clip");
    const from = Math.max(0, reveal - 3), to = Math.min(dur, reveal + 2);
    const p2 = await extractFrames(file, fd, "p2", { from, dur: to - from, fps: 4, width: 540 });
    const reads = [];
    for (const [i, t] of [reveal + 0.6, Math.min(dur - 0.05, reveal + 1.6), Math.max(0, (R.num(a1.pack_start) ?? 0) + 0.5)].entries()) {
      reads.push(await frameAt(file, Math.min(t, dur - 0.05), path.join(fd, `read_${i}.jpg`), 720));
    }
    const a2 = await claudeJson({
      model: VISION_MODEL(), system, maxTokens: 6000,
      content: [
        { type: "text", text: `First pass put the reveal near ${reveal} s. Frames at 4 fps around it:` },
        ...framesContent(p2),
        { type: "text", text: "Higher resolution reading frames (after the reveal, and at the pack start where a pack price may be shown):" },
        ...framesContent(reads),
        { type: "text", text: `Return {"reveal_t": exact seconds of the first frame where the card is fully visible, "pack_price": number in USD shown on screen or null, "card": card name as printed or null, "set": set name or null, "grader": "PSA"|"CGC"|"BGS"|other or null, "grade": grade as shown (string) or null, "buyback": buyback/instant sell offer in USD shown on screen or null, "notes": short note on what was unreadable}` },
      ],
    });
    reveal = R.num(a2.reveal_t) ?? reveal;
    return {
      duration: R.r2(dur), scene_changes: scenes, onsets, pack_start: R.num(a1.pack_start), reveal_t: R.r2(reveal),
      platform: a1.platform || null, pack_price: R.num(a2.pack_price), card: a2.card || null, set: a2.set || null,
      grader: a2.grader || null, grade: a2.grade != null ? String(a2.grade) : null, buyback: R.num(a2.buyback), notes: a2.notes || "",
    };
  }

  async function analyzeMarket(job, cfg, pull) {
    const wd = workDir(job.id); const fd = path.join(wd, "frames");
    const file = path.join(wd, "market.mp4");
    const dur = (await probe(file)).duration;
    const fps = Math.min(2, 40 / dur);
    const m1 = await extractFrames(file, fd, "m1", { fps, width: 540 });
    const system = `You analyze a screen recording where someone looks up a graded trading card on ${cfg.tool_name || "a price tool"} to see its market value. ${NULL_RULE} Reply with one JSON object.`;
    const pulled = `${pull.card || "unknown card"}${pull.set ? `, ${pull.set}` : ""}${pull.grader ? `, ${pull.grader} ${pull.grade || ""}` : ""}`;
    const a1 = await claudeJson({
      model: VISION_MODEL(), system, maxTokens: 6000,
      content: [
        { type: "text", text: `Market clip, ${R.r2(dur)} s. The card pulled in the other clip: ${pulled}. Frames follow.` },
        ...framesContent(m1),
        { type: "text", text: `Return {"value_t": seconds when the market value is first clearly on screen or null, "market_value": USD number or null, "card": card name shown or null, "same_card": true if this is the same card as pulled, false if it is clearly a different card, null if unsure, "value_bbox": [x, y, w, h] of the value text as fractions of the frame or null}` },
      ],
    });
    let valueT = R.num(a1.value_t);
    if (valueT == null) throw new Error("could not find the market value in the market clip");
    const conf = [];
    for (const [i, t] of [valueT, valueT + 0.5, valueT + 1].entries()) if (t < dur) conf.push(await frameAt(file, t, path.join(fd, `mread_${i}.jpg`), 720));
    const a2 = await claudeJson({
      model: VISION_MODEL(), system, maxTokens: 4000,
      content: [
        { type: "text", text: `Confirm the reading. Previous pass: value ${a1.market_value ?? "null"} at ${valueT} s, card ${a1.card ?? "null"}. Pulled card: ${pulled}.` },
        ...framesContent(conf),
        { type: "text", text: `Return {"market_value": USD number or null, "card": string or null, "same_card": true|false|null, "value_bbox": [x, y, w, h] fractions or null}` },
      ],
    });
    const bbox = Array.isArray(a2.value_bbox) && a2.value_bbox.length === 4 ? a2.value_bbox.map(Number) : (Array.isArray(a1.value_bbox) ? a1.value_bbox.map(Number) : null);
    const same = a2.same_card === false || a1.same_card === false ? false : (a2.same_card === true ? true : (a1.same_card === true ? true : null));
    return {
      duration: R.r2(dur), value_t: R.r2(valueT), market_value: R.num(a2.market_value) ?? R.num(a1.market_value),
      market_card: a2.card || a1.card || null, same_card: same,
      value_bbox: bbox && bbox.every(Number.isFinite) ? bbox.map(R.r2) : null,
    };
  }

  async function stepAnalyze(job, cfg) {
    const pull = await analyzePull(job, cfg);
    jobLog(job.id, `analyze pull: reveal ${pull.reveal_t}s, card ${pull.card ?? "null"}, pack $${pull.pack_price ?? "null"}`);
    const market = await analyzeMarket(job, cfg, pull);
    jobLog(job.id, `analyze market: value ${market.market_value ?? "null"} at ${market.value_t}s, same card ${market.same_card}`);
    if (market.same_card === false) throw new Error("market check shows a different card");
    const analysis = {
      pack_start: pull.pack_start, reveal_t: pull.reveal_t, value_t: market.value_t,
      platform: pull.platform, pack_price: pull.pack_price, card: pull.card, set: pull.set,
      grader: pull.grader, grade: pull.grade, buyback: pull.buyback,
      market_value: market.market_value, market_card: market.market_card, same_card: market.same_card,
      value_bbox: market.value_bbox, outcome: null,
      pull: { duration: pull.duration, scene_changes: pull.scene_changes, onsets: pull.onsets },
      market: { duration: market.duration },
      notes: pull.notes, analyzed_at: new Date().toISOString(),
    };
    analysis.outcome = R.outcome(analysis);
    fs.writeFileSync(path.join(workDir(job.id), "analysis.json"), JSON.stringify(analysis, null, 2));
    updateJob(job.id, j => { j.analysis = analysis; });
  }

  async function stepEdit(job, n, plan) {
    const wd = workDir(job.id), vd = vDir(job.id, n), a = job.analysis;
    const e = R.planEdit({ pullDur: a.pull.duration, marketDur: a.market.duration, packStart: a.pack_start, revealT: a.reveal_t, valueT: a.value_t }, plan);
    const { pull: p, market: m, zoom: z, markers: mk } = e;
    const lenA = R.r2((p.pFast - p.p0) / p.speed);
    const lenB = R.r2((p.revealT - p.pFast) + (plan.reveal_hold ?? R.DEFAULT_PLAN.reveal_hold));
    const lenC = R.r2(mk.t_end - mk.t_cut);
    const tvLocal = R.r2(m.valueT - m.m0);
    const bb = a.value_bbox;
    const cx = bb ? R.r2(Math.min(0.9, Math.max(0.1, bb[0] + bb[2] / 2))) : 0.5;
    const cy = bb ? R.r2(Math.min(0.9, Math.max(0.1, bb[1] + bb[3] / 2))) : 0.5;
    const norm = `fps=${FPS},setsar=1,format=yuv420p`;
    const parts = []; const labels = [];
    if (lenA > 0.05) {
      parts.push(`[0:v]trim=${p.p0}:${p.pFast},setpts=(PTS-STARTPTS)/${p.speed},${norm},trim=duration=${lenA}[va]`);
      parts.push(`[1:a]atrim=${p.p0}:${p.pFast},asetpts=PTS-STARTPTS,atempo=${p.speed},apad,atrim=0:${lenA}[aa]`);
      labels.push("[va][aa]");
    }
    parts.push(`[0:v]trim=${p.pFast}:${R.r2(p.revealT + p.holdReal)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${p.holdFreeze + 0.2},${norm},trim=duration=${lenB}[vb]`);
    parts.push(`[1:a]atrim=${p.pFast}:${R.r2(p.revealT + p.holdReal)},asetpts=PTS-STARTPTS,apad,atrim=0:${lenB}[ab]`);
    labels.push("[vb][ab]");
    const zexpr = `st(0,clip((it-${tvLocal})/${z.secs},0,1));1+(${z.to}-1)*ld(0)*ld(0)*(3-2*ld(0))`;
    parts.push(`[2:v]trim=${m.m0}:${m.end},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${m.freeze + 0.5},${norm},trim=duration=${lenC},` +
      `scale=${W * 2}:${H * 2},zoompan=z='${zexpr}':x='max(0,min(iw-iw/zoom,${cx}*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${cy}*ih-ih/zoom/2))':d=1:s=${W}x${H}:fps=${FPS},${norm}[vc]`);
    parts.push(`[3:a]atrim=${m.m0}:${m.end},asetpts=PTS-STARTPTS,apad,atrim=0:${lenC}[ac]`);
    labels.push("[vc][ac]");
    const fc = parts.join(";") + `;${labels.join("")}concat=n=${labels.length}:v=1:a=1[v][a]`;
    fs.mkdirSync(vd, { recursive: true });
    await ff(["-i", path.join(wd, "pull.mp4"), "-i", path.join(wd, "pull.wav"), "-i", path.join(wd, "market.mp4"), "-i", path.join(wd, "market.wav"),
      "-filter_complex", fc,
      "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-t", String(mk.t_end), path.join(vd, "edit.mp4"),
      "-map", "[a]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-t", String(mk.t_end), path.join(vd, "game.wav")]);
    const got = await probe(path.join(vd, "edit.mp4"));
    jobLog(job.id, `edit v${n}: ${R.r2(got.duration)}s (planned ${e.duration}s, speed ${p.speed}x, reveal at ${mk.t_reveal}s, cut ${mk.t_cut}s, value ${mk.t_value}s)`);
    return { edit: e, duration: R.r2(got.duration) };
  }

  function scriptPrompt(job, v, cfg, errors, prev) {
    const a = job.analysis, e = v.edit, mk = e.markers, o = R.outcome(a);
    const tone = { calm: "calm, dry, understated", neutral: "natural and conversational", excited: "energetic and excited, but believable" }[v.plan.tone] || "natural";
    const facts = {
      card: a.card, set: a.set, grader: a.grader, grade: a.grade, pack_price_usd: a.pack_price,
      market_value_usd: a.market_value, buyback_usd: a.buyback, outcome: o.kind, difference_usd: o.diff, difference_pct: o.pct, platform: a.platform,
    };
    const lines = [
      `Write the voice over for a ${R.r2(mk.t_end)} s vertical short of a ${cfg.niche} pull.`,
      `Facts from the screen (null = unknown, never fill it in): ${JSON.stringify(facts)}`,
      `Timeline: reveal at ${mk.t_reveal}s, hard cut to the ${cfg.tool_name} market check at ${mk.t_cut}s, value on screen at ${mk.t_value}s (zoom until ${mk.t_zoom_end}s), video ends at ${mk.t_end}s.`,
      "Rules:",
      "- segments: [{start, text, delivery}], start in seconds, strictly increasing.",
      "- segment 1 is the hook: start 0, max 6 words, lands within 1.5 s.",
      `- no segment may start between ${R.r2(mk.t_reveal - 0.5)} and ${R.r2(mk.t_reveal + 0.3)}; a line that starts before the reveal must be short enough to finish before ${R.r2(mk.t_reveal - 0.5)} (about 2.6 words per second).`,
      `- the reaction line starts between ${R.r2(mk.t_reveal + 0.3)} and ${R.r2(mk.t_reveal + 0.5)} and matches the real outcome (${o.kind}${a.card ? `, the card is ${a.card}` : ""}).`,
      `- at ${mk.t_cut}s (within 0.8 s) a line names ${cfg.tool_name}; after the cut a line says the market value and whether it is a win or a loss versus the pack price (only if both are known).`,
      `- the last line ends with exactly "${R.CLOSING}" and must finish before ${mk.t_end}s.`,
      "- only numbers from the facts; no em or en dashes; no hollow superlatives (insane, incredible, amazing, epic...); no buy call to action; no links.",
      "- ElevenLabs v3 audio tags in square brackets are allowed inside text, e.g. [excited], [laughs softly], [whispers]. Use them sparingly.",
      `- delivery: a short note on how to say it. Overall tone: ${tone}.`,
      v.plan.hook_instruction ? `- hook: ${v.plan.hook_instruction}` : "",
      v.plan.script_instruction ? `- extra direction from the editor: ${v.plan.script_instruction}` : "",
      prev ? `Previous version of the script (change it as directed, keep what works): ${JSON.stringify(prev.segments)}` : "",
      errors && errors.length ? `Your last attempt broke these rules, fix all of them:\n- ${errors.join("\n- ")}` : "",
      'Reply with {"segments": [...]} only.',
    ];
    return lines.filter(Boolean).join("\n");
  }

  async function stepScript(job, n, v, cfg) {
    let errors = []; let script = null;
    const prev = v.prev_script || null;
    for (let round = 0; round < 3; round++) {
      const out = await claudeJson({ model: SCRIPT_MODEL(), system: "You write short, honest voice overs for card pull videos. Reply with JSON only.", content: [{ type: "text", text: scriptPrompt(job, v, cfg, errors, prev) }], maxTokens: 8000 });
      script = { segments: (out.segments || []).map(s => ({ start: R.r2(Number(s.start)), text: R.cleanText(String(s.text || "")), delivery: R.cleanText(String(s.delivery || "")) })) };
      errors = R.validateScript(script, { edit: v.edit, analysis: job.analysis, toolName: cfg.tool_name });
      if (!errors.length) break;
      jobLog(job.id, `script v${n} round ${round + 1}: ${errors.length} rule issue(s): ${errors.slice(0, 3).join("; ")}`);
    }
    if (errors.length) throw new Error(`script breaks the rules after 3 tries: ${errors.slice(0, 3).join("; ")}`);
    fs.writeFileSync(path.join(outDir(job.id, n), "script.json"), JSON.stringify(script, null, 2));
    jobLog(job.id, `script v${n}: ${script.segments.length} segments`);
    return script;
  }

  async function ensureVoice(cfg) {
    const envName = cfg.voice_env || "RIPS_VOICE_ID";
    const cur = (process.env[envName] || "").trim();
    if (cur) return cur;
    const voices = await listElevenVoices();
    if (!voices.length) throw new Error(`${envName} is not set and no ElevenLabs voices are available`);
    const hint = String(cfg.voice_hint || "").toLowerCase().split(/\W+/).filter(Boolean);
    const score = (vo) => { const t = JSON.stringify([vo.name, vo.labels, vo.description]).toLowerCase(); return hint.filter(h => t.includes(h)).length; };
    const pick = [...voices].sort((x, y) => score(y) - score(x))[0];
    const id = pick.voice_id || pick.id;
    process.env[envName] = id;
    try { writeEnvFile({ [envName]: id }); } catch (e) { log(`could not save ${envName}: ${e.message}`); }
    log(`voice auto-picked for ${envName}: ${pick.name} (${id})`);
    return id;
  }

  async function tts(voiceId, text, seed) {
    const key = (process.env.ELEVENLABS_API_KEY || "").trim();
    if (!key) throw new Error("ELEVENLABS_API_KEY missing");
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_v3", seed, voice_settings: { stability: 0.0, similarity_boost: 0.75, style: 0.4, use_speaker_boost: true } }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${redact(JSON.stringify(d.detail || d).slice(0, 200))}`);
    return { audio: Buffer.from(d.audio_base64 || "", "base64"), alignment: d.alignment || d.normalized_alignment };
  }

  async function shorterLine(job, seg, maxWords, isLast) {
    const allowed = R.allowedNumbers(job.analysis);
    const out = await claudeJson({
      model: SCRIPT_MODEL(), system: "You shorten voice over lines. Reply with JSON only.", maxTokens: 2000,
      content: [{ type: "text", text: `Shorten this voice over line to at most ${maxWords} words. Keep the meaning and any numbers, keep audio tags only if they fit. No dashes, no new numbers.${isLast ? ` It must still end with "${R.CLOSING}".` : ""}\nLine: ${JSON.stringify(seg.text)}\nReply {"text": "..."}` }],
    });
    const t = R.cleanText(String(out.text || ""));
    if (!t || R.textIssues(t, allowed).length) return null;
    if (isLast && !R.stripTags(t).toLowerCase().endsWith(R.CLOSING)) return null;
    return t;
  }

  async function stepVoice(job, n, v, cfg) {
    const vd = vDir(job.id, n); const voiceId = await ensureVoice(cfg);
    const mk = v.edit.markers; const segs = v.script.segments;
    const silentFrom = mk.t_reveal - 0.5;
    const result = []; const notes = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]; const next = segs[i + 1];
      let room = (next ? next.start : mk.t_end) - s.start - 0.08;
      if (s.start < silentFrom) room = Math.min(room, silentFrom - s.start);
      const seed = (Number(v.plan.voice_seed) || 1) * 1000 + i;
      const file = path.join(vd, `voice_${i}.mp3`);
      let { audio, alignment } = await tts(voiceId, s.text, seed);
      fs.writeFileSync(file, audio);
      let dur = (await probe(file)).duration;
      let tempo = 1, trimmed = false, shortened = false;
      if (dur > room + 0.05) {
        const words = R.stripTags(s.text).split(/\s+/).length;
        const maxWords = Math.max(2, Math.floor(words * room / dur) - 1);
        const t = await shorterLine(job, s, maxWords, i === segs.length - 1);
        if (t) {
          s.text = t; shortened = true;
          ({ audio, alignment } = await tts(voiceId, s.text, seed));
          fs.writeFileSync(file, audio); dur = (await probe(file)).duration;
          notes.push(`segment ${i + 1} regenerated with a shorter line`);
        }
      }
      let use = file;
      if (dur > room + 0.05) {
        tempo = Math.min(1.08, Math.max(1, dur / room));
        const fx = path.join(vd, `voice_${i}_fit.wav`);
        const after = dur / tempo;
        const af = [`atempo=${tempo.toFixed(3)}`];
        if (after > room + 0.05) { trimmed = true; af.push(`atrim=0:${room.toFixed(2)}`, `afade=t=out:st=${Math.max(0, room - 0.15).toFixed(2)}:d=0.15`); }
        await ff(["-i", file, "-af", af.join(","), "-ar", "48000", "-ac", "1", fx]);
        use = fx; dur = Math.min(after, room);
        notes.push(`segment ${i + 1} ${tempo > 1 ? `sped to ${tempo.toFixed(2)}x` : ""}${trimmed ? " and trimmed" : ""}`.trim());
      }
      let words = R.wordsFromAlignment(alignment, s.start, tempo);
      if (trimmed) words = words.filter(w => w.start < s.start + room - 0.1).map(w => ({ ...w, end: Math.min(w.end, R.r2(s.start + room)) }));
      result.push({ i, start: s.start, text: s.text, file: path.basename(use), duration: R.r2(dur), tempo: R.r2(tempo), trimmed, shortened, words });
    }
    const voice = { voice_id: voiceId, model: "eleven_v3", settings: { stability: 0, similarity_boost: 0.75, style: 0.4 }, segments: result };
    fs.writeFileSync(path.join(vd, "voice.json"), JSON.stringify(voice, null, 2));
    fs.writeFileSync(path.join(outDir(job.id, n), "script.json"), JSON.stringify(v.script, null, 2)); // texts may have been shortened
    jobLog(job.id, `voice v${n}: voice ${voiceId} (eleven_v3), ${result.length} segments${notes.length ? ` (${notes.join("; ")})` : ""}`);
    return { voice, notes };
  }

  async function stepMix(job, n, v) {
    const vd = vDir(job.id, n); const mk = v.edit.markers; const T = mk.t_end;
    const voice = JSON.parse(fs.readFileSync(path.join(vd, "voice.json"), "utf8"));
    const inputs = ["-i", path.join(vd, "game.wav")];
    const vparts = []; const vlabels = [];
    voice.segments.forEach((s, k) => {
      inputs.push("-i", path.join(vd, s.file));
      const ms = Math.round(s.start * 1000);
      vparts.push(`[${k + 1}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}:all=1[s${k}]`);
      vlabels.push(`[s${k}]`);
    });
    const tr = mk.t_reveal, tc = mk.t_cut;
    const fc = [
      ...vparts,
      `${vlabels.join("")}amix=inputs=${vlabels.length}:normalize=0:dropout_transition=0,apad,atrim=0:${T},highpass=f=80,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1:g=3,acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=2,aformat=channel_layouts=stereo,asplit=2[vo][vk]`,
      `[vk]volume='if(between(t,${R.r2(tr - 0.5)},${R.r2(tr + 1.5)}),0,1)':eval=frame[key]`,
      `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:${T},volume='if(gte(t,${tc}),0.25,1)':eval=frame[g0]`,
      `[g0][key]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[gd]`,
      `anoisesrc=color=pink:amplitude=0.006:r=48000:d=${T},lowpass=f=5000,volume='if(gte(t,${tc}),2.2,1)':eval=frame,aformat=channel_layouts=stereo[room]`,
      `[gd][vo][room]amix=inputs=3:normalize=0:duration=first[mix]`,
    ].join(";");
    const pre = path.join(vd, "premix.wav");
    await ff([...inputs, "-filter_complex", fc, "-map", "[mix]", "-ar", "48000", "-c:a", "pcm_s16le", "-t", String(T), pre]);
    const { stderr } = await ff(["-i", pre, "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], { timeout: 120000 });
    const js = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
    const meas = JSON.parse(js);
    const ln = `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true:print_format=json`;
    const { stderr: e2 } = await ff(["-i", pre, "-af", ln, "-ar", "48000", "-c:a", "pcm_s16le", path.join(vd, "mix.wav")], { timeout: 120000 });
    let out = null; try { out = JSON.parse(e2.slice(e2.lastIndexOf("{"), e2.lastIndexOf("}") + 1)); } catch {}
    const loud = out ? { integrated: Number(out.output_i), true_peak: Number(out.output_tp) } : null;
    jobLog(job.id, `mix v${n}: ${loud ? `${loud.integrated} LUFS, TP ${loud.true_peak} dB` : "done"}`);
    return { loudness: loud };
  }

  function stepCaptions(job, n, v) {
    const vd = vDir(job.id, n);
    const voice = JSON.parse(fs.readFileSync(path.join(vd, "voice.json"), "utf8"));
    const words = voice.segments.flatMap(s => s.words);
    const ass = R.buildCaptionsAss({ words, raiseAt: v.edit.markers.t_value, width: W, height: H, font: "Montserrat ExtraBold" });
    fs.writeFileSync(path.join(vd, "captions.ass"), ass);
    jobLog(job.id, `captions v${n}: ${R.dropTagWords(words).length} words`);
  }

  async function stepFinal(job, n, v, cfg) {
    const vd = vDir(job.id, n), od = outDir(job.id, n); fs.mkdirSync(od, { recursive: true });
    const notes = [];
    const logo = cfg.logo_path ? path.resolve(rootDir, cfg.logo_path) : "";
    const hasLogo = logo && fs.existsSync(logo);
    if (!hasLogo) notes.push(`logo not found${cfg.logo_path ? ` at ${cfg.logo_path}` : ""}, exported without logo`);
    const esc = (p) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const sub = `subtitles=filename='${esc(path.join(vd, "captions.ass"))}':fontsdir='${esc(fontsDir)}'`;
    const inputs = ["-i", path.join(vd, "edit.mp4"), "-i", path.join(vd, "mix.wav")];
    let fc;
    if (hasLogo) {
      inputs.push("-loop", "1", "-i", logo);
      fc = `[0:v]${sub}[s];[2:v]scale=180:-1,format=rgba,colorchannelmixer=aa=0.6[lg];[s][lg]overlay=W-w-48:48:shortest=1,format=yuv420p[v]`;
    } else fc = `[0:v]${sub},format=yuv420p[v]`;
    const T = v.edit.markers.t_end;
    await ff([...inputs, "-filter_complex", fc, "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", String(T), finalPath(job.id, n)]);
    const got = await probe(finalPath(job.id, n));
    jobLog(job.id, `final v${n}: ${R.r2(got.duration)}s ${got.width}x${got.height}`);
    return { duration: R.r2(got.duration), notes };
  }

  async function stepPost(job, n, v, cfg) {
    const a = job.analysis; const allowed = R.allowedNumbers(a);
    let errors = []; let res = null;
    for (let round = 0; round < 3; round++) {
      const out = await claudeJson({
        model: SCRIPT_MODEL(), system: "You write short social captions for card pull videos. Reply with JSON only.", maxTokens: 3000,
        content: [{ type: "text", text: [
          `Write the caption line for a short about this pull: ${JSON.stringify({ card: a.card, set: a.set, grader: a.grader, grade: a.grade, pack_price_usd: a.pack_price, market_value_usd: a.market_value, outcome: R.outcome(a).kind })}.`,
          "Caption line: one sentence, max 120 characters, plain and specific, may ask the viewer a question. Only numbers from the facts. No dashes, no hollow superlatives, no links, no buy call to action.",
          `Pick exactly 5 hashtags (without #) from this pool or close variants that fit: ${cfg.hashtag_pool.join(", ")}.`,
          v.plan.caption_instruction ? `Direction from the editor: ${v.plan.caption_instruction}` : "",
          v.prev_caption_line ? `Previous caption line (write a different one if asked): ${v.prev_caption_line}` : "",
          errors.length ? `Fix: ${errors.join("; ")}` : "",
          'Reply {"caption_line": "...", "hashtags": ["...", "...", "...", "...", "..."]}',
        ].filter(Boolean).join("\n") }],
      });
      const line = R.cleanText(String(out.caption_line || "")).trim();
      errors = R.textIssues(line, allowed);
      if (!line) errors.push("empty caption line");
      let tags = R.cleanHashtags(out.hashtags || [], 5);
      if (tags.length < 5) tags = R.cleanHashtags([...tags, ...cfg.hashtag_pool], 5);
      if (!errors.length && tags.length === 5) { res = { line, tags }; break; }
    }
    if (!res) throw new Error(`caption breaks the rules: ${errors.join("; ")}`);
    const post = R.buildPostTxt({ captionLine: res.line, lines: cfg.post_lines, hashtags: res.tags });
    fs.writeFileSync(path.join(outDir(job.id, n), "post.txt"), post + "\n");
    jobLog(job.id, `post v${n}: caption written, X version ${R.weightedLength(R.trimForX(post))} chars`);
    return { caption_line: res.line, post, captions: { instagram: post, x: R.trimForX(post, 280) } };
  }

  // ══════════════════════════════════════════════════════════════════════
  // Runner
  // ══════════════════════════════════════════════════════════════════════
  let busy = false;

  async function runPending(jobId) {
    const cfg = config();
    let job = getJob(jobId);
    const pend = job.pending; const n = pend.n;
    fs.mkdirSync(vDir(jobId, n), { recursive: true }); fs.mkdirSync(outDir(jobId, n), { recursive: true });
    for (const step of pend.steps) {
      job = getJob(jobId);
      if ((job.pending.done || []).includes(step)) continue;
      updateJob(jobId, j => { j.step = step; });
      jobLog(jobId, `step ${step} (v${n}) started`);
      const v = () => version(getJob(jobId), n);
      const patchV = (fn) => updateJob(jobId, j => { fn(version(j, n)); });
      switch (step) {
        case "normalize": await stepNormalize(job); break;
        case "analyze": await stepAnalyze(getJob(jobId), cfg); break;
        case "edit": { const r = await stepEdit(getJob(jobId), n, v().plan); patchV(x => { x.edit = r.edit; x.duration = r.duration; }); break; }
        case "script": { const s = await stepScript(getJob(jobId), n, v(), cfg); patchV(x => { x.script = s; }); break; }
        case "voice": { const r = await stepVoice(getJob(jobId), n, v(), cfg); patchV(x => { x.script = v().script; x.voice_id = r.voice.voice_id; x.notes = [...(x.notes || []), ...r.notes]; }); break; }
        case "mix": { const r = await stepMix(getJob(jobId), n, v()); patchV(x => { x.loudness = r.loudness; }); break; }
        case "captions": stepCaptions(getJob(jobId), n, v()); break;
        case "final": { const r = await stepFinal(getJob(jobId), n, v(), cfg); patchV(x => { x.duration = r.duration; x.notes = [...(x.notes || []).filter(s => !/^logo not found/.test(s)), ...r.notes]; }); break; }
        case "post": { const r = await stepPost(getJob(jobId), n, v(), cfg); patchV(x => { x.caption_line = r.caption_line; x.post_text = r.post; x.captions = r.captions; }); break; }
      }
      updateJob(jobId, j => { j.pending.done = [...(j.pending.done || []), step]; const x = version(j, n); if (x) x.steps_done = [...new Set([...(x.steps_done || []), step])]; });
    }
    // copy analysis into the version output
    job = getJob(jobId);
    fs.writeFileSync(path.join(outDir(jobId, n), "analysis.json"), JSON.stringify(job.analysis, null, 2));
    updateJob(jobId, j => {
      const x = version(j, n);
      x.status = "ready"; x.ready_at = new Date().toISOString();
      x.files = { final: finalPath(jobId, n), analysis: path.join(outDir(jobId, n), "analysis.json"), script: path.join(outDir(jobId, n), "script.json"), post: path.join(outDir(jobId, n), "post.txt") };
      j.current_version = n; j.pending = null; j.step = null; j.error = null; j.status = "ready_for_review";
    });
    jobLog(jobId, `v${n} ready for review`);
    try { sendTelegram && sendTelegram("🎴 Rip short ready", `${getJob(jobId).card_label || jobId} v${n} is ready for review.`, "info"); } catch {}
  }

  async function runPublish(jobId) {
    const job = getJob(jobId); const req = job.publish_request;
    const out = {};
    for (const platform of req.platforms) {
      const v = version(job, req.version);
      const pub = (v.publish || {})[platform] || {};
      if (pub.status === "published") { out[platform] = "already published"; continue; }
      try {
        updateJob(jobId, j => { const x = version(j, req.version); x.publish = x.publish || {}; x.publish[platform] = { ...(x.publish[platform] || {}), status: "publishing", error: null, started_at: new Date().toISOString() }; });
        const r = platform === "instagram" ? await publishInstagram(getJob(jobId), req.version) : await publishX(getJob(jobId), req.version);
        updateJob(jobId, j => { const x = version(j, req.version); x.publish[platform] = { ...x.publish[platform], ...r, status: "published", published_at: new Date().toISOString() }; });
        jobLog(jobId, `published v${req.version} on ${platform}: ${r.permalink || r.media_id}`);
        out[platform] = "published";
      } catch (e) {
        updateJob(jobId, j => { const x = version(j, req.version); x.publish[platform] = { ...x.publish[platform], status: "failed", error: redact(e.message) }; });
        jobLog(jobId, `publish ${platform} failed: ${e.message}`);
        out[platform] = "failed";
      }
    }
    const failed = Object.values(out).includes("failed");
    updateJob(jobId, j => {
      j.publish_request = null; j.step = null;
      if (failed) { j.status = "failed"; j.failed_from = "publishing"; j.error = "publishing failed on: " + Object.keys(out).filter(k => out[k] === "failed").join(", "); }
      else j.status = "published";
    });
  }

  async function tick() {
    if (busy) return;
    const jobs = readJobs();
    const job = jobs.find(j => j.publish_request && j.status === "publishing")
      || jobs.find(j => j.pending && (j.status === "processing" || j.status === "revising"))
      || jobs.find(j => j.status === "uploaded");
    if (!job) return;
    busy = true;
    try {
      await apiUsage.forTask(job.id, async () => {
        if (job.status === "publishing") return runPublish(job.id);
        if (job.status === "uploaded") {
          updateJob(job.id, j => {
            j.status = "processing";
            j.versions = [{ n: 1, status: "building", created_at: new Date().toISOString(), plan: { ...R.DEFAULT_PLAN, ...(j.plan || {}) }, steps: [...R.STEPS], steps_done: [], notes: [], publish: {} }];
            j.pending = { n: 1, steps: [...R.STEPS], done: [] };
          });
        }
        await runPending(job.id);
      });
    } catch (e) {
      const j0 = getJob(job.id);
      log(`${job.id} failed at ${j0 && j0.step}: ${e.stack || e.message}`);
      updateJob(job.id, j => {
        j.failed_from = j.status; j.status = "failed"; j.error = redact(e.message);
        const x = j.pending && version(j, j.pending.n); if (x) x.status = "failed";
      });
      jobLog(job.id, `failed: ${e.message}`);
    } finally { busy = false; }
  }

  // ── revisions ──────────────────────────────────────────────────────────
  async function planRevision(job, text, chips) {
    const cur = version(job, job.current_version);
    const base = { ...R.DEFAULT_PLAN, ...(cur.plan || {}) };
    let { plan, steps } = R.applyChips(base, chips);
    plan.hook_instruction = chips.includes("new_hook") ? plan.hook_instruction : "";
    let reason = chips.length ? `chips: ${chips.join(", ")}` : "";
    if (text && text.trim()) {
      const out = await claudeJson({
        model: SCRIPT_MODEL(), system: "You turn an editor's revision note into plan changes for an automated short video pipeline. Reply with JSON only.", maxTokens: 3000,
        content: [{ type: "text", text: [
          `Pipeline steps that can rerun: edit (cut lengths, speed, zoom, holds), script (voice over text), voice (new take of the same text), mix, captions, final, post (caption text for social).`,
          `Current plan: ${JSON.stringify(plan)}`,
          `Plan keys you may change: ${PLAN_KEYS.join(", ")}. tone is calm|neutral|excited. max_duration ≤ 30, min_duration ≥ 20, max_speed ≤ 2, zoom_to 1.0 to 2.0, value_hold 1 to 5, reveal_hold 1 to 3. script_instruction / hook_instruction / caption_instruction are free text directions.`,
          `Current script: ${JSON.stringify((cur.script || {}).segments || [])}`,
          `Current caption line: ${cur.caption_line || ""}`,
          `Editor note: ${JSON.stringify(text.trim())}`,
          'Reply {"plan_changes": {...}, "steps": ["script", ...], "summary": "one line"}',
        ].join("\n") }],
      });
      const changes = {};
      for (const [k, val] of Object.entries(out.plan_changes || {})) if (PLAN_KEYS.includes(k)) changes[k] = val;
      plan = { ...plan, ...changes };
      steps.push(...(out.steps || []).filter(s => R.STEPS.includes(s) && !["normalize", "analyze"].includes(s)));
      if (!steps.length) steps.push("script");
      reason = [reason, out.summary || ""].filter(Boolean).join(" · ");
    }
    // clamp
    plan.max_duration = Math.min(30, Math.max(20, Number(plan.max_duration) || 30));
    plan.min_duration = Math.min(plan.max_duration, Math.max(20, Number(plan.min_duration) || 20));
    plan.max_speed = Math.min(2, Math.max(1, Number(plan.max_speed) || 2));
    plan.zoom_to = Math.min(2, Math.max(1, Number(plan.zoom_to) || 1.6));
    plan.value_hold = Math.min(5, Math.max(1, Number(plan.value_hold) || 2));
    plan.reveal_hold = Math.min(3, Math.max(1, Number(plan.reveal_hold) || 1.5));
    return { plan, steps: R.closeSteps(steps.length ? steps : ["script"]), reason };
  }

  function startRevision(jobId, { plan, steps, reason, text, chips }) {
    const job = getJob(jobId); const from = job.current_version; const n = Math.max(...job.versions.map(v => v.n)) + 1;
    const src = vDir(jobId, from), dst = vDir(jobId, n);
    fs.cpSync(src, dst, { recursive: true });
    fs.mkdirSync(outDir(jobId, n), { recursive: true });
    for (const f of fs.readdirSync(outDir(jobId, from))) {
      if (f.startsWith("publish-")) continue;
      const target = f.endsWith("_final.mp4") ? `${jobId}_final.mp4` : f;
      fs.copyFileSync(path.join(outDir(jobId, from), f), path.join(outDir(jobId, n), target));
    }
    const prev = version(job, from);
    updateJob(jobId, j => {
      j.versions.push({
        n, from, status: "building", created_at: new Date().toISOString(), plan, steps,
        steps_done: R.STEPS.filter(s => !steps.includes(s)), revision: { text: text || "", chips: chips || [], summary: reason },
        edit: prev.edit, duration: prev.duration, script: prev.script, prev_script: steps.includes("script") ? prev.script : undefined,
        prev_caption_line: prev.caption_line, caption_line: prev.caption_line, post_text: prev.post_text, captions: prev.captions,
        voice_id: prev.voice_id, loudness: prev.loudness, notes: [], publish: {},
      });
      j.status = "revising"; j.pending = { n, steps, done: [] }; j.error = null;
    });
    jobLog(jobId, `revision v${n} from v${from}: steps ${steps.join(", ")}${reason ? ` (${reason})` : ""}`);
    return n;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Publishing
  // ══════════════════════════════════════════════════════════════════════
  const shareSig = (id, n, exp) => crypto.createHmac("sha256", sessionSecret).update(`share-rip:${id}:${n}:${exp}`).digest("hex").slice(0, 40);
  function signedVideoUrl(id, n, ttlSec = 3600) {
    const origin = (knownPublicOrigin() || "").replace(/\/+$/, "");
    if (!origin) return null;
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `${origin}/share/rip/${exp}/${shareSig(id, n, exp)}/${id}/${n}`;
  }
  function servePublic(req, res) {
    const { exp, sig, id, n } = req.params;
    if (!/^\d+$/.test(exp) || !/^rip_[a-z0-9]+$/.test(id) || !/^\d+$/.test(n)) return res.status(404).end();
    if (Number(exp) < Date.now() / 1000) return res.status(410).end();
    const want = Buffer.from(shareSig(id, n, exp)); const got = Buffer.from(String(sig));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return res.status(404).end();
    const f = finalPath(id, n);
    if (!fs.existsSync(f)) return res.status(404).end();
    res.type("video/mp4").sendFile(f);
  }

  function igConnection(cfg) {
    const conns = readSocial();
    const list = Array.isArray(conns) ? conns : Object.values(conns || {});
    return list.find(c => c && c.id === cfg.ig_account) || null;
  }
  function xChannel(cfg) { return (readChannels() || []).find(c => c.id === cfg.channel_id) || null; }

  function readTokenStatus() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch { return {}; } }

  // Checks the Meta token (debug_token) and refreshes the long lived user token
  // when it expires within 7 days, then re-reads the page token. Never logs tokens.
  async function refreshInstagramToken(cfg, { force = false } = {}) {
    const st = readTokenStatus(); const warnings = [];
    const conn = igConnection(cfg);
    if (!conn) return { warnings: ["Instagram connection not found"], status: st };
    const appId = process.env.META_APP_ID, appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) return { warnings: ["META_APP_ID / META_APP_SECRET missing, the token cannot be checked or refreshed"], status: st };
    if (!force && st.checked_at && Date.now() - Date.parse(st.checked_at) < 6 * 3600e3) return { warnings: st.warnings || [], status: st };
    const appToken = `${appId}|${appSecret}`;
    const dbg = async (tok) => {
      const r = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(tok)}&access_token=${encodeURIComponent(appToken)}`);
      const d = await r.json().catch(() => ({})); return d.data || {};
    };
    const out = { checked_at: new Date().toISOString() };
    try {
      const page = await dbg(conn.page_access_token);
      out.page_token_valid = !!page.is_valid;
      out.page_token_expires_at = page.expires_at ? new Date(page.expires_at * 1000).toISOString() : "never";
      out.scopes = page.scopes || [];
      if (!page.is_valid) warnings.push("Instagram page token is not valid, reconnect Meta in Settings");
      for (const s of ["instagram_content_publish", "instagram_basic"]) if (page.scopes && !page.scopes.includes(s)) warnings.push(`token lacks scope ${s}, reconnect Meta in Settings`);
      if (conn.user_access_token) {
        const user = await dbg(conn.user_access_token);
        out.user_token_expires_at = user.expires_at ? new Date(user.expires_at * 1000).toISOString() : "never";
        const soon = user.expires_at && user.expires_at * 1000 - Date.now() < 7 * 86400e3;
        if (user.is_valid && soon) {
          const r = await fetch(`${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(conn.user_access_token)}`);
          const d = await r.json().catch(() => ({}));
          if (d.access_token) {
            const acc = await (await fetch(`${GRAPH}/me/accounts?fields=id,access_token,instagram_business_account{id}&access_token=${encodeURIComponent(d.access_token)}`)).json().catch(() => ({}));
            const pg = (acc.data || []).find(p => p.id === conn.page_id);
            const all = readSocial(); const list = Array.isArray(all) ? all : null;
            if (list) {
              const c = list.find(x => x.id === conn.id);
              c.user_access_token = d.access_token; if (pg && pg.access_token) c.page_access_token = pg.access_token;
              c.token_refreshed_at = new Date().toISOString(); writeSocial(list);
              redact = R.makeRedactor({ ...process.env, IG_USER: d.access_token, IG_PAGE: (pg && pg.access_token) || "" });
              out.refreshed_at = c.token_refreshed_at; log("instagram token refreshed");
            }
          } else warnings.push("Instagram user token expires within 7 days and the refresh failed, reconnect Meta in Settings");
        } else if (!user.is_valid && !page.is_valid) warnings.push("Instagram user token expired, reconnect Meta in Settings");
      }
    } catch (e) { warnings.push(`token check failed: ${redact(e.message)}`); }
    out.warnings = warnings;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 2));
    return { warnings, status: out };
  }

  function credentials(cfg = config()) {
    const res = { instagram: { ok: false, missing: [], warnings: [] }, x: { ok: false, missing: [], warnings: [] } };
    const conn = igConnection(cfg);
    if (!cfg.ig_account) res.instagram.missing.push("ig_account in data/rips-config.json");
    else if (!conn) res.instagram.missing.push(`Instagram connection ${cfg.ig_account} (connect Meta in Settings)`);
    else {
      if (!conn.ig_user_id) res.instagram.missing.push("ig_user_id on the connection");
      if (!conn.page_access_token) res.instagram.missing.push("page_access_token on the connection");
      res.instagram.username = conn.username || null;
    }
    if (!knownPublicOrigin()) res.instagram.missing.push("PUBLIC_BASE_URL in .env (Instagram must fetch the video from a public https URL)");
    if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) res.instagram.warnings.push("META_APP_ID / META_APP_SECRET missing, the token cannot be refreshed automatically");
    const ts = readTokenStatus();
    res.instagram.token = { checked_at: ts.checked_at || null, page_token_expires_at: ts.page_token_expires_at || null, user_token_expires_at: ts.user_token_expires_at || null };
    res.instagram.warnings.push(...(ts.warnings || []));
    res.instagram.ok = !res.instagram.missing.length;

    const ch = xChannel(cfg);
    if (!cfg.channel_id) res.x.missing.push("channel_id in data/rips-config.json");
    else if (!ch) res.x.missing.push(`X channel ${cfg.channel_id} in the Social Media Manager`);
    else {
      try { twitterCreds(ch); } catch (e) { res.x.missing.push(e.message.replace(/^X credentials missing:\s*/, "")); }
      res.x.username = ch.x_username || null;
      try { const u = twitterUsageSummary(); res.x.usage = u; if (u.used >= u.limit) res.x.warnings.push(`X monthly post limit reached (${u.used}/${u.limit})`); } catch {}
    }
    res.x.ok = !res.x.missing.length;
    return res;
  }

  async function publishInstagram(job, n) {
    const cfg = config();
    const cred = credentials(cfg);
    if (!cred.instagram.ok) throw new Error(`credentials missing: ${cred.instagram.missing.join("; ")}`);
    await refreshInstagramToken(cfg);
    const conn = igConnection(cfg); const v = version(job, n);
    const tok = conn.page_access_token; const ig = conn.ig_user_id;
    const videoUrl = signedVideoUrl(job.id, n, 3600);
    const caption = (v.captions && v.captions.instagram) || v.post_text || "";
    const post = async (url, body) => {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(`Instagram: ${(d.error && d.error.message) || `HTTP ${r.status}`}`);
      return d;
    };
    const c = await post(`${GRAPH}/${ig}/media`, { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: "true", access_token: tok });
    updateJob(job.id, j => { const x = version(j, n); x.publish.instagram = { ...x.publish.instagram, container_id: c.id }; });
    const t0 = Date.now(); let status = "";
    while (Date.now() - t0 < 15 * 60e3) {
      await new Promise(r => setTimeout(r, 10000));
      const d = await (await fetch(`${GRAPH}/${c.id}?fields=status_code,status&access_token=${encodeURIComponent(tok)}`)).json().catch(() => ({}));
      status = d.status_code;
      if (status === "FINISHED") break;
      if (status === "ERROR" || status === "EXPIRED") throw new Error(`Instagram processing ${status}: ${d.status || ""}`);
    }
    if (status !== "FINISHED") throw new Error("Instagram processing timed out");
    const p = await post(`${GRAPH}/${ig}/media_publish`, { creation_id: c.id, access_token: tok });
    const m = await (await fetch(`${GRAPH}/${p.id}?fields=permalink&access_token=${encodeURIComponent(tok)}`)).json().catch(() => ({}));
    return { media_id: p.id, container_id: c.id, permalink: m.permalink || null };
  }

  async function publishX(job, n) {
    const cfg = config(); const ch = xChannel(cfg);
    const cred = credentials(cfg);
    if (!cred.x.ok) throw new Error(`credentials missing: ${cred.x.missing.join("; ")}`);
    const creds = twitterCreds(ch);
    const u = twitterUsageSummary(); if (u.used >= u.limit) throw new Error(`X monthly post limit reached (${u.used}/${u.limit})`);
    const v = version(job, n);
    const text = R.trimForX((v.captions && v.captions.x) || v.post_text || "", 280);
    const mediaId = await twitterUploadFile(finalPath(job.id, n), `${job.id}_final.mp4`, creds);
    const d = await twitterApi("POST", "https://api.x.com/2/tweets", creds, { json: { text, media: { media_ids: [mediaId] } } });
    if (!d.data || !d.data.id) throw new Error("X API: tweet created but no id returned");
    bumpTwitterUsage();
    return { media_id: d.data.id, upload_media_id: mediaId, permalink: ch.x_username ? `https://x.com/${ch.x_username}/status/${d.data.id}` : null };
  }

  // Builds every request publishing would send, with masked tokens. Sends nothing.
  function dryRun(job, n, platforms) {
    const cfg = config(); const v = version(job, n); const cred = credentials(cfg);
    const file = finalPath(job.id, n);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const out = { job: job.id, version: n, built_at: new Date().toISOString(), sent: false, file, bytes: size, platforms: {} };
    if (platforms.includes("instagram")) {
      const conn = igConnection(cfg) || {};
      const ig = conn.ig_user_id || "<ig_user_id missing>";
      const tok = R.mask(conn.page_access_token) || "<page token missing>";
      const url = signedVideoUrl(job.id, n, 3600) || "<PUBLIC_BASE_URL missing>";
      out.platforms.instagram = {
        credentials: cred.instagram,
        ai_flag: "not set: the Graph API has no AI-content field for Reels; the caption carries the AI voice disclosure",
        requests: [
          { method: "POST", url: `${GRAPH}/${ig}/media`, body: { media_type: "REELS", video_url: url, caption: (v.captions && v.captions.instagram) || v.post_text, share_to_feed: "true", access_token: tok } },
          { method: "GET", url: `${GRAPH}/<container_id>?fields=status_code,status&access_token=${tok}`, note: "poll every 10 s until status_code is FINISHED (max 15 min)" },
          { method: "POST", url: `${GRAPH}/${ig}/media_publish`, body: { creation_id: "<container_id>", access_token: tok } },
          { method: "GET", url: `${GRAPH}/<media_id>?fields=permalink&access_token=${tok}` },
        ],
      };
    }
    if (platforms.includes("x")) {
      const ch = xChannel(cfg) || {};
      let ck = ""; try { ck = R.mask(twitterCreds(ch).key); } catch {}
      const auth = ck ? `OAuth oauth_consumer_key="${ck}", oauth_signature="***" (OAuth 1.0a user context)` : "<X credentials missing>";
      const chunks = Math.max(1, Math.ceil(size / (4 * 1024 * 1024)));
      const text = R.trimForX((v.captions && v.captions.x) || v.post_text || "", 280);
      out.platforms.x = {
        credentials: cred.x,
        ai_flag: "not set: the X API v2 has no AI-content field; the caption carries the AI voice disclosure",
        text_length: R.weightedLength(text),
        requests: [
          { method: "POST", url: "https://api.x.com/2/media/upload/initialize", headers: { Authorization: auth }, body: { media_type: "video/mp4", total_bytes: size, media_category: "tweet_video" } },
          ...Array.from({ length: chunks }, (_, i) => ({ method: "POST", url: "https://api.x.com/2/media/upload/<media_id>/append", headers: { Authorization: auth }, body: { segment_index: String(i), media: `<bytes ${i * 4194304} to ${Math.min(size, (i + 1) * 4194304) - 1}>` } })),
          { method: "POST", url: "https://api.x.com/2/media/upload/<media_id>/finalize", headers: { Authorization: auth } },
          { method: "GET", url: "https://api.x.com/2/media/upload?command=STATUS&media_id=<media_id>", headers: { Authorization: auth }, note: "poll until processing_info.state is succeeded" },
          { method: "POST", url: "https://api.x.com/2/tweets", headers: { Authorization: auth }, body: { text, media: { media_ids: ["<media_id>"] } } },
        ],
      };
    }
    const f = path.join(outDir(job.id, n), "publish-dry-run.json");
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    log(`${job.id} dry-run publish v${n} built for ${platforms.join(", ")} (nothing sent)`);
    return { ...out, path: f };
  }

  // ══════════════════════════════════════════════════════════════════════
  // Routes
  // ══════════════════════════════════════════════════════════════════════
  function publicJob(j) {
    const cfg = config();
    return {
      ...j,
      uploads: Object.fromEntries(Object.entries(j.uploads || {}).map(([k, u]) => [k, { id: u.id, name: u.name, size: u.size }])),
      versions: (j.versions || []).map(v => ({ ...v, prev_script: undefined, video_url: v.status === "ready" ? `/rips/jobs/${j.id}/v/${v.n}/video` : null })),
      tool_name: cfg.tool_name,
    };
  }

  function mount(app, express) {
    app.post("/rips/uploads", (req, res) => {
      const { name, size, kind } = req.body || {};
      const ext = String(name || "").toLowerCase().split(".").pop();
      if (!UPLOAD_EXT.has(ext)) return res.status(400).json({ error: "only .mp4 and .mov files" });
      const sz = Number(size);
      if (!(sz > 0)) return res.status(400).json({ error: "size missing" });
      if (sz > MAX_UPLOAD) return res.status(413).json({ error: "file is larger than 1 GB" });
      const id = "up_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
      const u = { id, name: String(name).slice(0, 200), size: sz, ext, kind: kind === "market" ? "market" : "pull", received: 0, done: false, created_at: new Date().toISOString() };
      fs.writeFileSync(path.join(UPLOADS, `${id}.part`), "");
      writeUpload(u);
      res.json(u);
    });
    app.get("/rips/uploads/:id", (req, res) => {
      const u = readUpload(req.params.id); if (!u) return res.status(404).json({ error: "not found" });
      res.json(u);
    });
    app.put("/rips/uploads/:id/chunk", express.raw({ type: "*/*", limit: "9mb" }), (req, res) => {
      const u = readUpload(req.params.id); if (!u) return res.status(404).json({ error: "not found" });
      if (u.done) return res.json(u);
      const offset = Number(req.query.offset);
      if (offset !== u.received) return res.status(409).json({ error: "offset mismatch", received: u.received });
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) return res.status(400).json({ error: "empty chunk" });
      if (u.received + buf.length > u.size) return res.status(400).json({ error: "chunk exceeds the file size" });
      fs.appendFileSync(path.join(UPLOADS, `${u.id}.part`), buf);
      u.received += buf.length;
      if (u.received === u.size) {
        const final = path.join(UPLOADS, `${u.id}.${u.ext}`);
        fs.renameSync(path.join(UPLOADS, `${u.id}.part`), final);
        u.done = true; u.path = final;
      }
      writeUpload(u);
      res.json(u);
    });

    app.post("/rips/jobs", (req, res) => {
      const cards = Array.isArray(req.body && req.body.cards) ? req.body.cards : [];
      if (!cards.length) return res.status(400).json({ error: "no cards" });
      const created = [];
      for (const c of cards) {
        const pull = readUpload(c.pull), market = readUpload(c.market);
        if (!pull || !pull.done || !market || !market.done) return res.status(400).json({ error: "both uploads must be complete for every card" });
      }
      const jobs = readJobs();
      for (const c of cards) {
        const pull = readUpload(c.pull), market = readUpload(c.market);
        const job = {
          id: genId(), status: "uploaded", step: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          card_label: String(c.label || "").slice(0, 80) || pull.name,
          uploads: { pull: { id: pull.id, name: pull.name, size: pull.size, path: pull.path }, market: { id: market.id, name: market.name, size: market.size, path: market.path } },
          plan: {}, versions: [], current_version: null, pending: null, error: null, log: [],
        };
        jobs.push(job); created.push(job.id);
        log(`${job.id} created from ${pull.id} + ${market.id}`);
      }
      writeJobs(jobs);
      setImmediate(tick);
      res.json({ ok: true, jobs: created });
    });
    app.get("/rips/jobs", (_req, res) => res.json(readJobs().slice().reverse().map(publicJob)));
    app.get("/rips/jobs/:id", (req, res) => { const j = getJob(req.params.id); if (!j) return res.status(404).json({ error: "not found" }); res.json(publicJob(j)); });
    app.delete("/rips/jobs/:id", (req, res) => {
      const j = getJob(req.params.id); if (!j) return res.status(404).json({ error: "not found" });
      if (busy && ["processing", "revising", "publishing"].includes(j.status)) return res.status(409).json({ error: "job is running" });
      writeJobs(readJobs().filter(x => x.id !== j.id));
      for (const d of [workDir(j.id), path.join(OUT, j.id)]) fs.rmSync(d, { recursive: true, force: true });
      log(`${j.id} deleted`);
      res.json({ ok: true });
    });
    app.get("/rips/jobs/:id/v/:n/video", (req, res) => {
      const j = getJob(req.params.id); if (!j || !version(j, req.params.n)) return res.status(404).end();
      const f = finalPath(j.id, Number(req.params.n));
      if (!fs.existsSync(f)) return res.status(404).end();
      res.type("video/mp4").sendFile(f);
    });
    app.get("/rips/jobs/:id/v/:n/file/:name", (req, res) => {
      const j = getJob(req.params.id); const name = req.params.name;
      if (!j || !version(j, req.params.n) || !["analysis.json", "script.json", "post.txt", "publish-dry-run.json"].includes(name)) return res.status(404).end();
      const f = path.join(outDir(j.id, Number(req.params.n)), name);
      if (!fs.existsSync(f)) return res.status(404).end();
      res.sendFile(f);
    });

    app.post("/rips/jobs/:id/revise", async (req, res) => {
      const j = getJob(req.params.id); if (!j) return res.status(404).json({ error: "not found" });
      if (!["ready_for_review", "approved", "published"].includes(j.status) && !(j.status === "failed" && j.current_version)) return res.status(409).json({ error: `cannot revise while ${j.status}` });
      const chips = (Array.isArray(req.body.chips) ? req.body.chips : []).filter(c => R.CHIPS[c]);
      const text = String(req.body.text || "").slice(0, 2000);
      if (!chips.length && !text.trim()) return res.status(400).json({ error: "add a note or pick a chip" });
      try {
        const plan = await apiUsage.forTask(j.id, () => planRevision(j, text, chips));
        const n = startRevision(j.id, { ...plan, text, chips });
        setImmediate(tick);
        res.json({ ok: true, version: n, steps: plan.steps, plan: plan.plan });
      } catch (e) { res.status(500).json({ error: redact(e.message) }); }
    });
    app.post("/rips/jobs/:id/retry", (req, res) => {
      const j = getJob(req.params.id); if (!j) return res.status(404).json({ error: "not found" });
      if (j.status !== "failed") return res.status(409).json({ error: "only failed jobs can be retried" });
      const from = j.failed_from;
      updateJob(j.id, x => {
        x.error = null;
        if (from === "publishing") { x.status = "approved"; }
        else if (x.pending) { x.status = from === "revising" ? "revising" : "processing"; const v = version(x, x.pending.n); if (v) v.status = "building"; }
        else if (!x.versions.length) { x.status = "uploaded"; }
        else x.status = "ready_for_review";
      });
      jobLog(j.id, `retry requested (was ${from})`);
      setImmediate(tick);
      res.json({ ok: true, status: getJob(j.id).status });
    });
    app.post("/rips/jobs/:id/caption", (req, res) => {
      const j = getJob(req.params.id); const n = Number(req.body.version) || (j && j.current_version);
      if (!j || !version(j, n)) return res.status(404).json({ error: "not found" });
      const ig = req.body.instagram, x = req.body.x;
      if (x != null && R.weightedLength(String(x)) > 280) return res.status(400).json({ error: `X caption is ${R.weightedLength(String(x))}/280 characters` });
      if (ig != null && String(ig).length > 2200) return res.status(400).json({ error: "Instagram caption is longer than 2200 characters" });
      for (const t of [ig, x]) if (t != null && /[‒–—―]/.test(t)) return res.status(400).json({ error: "no em or en dashes" });
      updateJob(j.id, jj => { const v = version(jj, n); v.captions = { ...(v.captions || {}), ...(ig != null ? { instagram: String(ig) } : {}), ...(x != null ? { x: String(x) } : {}) }; v.captions_edited = true; });
      res.json({ ok: true, captions: version(getJob(j.id), n).captions });
    });
    app.post("/rips/jobs/:id/approve", (req, res) => {
      const j = getJob(req.params.id); if (!j) return res.status(404).json({ error: "not found" });
      const n = Number(req.body.version) || j.current_version; const v = version(j, n);
      if (!v || v.status !== "ready") return res.status(400).json({ error: "version is not ready" });
      const platforms = (Array.isArray(req.body.platforms) ? req.body.platforms : []).filter(p => p === "instagram" || p === "x");
      if (!platforms.length) return res.status(400).json({ error: "pick Instagram and/or X" });
      if (req.body.dry_run) {
        const out = dryRun(j, n, platforms);
        updateJob(j.id, x => { if (x.status === "ready_for_review") x.status = "approved"; x.approved_version = n; version(x, n).dry_run = { at: out.built_at, path: out.path, platforms }; });
        jobLog(j.id, `approved v${n} (dry run, nothing sent) for ${platforms.join(", ")}`);
        return res.json({ ok: true, dry_run: out });
      }
      const cred = credentials();
      const missing = platforms.filter(p => !cred[p].ok);
      if (missing.length) return res.status(400).json({ error: "credentials missing", details: Object.fromEntries(missing.map(p => [p, cred[p].missing])) });
      const todo = platforms.filter(p => ((v.publish || {})[p] || {}).status !== "published");
      if (!todo.length) return res.status(409).json({ error: "this version is already published on the chosen platforms" });
      updateJob(j.id, x => { x.status = "publishing"; x.approved_version = n; x.publish_request = { version: n, platforms: todo }; });
      jobLog(j.id, `approved v${n} for ${todo.join(", ")}`);
      setImmediate(tick);
      res.json({ ok: true, publishing: todo });
    });
    app.post("/rips/jobs/:id/publish", (req, res) => {
      const j = getJob(req.params.id); if (!j) return res.status(404).json({ error: "not found" });
      const n = Number(req.body.version) || j.approved_version || j.current_version; const v = version(j, n);
      const platform = req.body.platform;
      if (!v || !["instagram", "x"].includes(platform)) return res.status(400).json({ error: "version and platform needed" });
      if (((v.publish || {})[platform] || {}).status === "published") return res.status(409).json({ error: "already published" });
      const cred = credentials();
      if (!cred[platform].ok) return res.status(400).json({ error: "credentials missing", details: { [platform]: cred[platform].missing } });
      updateJob(j.id, x => { x.status = "publishing"; x.publish_request = { version: n, platforms: [platform] }; x.error = null; });
      setImmediate(tick);
      res.json({ ok: true });
    });
    app.get("/rips/credentials", async (req, res) => {
      const cfg = config();
      if (req.query.check) { try { await refreshInstagramToken(cfg, { force: true }); } catch {} }
      res.json({ ...credentials(cfg), chips: Object.keys(R.CHIPS), brand: cfg.brand, tool_name: cfg.tool_name });
    });
    app.get("/rips/status", (_req, res) => res.json(status()));
  }

  function status() {
    const jobs = readJobs();
    const counts = {}; for (const j of jobs) counts[j.status] = (counts[j.status] || 0) + 1;
    return { busy, counts, total: jobs.length };
  }

  return { mount, servePublic, tick, status, dryRun, credentials, _internal: { readJobs, getJob, updateJob, planRevision, startRevision } };
}

module.exports = { createRips };
