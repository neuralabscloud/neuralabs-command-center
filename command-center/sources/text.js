// Shared item helpers: number + entity extraction, HTML to text.
const ENTITIES = [
  ["Bitcoin", /\bbitcoin\b|\bBTC\b/i], ["Ethereum", /\bethereum\b|\bETH\b/i], ["Solana", /\bsolana\b|\bSOL\b/], ["XRP", /\bXRP\b|\bripple\b/i],
  ["Hyperliquid", /\bhyperliquid\b|\bHYPE\b/i], ["Tether", /\btether\b|\bUSDT\b/i], ["Circle", /\bcircle\b|\bUSDC\b/i], ["BlackRock", /\bblackrock\b/i],
  ["SEC", /\bSEC\b/], ["CFTC", /\bCFTC\b/], ["Fed", /\bfed(eral reserve)?\b|\bFOMC\b/i], ["ETF", /\bETFs?\b/i], ["Coinbase", /\bcoinbase\b/i],
  ["Binance", /\bbinance\b/i], ["MicroStrategy", /\bmicrostrategy\b|\bstrategy inc\b/i], ["Stablecoins", /\bstablecoins?\b/i], ["DeFi", /\bdefi\b/i],
  ["Miners", /\bminers?\b|\bhashrate\b/i], ["Lightning", /\blightning network\b/i], ["Base", /\bbase (chain|network|l2)\b/i], ["Arbitrum", /\barbitrum\b/i],
];
function entities(text) { return ENTITIES.filter(([, re]) => re.test(text)).map(([n]) => n); }

const MULT = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, tn: 1e12, trillion: 1e12 };
// Returns [{raw, value}] for money, percentages, multiples and plain numbers >= 10 (years excluded).
function numbers(text) {
  const out = [];
  const re = /(\$|€)?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?(%|x\b|k\b|m\b|mn\b|b\b|bn\b|t\b|tn\b|thousand\b|million\b|billion\b|trillion\b)?/gi;
  let m;
  const s = String(text || "");
  while ((m = re.exec(s)) && out.length < 12) {
    const base = Number(`${m[2].replace(/,/g, "")}${m[3] ? `.${m[3]}` : ""}`);
    const unit = (m[4] || "").toLowerCase();
    if (!Number.isFinite(base)) continue;
    if (!m[1] && !unit && (base < 10 || (base >= 1990 && base <= 2035 && !m[3]))) continue;
    out.push({ raw: m[0].trim(), value: MULT[unit] ? base * MULT[unit] : base });
  }
  return out;
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: ", ", ndash: ", ", hellip: "..." };
function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}
function htmlText(s) {
  return decode(String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/[–—]/g, ", ").replace(/\s+/g, " ").trim();
}
// Article body: concatenated <p> text, capped.
function articleText(html, max = 4000) {
  const ps = [...String(html || "").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => htmlText(m[1])).filter(t => t.length > 60);
  return ps.join(" ").slice(0, max);
}

module.exports = { entities, numbers, decode, htmlText, articleText };
