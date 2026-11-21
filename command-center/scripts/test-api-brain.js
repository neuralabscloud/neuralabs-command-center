// Tests voor api-brain.js (geen netwerk). Run: node scripts/test-api-brain.js
const ab = require("../api-brain");
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FOUT " + name); } };

(async () => {
  // indeling van routes
  const want = {
    "/api/v1/regime": "regime", "/api/v1/public/regime/full": "regime", "/api/v1/public/btc-vitals": "regime",
    "/api/v1/public/options-skew/btc": "derivatives", "/api/v1/public/vol-cones/{symbol}": "derivatives",
    "/api/v1/public/funding/{symbol}": "derivatives", "/api/v1/public/funding-cross-section": "derivatives", "/api/v1/public/oi/{symbol}": "derivatives",
    "/api/v1/public/cvd/{symbol}": "flow", "/api/v1/public/candles/{symbol}/{timeframe}": "flow", "/api/v1/public/liquidations/{symbol}": "flow",
    "/api/v1/public/solana/token/{address}": "scanners", "/api/v1/public/rh/status": "scanners", "/api/v1/public/arc/wallets": "scanners",
    "/collectibles/v1/cards/search": "collectibles", "/collectibles/v1/deals/{deal_id}": "collectibles",
    "/market/v1/{provider}/{path:path}": "market", "/hyperliquid/info": "market", "/news": "market", "/yahoo/chart/{symbol}": "market",
    "/health": "core", "/": "core", "/api/v1/keys": "core",
  };
  for (const [p, id] of Object.entries(want)) check(`classify ${p}`, ab.classify(p) === id);
  check("classify unknown path", ab.classify("/wp-login.php") === null && ab.classify("/.env") === null);
  check("classify ignores query", ab.classify("/news?x=1") === "market");
  check("classify empty input", ab.classify(undefined) === null && ab.classify(null) === null);
  check("every region has a lobe and label", ab.REGIONS.every(r => r.id && r.label && r.lobe && r.role));
  check("region ids unique", new Set(ab.REGIONS.map(r => r.id)).size === ab.REGIONS.length);

  // samenvatting
  const now = 1_800_000_000_000;
  const feed = {
    ts_ms: now, version: "0.2.0", uptime_seconds: 500, redis: { connected: true, keys: 10 },
    regime: { label: "neutral", age_seconds: 30 },
    scanners: { solana: { age_seconds: 20, stale: false }, arc: { age_seconds: 900, stale: true } },
    total_requests: 50, window_seconds: 60, tier_window_counts: { public: 7, anonymous: 3 }, statuses: { 200: 46, 404: 2, 500: 2 },
    endpoints: [
      { endpoint: "GET /api/v1/public/cvd/{symbol}", count: 30, last_ts_ms: now - 1000, latency_p50_ms: 12 },
      { endpoint: "GET /api/v1/public/candles/{symbol}/{timeframe}", count: 5, last_ts_ms: now - 5000, latency_p50_ms: 8 },
      { endpoint: "GET /news", count: 13, last_ts_ms: now - 2000, latency_p50_ms: 40 },
      { endpoint: "GET /wp-login.php", count: 2, last_ts_ms: now - 9000, latency_p50_ms: 1 },
    ],
    recent: [
      { t: now - 1000, method: "GET", path: "/api/v1/public/cvd/{symbol}", status: 200, latency_ms: 10 },
      { t: now - 3000, method: "GET", path: "/api/v1/public/cvd/{symbol}", status: 500, latency_ms: 30 },
      { t: now - 2000, method: "GET", path: "/news", status: 200, latency_ms: 40 },
      { t: now - 90000, method: "GET", path: "/news", status: 200, latency_ms: 50 },
      { t: now - 4000, method: "GET", path: "/wp-login.php\u0007<b>", status: 404, latency_ms: 1 },
      { t: "x", path: "/health" },
    ],
  };
  const s = ab.summarize(feed, now);
  const reg = id => s.regions.find(r => r.id === id);
  check("summarize ok + meta", s.ok === true && s.version === "0.2.0" && s.uptime_seconds === 500 && s.redis.connected === true);
  check("per_min from tier window", s.per_min === 10);
  check("region totals", reg("flow").count === 35 && reg("market").count === 13 && reg("regime").count === 0);
  check("region per minute skips old events", reg("flow").per_min === 2 && reg("market").per_min === 1);
  check("region p50 + errors", reg("flow").p50_ms === 10 && reg("flow").errors_recent === 1);
  check("top endpoints sorted", reg("flow").top[0].count === 30 && reg("flow").top.length === 2);
  check("unknown counted apart", s.unknown_total === 2 && s.unknown_per_min === 1);
  check("errors total = 5xx only", s.errors_total === 2);
  check("events sorted oldest first, bad rows dropped", s.events.length === 5 && s.events[0].t === now - 90000 && s.events[4].t === now - 1000);
  check("event path cleaned of control chars", s.events.every(e => /^[\x20-\x7e]*$/.test(e.path)));
  check("senses: stale + missing", s.senses.find(x => x.id === "arc").stale === true && s.senses.find(x => x.id === "solana").stale === false && s.senses.find(x => x.id === "robinhood").stale === true);
  check("regime passthrough", s.regime.label === "neutral" && s.regime.age_seconds === 30);
  const empty = ab.summarize(null, now);
  check("summarize survives empty feed", empty.ok === true && empty.regions.length === ab.REGIONS.length && empty.events.length === 0 && empty.p50_ms === null);

  // volle ring: tempo wordt omgerekend naar een minuut
  const ring = Array.from({ length: 200 }, (_, i) => ({ t: now - i * 50, region: "flow" }));
  check("saturated ring scales to per minute", ab.perMinute(ring, now, 60, 200).flow === 1206);
  check("median", ab.median([5, 1, 3]) === 3 && ab.median([]) === null);

  // ophalen: sleutel in header, cache, fouten
  let calls = 0, seenHeader = null, seenUrl = null;
  const okFetch = async (url, opt) => { calls++; seenUrl = url; seenHeader = opt.headers["X-Brain-Key"]; return { ok: true, status: 200, json: async () => feed }; };
  const b = ab.createBrain({ url: "http://127.0.0.1:8000/admin/brain-feed", key: "k".repeat(40), fetchImpl: okFetch });
  const a1 = await b.snapshot(), a2 = await b.snapshot();
  check("key goes in a header, not the url", seenHeader === "k".repeat(40) && !seenUrl.includes("k".repeat(40)));
  check("snapshot cached", calls === 1 && a1 === a2 && a1.ok === true);
  const noKey = await ab.createBrain({ url: "x", key: "", fetchImpl: okFetch }).snapshot();
  check("no key = not configured, no call", noKey.ok === false && noKey.error === "not_configured" && calls === 1);
  const down = await ab.createBrain({ url: "x", key: "k", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }).snapshot();
  check("unreachable handled", down.ok === false && down.error === "unreachable" && down.regions.length === ab.REGIONS.length);
  const denied = await ab.createBrain({ url: "x", key: "k", fetchImpl: async () => ({ ok: false, status: 401 }) }).snapshot();
  check("api error handled", denied.ok === false && denied.error === "api_401");

  // gemiddelde over 5 minuten
  const R = n => ({ regime: 0, derivatives: 0, flow: 0, scanners: 0, market: n, collectibles: 0, core: 0 });
  const T0 = 1_800_000_000_000;
  check("average: too little history = null", ab.averages([{ t: T0, total: 0, regions: R(0) }], T0) === null);
  check("average: span under a minute = null", ab.averages([{ t: T0, total: 0, regions: R(0) }, { t: T0 + 30000, total: 50, regions: R(50) }], T0 + 30000) === null);
  const avg = ab.averages([{ t: T0, total: 100, regions: R(80) }, { t: T0 + 150000, total: 250, regions: R(230) }, { t: T0 + 300000, total: 250, regions: R(230) }], T0 + 300000);
  check("average: burst spread over 5 minutes", avg && avg.per_min === 30 && avg.regions.market === 30 && avg.regions.regime === 0 && avg.window_s === 300);
  check("average: counters reset = null", ab.averages([{ t: T0, total: 500, regions: R(500) }, { t: T0 + 120000, total: 5, regions: R(5) }], T0 + 120000) === null);
  check("average: old samples ignored", ab.averages([{ t: T0 - 900000, total: 0, regions: R(0) }, { t: T0, total: 900, regions: R(900) }], T0) === null);
  let tick = 0;
  const feedAt = n => async () => ({ ok: true, status: 200, json: async () => ({ ts_ms: T0 + n() * 120000, total_requests: n() * 60, window_seconds: 60, endpoints: [{ endpoint: "GET /news", count: n() * 60 }], recent: [] }) });
  const live = ab.createBrain({ url: "x", key: "k", cacheMs: 0, fetchImpl: feedAt(() => tick) });
  const s0 = await live.snapshot(); tick = 1; const s1 = await live.snapshot();
  check("snapshot: first has no average, later has", s0.avg_per_min === null && s1.avg_per_min === 30 && s1.regions.find(r => r.id === "market").avg_per_min === 30);

  console.log(`\n${pass} ok, ${fail} FOUT`);
  process.exit(fail ? 1 : 0);
})();
