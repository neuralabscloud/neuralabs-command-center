// Slabhaus TCG sources. fetchAll() -> { items, status, fetched_at }.
// News (max 48 h) from outlet listings, Reddit only as a trending signal (never a fact source),
// numbers ONLY from the NeuraCollectibles API in the same run (timestamped), evergreen facts from evergreen.yaml.
// Never: card images, logos or photos from news sites or marketplaces; never marketplace scraping for numbers.
const path = require("path");
const { get } = require("../http");
const T = require("../text");
const rss = require("../rss");
const evergreen = require("../evergreen");
const ncapi = require("./nc");

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const EVERGREEN_FILE = path.join(__dirname, "evergreen.yaml");

// Outlets from the spec. Status per outlet goes into the run report.
const OUTLETS = [
  { source: "PokeGuardian", kind: "pokeguardian", url: "https://www.pokeguardian.com/articles/news-archive", hosts: ["pokeguardian.com"] },
  { source: "Cardmarket Insight", kind: "cardmarket", url: "https://news.cardmarket.com/en/Pokemon", hosts: ["news.cardmarket.com"] },
  { source: "PokéBeach", blocked: "geblokkeerd: HTTP 403 voor servers (Cloudflare)" },
  { source: "pokemon.com", blocked: "geblokkeerd: Imperva bot-muur" },
  { source: "TCGplayer Infinite", blocked: "niet bruikbaar: pagina alleen via JavaScript, geen feed" },
  { source: "PSA", blocked: "geblokkeerd: HTTP 403 voor servers" },
  { source: "CGC", blocked: "niet bruikbaar: pagina alleen via JavaScript, geen feed" },
  { source: "Beckett", blocked: "geblokkeerd: HTTP 403 voor servers" },
];
const REDDIT = [
  { source: "r/PokemonTCG", url: "https://www.reddit.com/r/PokemonTCG/top/.rss?t=day", hosts: ["reddit.com"] },
  { source: "r/PokeInvesting", url: "https://www.reddit.com/r/PokeInvesting/top/.rss?t=day", hosts: ["reddit.com"] },
];

const TCG_ENTITIES = [
  ["psa", /\bPSA\b/i], ["cgc", /\bCGC\b/], ["bgs", /\bBGS\b/], ["beckett", /\bbeckett\b/i], ["sgc", /\bSGC\b/], ["tag", /\bTAG grad/i],
  ["pop", /\b(pop(ulation)?( report)?|gem rate)\b/i], ["market", /\b(sales?|sold|auction|market|prices?|volume)\b/i],
  ["release", /\b(set|expansion|release[sd]?|prerelease|booster|reveal(ed)?|collection|tin|box)\b/i],
];
function entities(text) { return TCG_ENTITIES.filter(([, re]) => re.test(text)).map(([n]) => n); }

const getPage = (url, hosts, opts = {}) => get(url, { allowHosts: hosts, maxBytes: 3e6, timeout: 15000, headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,application/xml" }, ...opts });
const meta = (html, re) => T.decode(((html.match(re) || [])[1] || "").trim());

function newsItem(o, { title, url, summary, published_at }) {
  const text = `${title}. ${summary || ""}`;
  return { kind: "news", source: o.source, url, title, summary: String(summary || "").slice(0, 2000), published_at, numbers: T.numbers(text), entities: entities(text), hosts: o.hosts };
}

// PokeGuardian: archive links "/<id>_<slug>" (higher id = newer), date and summary from the article meta.
async function pokeguardian(o, { now, maxAgeH, top = 10 }) {
  const html = await getPage(o.url, o.hosts);
  const links = [...new Set([...html.matchAll(/href="(\/(\d+)_[a-z0-9-]+)"/g)].map(m => m[1]))]
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0])).slice(0, top);
  const out = [];
  for (const rel of links) {
    try {
      const url = `https://www.pokeguardian.com${rel}`;
      const page = await getPage(url, o.hosts, { timeout: 12000 });
      const published_at = meta(page, /itemprop="datePublished"\s+content="([^"]+)"/i);
      if (!published_at || now - Date.parse(published_at) > maxAgeH * 3600e3) continue;
      const title = meta(page, /property="og:title"\s+content="([^"]+)"/i).replace(/\s*\|.*$/, "");
      const desc = meta(page, /property="og:description"\s+content="([^"]+)"/i);
      const body = T.articleText(page, 2000);
      out.push(newsItem(o, { title, url, summary: body.length > desc.length ? body : desc, published_at: new Date(published_at).toISOString() }));
    } catch {}
  }
  return out;
}

