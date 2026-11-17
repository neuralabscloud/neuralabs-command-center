#!/usr/bin/env node
// Vault posts CLI.
//   node scripts/vault-posts.js --dry-run [--channel slabcok4gtn6] [--out DIR] [--listing ID ...] [--sold ID ...]
// --dry-run renders the PNGs and writes the captions for real feed records, publishes nothing.
// Without --listing/--sold it takes the first 2 priced items as listings and the third as a simulated sale.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });
const vault = require("../vault-posts");
const listings = require("../listings-autopilot");
const nc = require("../news-cards");
const { galleryPhotos } = require("../news-cards-pipeline");

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const all = (k) => argv.flatMap((a, i) => a === k ? [argv[i + 1]] : []);

async function main() {
  if (!argv.includes("--dry-run")) { console.error("Only --dry-run is supported here; live posts go through the listings trigger or POST /vault-posts/run."); process.exit(64); }
  const channels = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "community", "channels.json"), "utf8"));
  const list = Array.isArray(channels) ? channels : channels.channels || [];
  const channel = list.find(c => c.id === (opt("--channel") || "slabcok4gtn6"));
  if (!channel) throw new Error("channel not found");
  const cfg = listings.config(channel);
  const r = await fetch(cfg.feed_url);
  const feed = listings.normaliseFeed(await r.json(), cfg.feed_url);
  const priced = feed.items.filter(listings.sellable);
  const pick = ids => ids.map(id => priced.find(i => i.id === id || i.id.startsWith(id)) || (() => { throw new Error(`item ${id} not in the feed`); })());
  let L = pick(all("--listing")), S = pick(all("--sold"));
  if (!L.length && !S.length) { L = priced.slice(0, 2); S = priced.slice(2, 3); }
  const out = opt("--out") || path.join(ROOT, "public", "media", "vault-posts", "dry-run");
  const Anthropic = require("@anthropic-ai/sdk");
  const anthropic = new (Anthropic.default || Anthropic)();
  const A = nc.account(vault.vaultConfig(channel).account);
  const galleryDir = path.join(ROOT, A.imagePolicy.gallery_dir || "data/brand-assets/SLABHAUS/slabs");
  const v = vault.createVault({ dataDir: path.join(ROOT, "data"), mediaDir: path.join(ROOT, "public", "media"), anthropic, galleryDir, galleryPhotos: () => galleryPhotos(galleryDir) });
  const results = [];
  for (const [kind, items] of [["listing", L], ["sold", S]]) {
    for (const item of items) {
      const it = kind === "sold" ? { ...item, sold_at: new Date().toISOString() } : item;
      try {
        const e = await v.build(channel, { kind, item: it, dryRun: true, outDir: out });
        results.push(e);
        console.log(`\n=== ${kind}: ${e.record.card} ${e.record.grader} ${e.record.grade} (cert ${e.record.cert}) ===`);
        console.log(`png: ${e.png}\nphoto: ${e.photo}\ncutout: ${e.cutout}\ncopy by: ${e.copy.by}`);
        console.log(`--- instagram caption ---\n${e.copy.ig_caption}\n--- x hook ---\n${e.copy.x_hook}${e.copy.x_reply ? `\n--- x reply ---\n${e.copy.x_reply}` : ""}`);
      } catch (err) { console.log(`\n=== ${kind}: ${item.id} FAILED: ${err.message}`); }
    }
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "dry-run.json"), JSON.stringify(results, null, 2));
  await nc.closeBrowser();
}
main().catch(e => { console.error(e.message); process.exit(1); });
