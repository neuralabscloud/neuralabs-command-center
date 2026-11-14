#!/usr/bin/env node
// Hook + reply pairs from the terminal (talks to the running server, nothing is published).
//   node scripts/x-pairs.js --dry-run [--channel <id>] [--n 5]   5 pairs per channel with a profile, printed
//   node scripts/x-pairs.js --status  [--channel <id>]           last 20 pairs per channel
//   node scripts/x-pairs.js --run --channel <id>                 one pair now as a draft (review)
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = process.env.PORT_CC || 3004;
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "Content-Type": "application/json", "x-internal": "scheduler", "x-internal-secret": process.env.INTERNAL_SECRET || "" };

async function call(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { error: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${r.status} ${d.error || ""}`);
  return d;
}

function channelIds() {
  const one = val("--channel");
  if (one) return [one];
  const f = path.join(__dirname, "..", "data", "x-pair-profiles.json");
  try { return Object.keys(JSON.parse(fs.readFileSync(f, "utf8"))); } catch { return []; }
}

const line = "─".repeat(64);
function printPair(p, i) {
  const v = p.validator || {};
  console.log(`\n#${i + 1}  ${p.formula} · ${p.pillar}${p.media ? " · media: " + (p.media.label || p.media.kind) : ""}${p.has_link ? " · link" : ""}${p.facts_used ? " · API facts" : ""}`);
  console.log(`validator: ${v.ok ? "ok" + (v.attempts > 1 ? ` (after ${v.attempts} tries)` : "") : "DROPPED: " + v.error}`);
  for (const r of v.rejected_attempts || []) if (r && r.length) console.log(`  rejected try: ${r.join("; ")}`);
  if (p.hook) { console.log("HOOK:\n" + p.hook); (p.replies || []).forEach((r, j) => console.log(`REPLY ${j + 1}:\n` + r)); }
}

(async () => {
  const ids = channelIds();
  if (!ids.length) { console.error("No channels with a pair profile."); process.exit(1); }
  if (flag("--run")) {
    if (!val("--channel")) { console.error("--run needs --channel <id>"); process.exit(1); }
    console.log(await call("POST", `/community/channels/${encodeURIComponent(ids[0])}/pairs/run`, { mode: "review" }));
    return;
  }
  if (flag("--status")) {
    for (const id of ids) {
      const s = await call("GET", `/community/channels/${encodeURIComponent(id)}/pairs`);
      console.log(`${line}\n${id}: ${s.pairs.length} pairs`);
      for (const p of s.pairs) console.log(`${p.posted_at || p.created_at} ${p.status} ${p.formula}/${p.pillar} hook=${p.hook_id || "-"} score=${p.score ?? "-"}`);
    }
    return;
  }
  if (!flag("--dry-run")) { console.log("Use --dry-run, --status or --run. Nothing done."); return; }
  const n = Number(val("--n", 5)) || 5;
  const all = {};
  for (const id of ids) {
    const r = await call("POST", `/community/channels/${encodeURIComponent(id)}/pairs/dry-run`, { n });
    all[id] = r;
    console.log(`${line}\n${r.channel} (${r.premium ? "Premium, 1 reply" : "thread"})`);
    r.pairs.forEach(printPair);
  }
  const out = val("--out");
  if (out) { fs.writeFileSync(out, JSON.stringify(all, null, 2)); console.log(`\nsaved: ${out}`); }
  const tot = Object.values(all).flatMap(r => r.pairs);
  console.log(`\n${line}\nDRY RUN: ${tot.length} pairs, ${tot.filter(p => p.validator && p.validator.ok).length} valid, nothing published.`);
})().catch(e => { console.error("FOUT:", e.message); process.exit(1); });
