// Tijdelijke GTA VI campagne voor gh0stlayer (X + Instagram via de gewone crosspost).
// Eén post per dag, 18 t/m 27 nov 2026. Elke dag een vaste invalshoek met een link
// tussen GTA en crypto. Teksten zijn sjablonen met alleen gecontroleerde feiten;
// het enige live getal is de BTC-koers (CoinGecko, terugval Coinbase).
// Beeld: Nano Banana maakt een eigen achtergrond (geen tekst, geen logo's),
// daarna zetten we titel en cijfers er exact overheen met Playwright.
const fs = require("fs");
const path = require("path");
const { getJson } = require("./sources/http");

const START = "2026-11-18";
const TZ = "Europe/Madrid";
const FONTS_DIR = path.join(__dirname, "assets", "fonts");
const MEDIA_DIR = path.join(__dirname, "public", "media", "gta6");
const TAGS = "#GTA6 #Bitcoin";

// Historische BTC/USD dagslotkoersen, Bitstamp (TradingView), gecontroleerd 2026-11-18.
const HIST = {
  gta5_launch: { date: "17 Sep 2013", close: 126.92 },
  gta5_ps4: { date: "18 Nov 2014", close: 374.88 },
  trailer1: { date: "4 Dec 2023", close: 41985 },
  trailer2: { date: "6 May 2025", close: 96814 },
  delay_nov: { date: "6 Nov 2025", close: 101284 },
};
const GTA5_PRICE = 59.99;

