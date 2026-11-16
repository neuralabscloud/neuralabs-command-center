#!/usr/bin/env node
// gh0stlayer news cards CLI.
//   node scripts/news-cards.js --dry-run                 one set per layout (signal, number, versus, persona), render locally, publish nothing
//   node scripts/news-cards.js --dry-run --layouts number,versus --no-images
// Output: data/news-cards/dry-run/set_<id>_slide_<n>.png + dry-run-<timestamp>.json (cards, scores, validator, sources).
// A real run (publish) goes through the service: POST /news-cards/run or the button on the Social Media Manager page.
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });
const pipeline = require("../news-cards-pipeline");
const nc = require("../news-cards");

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

if (!flag("--dry-run")) {
  console.log("Alleen --dry-run hier. Echte run: POST /news-cards/run (of de knop op de Social Media Manager pagina).");
  process.exit(1);
}

const MODEL = process.env.NEWS_CARDS_MODEL || "claude-opus-5-5";
let anthropic = null;
async function llm(system, user) {
  if (!anthropic) { const Anthropic = require("@anthropic-ai/sdk"); anthropic = new (Anthropic.default || Anthropic)(); }
  const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 4000, system, messages: [{ role: "user", content: user }] });
  return (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

// Nano Banana via the inference.sh CLI (same app as the service), saved next to the dry-run PNGs.
function genImage({ prompt, aspect, setId, label }) {
  const tag = `${setId}-${label.replace(/\W+/g, "-")}`;
  const input = path.join(pipeline.DRY_DIR, `nb-input-${tag}.json`);
  fs.mkdirSync(pipeline.DRY_DIR, { recursive: true });
  fs.writeFileSync(input, JSON.stringify({ prompt, aspect_ratio: aspect, resolution: "2K", num_images: 1 }));
  return new Promise((resolve, reject) => {
    execFile("infsh", ["app", "run", "google/gemini-3-1-flash-image-preview", "--input", input, "--json", "--no-input"],
      { timeout: 180000, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, HOME: "/root" } }, async (err, stdout) => {
        try { fs.unlinkSync(input); } catch {}
        try {
          const out = String(stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
          const j = out.indexOf("{");
          if (err || j < 0) throw new Error(err ? err.message.slice(0, 200) : "geen JSON van infsh");
          const r = JSON.parse(out.slice(j));
          const url = (r.output?.images || r.images || [])[0];
          if (!url) throw new Error("geen beeld terug");
          const res = await fetch(url);
          if (!res.ok) throw new Error(`download HTTP ${res.status}`);
          const file = path.join(pipeline.DRY_DIR, `img-${tag}.png`);
          fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
          resolve({ file, url: null, task_id: null, infsh_id: r.id || null });
        } catch (e) { reject(e); }
      });
  });
}

function personaStills() {
  const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "designer-tasks.json"), "utf8"));
  return tasks.filter(t => t.status === "completed" && t.batch_id && String(t.result_url || "").startsWith("/generated-images/"))
    .map(t => ({ id: t.id, prompt: t.prompt, url: t.result_url, file: path.join(ROOT, "data", "generated-images", path.basename(t.result_url)) }))
    .filter(t => fs.existsSync(t.file));
}

(async () => {
  const layouts = (opt("--layouts") || "signal,number,versus,persona").split(",").map(s => s.trim()).filter(l => nc.LAYOUTS.includes(l));
  const deps = { llm, genImage: flag("--no-images") ? null : genImage, personaStills: flag("--no-images") ? null : personaStills };
  const r = await pipeline.run({ deps, dryRun: true, layouts, reason: "cli dry-run" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonFile = path.join(pipeline.DRY_DIR, `dry-run-${stamp}.json`);
  fs.mkdirSync(pipeline.DRY_DIR, { recursive: true });
  fs.writeFileSync(jsonFile, JSON.stringify(r, null, 2));
  console.log("bronnen:");
  for (const [k, v] of Object.entries(r.sources)) console.log(`  ${k}: ${v}`);
  console.log(`kandidaten ${r.candidates}, sets ${r.sets.length}`);
  for (const m of r.manifests) {
    console.log(`- ${m.layout} ${m.status} ${m.pill || ""} | ${String(m.item?.title || "").slice(0, 70)} | score ${m.score?.total}${m.reason ? " | " + m.reason.slice(0, 160) : ""}`);
    for (const s of m.slides || []) console.log(`    ${s.path}`);
  }
  console.log(`JSON: ${jsonFile}`);
  process.exit(r.manifests.some(m => m.status === "rendered") ? 0 : 1);
})().catch(e => { console.error("FOUT", e.message); process.exit(1); });
