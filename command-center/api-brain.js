// Het brein: api.neuralabs.cloud als hersenen op de overview-pagina.
// Pure helpers: deelt de routes van de API in hersengebieden in en vat de activiteitsfeed
// (/admin/brain-feed op de API, alleen-lezen, eigen sleutel) samen. Bedrading in api-server.js.
"use strict";

// Elk gebied is een echt onderdeel van de API. `lobe` bepaalt waar het in de tekening ligt.
const REGIONS = [
  { id: "regime", label: "Regime", lobe: "frontal", role: "Judges the market state", hue: 264 },
  { id: "derivatives", label: "Derivatives", lobe: "parietal", role: "Options, funding and volatility", hue: 218 },
  { id: "flow", label: "Order flow", lobe: "temporal", role: "Candles, CVD, order book, liquidations", hue: 188 },
  { id: "scanners", label: "Scanners", lobe: "occipital", role: "Watches Solana, Arc and Robinhood Chain", hue: 150 },
  { id: "market", label: "Market data", lobe: "cerebellum", role: "Relays prices and news from outside", hue: 38 },
  { id: "collectibles", label: "Collectibles", lobe: "limbic", role: "Card catalog, prices and deals", hue: 328 },
  { id: "core", label: "Core", lobe: "stem", role: "Health, keys and the Redis store", hue: 0 },
];
const REGION_IDS = REGIONS.map(r => r.id);

const RULES = [
  [/^\/api\/v1\/public\/(rh|arc|solana)(\/|$)/, "scanners"],
  [/^\/api\/v1\/(public\/)?regime(\/|$)/, "regime"],
  [/^\/api\/v1\/public\/(btc|eth)-vitals$/, "regime"],
  [/^\/api\/v1\/public\/(options-skew|options-positioning|realized-vs-implied|vol-cones|funding-cross-section|prediction-market-edge|funding|oi)(\/|$)/, "derivatives"],
  [/^\/api\/v1\/public\/(candles|cvd|orderbook-imbalance|liquidations)(\/|$)/, "flow"],
  [/^\/collectibles\/v1(\/|$)/, "collectibles"],
  [/^\/(market\/v1|hyperliquid|binance|defillama|yahoo)(\/|$)/, "market"],
  [/^\/news$/, "market"],
  [/^\/api\/v1\/keys(\/|$)/, "core"],
  [/^\/(health)?$/, "core"],
];