function usd(v) {
  if (v < 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${(Math.round(v / 100) * 100).toLocaleString("en-US")}`;
}
function pct(a, b) { const p = (a / b - 1) * 100; return `${p >= 0 ? "+" : ""}${p.toFixed(0)}%`; }

const STYLE = "Original cinematic digital illustration, no text, no letters, no numbers, no logos, no brand names, no real game characters or recognisable game art. Premium dark aesthetic: deep black shadows, deep purple (hsl 264 65% 49%) neon glow as main accent with hot pink and cyan highlights, glossy, high contrast, cinematic lighting. Keep the lower 45% of the frame calm and dark so text can be placed over it. Vertical 4:5 composition.";

// Eén invalshoek per dag (index = dagen sinds START).
const ANGLES = [
  { key: "gta5_vs_now", scene: "A neon-lit coastal city boulevard at dusk in a fictional tropical Florida-like city, palm trees, a 2013-style sports car, and a huge glowing golden bitcoin coin rising over the ocean horizon like a sun.",
    build: n => ({
      text: `GTA V launched on 17 September 2013. Bitcoin closed that day around $127.\n\nGTA VI drops tomorrow. Bitcoin is around ${usd(n)} today.\n\nOne sequel later, the coin is roughly ${Math.round(n / HIST.gta5_launch.close)}x higher.\n\n${TAGS}`,
      card: { kicker: "GTA V to GTA VI", title: "Bitcoin between two launches", rows: [["GTA V launch, Sep 2013", "$127"], ["GTA VI eve, Nov 2026", usd(n)]], foot: "BTC/USD daily close, Bitstamp. Today: live price." } }) },
  { key: "launch_day", scene: "Midnight launch atmosphere: a glowing game console on a desk in a dark room facing a window with a neon tropical city skyline, a bitcoin price chart glowing faintly on a second screen.",
    build: n => ({
      text: `GTA VI is out today. Bitcoin along the way:\n\nFirst trailer, Dec 2023: about $42,000\nSecond trailer, May 2025: about $96,800\nLaunch day: about ${usd(n)}\n\nTwo trailers, two delays, one chart.\n\n${TAGS}`,
      card: { kicker: "GTA VI launch day", title: "The trailer chart", rows: [["First trailer, Dec 2023", "$42,000"], ["Second trailer, May 2025", "$96,800"], ["Launch day, Nov 2026", usd(n)]], foot: "BTC/USD daily close, Bitstamp. Today: live price." } }) },
  { key: "heist", scene: "A stylised crypto heist scene: a vault door made of glowing circuit boards blown open, streams of glowing ethereum-like crystals flowing out into the night, a getaway car silhouette under neon lights.",
    build: () => ({
      text: `In GTA a heist needs a crew, a plan and a getaway car.\n\nIn February 2025 about $1.5 billion in ETH left Bybit, the largest crypto hack on record. The FBI attributed it to North Korea's Lazarus Group.\n\nReal heists now start with a signature.\n\n${TAGS}`,
      card: { kicker: "Heist mode", title: "The real heist was on chain", rows: [["Bybit, Feb 2025", "$1.5B"], ["Asset taken", "ETH"]], foot: "Sources: Bybit, FBI statement 26 Feb 2025." } }) },
  { key: "money_printer", scene: "A neon money printer machine spitting out endless glowing cartoon cash bills in a dark luxury penthouse, next to it a single solid glowing bitcoin on a pedestal behind glass.",
    build: () => ({
      text: `GTA Online money has no cap. Rockstar can add more whenever it wants, and Shark Cards sell it for real money.\n\nBitcoin works the other way round: 21 million, ever. No studio, no patch notes.\n\nOne economy is a game. The other one is a rulebook.\n\n${TAGS}`,
      card: { kicker: "In-game economy", title: "Unlimited cash vs a hard cap", rows: [["GTA Online cash supply", "No cap"], ["Bitcoin supply", "21M"]], foot: "Bitcoin supply cap set in the protocol." } }) },
  { key: "vice_city", scene: "A fictional neon Miami-like beach city at night, art deco hotels glowing purple and pink, an empty basketball arena glowing in the distance, a bitcoin coin reflected in a wet street.",
    build: () => ({
      text: `GTA VI takes us back to Vice City, Rockstar's take on Miami.\n\nThe real Miami had its own crypto era: Bitcoin 2021 and 2022 conferences, a city coin, and an arena called FTX Arena. After FTX collapsed it was renamed. Today it is the Kaseya Center.\n\n${TAGS}`,
      card: { kicker: "Vice City, real life", title: "Miami already played the crypto level", rows: [["Bitcoin conference", "2021, 2022"], ["FTX Arena", "Renamed 2023"]], foot: "Public record. Not affiliated with Rockstar Games." } }) },
  { key: "copy_cost", scene: "A single retro game case on a glossy black table under a neon spotlight, a stack of glowing bitcoin coins next to it, a tropical neon city reflected in the table surface.",
    build: n => {
      const btc = GTA5_PRICE / HIST.gta5_launch.close;
      return {
        text: `GTA V cost $59.99 at launch in 2013. With Bitcoin around $127, that was about ${btc.toFixed(2)} BTC.\n\nThat ${btc.toFixed(2)} BTC is worth about ${usd(btc * n)} today.\n\nHindsight, not advice. Still the most expensive copy of GTA V ever.\n\n${TAGS}`,
        card: { kicker: "Priced in Bitcoin", title: "What GTA V cost in BTC", rows: [["GTA V, 2013", "$59.99"], ["In BTC at launch", `${btc.toFixed(2)} BTC`], ["That BTC today", usd(btc * n)]], foot: "BTC/USD daily close, Bitstamp. Today: live price. Not financial advice." } };
    } },
  { key: "cheat_codes", scene: "A glowing retro game controller floating in darkness, button inputs drawn as neon light trails, next to it a paper sheet with twelve blank lines and a small padlock, moody purple light.",
    build: () => ({
      text: `GTA has cheat codes for everything. Infinite health, max wanted level, a tank out of thin air.\n\nCrypto has none. Lose your seed phrase and there is no button combo that brings your coins back.\n\nWrite it down. Offline. Not in a screenshot.\n\n${TAGS}`,
      card: { kicker: "Cheat codes", title: "There is no cheat for a lost seed", rows: [["GTA", "Cheats"], ["Seed phrase lost", "No respawn"]], foot: "Self-custody basics." } }) },
  { key: "halvings", scene: "A long neon highway through a tropical city at night stretching to the horizon with three glowing gates over the road, a bitcoin coin shining at the far end.",
    build: () => ({
      text: `Between GTA V (2013) and GTA VI (2026), Bitcoin went through three halvings: 2016, 2020 and 2024.\n\nThe block reward fell from 25 BTC to 3.125 BTC.\n\nRockstar shipped one game. The network cut its new supply by 87.5%.\n\n${TAGS}`,
      card: { kicker: "The long wait", title: "Three halvings, one sequel", rows: [["Block reward, 2013", "25 BTC"], ["Block reward, 2026", "3.125 BTC"]], foot: "Halvings: Jul 2016, May 2020, Apr 2024." } }) },
  { key: "wanted_level", scene: "Five glowing neon stars above a dark city skyline, police light glow in purple and cyan, a glowing chain of linked blocks running across the sky like a light trail.",
    build: () => ({
      text: `In GTA your wanted level fades if you hide long enough.\n\nOn chain it never fades. Coins from the 2016 Bitfinex hack were traced for years, and in 2022 the US seized about 94,000 BTC of them.\n\nThe ledger is the cop with the best memory.\n\n${TAGS}`,
      card: { kicker: "Wanted level", title: "The chain never forgets", rows: [["Bitfinex hack", "2016"], ["BTC seized", "~94,000"], ["Seizure", "2022"]], foot: "Source: US Department of Justice, Feb 2022." } }) },
  { key: "recap", scene: "A neon tropical city skyline at sunrise seen from above, a glowing upward-winding road through the city shaped like a price chart, a bitcoin coin at its peak.",
    build: n => ({
      text: `GTA V to GTA VI, priced in Bitcoin:\n\nSep 2013, GTA V launch: $127\nNov 2014, PS4 release: $375\nDec 2023, first trailer: $42,000\nMay 2025, second trailer: $96,800\nNov 2026, GTA VI out: ${usd(n)}\n\nThirteen years, one sequel.\n\n${TAGS}`,
      card: { kicker: "Recap", title: "Thirteen years in one chart", rows: [["GTA V, Sep 2013", "$127"], ["PS4, Nov 2014", "$375"], ["Trailer 1, Dec 2023", "$42,000"], ["Trailer 2, May 2025", "$96,800"], ["GTA VI, Nov 2026", usd(n)]], foot: "BTC/USD daily close, Bitstamp. Today: live price." } }) },
];
const END = (() => { const d = new Date(`${START}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + ANGLES.length - 1); return d.toISOString().slice(0, 10); })();

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function angleFor(date) {
  const i = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${START}T12:00:00Z`)) / 86400e3);
  return i >= 0 && i < ANGLES.length ? { index: i, ...ANGLES[i] } : null;
}

