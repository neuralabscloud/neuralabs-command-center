// RSS/Atom news fetcher (no library). Items: {source,url,title,summary,published_at,numbers,entities,kind:"news"}.
const { get } = require("./http");
const T = require("./text");

const FEEDS = [
  { source: "The Block", url: "https://www.theblock.co/rss.xml", hosts: ["theblock.co"] },
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", hosts: ["coindesk.com"] },
  { source: "Decrypt", url: "https://decrypt.co/feed", hosts: ["decrypt.co"] },
  { source: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/.rss/full/", hosts: ["bitcoinmagazine.com"] },
  { source: "DL News", url: "https://www.dlnews.com/arc/outboundfeeds/rss/", hosts: ["dlnews.com"] },
];

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}
function parseFeed(xml) {
  const blocks = [...String(xml).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  return blocks.map(b => {
    const linkHref = (b.match(/<link\b[^>]*href="([^"]+)"/i) || [])[1];
    return {
      title: T.htmlText(tag(b, "title")),
      url: T.decode((linkHref || tag(b, "link") || tag(b, "guid")).trim()),
      summary: T.htmlText(tag(b, "description") || tag(b, "summary") || tag(b, "content:encoded") || tag(b, "content")),
      published_at: (() => { const d = Date.parse(T.decode(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")).trim()); return Number.isFinite(d) ? new Date(d).toISOString() : null; })(),
    };
  }).filter(i => i.title && /^https?:\/\//.test(i.url));
}

function toItem(feed, raw) {
  const text = `${raw.title}. ${raw.summary}`;
  return { kind: "news", source: feed.source, url: raw.url, title: raw.title, summary: raw.summary.slice(0, 2000), published_at: raw.published_at, numbers: T.numbers(text), entities: T.entities(text), hosts: feed.hosts };
}

async function fetchFeed(feed, { now = Date.now(), maxAgeH = 24 } = {}) {
  const xml = await get(feed.url, { allowHosts: feed.hosts, maxBytes: 2e6 });
  return parseFeed(xml).map(r => toItem(feed, r)).filter(i => i.published_at && now - Date.parse(i.published_at) <= maxAgeH * 3600e3);
}

// Fill thin summaries from the article page (same host only).
async function enrich(item, { minLen = 240 } = {}) {
  if (String(item.summary || "").length >= minLen) return item;
  try {
    const body = T.articleText(await get(item.url, { allowHosts: item.hosts, maxBytes: 3e6, timeout: 12000 }));
    if (body.length > item.summary.length) {
      const text = `${item.title}. ${body}`;
      return { ...item, summary: body.slice(0, 2000), numbers: T.numbers(text), entities: T.entities(text), enriched: true };
    }
  } catch {}
  return item;
}

module.exports = { FEEDS, parseFeed, toItem, fetchFeed, enrich };