// Cardmarket Insight: listing with "/en/Pokemon/<slug>" links, title, "dd.mm.yyyy, hh:mm:ss" and a teaser.
async function cardmarket(o, { now, maxAgeH }) {
  const html = await getPage(o.url, o.hosts);
  const out = [], seen = new Set();
  for (const m of html.matchAll(/href="((?:https:\/\/news\.cardmarket\.com)?\/en\/Pokemon\/[a-z0-9-]+)"/g)) {
    const url = m[1].startsWith("http") ? m[1] : `https://news.cardmarket.com${m[1]}`;
    if (seen.has(url)) continue;
    const win = T.htmlText(html.slice(m.index, m.index + 1500));
    const d = win.match(/(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{2}):(\d{2})/);
    if (!d) continue;
    seen.add(url);
    const published_at = new Date(`${d[3]}-${d[2]}-${d[1]}T${d[4]}:${d[5]}:00+01:00`).toISOString();
    if (now - Date.parse(published_at) > maxAgeH * 3600e3) continue;
    const title = win.slice(0, d.index).replace(/^.*?(Featured news|Other)\s*/i, "").trim().slice(0, 160);
    const summary = win.slice(d.index + d[0].length).replace(/^[:\d\s]+/, "").slice(0, 600);
    if (title) out.push(newsItem(o, { title, url, summary, published_at }));
  }
  return out;
}

// Trending: same story at several outlets, and how often Reddit top-of-day titles mention it. Ranking only.
const STOP = new Set("the a an and or of for to in on at with from new is are by its as tcg pokemon pokémon card cards set revealed reveal".split(" "));
const tokens = s => new Set(String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));
function overlap(a, b) { let n = 0; for (const w of a) if (b.has(w)) n++; return n; }
function applyTrend(news, redditTitles) {
  const tk = news.map(n => tokens(n.title));
  const rt = redditTitles.map(tokens);
  news.forEach((n, i) => {
    const outlets = new Set([n.source]);
    news.forEach((o, j) => { if (j !== i && overlap(tk[i], tk[j]) >= 2) outlets.add(o.source); });
    const reddit = rt.filter(r => overlap(tk[i], r) >= 2).length;
    n.trend = { outlets: outlets.size, reddit };
  });
}

// Reddit top-of-day titles (RSS; the JSON API answers 403). On 429/errors: last good list up to 12 h old.
async function redditTop(r, cacheFile, now) {
  const fs = require("fs");
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
  try {
    const titles = rss.parseFeed(await getPage(r.url, r.hosts)).map(x => x.title);
    cache[r.source] = { at: new Date(now).toISOString(), titles };
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch {}
    return titles;
  } catch (e) {
    const c = cache[r.source];
    if (c && now - Date.parse(c.at) < 12 * 3600e3) return c.titles;
    throw e;
  }
}

async function fetchAll({ now = Date.now(), env = process.env, account = {}, log = () => {} } = {}) {
  const status = {};
  const maxAgeH = Number(account.scoring?.max_age_hours) || 48;
  const news = [];
  const run = async (name, fn, sink) => {
    try { const r = await fn(); sink.push(...r); status[name] = `live (${r.length})`; }
    catch (e) { status[name] = `fout: ${String(e.message || e).slice(0, 120)}`; log(`tcg bron ${name}: ${status[name]}`); }
  };
  const redditTitles = [];
  const cacheFile = path.join(__dirname, "..", "..", account.data_dir || "data/news-cards/slabhaus", "reddit-cache.json");
  const metrics = [];
  await Promise.all([
    ...OUTLETS.filter(o => !o.blocked).map(o => run(o.source, () => (o.kind === "pokeguardian" ? pokeguardian : cardmarket)(o, { now, maxAgeH }), news)),
    (async () => { // one by one: Reddit answers parallel requests with 429
      for (const r of REDDIT) {
        await run(`${r.source} (trending)`, () => redditTop(r, cacheFile, now), redditTitles);
        await new Promise(res => setTimeout(res, 2500));
      }
    })(),
    run("NeuraCollectibles API", () => ncapi.metricItems({ base: account.sources?.nc_api, key: env[account.credentials?.nc_api_key_env || "NC_API_KEY"], now, log }), metrics),
  ]);
  for (const o of OUTLETS.filter(o => o.blocked)) status[o.source] = o.blocked;
  applyTrend(news, redditTitles);
  let ever = [];
  try { ever = evergreen.load(EVERGREEN_FILE); status.Evergreen = `live (${ever.length})`; } catch (e) { status.Evergreen = `fout: ${e.message}`; }
  const seen = new Set();
  const uniq = news.filter(i => { const k = i.url; if (seen.has(k)) return false; seen.add(k); return true; });
  return { items: [...uniq, ...metrics, ...ever], status, fetched_at: new Date(now).toISOString() };
}

module.exports = { OUTLETS, REDDIT, EVERGREEN_FILE, entities, pokeguardian, cardmarket, applyTrend, fetchAll, nc: ncapi };