// Copy-stijl: geen streepjes, geen ALL CAPS (behalve tickers/acroniemen), max 280 tekens.
const CAPS_OK = new Set(["GTA", "BTC", "ETH", "FBI", "FTX", "US", "PS4", "VI", "V", "USD"]);
function validate(text) {
  const errors = [];
  if (/[–—]/.test(text)) errors.push("streepje");
  for (const w of text.match(/\b[A-Z]{2,}\b/g) || []) if (!CAPS_OK.has(w)) errors.push(`caps: ${w}`);
  if ([...text].length > 280) errors.push(`te lang: ${[...text].length}`);
  return errors;
}

async function btcPrice() {
  try {
    const j = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", { allowHosts: ["api.coingecko.com"] });
    if (j.bitcoin && j.bitcoin.usd > 1000) return { price: j.bitcoin.usd, source: "CoinGecko" };
  } catch {}
  const j = await getJson("https://api.coinbase.com/v2/prices/BTC-USD/spot", { allowHosts: ["api.coinbase.com"] });
  const p = Number(j.data && j.data.amount);
  if (!(p > 1000)) throw new Error("geen bruikbare BTC-koers");
  return { price: p, source: "Coinbase" };
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fontFace(family, file, weight) {
  const full = path.join(FONTS_DIR, file);
  if (!fs.existsSync(full)) return "";
  return `@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${fs.readFileSync(full).toString("base64")}) format('truetype');font-weight:${weight}}`;
}
function cardHtml(card, bgFile) {
  const bg = bgFile ? `url(data:image/png;base64,${fs.readFileSync(bgFile).toString("base64")})` : "none";
  const rows = card.rows.map(([l, v]) => `<div class="row"><span class="l">${esc(l)}</span><span class="v">${esc(v)}</span></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace("Display", "Montserrat-ExtraBold.ttf", 800)}${fontFace("Inter", "Inter-Medium.ttf", 500)}${fontFace("Inter", "Inter-Bold.ttf", 700)}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1350px;background:#05030a ${bg} center/cover no-repeat;font-family:Inter,sans-serif;color:#fff;position:relative;overflow:hidden}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,3,10,.55) 0%,rgba(5,3,10,0) 22%,rgba(5,3,10,0) 38%,rgba(5,3,10,.86) 60%,rgba(5,3,10,.97) 100%)}
.mark{position:absolute;top:48px;left:60px;font:700 30px Inter;letter-spacing:.5px;opacity:.92}
.mark b{color:hsl(264 90% 72%)}
.box{position:absolute;left:60px;right:60px;bottom:64px}
.kicker{display:inline-block;font:700 24px Inter;color:#fff;background:hsl(264 65% 49%);padding:8px 18px;border-radius:999px;margin-bottom:22px}
h1{font:800 70px/1.05 Display,Inter;margin-bottom:34px;text-shadow:0 4px 30px rgba(0,0,0,.6)}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:24px;padding:18px 0;border-top:1px solid rgba(255,255,255,.16)}
.l{font:500 30px Inter;color:rgba(255,255,255,.78)}
.v{font:800 46px Display,Inter;color:hsl(264 95% 78%);white-space:nowrap}
.foot{margin-top:22px;font:500 20px Inter;color:rgba(255,255,255,.55)}
</style></head><body><div class="shade"></div><div class="mark">gh0st<b>layer</b></div>
<div class="box"><div class="kicker">${esc(card.kicker)}</div><h1>${esc(card.title)}</h1>${rows}<div class="foot">${esc(card.foot)}</div></div>
</body></html>`;
}

async function renderCard(card, bgFile, outFile) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
    await page.setContent(cardHtml(card, bgFile), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile, type: "png" });
  } finally { await browser.close().catch(() => {}); }
}

