// Offline tests for api-usage.js — run: node scripts/test-api-usage.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "api-usage-test-"));
process.env.API_USAGE_DATA_DIR = tmp;
const u = require("../api-usage");
const { rowCost, effectiveRates, modelRate, higgsfieldRate, meterFetch, providerForHost, recordClaudeMessage, reset } = u._internal;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FOUT " + name); }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
const rates = effectiveRates({});

// ── rates ──
check("exact model rate", modelRate("claude-opus-5-5", rates).in === 4);
check("dated model id matches", modelRate("claude-haiku-4-5-20251001", rates).out === 5);
check("longest id wins (fable-5-1 not fable-5)", modelRate("claude-fable-5-1", rates).cr === 0.25);
check("unknown model has no rate", modelRate("gpt-9", rates) === null);

// ── cost per row ──
check("claude token cost", near(rowCost({ p: "anthropic", m: "claude-sonnet-5", in: 1e6, out: 1e6 }, rates).cost, 12));
check("cache read/write priced", near(rowCost({ p: "anthropic", m: "claude-opus-5-5", cw: 1e6, cr: 1e6 }, rates).cost, 5.2));
check("1h cache write = 2x input", near(rowCost({ p: "anthropic", m: "claude-opus-5-5", cw1h: 1e6 }, rates).cost, 8));
check("web search $10 per 1k", near(rowCost({ p: "anthropic", m: "claude-sonnet-5", searches: 100 }, rates).cost, 1));
check("unknown model flagged unpriced", rowCost({ p: "anthropic", m: "mystery", in: 5 }, rates).priced === false);

// ── higgsfield per model ──
const hfRates = effectiveRates({ rates: { higgsfield: { per_job: 0.1, models: { "nano-banana": { per_job: 0.04 }, "seedance-2.5": { per_sec: 0.05 }, "seedance-2.5/text-to-video": { per_job: 0.2, per_sec: 0.06 } } } } });
check("higgsfield: model rate by contained key", higgsfieldRate("text2image/nano-banana", hfRates).per_job === 0.04);
check("higgsfield: longest key wins", higgsfieldRate("bytedance/seedance-2.5/text-to-video", hfRates).per_sec === 0.06);
check("higgsfield: per job x jobs", near(rowCost({ p: "higgsfield", m: "text2image/nano-banana", jobs: 8 }, hfRates).cost, 0.32));
check("higgsfield: per second x secs", near(rowCost({ p: "higgsfield", m: "bytedance/seedance-2.5/image-to-video", jobs: 3, secs: 24 }, hfRates).cost, 1.2));
check("higgsfield: per job + per second combined", near(rowCost({ p: "higgsfield", m: "bytedance/seedance-2.5/text-to-video", jobs: 1, secs: 8 }, hfRates).cost, 0.68));
check("higgsfield: unknown model falls back to per_job", near(rowCost({ p: "higgsfield", m: "speak/kling", jobs: 2 }, hfRates).cost, 0.2));
check("higgsfield: no rates = unpriced", rowCost({ p: "higgsfield", m: "speak/kling", jobs: 2 }, rates).priced === false);
check("inference uses actual charge", near(rowCost({ p: "inference", actual: 0.101, tasks: 1 }, rates).cost, 0.101));
check("elevenlabs per 1k chars", near(rowCost({ p: "elevenlabs", chars: 2000 }, rates).cost, 0.6));
check("x reads + writes", near(rowCost({ p: "x", reads: 100, writes: 2 }, rates).cost, 0.52));
check("free provider costs nothing", rowCost({ p: "telegram", calls: 50 }, rates).cost === 0);
check("rate override applies", near(rowCost({ p: "elevenlabs", chars: 1000 }, effectiveRates({ rates: { elevenlabs: { per_1k_chars: 0.1 } } })).cost, 0.1));
check("empty override falls back to default", effectiveRates({ rates: { x: { per_read: "" } } }).x.per_read === 0.005);

// ── host mapping ──
check("anthropic host not double counted", providerForHost("api.anthropic.com") === null);
check("x hosts", providerForHost("api.x.com") === "x" && providerForHost("api.twitter.com") === "x");
check("higgsfield host", providerForHost("platform.higgsfield.ai") === "higgsfield");
check("unknown host ignored", providerForHost("example.com") === null);

// ── recording ──
reset();
u.tag("Unit test", () => recordClaudeMessage({ model: "claude-sonnet-5", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, server_tool_use: { web_search_requests: 2 } } }));
const okRes = { ok: true, clone: () => ({ json: async () => ({ data: [1, 2, 3] }) }) };
u.tag("Unit test", () => {
  meterFetch("https://api.elevenlabs.io/v1/text-to-speech/abc", { method: "POST", body: JSON.stringify({ text: "hello world", model_id: "m" }) }, okRes);
  meterFetch("https://api.x.com/2/tweets", { method: "POST", body: "{}" }, okRes);
  meterFetch("https://platform.higgsfield.ai/v1/speak/higgsfield", { method: "POST", body: JSON.stringify({ params: { model: "kling" } }) }, okRes);
  meterFetch("https://platform.higgsfield.ai/requests/123/status", { method: "GET" }, okRes);
  meterFetch("https://api.higgsfield.ai/bytedance/seedance-2.5/image-to-video", { method: "POST", body: JSON.stringify({ prompt: "x", duration: 8 }) }, okRes);
  meterFetch("https://api.higgsfield.ai/files/generate-upload-url", { method: "POST", body: "{}" }, okRes);
  meterFetch("https://api.telegram.org/botX/sendMessage", { method: "POST" }, okRes);
  meterFetch("https://api.x.com/2/tweets/search/recent?query=btc", { method: "GET" }, okRes);
});

