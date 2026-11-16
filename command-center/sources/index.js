// All news-card sources. fetchAll() -> { items, status: {name: "live (n)" | "fout: .." | "geen key" | ..} }.
const rss = require("./rss");
const market = require("./market");
const evergreen = require("./evergreen");

async function fetchAll({ now = Date.now(), env = process.env, enrichTop = 10, log = () => {} } = {}) {
  const status = {};
  const items = [];
  const run = async (name, fn) => {
    try { const r = await fn(); items.push(...r); status[name] = `live (${r.length})`; }
    catch (e) { status[name] = `fout: ${String(e.message || e).slice(0, 120)}`; log(`news-cards bron ${name}: ${status[name]}`); }
  };
  await Promise.all([
    ...rss.FEEDS.map(f => run(f.source, () => rss.fetchFeed(f, { now }))),
    run("CoinGecko", () => market.coingecko(now)),
    run("DefiLlama", () => market.defillama(now)),
    run("mempool.space", () => market.mempool(now)),
    run("Alternative.me", () => market.feargreed(now)),
    run("Hyperliquid", () => market.hyperliquid(now)),
  ]);
  // CryptoPanic only supports ?auth_token= (key in URL); no key in this stack, so it stays off.
  status.CryptoPanic = env.CRYPTOPANIC_API_KEY ? "key aanwezig, niet gebruikt (alleen ?auth_token=, huisregel: geen key in URL)" : "geen key";
  status["TradingView news"] = "geen integratie in Command Center";
  status["Hyperliquid (Redis)"] = "geen Redis in deze stack; publieke info-API gebruikt";
  try { const e = evergreen.load(); items.push(...e); status.Evergreen = `live (${e.length})`; }
  catch (e) { status.Evergreen = `fout: ${e.message}`; }

  // Dedup news on URL and on near-identical titles across feeds.
  const seen = new Set();
  const uniq = items.filter(i => {
    const k = i.kind === "news" ? String(i.title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70) : `${i.kind}:${i.id || i.title}`;
    if (seen.has(k) || seen.has(i.url + i.title)) return false;
    seen.add(k); seen.add(i.url + i.title);
    return true;
  });
  // Thin RSS summaries: fetch the article page for the newest few.
  const news = uniq.filter(i => i.kind === "news").sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)).slice(0, enrichTop);
  const enriched = await Promise.all(news.map(i => rss.enrich(i)));
  const map = new Map(news.map((n, k) => [n, enriched[k]]));
  return { items: uniq.map(i => map.get(i) || i), status, fetched_at: new Date(now).toISOString() };
}

module.exports = { fetchAll, rss, market, evergreen };
