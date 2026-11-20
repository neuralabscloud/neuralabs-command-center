// node scripts/test-news-sources.js   (geen netwerk)
const T = require("../sources/text");
const rss = require("../sources/rss");
const ev = require("../sources/evergreen");
const market = require("../sources/market");
const nc = require("../news-cards");
let fails = 0;
const t = (name, cond) => { console.log(`${cond ? "ok  " : "FOUT"} ${name}`); if (!cond) fails++; };

const n = T.numbers("ETF outflows hit $420 million, 3.5% of AUM, in 2026 with 12 funds and 7 days");
t("numbers: $420 million", n.some(x => x.raw === "$420 million" && x.value === 420e6));
t("numbers: 3.5%", n.some(x => x.value === 3.5));
t("numbers: jaar en <10 genegeerd", !n.some(x => x.value === 2026 || x.value === 7));
t("entities", T.entities("Spot bitcoin ETF and BlackRock").join(",") === "Bitcoin,BlackRock,ETF");
t("htmlText decodeert en vervangt dashes", T.htmlText("<p>A &amp; B — C</p>") === "A & B , C");

const xml = `<rss><channel><item><title><![CDATA[Lighter suspends withdrawals after $10.4 million exploit]]></title><link>https://www.coindesk.com/a</link><description>&lt;p&gt;Short.&lt;/p&gt;</description><pubDate>Mon, 16 Nov 2026 05:00:00 GMT</pubDate></item>
<entry><title>Atom item</title><link href="https://decrypt.co/b"/><summary>x</summary><updated>2026-11-15T01:00:00Z</updated></entry></channel></rss>`;
const p = rss.parseFeed(xml);
t("rss + atom geparsed", p.length === 2 && p[1].url === "https://decrypt.co/b");
const it = rss.toItem({ source: "CoinDesk", hosts: ["coindesk.com"] }, p[0]);
t("rss item met getal", it.kind === "news" && it.numbers[0].value === 10.4e6);

const pool = ev.load();
t(`evergreen geladen (${pool.length})`, pool.length >= 12);
t("evergreen: elk item heeft url + titel + layouts", pool.every(e => /^https:\/\//.test(e.url) && e.title && e.layouts.length));
t("evergreen: versus/series JSON", pool.find(e => e.id === "btc-halving-schedule").series.length === 5 && pool.find(e => e.id === "btc-halving-schedule").versus.right.value === "3.125");
t("evergreen: geen dashes", !pool.some(e => /[–—]/.test(e.title + e.summary)));
t("evergreen: elke layout gedekt", ["signal", "number", "versus", "persona"].every(l => pool.some(e => e.layouts.includes(l))));
t("evergreen: alles scoort", pool.every(e => !nc.scoreItem(e).reject));
t("yaml parse fout bij rommel", (() => { try { ev.parse("- a: 1\n???"); return false; } catch { return true; } })());

t("usd format", market.usd(71119777858) === "$71.1B" && market.usd(2.41e12) === "$2.41T");
const rows = Array.from({ length: 400 }, (_, i) => ({ t: Date.parse("2025-10-01") + i * 86400e3, v: (i + 1) * 1e9 }));
const s = market.monthly(rows, Date.parse("2026-11-04"), 1e9, 1);
t("monthly reeks 13 punten", s.length === 13 && s[12][1] === 400);
t("koersvoorspelling afgewezen", !!nc.scoreItem({ kind: "news", title: "Bitcoin risks falling below $60,000", numbers: [{ value: 60000 }], published_at: new Date().toISOString() }).reject);

// articleText: page JS from an unclosed <p> before a <script> must not leak in (PokeGuardian/JouwWeb, 2026-11-20).
{
  const T = require("../sources/text");
  const html = '<p>The Pok&amp;eacute;mon Company announced the next expansion with 120 cards in the main set today.<script>window.JOUWWEB.cart = {"products":[],"coupon":null}; var x = 50033;</script></p><p>' + 'x'.repeat(10) + '</p>';
  const out = T.articleText(html);
  t("articleText zonder page JS", !/coupon|JOUWWEB|50033/.test(out) && /120 cards/.test(out));
  t("articleText dubbel gecodeerde entity", /Pokémon/.test(out));
}

console.log(fails ? `${fails} FOUT` : "alles ok");
process.exit(fails ? 1 : 0);