setTimeout(() => {
  const s = u.summary({ days: 30 });
  const p = Object.fromEntries(s.providers.map(x => [x.id, x]));
  check("claude tokens recorded", p.anthropic.period.qty.in === 1000 && p.anthropic.period.qty.out === 500 && p.anthropic.period.qty.cr === 200);
  check("claude searches recorded", p.anthropic.period.qty.searches === 2);
  check("claude cost in summary", near(p.anthropic.period.cost, (1000 * 2 + 500 * 10 + 200 * 0.2) / 1e6 + 0.02));
  check("elevenlabs characters counted", p.elevenlabs.period.qty.chars === 11);
  check("x post counted", p.x.period.qty.writes === 1);
  check("x search reads = items returned", p.x.period.qty.reads === 3);
  check("higgsfield jobs counted (platform + api), polling/upload not", p.higgsfield.period.qty.jobs === 2 && p.higgsfield.period.calls === 2);
  check("higgsfield video seconds recorded from body", p.higgsfield.period.qty.secs === 8);
  check("higgsfield per-model list in summary", s.higgsfield_models.length === 2 && s.higgsfield_models.every(h => h.priced === false));
  check("telegram call counted at $0", p.telegram.period.calls === 1 && p.telegram.period.cost === 0);
  check("feature tag applied", s.features.length === 1 && s.features[0].feature === "Unit test");
  check("model breakdown", s.models.length === 1 && s.models[0].model === "claude-sonnet-5");
  check("series covers period", s.series.length === 30 && s.series[29].day === s.period.to);
  check("today equals period (single day)", near(s.series[29].cost, s.providers.reduce((a, x) => a + x.today.cost, 0)));

  // ── config ──
  u.updateConfig({ fixed: { higgsfield: "29", opusclip: "", bogus: 5 }, rates: { x: { per_read: "0.01" } } });
  const s2 = u.summary({ days: 7 });
  const p2 = Object.fromEntries(s2.providers.map(x => [x.id, x]));
  check("fixed fee saved", p2.higgsfield.fixed_monthly === 29 && s2.month.fixed === 29);
  check("unknown provider ignored", !JSON.parse(fs.readFileSync(path.join(tmp, "api-costs-config.json"), "utf8")).fixed.bogus);
  check("rate change recalculates history", near(p2.x.period.cost, 3 * 0.01 + 0.01));
  check("month total = usage + fixed", near(s2.month.total, s2.month.variable + 29));
  u.updateConfig({ rates: { higgsfield: { models: { "Bytedance/Seedance-2.5/image-to-video": { per_job: "", per_sec: "0.05" }, "kling": { per_job: "0.5" }, "junk": { per_job: "-1" } } } } });
  const s3 = u.summary({ days: 7 });
  const hf3 = Object.fromEntries(s3.higgsfield_models.map(h => [h.model, h]));
  const savedCfg = JSON.parse(fs.readFileSync(path.join(tmp, "api-costs-config.json"), "utf8"));
  check("higgsfield model rates saved (lowercased, empty/negative dropped)", savedCfg.rates.higgsfield.models["bytedance/seedance-2.5/image-to-video"].per_sec === 0.05 && !("per_job" in savedCfg.rates.higgsfield.models["bytedance/seedance-2.5/image-to-video"]) && !savedCfg.rates.higgsfield.models.junk);
  check("higgsfield model cost in summary", near(hf3["bytedance/seedance-2.5/image-to-video"].cost, 0.4) && near(hf3["kling"].cost, 0.5) && hf3["kling"].priced);
  u.updateConfig({ rates: { higgsfield: { models: { "kling": { per_job: "" } } } } });
  check("clearing a higgsfield rate removes it", !JSON.parse(fs.readFileSync(path.join(tmp, "api-costs-config.json"), "utf8")).rates.higgsfield.models["kling"]);
  check("projection at least month total", s2.month.projected >= s2.month.total - 1e-9);

  // ── x dedup: X bills a post once per UTC day per app ──
  const before = u.summary({ days: 1 }).providers.find(x => x.id === "x").period.qty.reads;
  const idRes = { ok: true, clone: () => ({ json: async () => ({ data: [{ id: "111" }, { id: "222" }] }) }) };
  const authA = { method: "GET", headers: { Authorization: 'OAuth oauth_consumer_key="AAAAAAAAAAAAAAAA", oauth_nonce="n"' } };
  const authB = { method: "GET", headers: { Authorization: 'OAuth oauth_consumer_key="BBBBBBBBBBBBBBBB", oauth_nonce="n"' } };
  meterFetch("https://api.x.com/2/tweets/search/recent?query=a", authA, idRes);
  meterFetch("https://api.x.com/2/tweets/search/recent?query=b", authA, idRes);
  meterFetch("https://api.x.com/2/tweets/search/recent?query=a", authB, idRes);
  meterFetch("https://api.x.com/2/usage/tweets?days=7", authA, idRes);
  setTimeout(() => {
    const after = u.summary({ days: 1 }).providers.find(x => x.id === "x");
    check("x: same post twice on one app = 1 read, other app counts again", after.period.qty.reads - before === 4);
    check("x: usage endpoint not metered", after.period.calls === 1 + 1 + 3);
    persistence();
  }, 20);
}, 20);

function persistence() {
  // ── persistence ──
  u.record("elevenlabs", { chars: 1 }, { feature: "x" });
  u.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, "api-usage.json"), "utf8"));
  check("flushed to disk", Object.keys(saved.days).length === 1);

  // ── SDK hook ──
  const { Messages } = require("@anthropic-ai/sdk/resources/messages/messages");
  u.install();
  check("SDK Messages patched", Messages.prototype.__usagePatched === true);
  check("fetch patched", globalThis.fetch.__usagePatched === true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
}