// deps: { nanoBananaRun, downloadTo, readTaskFile, writeTaskFile, genId, notify, channelId }
// opts: { date, dry_run, force, delay_min }
async function run(deps, opts = {}) {
  const date = opts.date || localDate();
  const angle = angleFor(date);
  if (!angle) return { ok: false, skipped: true, reason: `buiten campagne (${START} t/m ${END})` };
  const tasks = deps.readTaskFile("community-tasks.json");
  const done = tasks.find(t => t.campaign === "gta6" && t.gta6_day === date && t.status !== "cancelled");
  if (done && !opts.force && !opts.dry_run) return { ok: false, skipped: true, reason: `vandaag al gedaan (${done.id})` };

  const { price, source } = await btcPrice();
  const { text, card } = angle.build(price);
  const errors = validate(text);
  if (errors.length) throw new Error(`tekst afgekeurd: ${errors.join(", ")}`);

  const id = deps.genId();
  const bg = path.join(MEDIA_DIR, `gta6-${date}-${id}-bg.png`);
  const out = path.join(MEDIA_DIR, `gta6-${date}-${id}.png`);
  const nb = await deps.nanoBananaRun({ prompt: `${angle.scene} ${STYLE}`, aspect_ratio: "4:5", resolution: "2K", num_images: 1 }, `gta6-${id}`);
  if (!/^https:\/\//.test(nb.url)) throw new Error("Nano Banana gaf geen https-URL");
  await deps.downloadTo(nb.url, bg);
  await renderCard(card, bg, out);

  const mediaPath = `/media/gta6/${path.basename(out)}`;
  const delay = Number.isFinite(+opts.delay_min) ? +opts.delay_min : 30;
  const now = new Date();
  const task = {
    id, channel_id: deps.channelId, status: opts.dry_run ? "draft" : "scheduled",
    created_at: now.toISOString(), updated_at: now.toISOString(),
    scheduled_at: new Date(now.getTime() + delay * 60e3).toISOString(), scheduled_local: null,
    archetype: `GTA VI · ${angle.key}`, trigger_word: "", text, media_path: mediaPath, media_paths: [mediaPath],
    attempts: 0, error: null, autopilot: true, campaign: "gta6", gta6_day: date, gta6_angle: angle.key,
    topic: `GTA VI x crypto: ${card.title}`, reason: `Tijdelijke GTA VI campagne, dag ${angle.index + 1}/${ANGLES.length}`,
    btc_price: { usd: price, source, at: now.toISOString() }, image_method: "nanobanana", infsh_id: nb.infshId || null,
  };
  deps.writeTaskFile("community-tasks.json", [task, ...deps.readTaskFile("community-tasks.json")]);
  if (deps.notify) deps.notify("GTA VI post " + (opts.dry_run ? "als concept klaar" : "ingepland"), `Dag ${angle.index + 1}/${ANGLES.length} (${angle.key}), ${opts.dry_run ? "concept" : "post om " + task.scheduled_at.slice(11, 16) + " UTC"} op X + Instagram.\n\n${text}`);
  return { ok: true, task_id: id, date, angle: angle.key, scheduled_at: task.scheduled_at, status: task.status, media: mediaPath, text };
}

function status(readTaskFile) {
  const posts = readTaskFile("community-tasks.json").filter(t => t.campaign === "gta6")
    .map(t => ({ id: t.id, day: t.gta6_day, angle: t.gta6_angle, status: t.status, scheduled_at: t.scheduled_at, media: t.media_path }));
  return { start: START, end: END, today: localDate(), today_angle: (angleFor(localDate()) || {}).key || null, plan: ANGLES.map((a, i) => a.key), posts };
}

module.exports = { START, END, ANGLES, HIST, angleFor, validate, cardHtml, localDate, btcPrice, run, status, usd };
