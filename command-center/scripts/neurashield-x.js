#!/usr/bin/env node
// NeuraShield on X (task neurashield-x) from the terminal. Talks to the running server; nothing is published.
//   node scripts/neurashield-x.js --dry-run [--n 7]      generate + validate 7 pairs (one per pillar, one poll), printed
//   node scripts/neurashield-x.js --run                  one pair now as a draft (review mode)
//   node scripts/neurashield-x.js --status               panel data (last 20 pairs, drafts, tickets)
//   node scripts/neurashield-x.js --facts --dry-run      what the weekly facts updater would append
//   node scripts/neurashield-x.js --report --print       weekly report text without sending it
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = `http://127.0.0.1:${process.env.PORT_CC || 3004}`;
const H = { "Content-Type": "application/json", "x-internal": "scheduler", "x-internal-secret": process.env.INTERNAL_SECRET || "" };

async function call(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20 * 60e3) });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { error: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${r.status} ${d.error || ""}`);
  return d;
}

function printPair(p, i) {
  const v = p.validator || {};
  console.log(`\n${"─".repeat(64)}\n#${i + 1}  pillar ${p.pillar} · formule ${p.formula}${p.poll ? " · POLL" : ""}${p.media ? " · beeld: " + (p.media.label || p.media.kind) : ""}${p.fallback ? " · fallback: " + p.fallback : ""}`);
  console.log(`validator: ${v.ok ? "ok" + (v.attempts > 1 ? ` (na ${v.attempts} pogingen)` : "") : "AFGEKEURD: " + v.error}`);
  for (const r of v.rejected_attempts || []) if (r && r.length) console.log(`  afgekeurde poging: ${r.join("; ")}`);
  if (p.hook) { console.log("HOOK:\n" + p.hook); if (p.poll_options) console.log("POLL: " + p.poll_options.join(" / ")); (p.replies || []).forEach((r, j) => console.log(`REPLY ${j + 1}:\n` + r)); }
  for (const f of (p.check || {}).facts_matched || []) console.log(`  facts L${f.line}: ${f.text}\n    claim: ${f.claim}`);
}

(async () => {
  if (flag("--facts")) { const r = await call("POST", "/neurashield/facts", { dry_run: flag("--dry-run") }); console.log(JSON.stringify(r, null, 2)); return; }
  if (flag("--report")) { const r = await call("POST", "/neurashield/report", { send: !flag("--print") }); console.log(r.message); return; }
  if (flag("--dry-run")) {
    const r = await call("POST", "/neurashield/dry-run", { n: Number(val("--n", 7)) });
    console.log(`${r.channel} · premium ${r.premium} · nieuws: ${r.news_found ? r.news_found.title + " (" + r.news_found.url + ")" : "geen in 72 uur"}`);
    r.pairs.forEach(printPair);
    return;
  }
  if (flag("--run")) { console.log(JSON.stringify(await call("POST", "/neurashield/run", { mode: "review", force: true }), null, 2)); return; }
  if (flag("--status")) { console.log(JSON.stringify(await call("GET", "/neurashield/status"), null, 2)); return; }
  console.log("Gebruik: --dry-run | --run | --status | --facts --dry-run | --report --print");
})().catch(e => { console.error("FOUT " + e.message); process.exit(1); });
