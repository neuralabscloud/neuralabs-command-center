// API usage & cost meter.
//
// Every outgoing call to a paid API is counted here, without touching the call
// sites: the Anthropic SDK's Messages.create/stream are wrapped (tokens per
// model), global fetch is wrapped (ElevenLabs characters, X reads/writes,
// Higgsfield/OpusClip jobs, call counts for the free APIs) and inference.sh
// runs report their real charged cost via recordInfshTask().
//
// Only raw quantities are stored (tokens, characters, jobs); the dollar
// estimate is computed when the summary is read, so fixing a rate in Settings
// also corrects the history. inference.sh is the exception: it bills an exact
// amount per task, which is stored as `actual`.
//
// Which feature caused a call: an explicit tag() wins, then a known function
// or file on the call stack, then the HTTP route the request came in on.

const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { execFile } = require("child_process");

const DATA_DIR = process.env.API_USAGE_DATA_DIR || path.join(__dirname, "data"); // override for tests
const USAGE_FILE = path.join(DATA_DIR, "api-usage.json");
const RATES_FILE = path.join(DATA_DIR, "api-costs-config.json");
const KEEP_DAYS = 400;

// ── Providers ────────────────────────────────────────────
// `billing`: "metered" = cost follows usage, "plan" = mostly a subscription
// (fill in the monthly fee), "free" = no direct cost.
const PROVIDERS = {
  anthropic:  { label: "Anthropic (Claude)", billing: "metered", env: ["ANTHROPIC_API_KEY"], unit: "tokens" },
  inference:  { label: "inference.sh", billing: "metered", env: ["INFERENCE_API_KEY"], unit: "tasks" },
  elevenlabs: { label: "ElevenLabs", billing: "metered", env: ["ELEVENLABS_API_KEY"], unit: "characters" },
  higgsfield: { label: "Higgsfield", billing: "plan", env: ["HIGGSFIELD_API_KEY"], unit: "jobs" },
  x:          { label: "X (Twitter) API", billing: "metered", env: ["TWITTER_API_KEY"], unit: "reads / posts" },
  opusclip:   { label: "OpusClip", billing: "plan", env: ["OPUSCLIP_API_KEY"], unit: "projects" },
  meta:       { label: "Meta Graph API", billing: "free", env: ["META_APP_ID"], unit: "calls" },
  youtube:    { label: "YouTube / Google APIs", billing: "free", env: ["YOUTUBE_API_KEY"], unit: "calls" },
  composio:   { label: "Composio", billing: "plan", env: ["COMPOSIO_API_KEY"], unit: "calls" },
  canva:      { label: "Canva Connect", billing: "free", env: ["CANVA_CLIENT_ID"], unit: "calls" },
  telegram:   { label: "Telegram Bot API", billing: "free", env: ["TELEGRAM_BOT_TOKEN"], unit: "calls" },
};

// ── Default rates (USD) ──────────────────────────────────
// Claude list prices per million tokens. cw = 5-minute cache write, cr = cache read.
// Everything else is an estimate the owner can correct in Settings.
const DEFAULT_RATES = {
  anthropic: {
    models: {
      "claude-fable-5-1":  { in: 10, out: 50, cw: 12.5,  cr: 0.25 },
      "claude-fable-5":    { in: 10, out: 50, cw: 12.5,  cr: 1 },
      "claude-opus-5-5":   { in: 4,  out: 20, cw: 5,     cr: 0.2 },
      "claude-opus-5":     { in: 5,  out: 25, cw: 6.25,  cr: 0.5 },
      "claude-opus-4-8":   { in: 5,  out: 25, cw: 6.25,  cr: 0.5 },
      "claude-opus-4-7":   { in: 5,  out: 25, cw: 6.25,  cr: 0.5 },
      "claude-opus-4-6":   { in: 5,  out: 25, cw: 6.25,  cr: 0.5 },
      "claude-sonnet-5":   { in: 2,  out: 10, cw: 2.5,   cr: 0.2 },
      "claude-sonnet-4-6": { in: 3,  out: 15, cw: 3.75,  cr: 0.3 },
      "claude-sonnet-4-5": { in: 3,  out: 15, cw: 3.75,  cr: 0.3 },
      "claude-haiku-4-5":  { in: 1,  out: 5,  cw: 1.25,  cr: 0.1 },
    },
    web_search_per_1k: 10,
  },
  elevenlabs: { per_1k_chars: 0.3 },
  x: { per_read: 0.005, per_write: 0.01 },
  higgsfield: { per_job: 0 },
  opusclip: { per_job: 0 },
};