// Routepad → gebied, of null voor paden die de API niet kent (scanners van buitenaf, 404's).
function classify(path) {
  const p = String(path || "").split("?")[0];
  for (const [re, id] of RULES) if (re.test(p)) return id;
  return null;
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const cleanPath = p => String(p || "").replace(/[^\x20-\x7e]/g, "").slice(0, 120);

function median(list) {
  const s = list.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return Math.round(s[Math.floor((s.length - 1) / 2)] * 10) / 10;
}

// Verzoeken per minuut uit de ring van recente verzoeken. De ring is begrensd (200): is hij vol en
// korter dan het venster, dan rekenen we het tempo om naar een minuut.
function perMinute(events, nowMs, windowS, ringMax) {
  const out = Object.fromEntries(REGION_IDS.map(id => [id, 0]));
  out._unknown = 0;
  if (!events.length) return out;
  const cutoff = nowMs - windowS * 1000;
  const oldest = events.reduce((m, e) => Math.min(m, e.t), Infinity);
  const saturated = events.length >= ringMax && oldest > cutoff;
  const spanS = Math.max(1, (nowMs - oldest) / 1000);
  for (const e of events) {
    if (!saturated && e.t < cutoff) continue;
    out[e.region || "_unknown"] += 1;
  }
  if (saturated) for (const k of Object.keys(out)) out[k] = Math.round((out[k] / spanS) * windowS);
  return out;
}

// Ruwe feed van de API → wat de pagina nodig heeft.
function summarize(feed, nowMs = Date.now()) {
  const f = feed && typeof feed === "object" ? feed : {};
  const windowS = num(f.window_seconds, 60) || 60;
  const events = (Array.isArray(f.recent) ? f.recent : [])
    .filter(e => e && Number.isFinite(Number(e.t)))
    .map(e => ({
      t: Number(e.t), region: classify(e.path), method: String(e.method || "GET").slice(0, 8),
      path: cleanPath(e.path), status: num(e.status), latency_ms: num(e.latency_ms),
    }))
    .sort((a, b) => a.t - b.t);

  const rpm = perMinute(events, num(f.ts_ms, nowMs), windowS, 200);
  const by = Object.fromEntries(REGION_IDS.map(id => [id, { count: 0, last_ts_ms: 0, endpoints: [] }]));
  let unknownTotal = 0;
  for (const ep of Array.isArray(f.endpoints) ? f.endpoints : []) {
    const name = String(ep.endpoint || "");
    const id = classify(name.replace(/^\S+\s+/, ""));
    if (!id) { unknownTotal += num(ep.count); continue; }
    const r = by[id];
    r.count += num(ep.count);
    r.last_ts_ms = Math.max(r.last_ts_ms, num(ep.last_ts_ms));
    r.endpoints.push({ endpoint: cleanPath(name), count: num(ep.count), p50_ms: ep.latency_p50_ms == null ? null : num(ep.latency_p50_ms) });
  }

  const regions = REGIONS.map(meta => {
    const r = by[meta.id];
    const recent = events.filter(e => e.region === meta.id);
    return {
      ...meta,
      count: r.count,
      per_min: rpm[meta.id],
      p50_ms: median(recent.map(e => e.latency_ms)),
      errors_recent: recent.filter(e => e.status >= 500).length,
      last_ts_ms: r.last_ts_ms || null,
      top: r.endpoints.sort((a, b) => b.count - a.count).slice(0, 4),
    };
  });

  const tierWindow = f.tier_window_counts && typeof f.tier_window_counts === "object" ? f.tier_window_counts : {};
  const statuses = f.statuses && typeof f.statuses === "object" ? f.statuses : {};
  const total = num(f.total_requests);
  const errors = Object.entries(statuses).reduce((n, [code, c]) => n + (Number(code) >= 500 ? num(c) : 0), 0);
  const sc = f.scanners && typeof f.scanners === "object" ? f.scanners : {};
  const senses = ["solana", "arc", "robinhood"].map(k => ({
    id: k, label: k === "robinhood" ? "Robinhood Chain" : k[0].toUpperCase() + k.slice(1),
    age_seconds: sc[k] && sc[k].age_seconds != null ? num(sc[k].age_seconds) : null,
    stale: !sc[k] || sc[k].stale !== false,
  }));

  return {
    ok: true,
    ts_ms: num(f.ts_ms, nowMs),
    version: String(f.version || "").slice(0, 20),
    uptime_seconds: num(f.uptime_seconds),
    redis: { connected: !!(f.redis && f.redis.connected), keys: f.redis && f.redis.keys != null ? num(f.redis.keys) : null },
    regime: {
      label: f.regime && f.regime.label ? String(f.regime.label).slice(0, 30) : null,
      age_seconds: f.regime && f.regime.age_seconds != null ? num(f.regime.age_seconds) : null,
    },
    senses,
    per_min: Object.values(tierWindow).reduce((n, c) => n + num(c), 0),
    total_requests: total,
    errors_total: errors,
    unknown_total: unknownTotal,
    unknown_per_min: rpm._unknown,
    p50_ms: median(events.map(e => e.latency_ms)),
    regions,
    events: events.slice(-120),
  };
}

// Haalt de feed op met de eigen sleutel in een header. Korte cache, zodat meerdere tabbladen
// de API niet vaker bevragen dan nodig.
function createBrain({ url, key, fetchImpl = fetch, cacheMs = 2000, timeoutMs = 4000 }) {
  let cache = null, cachedAt = 0, inflight = null;
  async function load() {
    if (!key) return { ok: false, error: "not_configured", regions: REGIONS, events: [] };
    try {
      const r = await fetchImpl(url, { headers: { "X-Brain-Key": key }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return { ok: false, error: `api_${r.status}`, regions: REGIONS, events: [] };
      return summarize(await r.json());
    } catch {
      return { ok: false, error: "unreachable", regions: REGIONS, events: [] };
    }
  }
  return {
    async snapshot() {
      if (cache && Date.now() - cachedAt < cacheMs) return cache;
      if (!inflight) inflight = load().then(v => { cache = v; cachedAt = Date.now(); inflight = null; return v; });
      return inflight;
    },
  };
}

module.exports = { REGIONS, classify, summarize, perMinute, median, createBrain };
