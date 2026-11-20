// Market facts (own fetched data, keyless APIs). Every item carries the values and fetched_at.
const { getJson, postJson, get } = require("./http");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function usd(v) {
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}
function monthLabel(ts) { const d = new Date(ts); return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
// rows [{t (ms), v}] sorted asc -> 13 monthly points over the last year.
function monthly(rows, now, scale = 1, digits = 1) {
  const out = [];
  for (let i = 12; i >= 0; i--) {
    const target = now - i * 30.4 * 86400e3;
    let best = null;
    for (const r of rows) if (r.t <= target) best = r; else break;
    if (best) out.push([MON[new Date(best.t).getUTCMonth()], Math.round(best.v / scale * 10 ** digits) / 10 ** digits]);
  }
  return out;
}
function yearAgo(rows, now) { let best = null; for (const r of rows) if (r.t <= now - 365 * 86400e3) best = r; else break; return best; }
function metric(o, now) { const at = new Date(now).toISOString(); return { kind: "metric", published_at: at, fetched_at: at, ...o }; }

async function coingecko(now) {
  const g = (await getJson("https://api.coingecko.com/api/v3/global")).data;
  const dom = g.market_cap_percentage.btc, eth = g.market_cap_percentage.eth, mc = g.total_market_cap.usd;
  return [metric({
    source: "CoinGecko", url: "https://www.coingecko.com/en/global-charts",
    topic: "btc dominance",
    title: `Bitcoin dominance is ${dom.toFixed(1)}% of a ${usd(mc)} crypto market`,
    summary: `Bitcoin holds ${dom.toFixed(1)}% of total crypto market cap (${usd(mc)}). Ether holds ${eth.toFixed(1)}%. Market cap change over 24h: ${g.market_cap_change_percentage_24h_usd.toFixed(1)}%.`,
    numbers: [{ raw: `${dom.toFixed(1)}%`, value: +dom.toFixed(1) }, { raw: usd(mc), value: mc }, { raw: `${eth.toFixed(1)}%`, value: +eth.toFixed(1) }],
    entities: ["Bitcoin", "Ethereum"], layouts: ["number", "signal"], values: { btc_dominance: dom, eth_dominance: eth, total_mcap_usd: mc },
  }, now)];
}

function vsItem({ source, url, name, rows, now, entities, extra = "" }) {
  const cur = rows[rows.length - 1], ago = yearAgo(rows, now);
  if (!cur || !ago) return null;
  const pct = (cur.v / ago.v - 1) * 100;
  return metric({
    topic: String(name).toLowerCase(),
    source, url, title: `${name} is ${usd(cur.v)}, versus ${usd(ago.v)} a year ago`,
    summary: `${name}: ${usd(cur.v)} on ${monthLabel(cur.t)}, ${usd(ago.v)} on ${monthLabel(ago.t)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% over 12 months). ${extra}`.trim(),
    numbers: [{ raw: usd(cur.v), value: cur.v }, { raw: usd(ago.v), value: ago.v }, { raw: `${pct.toFixed(1)}%`, value: +pct.toFixed(1) }],
    entities, layouts: ["number", "versus"],
    series: monthly(rows, now, 1e9, 1), series_unit: "billion USD",
    versus: { left: { label: monthLabel(ago.t), value: usd(ago.v) }, right: { label: monthLabel(cur.t), value: usd(cur.v) } },
    values: { current: cur.v, year_ago: ago.v, change_pct: pct },
  }, now);
}

async function defillama(now) {
  const tvl = (await getJson("https://api.llama.fi/v2/historicalChainTvl", { maxBytes: 5e6 })).map(r => ({ t: r.date * 1000, v: r.tvl }));
  const st = (await getJson("https://stablecoins.llama.fi/stablecoincharts/all", { maxBytes: 5e6 })).map(r => ({ t: Number(r.date) * 1000, v: r.totalCirculating?.peggedUSD || r.totalCirculatingUSD?.peggedUSD || 0 })).filter(r => r.v > 0);
  return [
    vsItem({ source: "DefiLlama", url: "https://defillama.com/", name: "Total DeFi TVL", rows: tvl, now, entities: ["DeFi"] }),
    vsItem({ source: "DefiLlama", url: "https://defillama.com/stablecoins", name: "USD stablecoin supply", rows: st, now, entities: ["Stablecoins"] }),
  ].filter(Boolean);
}

async function mempool(now) {
  const tip = Number(await get("https://mempool.space/api/blocks/tip/height"));
  const diff = await getJson("https://mempool.space/api/v1/difficulty-adjustment");
  const hr = await getJson("https://mempool.space/api/v1/mining/hashrate/1y");
  const out = [];
  if (Number.isFinite(tip)) {
    const next = Math.ceil((tip + 1) / 210000) * 210000, left = next - tip;
    out.push(metric({
      source: "mempool.space", url: "https://mempool.space/",
      topic: "btc halving",
      title: `Bitcoin's next halving is ${left.toLocaleString("en-US")} blocks away, at block ${next.toLocaleString("en-US")}`,
      summary: `Current block height ${tip.toLocaleString("en-US")}. The subsidy halves every 210,000 blocks; the next halving is at block ${next.toLocaleString("en-US")}, ${left.toLocaleString("en-US")} blocks from now. At the 10 minute target that is roughly ${Math.round(left * 10 / 1440)} days.`,
      numbers: [{ raw: left.toLocaleString("en-US"), value: left }, { raw: next.toLocaleString("en-US"), value: next }, { raw: tip.toLocaleString("en-US"), value: tip }, { raw: "210,000", value: 210000 }],
      entities: ["Bitcoin", "Miners"], layouts: ["number", "signal"], values: { tip, next_halving_height: next, blocks_left: left },
    }, now));
  }
  const rows = (hr.hashrates || []).map(r => ({ t: r.timestamp * 1000, v: r.avgHashrate }));
  const cur = rows[rows.length - 1], ago = rows[0];
  if (cur && ago) {
    const eh = v => Math.round(v / 1e18);
    const pct = (cur.v / ago.v - 1) * 100;
    out.push(metric({
      source: "mempool.space", url: "https://mempool.space/graphs/mining/hashrate-difficulty",
      topic: "btc hashrate",
      title: `Bitcoin hashrate is ${eh(cur.v)} EH/s, versus ${eh(ago.v)} EH/s a year ago`,
      summary: `Average network hashrate ${eh(cur.v)} EH/s on ${monthLabel(cur.t)}, ${eh(ago.v)} EH/s on ${monthLabel(ago.t)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%). Last difficulty adjustment: ${diff.previousRetarget >= 0 ? "+" : ""}${Number(diff.previousRetarget).toFixed(2)}%.`,
      numbers: [{ raw: `${eh(cur.v)} EH/s`, value: eh(cur.v) }, { raw: `${eh(ago.v)} EH/s`, value: eh(ago.v) }, { raw: `${pct.toFixed(1)}%`, value: +pct.toFixed(1) }, { raw: `${Number(diff.previousRetarget).toFixed(2)}%`, value: +Number(diff.previousRetarget).toFixed(2) }],
      entities: ["Bitcoin", "Miners"], layouts: ["number", "versus"],
      series: monthly(rows, now, 1e18, 0), series_unit: "EH/s",
      versus: { left: { label: monthLabel(ago.t), value: `${eh(ago.v)}`, unit: "EH/s" }, right: { label: monthLabel(cur.t), value: `${eh(cur.v)}`, unit: "EH/s" } },
      values: { hashrate_ehs: eh(cur.v), year_ago_ehs: eh(ago.v), last_retarget_pct: diff.previousRetarget },
    }, now));
  }
  return out;
}

async function feargreed(now) {
  const d = (await getJson("https://api.alternative.me/fng/?limit=8")).data || [];
  const today = d[0], week = d[7] || d[d.length - 1];
  if (!today) return [];
  return [metric({
    source: "Alternative.me", url: "https://alternative.me/crypto/fear-and-greed-index/",
    topic: "fear and greed",
    title: `Crypto fear and greed index reads ${today.value} (${today.value_classification.toLowerCase()}), from ${week.value} a week ago`,
    summary: `Fear and greed index: ${today.value} today (${today.value_classification}), ${week.value} seven days ago (${week.value_classification}).`,
    numbers: [{ raw: String(today.value), value: +today.value }, { raw: String(week.value), value: +week.value }],
    entities: ["Bitcoin"], layouts: ["number", "versus"],
    series: d.slice().reverse().map(r => [MON[new Date(r.timestamp * 1000).getUTCMonth()] + " " + new Date(r.timestamp * 1000).getUTCDate(), +r.value]),
    versus: { left: { label: "a week ago", value: String(week.value), unit: week.value_classification }, right: { label: "today", value: String(today.value), unit: today.value_classification } },
    values: { today: +today.value, week_ago: +week.value },
  }, now)];
}

// Spec wants Hyperliquid from Redis; no Redis in this stack, so the public info API is used.
async function hyperliquid(now) {
  const [meta, ctxs] = await postJson("https://api.hyperliquid.xyz/info", { type: "metaAndAssetCtxs" }, { allowHosts: ["api.hyperliquid.xyz"] });
  const i = meta.universe.findIndex(u => u.name === "BTC");
  const c = ctxs[i];
  if (!c) return [];
  const oi = Number(c.openInterest) * Number(c.markPx), f = Number(c.funding) * 100, apr = f * 24 * 365;
  return [metric({
    source: "Hyperliquid", url: "https://app.hyperliquid.xyz/trade/BTC",
    topic: "hyperliquid oi",
    title: `BTC open interest on Hyperliquid is ${usd(oi)}, funding ${f.toFixed(4)}% per hour`,
    summary: `BTC perp on Hyperliquid: open interest ${Number(c.openInterest).toFixed(0)} BTC (${usd(oi)}), funding ${f.toFixed(4)}% per hour (about ${apr.toFixed(1)}% annualised), 24h notional volume ${usd(Number(c.dayNtlVlm))}.`,
    numbers: [{ raw: usd(oi), value: oi }, { raw: `${f.toFixed(4)}%`, value: +f.toFixed(4) }, { raw: `${apr.toFixed(1)}%`, value: +apr.toFixed(1) }, { raw: usd(Number(c.dayNtlVlm)), value: Number(c.dayNtlVlm) }],
    entities: ["Hyperliquid", "Bitcoin"], layouts: ["number", "signal"], values: { oi_usd: oi, funding_pct_hour: f, funding_apr_pct: apr },
  }, now)];
}

module.exports = { usd, monthly, coingecko, defillama, mempool, feargreed, hyperliquid };
