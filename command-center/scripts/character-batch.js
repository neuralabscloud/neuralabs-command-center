#!/usr/bin/env node
// Manual trigger for the weekly character video batch (same run as the Scheduler button).
//   node scripts/character-batch.js                 full batch (7 stills + 7 videos)
//   node scripts/character-batch.js --dry-run       concepts only, nothing is generated
//   node scripts/character-batch.js --slots 1,3     only these days (1 = Monday)
//   node scripts/character-batch.js --schedule <id> pick a schedule (default: the first)
//   node scripts/character-batch.js --no-wait       start and exit, result comes via Telegram
//   node scripts/character-batch.js --retry <batch> retry the videos skipped for low balance
const fs = require("fs");
const path = require("path");

const env = {};
try {
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const PORT = process.env.CC_PORT || env.PORT_CC || 3004;
const BASE = `http://127.0.0.1:${PORT}`;
const headers = { "Content-Type": "application/json", "x-internal": "scheduler", "x-internal-secret": env.INTERNAL_SECRET || process.env.INTERNAL_SECRET || "" };

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const body = { dry_run: flag("--dry-run") };
if (val("--slots")) body.slots = val("--slots").split(",").map(Number).filter(Boolean);
if (val("--schedule")) body.schedule_id = val("--schedule");

async function api(method, url, data) {
  const r = await fetch(BASE + url, { method, headers, body: data ? JSON.stringify(data) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function printManifest(m) {
  console.log(`\n${m.batch_id} · ${m.week_start} to ${m.week_end} · status ${m.status}${m.dry_run ? " (dry run)" : ""}`);
  for (const s of m.slots || []) {
    console.log(`\n[${s.slot}] ${s.day} ${s.date} · ${s.city} · outfit ${s.outfit?.label || s.outfit_index} · ${s.status}${s.onscreen_text ? ` · text: "${s.onscreen_text}"` : ""}`);
    if (m.dry_run) {
      console.log(`  still: ${s.start_frame_prompt}`);
      console.log(`  video: ${s.video_prompt}`);
      console.log(`  caption:\n    ${String(s.caption).split("\n").join("\n    ")}`);
    } else {
      if (s.still_url) console.log(`  still: ${s.still_url}`);
      if (s.video_url) console.log(`  video: ${s.video_url}`);
      if (s.error) console.log(`  error: ${s.error}`);
    }
  }
  if (m.stopped) console.log(`\n⚠ ${m.stopped}`);
  if (m.error) console.log(`\n✗ ${m.error}`);
  if (m.total_cost) console.log(`\nCost: $${m.total_cost.usd.toFixed(2)}${m.total_cost.priced ? "" : " (+? unknown rate)"}`);
}

(async () => {
  let r;
  if (val("--retry")) {
    r = await api("POST", `/character-batch/${encodeURIComponent(val("--retry"))}/retry`, { include_failed: flag("--include-failed") });
    console.log(`Retry started for ${r.slots} video(s).`);
  } else {
    console.log(`Video batch ${body.dry_run ? "(dry run) " : ""}starting…`);
    r = await api("POST", "/character-batch/run", body);
    if (body.dry_run) return printManifest(r);
    console.log(`Started (${r.schedule}).`);
  }
  if (flag("--no-wait")) return console.log("Result follows via Telegram.");
  let seen = 0, batchId = null;
  for (;;) {
    await new Promise(res => setTimeout(res, 15000));
    const st = await api("GET", "/character-batch/status");
    if (st.running) {
      batchId = st.running.batch_id;
      for (const l of st.running.log.slice(seen)) console.log("  " + l);
      seen = st.running.log.length;
      continue;
    }
    const list = await api("GET", "/character-batch");
    const m = (list.batches || []).find(b => !batchId || b.batch_id === batchId);
    if (m) printManifest(m);
    break;
  }
})().catch(e => { console.error("✗ " + e.message); process.exit(1); });