// ── Feature attribution ──────────────────────────────────
const als = new AsyncLocalStorage();

// Function names and files on the call stack that identify a feature.
const STACK_FEATURES = [
  [/\bat (?:async )?runGrowthReport\b/, "Growth Marketeer"],
  [/\bat (?:async )?(?:runEduDesign|executeEduDesignerSchedule|deliverEduToTelegram)\b/, "Designer (edu autopilot)"],
  [/\bat (?:async )?(?:createUgcAutopilotTask|finishUgcVideo|executeUgcAutopilotSchedule)\b/, "UGC Autopilot"],
  [/\bat (?:async )?executeAdsOptimizerSchedule\b/, "Ads Optimizer"],
  [/\bat (?:async )?processDesignerTasks\b/, "Designer"],
  [/\bat (?:async )?processCommunityTasks\b/, "Post publisher"],
  [/\bat (?:async )?tgPoll\b/, "Telegram bot"],
  [/social-autopilot\.js/, "X Autopilot"],
  [/telegram-autopilot\.js/, "Telegram Autopilot"],
  [/slide-designer-ai\.js/, "Designer (slides)"],
  [/opusclip-agent\.js/, "Clipper"],
];

// Route prefixes → feature, for calls made while handling an HTTP request.
const ROUTE_FEATURES = [
  [/^\/ctrl\/chat/, "AI Chat"],
  [/^\/calendar\//, "Calendar"],
  [/^\/marketeer\//, "Marketeer"],
  [/^\/growth\//, "Growth Marketeer"],
  [/^\/settings\//, "Settings (connection tests)"],
  [/^\/community\//, "Social Media Manager"],
  [/^\/(ugc|content|video|ai-video|opusclip|clipper)/, "Content Creator"],
  [/^\/(designer|design|slides|nanobanana)/, "Designer"],
  [/^\/(ads)\//, "Ads"],
  [/^\/(social|yt)\//, "Social Connections"],
  [/^\/(schedule|agents|tasks)/, "Scheduler"],
];

function tag(feature, fn) { return als.run({ ...(als.getStore() || {}), feature }, fn); }

// Express middleware: remembers which route a call originated from.
function middleware(req, _res, next) {
  const internal = req.headers["x-internal"];
  const store = { route: req.path };
  if (internal === "telegram") store.feature = "Telegram bot";
  als.run(store, next);
}

function currentFeature() {
  const store = als.getStore() || {};
  if (store.feature) return store.feature;
  const stack = new Error().stack || "";
  for (const [re, name] of STACK_FEATURES) if (re.test(stack)) return name;
  if (store.route) {
    for (const [re, name] of ROUTE_FEATURES) if (re.test(store.route)) return name;
    return store.route.split("/").slice(0, 2).join("/") || "Other";
  }
  // Last resort: the first named function in our own code.
  const m = stack.split("\n").slice(1).find(l => /command-center\/(?!node_modules)(?!api-usage)/.test(l) && /\bat (?:async )?[A-Za-z_$][\w$]*\s*\(/.test(l));
  const fnName = m && m.match(/\bat (?:async )?([A-Za-z_$][\w$]*)\s*\(/);
  return fnName ? fnName[1] : "Other";
}

// ── Storage ──────────────────────────────────────────────
let usage = null;       // { days: { "YYYY-MM-DD": { rowKey: row } } }
let dirty = false;

function load() {
  if (usage) return usage;
  try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch { usage = {}; }
  if (!usage.days || typeof usage.days !== "object") usage.days = {};
  return usage;
}

function flush() {
  if (!dirty || !usage) return;
  dirty = false;
  const days = Object.keys(usage.days).sort();
  while (days.length > KEEP_DAYS) delete usage.days[days.shift()];
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USAGE_FILE + ".tmp", JSON.stringify(usage));
    fs.renameSync(USAGE_FILE + ".tmp", USAGE_FILE);
  } catch (e) { console.warn("[USAGE] could not save:", e.message); }
}

function dayKey(d = new Date()) { return d.toISOString().slice(0, 10); }

// Add quantities to today's row for provider/feature/model.
function record(provider, qty, opts = {}) {
  load();
  const feature = opts.feature || currentFeature();
  const model = opts.model || "";
  const day = dayKey();
  const rows = usage.days[day] || (usage.days[day] = {});
  const key = `${provider}\t${feature}\t${model}`;
  const row = rows[key] || (rows[key] = { p: provider, f: feature, m: model, calls: 0 });
  row.calls += opts.calls == null ? 1 : opts.calls;
  for (const [k, v] of Object.entries(qty || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n) row[k] = (row[k] || 0) + n;
  }
  dirty = true;
}

// ── Rates ────────────────────────────────────────────────
function readConfig() {
  try { return JSON.parse(fs.readFileSync(RATES_FILE, "utf8")) || {}; } catch { return {}; }
}

function writeConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RATES_FILE, JSON.stringify(cfg, null, 2));
}

function effectiveRates(cfg = readConfig()) {
  const o = cfg.rates || {};
  return {
    anthropic: {
      models: { ...DEFAULT_RATES.anthropic.models, ...((o.anthropic || {}).models || {}) },
      web_search_per_1k: num((o.anthropic || {}).web_search_per_1k, DEFAULT_RATES.anthropic.web_search_per_1k),
    },
    elevenlabs: { per_1k_chars: num((o.elevenlabs || {}).per_1k_chars, DEFAULT_RATES.elevenlabs.per_1k_chars) },
    x: { per_read: num((o.x || {}).per_read, DEFAULT_RATES.x.per_read), per_write: num((o.x || {}).per_write, DEFAULT_RATES.x.per_write) },
    higgsfield: { per_job: num((o.higgsfield || {}).per_job, DEFAULT_RATES.higgsfield.per_job) },
    opusclip: { per_job: num((o.opusclip || {}).per_job, DEFAULT_RATES.opusclip.per_job) },
  };
}

function num(v, dflt) { const n = Number(v); return v === "" || v == null || !Number.isFinite(n) ? dflt : n; }

// Claude model ids may carry a date suffix or a region prefix; match the longest known id.
function modelRate(model, rates) {
  const m = String(model || "").toLowerCase();
  if (rates.anthropic.models[m]) return rates.anthropic.models[m];
  const hit = Object.keys(rates.anthropic.models).sort((a, b) => b.length - a.length).find(k => m.includes(k));
  return hit ? rates.anthropic.models[hit] : null;
}

// Estimated cost of one stored row. Returns { cost, priced } — priced=false
// when the rate is unknown (e.g. a new model), so the UI can flag it.
function rowCost(row, rates) {
  switch (row.p) {
    case "anthropic": {
      const r = modelRate(row.m, rates);
      const search = (row.searches || 0) / 1000 * rates.anthropic.web_search_per_1k;
      if (!r) return { cost: search, priced: false };
      const tok = ((row.in || 0) * r.in + (row.out || 0) * r.out + (row.cw || 0) * r.cw + (row.cw1h || 0) * r.in * 2 + (row.cr || 0) * r.cr) / 1e6;
      return { cost: tok + search, priced: true };
    }
    case "inference": return { cost: row.actual || 0, priced: true };
    case "elevenlabs": return { cost: (row.chars || 0) / 1000 * rates.elevenlabs.per_1k_chars, priced: true };
    case "x": return { cost: (row.reads || 0) * rates.x.per_read + (row.writes || 0) * rates.x.per_write, priced: true };
    case "higgsfield": return { cost: (row.jobs || 0) * rates.higgsfield.per_job, priced: rates.higgsfield.per_job > 0 };
    case "opusclip": return { cost: (row.jobs || 0) * rates.opusclip.per_job, priced: rates.opusclip.per_job > 0 };
    default: return { cost: 0, priced: true };
  }
}

// ── Anthropic SDK hook ───────────────────────────────────
function recordClaudeMessage(msg, feature) {
  const u = (msg && msg.usage) || {};
  const cc = u.cache_creation || {};
  const cw1h = Number(cc.ephemeral_1h_input_tokens) || 0;
  record("anthropic", {
    in: u.input_tokens,
    out: u.output_tokens,
    cw: (Number(u.cache_creation_input_tokens) || 0) - cw1h,
    cw1h,
    cr: u.cache_read_input_tokens,
    searches: (u.server_tool_use || {}).web_search_requests,
  }, { model: msg.model, feature });
}

function patchMessagesClass(Cls) {
  if (!Cls || !Cls.prototype || Cls.prototype.__usagePatched) return;
  const origCreate = Cls.prototype.create;
  const origStream = Cls.prototype.stream;
  Cls.prototype.create = function (body, options) {
    const p = origCreate.call(this, body, options);
    // Streamed creates are recorded by stream() below (it calls create with stream:true).
    if (!(body && body.stream)) {
      const feature = currentFeature();
      Promise.resolve(p).then(msg => recordClaudeMessage(msg, feature), () => {});
    }
    return p;
  };
  if (origStream) {
    Cls.prototype.stream = function (body, options) {
      const s = origStream.call(this, body, options);
      const feature = currentFeature();
      try { s.on("finalMessage", msg => recordClaudeMessage(msg, feature)); } catch {}
      return s;
    };
  }
  Cls.prototype.__usagePatched = true;
}

function patchAnthropic() {
  for (const mod of ["@anthropic-ai/sdk/resources/messages/messages", "@anthropic-ai/sdk/resources/beta/messages/messages"]) {
    try { patchMessagesClass(require(mod).Messages); }
    catch (e) { console.warn("[USAGE] could not hook", mod, e.message); }
  }
}

// ── fetch hook ───────────────────────────────────────────
function providerForHost(host) {
  if (host === "api.anthropic.com") return null; // counted via the SDK hook
  if (host.endsWith("elevenlabs.io")) return "elevenlabs";
  if (host.endsWith("higgsfield.ai")) return "higgsfield";
  if (host === "api.x.com" || host === "api.twitter.com" || host === "upload.twitter.com") return "x";
  if (host.endsWith("opus.pro")) return "opusclip";
  if (host === "graph.facebook.com" || host === "graph.instagram.com") return "meta";
  if (host.endsWith("googleapis.com")) return "youtube";
  if (host.endsWith("composio.dev")) return "composio";
  if (host.endsWith("canva.com")) return "canva";
  if (host === "api.telegram.org") return "telegram";
  return null;
}

function parseBody(body) {
  if (typeof body !== "string") return null;
  try { return JSON.parse(body); } catch { return null; }
}

// Higgsfield: every POST starts a generation, except uploads and status/cancel calls.
const HIGGSFIELD_NOT_A_JOB = /\/(files|uploads?|requests|job-sets|motions)\b|\/(cancel|status)\b/i;

function meterFetch(url, init, res) {
  let u;
  try { u = new URL(typeof url === "string" ? url : url.url || String(url)); } catch { return; }
  const provider = providerForHost(u.hostname);
  if (!provider) return;
  const method = String((init && init.method) || (url && url.method) || "GET").toUpperCase();
  const feature = currentFeature();
  const ok = res && res.ok;

  if (provider === "elevenlabs") {
    if (/\/v1\/user\b/.test(u.pathname)) return; // plan/balance lookups are free
    if (/\/v1\/dubbing\b/.test(u.pathname)) { // status polls and downloads are free
      return method === "POST" && ok ? record("elevenlabs", {}, { feature, model: "dubbing" }) : undefined;
    }
    if (method === "POST" && /text-to-speech|text-to-dialogue|sound-generation/.test(u.pathname) && ok) {
      const b = parseBody(init && init.body) || {};
      return record("elevenlabs", { chars: String(b.text || "").length }, { feature, model: b.model_id || "" });
    }
    return record("elevenlabs", {}, { feature, model: "other calls" });
  }
  if (provider === "higgsfield") {
    if (method === "POST" && !HIGGSFIELD_NOT_A_JOB.test(u.pathname) && ok) {
      const b = parseBody(init && init.body) || {};
      const model = (b.params && b.params.model) || b.model || u.pathname.replace(/^\/(v1\/)?/, "");
      return record("higgsfield", { jobs: 1 }, { feature, model });
    }
    return; // polling/uploads are not billed
  }
  if (provider === "opusclip") {
    if (method === "POST" && /clip-projects?\b/.test(u.pathname) && !/\/(cancel|delete)/.test(u.pathname) && ok) return record("opusclip", { jobs: 1 }, { feature, model: "clip project" });
    return record("opusclip", {}, { feature, model: "other calls" });
  }
  if (provider === "x") {
    if (!ok) return record("x", {}, { feature, model: "failed" });
    if (method === "POST" && /\/2\/tweets\/?$/.test(u.pathname)) return record("x", { writes: 1 }, { feature, model: "post" });
    if (method === "GET") {
      // X bills per resource returned: count the items in `data`.
      res.clone().json().then(d => {
        const n = Array.isArray(d && d.data) ? d.data.length : (d && d.data ? 1 : 0);
        record("x", { reads: n }, { feature, model: /search/.test(u.pathname) ? "search" : "lookup" });
      }).catch(() => record("x", {}, { feature, model: "lookup" }));
      return;
    }
    return record("x", {}, { feature, model: "other" });
  }
  record(provider, {}, { feature });
}

function patchFetch() {
  if (typeof globalThis.fetch !== "function" || globalThis.fetch.__usagePatched) return;
  const orig = globalThis.fetch;
  const wrapped = async function (url, init) {
    const res = await orig(url, init);
    try { meterFetch(url, init, res); } catch (e) { /* metering must never break a call */ }
    return res;
  };
  wrapped.__usagePatched = true;
  globalThis.fetch = wrapped;
}

// ── inference.sh ─────────────────────────────────────────
// The run result carries the task id; `infsh task cost` returns the charged
// amount in 1e-8 dollars. Looked up async so the caller is never slowed down.
function recordInfshTask(result, appId, feature) {
  feature = feature || currentFeature();
  const id = result && (result.id || result.task_id);
  if (!id) return record("inference", { tasks: 1 }, { feature, model: appId });
  execFile("infsh", ["task", "cost", String(id), "--json", "--no-input"], { timeout: 30000, env: { ...process.env, HOME: process.env.HOME || "/root" } }, (err, stdout) => {
    let actual = 0;
    if (!err) {
      try {
        const s = String(stdout).replace(/\x1b\[[0-9;]*m/g, "");
        const j = JSON.parse(s.slice(s.indexOf("{")));
        actual = (Number(j.charged ?? j.total) || 0) / 1e8;
      } catch {}
    }
    record("inference", { tasks: 1, actual }, { feature, model: appId });
  });
}

// Same, straight from the CLI's raw stdout (banner + JSON). Safe on any output.
function meterInfshOutput(stdout, appId, feature) {
  try {
    const s = String(stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
    const i = s.indexOf("{");
    if (i < 0) return;
    recordInfshTask(JSON.parse(s.slice(i)), appId, feature);
  } catch {}
}

// ── Live balances (fetched on demand, cached 5 min) ──────
let liveCache = { at: 0, data: null };

function runJson(cmd, args) {
  return new Promise(resolve => execFile(cmd, args, { timeout: 20000, env: { ...process.env, HOME: process.env.HOME || "/root" } }, (err, stdout) => {
    if (err) return resolve(null);
    try { const s = String(stdout); resolve(JSON.parse(s.slice(s.indexOf("{")))); } catch { resolve(null); }
  }));
}

async function liveBalances(force) {
  if (!force && liveCache.data && Date.now() - liveCache.at < 5 * 60 * 1000) return liveCache.data;
  const out = {};
  const jobs = [];
  jobs.push(runJson("infsh", ["balance", "--json", "--no-input"]).then(j => {
    if (j && j.balance_dollars != null) out.inference = { balance_usd: Number(j.balance_dollars) };
  }));
  const el = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (el) jobs.push(tag("Balance checks", () => fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": el } }))
    .then(r => r.ok ? r.json() : null).then(j => {
      if (!j) return;
      out.elevenlabs = {
        tier: j.tier, used: j.character_count, limit: j.character_limit,
        resets_at: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : null,
        overage_usd: j.current_overage ? Number(j.current_overage.amount) || 0 : 0,
      };
    }).catch(() => {}));
  await Promise.all(jobs);
  liveCache = { at: Date.now(), data: out };
  return out;
}

// ── Summary for the Settings page ────────────────────────
function addDays(key, n) { const d = new Date(key + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return dayKey(d); }

function summary({ days = 30 } = {}) {
  load();
  const cfg = readConfig();
  const rates = effectiveRates(cfg);
  const fixed = cfg.fixed || {};
  const today = dayKey();
  const monthStart = today.slice(0, 8) + "01";
  const from = addDays(today, -(Math.max(1, Math.min(KEEP_DAYS, days)) - 1));

  const providers = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    providers[id] = {
      id, label: p.label, billing: p.billing, unit: p.unit,
      configured: p.env.some(k => !!(process.env[k] || "").trim()) || (id === "inference" && infshConfigured()),
      fixed_monthly: Number(fixed[id]) || 0,
      period: { calls: 0, cost: 0, qty: {} },
      month: { calls: 0, cost: 0 },
      today: { cost: 0 },
      unpriced: false,
    };
  }

  const daily = {};         // day → cost
  const features = {};      // feature → { cost, calls, providers:Set }
  const models = {};        // claude model → { in, out, cw, cr, searches, cost, calls }
  for (const [day, rows] of Object.entries(usage.days)) {
    const inPeriod = day >= from, inMonth = day >= monthStart;
    if (!inPeriod && !inMonth) continue;
    for (const row of Object.values(rows)) {
      const pr = providers[row.p];
      if (!pr) continue;
      const { cost, priced } = rowCost(row, rates);
      if (inMonth) { pr.month.calls += row.calls; pr.month.cost += cost; }
      if (day === today) pr.today.cost += cost;
      if (!inPeriod) continue;
      pr.period.calls += row.calls;
      pr.period.cost += cost;
      if (!priced && (row.jobs || row.in || row.out)) pr.unpriced = true;
      for (const k of ["in", "out", "cw", "cw1h", "cr", "searches", "chars", "reads", "writes", "jobs", "tasks"]) {
        if (row[k]) pr.period.qty[k] = (pr.period.qty[k] || 0) + row[k];
      }
      daily[day] = (daily[day] || 0) + cost;
      const f = features[row.f] || (features[row.f] = { feature: row.f, cost: 0, calls: 0, providers: {} });
      f.cost += cost; f.calls += row.calls;
      f.providers[row.p] = (f.providers[row.p] || 0) + cost;
      if (row.p === "anthropic") {
        const m = models[row.m] || (models[row.m] = { model: row.m, calls: 0, in: 0, out: 0, cw: 0, cr: 0, searches: 0, cost: 0, priced });
        m.calls += row.calls; m.cost += cost;
        for (const k of ["in", "out", "cw", "cr", "searches"]) m[k] += row[k] || 0;
        m.cw += row.cw1h || 0;
      }
    }
  }

  // Month-to-date and a straight-line projection for the whole month.
  const d = new Date(today + "T00:00:00Z");
  const dayOfMonth = d.getUTCDate();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  let monthVariable = 0, fixedTotal = 0;
  for (const pr of Object.values(providers)) { monthVariable += pr.month.cost; fixedTotal += pr.fixed_monthly; }

  const series = [];
  for (let k = from; k <= today; k = addDays(k, 1)) series.push({ day: k, cost: daily[k] || 0 });
  const trackingSince = Object.keys(usage.days).sort()[0] || null;

  return {
    generated_at: new Date().toISOString(),
    period: { from, to: today, days },
    tracking_since: trackingSince,
    month: {
      start: monthStart,
      variable: monthVariable,
      fixed: fixedTotal,
      total: monthVariable + fixedTotal,
      projected: (trackingSince && trackingSince <= monthStart ? monthVariable / dayOfMonth * daysInMonth : monthVariable / Math.max(1, dayOfMonth - Number(trackingSince ? trackingSince.slice(8) : 1) + 1) * daysInMonth) + fixedTotal,
      day_of_month: dayOfMonth, days_in_month: daysInMonth,
    },
    providers: Object.values(providers),
    features: Object.values(features).sort((a, b) => b.cost - a.cost || b.calls - a.calls),
    models: Object.values(models).sort((a, b) => b.cost - a.cost),
    series,
    rates,
    defaults: DEFAULT_RATES,
  };
}

function infshConfigured() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(process.env.HOME || "/root", ".inferencesh", "config.json"), "utf8"));
    return !!(c.api_key || c.token);
  } catch { return false; }
}

// Save fixed monthly fees and rate overrides from the Settings page.
function updateConfig(body) {
  const cfg = readConfig();
  if (body && body.fixed && typeof body.fixed === "object") {
    cfg.fixed = cfg.fixed || {};
    for (const [id, v] of Object.entries(body.fixed)) {
      if (!PROVIDERS[id]) continue;
      const n = Number(v);
      if (v === "" || v == null || !Number.isFinite(n) || n <= 0) delete cfg.fixed[id]; else cfg.fixed[id] = Math.round(n * 100) / 100;
    }
  }
  if (body && body.rates && typeof body.rates === "object") {
    const r = body.rates;
    cfg.rates = cfg.rates || {};
    const setNum = (group, key, v) => {
      cfg.rates[group] = cfg.rates[group] || {};
      const n = Number(v);
      if (v === "" || v == null || !Number.isFinite(n) || n < 0) delete cfg.rates[group][key]; else cfg.rates[group][key] = n;
    };
    for (const [group, keys] of [["elevenlabs", ["per_1k_chars"]], ["x", ["per_read", "per_write"]], ["higgsfield", ["per_job"]], ["opusclip", ["per_job"]]]) {
      if (r[group]) for (const k of keys) if (k in r[group]) setNum(group, k, r[group][k]);
    }
    if (r.anthropic && "web_search_per_1k" in r.anthropic) setNum("anthropic", "web_search_per_1k", r.anthropic.web_search_per_1k);
  }
  writeConfig(cfg);
  return cfg;
}

// ── Start ────────────────────────────────────────────────
let started = false;
function install() {
  if (started) return;
  started = true;
  load();
  patchAnthropic();
  patchFetch();
  const t = setInterval(flush, 30000);
  if (t.unref) t.unref();
  process.on("exit", flush);
  for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => { flush(); process.exit(0); });
}

module.exports = {
  install, middleware, tag, record, recordInfshTask, meterInfshOutput, currentFeature, summary, updateConfig, liveBalances, flush,
  // exported for tests
  _internal: { rowCost, effectiveRates, modelRate, meterFetch, currentFeature, providerForHost, recordClaudeMessage, DEFAULT_RATES, PROVIDERS, reset: () => { usage = { days: {} }; dirty = false; } },
};
