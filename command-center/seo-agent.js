// ── SEO AGENT ──────────────────────────────────────────────
// Crawls a site (up to ~25 pages), performs deterministic on-page/technical
// SEO checks, optionally fetches Google PageSpeed Insights, then asks Claude
// for a prioritised strategic review. Exports `runSeoAnalysis(task)`.

const cheerio = require("cheerio");

const UA = "Mozilla/5.0 (compatible; CommandCenter-SEO/1.0; +https://example.com/bot)";
const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_MAX_PAGES = 25;

// ── HTTP helper with timeout ───────────────────────────────
async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "text/html,*/*", ...(opts.headers || {}) },
      redirect: "follow",
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function normaliseUrl(u, base) {
  try {
    const url = new URL(u, base);
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// ── Sitemap discovery ──────────────────────────────────────
async function discoverFromSitemap(rootUrl) {
  const found = new Set();
  const candidates = [
    new URL("/sitemap.xml", rootUrl).toString(),
    new URL("/sitemap_index.xml", rootUrl).toString(),
  ];
  try {
    const robots = await fetchWithTimeout(new URL("/robots.txt", rootUrl).toString());
    if (robots.ok) {
      const text = await robots.text();
      for (const m of text.matchAll(/Sitemap:\s*(\S+)/gi)) candidates.push(m[1].trim());
    }
  } catch {}

  async function walk(sitemapUrl, depth = 0) {
    if (depth > 2) return;
    try {
      const r = await fetchWithTimeout(sitemapUrl);
      if (!r.ok) return;
      const xml = await r.text();
      const isIndex = /<sitemapindex/i.test(xml);
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
      if (isIndex) {
        for (const child of locs.slice(0, 5)) await walk(child, depth + 1);
      } else {
        for (const u of locs) found.add(u);
      }
    } catch {}
  }

  for (const c of candidates) await walk(c);
  return [...found].filter(u => sameOrigin(u, rootUrl));
}

// ── BFS crawler (fallback when no sitemap) ─────────────────
async function bfsCrawl(rootUrl, max, seedQueue = []) {
  const visited = new Set();
  const pages = [];
  const queue = [rootUrl, ...seedQueue].filter(Boolean);

  while (queue.length && pages.length < max) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const r = await fetchWithTimeout(url);
      const status = r.status;
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("text/html")) {
        pages.push({ url, status, html: "", contentType: ct });
        continue;
      }
      const html = await r.text();
      pages.push({ url, status, html, contentType: ct });

      if (pages.length >= max) break;

      const $ = cheerio.load(html);
      const links = new Set();
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        const abs = normaliseUrl(href, url);
        if (abs && sameOrigin(abs, rootUrl) && !visited.has(abs)) links.add(abs);
      });
      for (const l of links) if (!queue.includes(l)) queue.push(l);
    } catch (e) {
      pages.push({ url, status: 0, html: "", error: e.message });
    }
  }
  return pages;
}

async function crawlSite(rootUrl, max = DEFAULT_MAX_PAGES) {
  const sitemapUrls = await discoverFromSitemap(rootUrl);
  if (sitemapUrls.length) {
    const limited = sitemapUrls.slice(0, max);
    const pages = [];
    for (const u of limited) {
      try {
        const r = await fetchWithTimeout(u);
        const ct = r.headers.get("content-type") || "";
        const html = ct.includes("text/html") ? await r.text() : "";
        pages.push({ url: u, status: r.status, html, contentType: ct });
      } catch (e) {
        pages.push({ url: u, status: 0, html: "", error: e.message });
      }
    }
    return { method: "sitemap", pages, sitemapCount: sitemapUrls.length };
  }
  const pages = await bfsCrawl(rootUrl, max);
  return { method: "crawl", pages, sitemapCount: 0 };
}

// ── Per-page analysis ──────────────────────────────────────
function analyzePage(html, url) {
  if (!html) return { url, empty: true };
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const metaDesc = $('meta[name="description"]').attr("content")?.trim() || "";
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const robots = $('meta[name="robots"]').attr("content") || "";
  const viewport = $('meta[name="viewport"]').attr("content") || "";
  const lang = $("html").attr("lang") || "";
  const charset = $('meta[charset]').attr("charset") || $('meta[http-equiv="Content-Type"]').attr("content") || "";

  const h1s = $("h1").map((_, el) => $(el).text().trim()).get();
  const h2s = $("h2").map((_, el) => $(el).text().trim()).get();
  const h3s = $("h3").map((_, el) => $(el).text().trim()).get();

  const og = {};
  $('meta[property^="og:"]').each((_, el) => {
    og[$(el).attr("property")] = $(el).attr("content") || "";
  });
  const twitter = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    twitter[$(el).attr("name")] = $(el).attr("content") || "";
  });

  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      jsonLd.push(parsed);
    } catch {}
  });

  const hreflang = $('link[rel="alternate"][hreflang]').map((_, el) => ({
    hreflang: $(el).attr("hreflang"),
    href: $(el).attr("href"),
  })).get();

  const images = $("img").map((_, el) => ({
    src: $(el).attr("src") || "",
    alt: $(el).attr("alt"),
    hasAlt: $(el).attr("alt") !== undefined,
    altEmpty: ($(el).attr("alt") || "").trim() === "",
  })).get();

  const links = $("a[href]").map((_, el) => {
    const href = $(el).attr("href");
    const abs = normaliseUrl(href, url);
    return {
      href: abs || href,
      text: $(el).text().trim().slice(0, 80),
      internal: abs ? sameOrigin(abs, url) : false,
      nofollow: ($(el).attr("rel") || "").includes("nofollow"),
    };
  }).get();

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  return {
    url,
    title,
    titleLen: title.length,
    metaDesc,
    metaDescLen: metaDesc.length,
    canonical,
    robots,
    viewport,
    lang,
    charset: !!charset,
    h1: h1s,
    h1Count: h1s.length,
    h2Count: h2s.length,
    h3Count: h3s.length,
    og,
    twitter,
    jsonLdCount: jsonLd.length,
    jsonLdTypes: jsonLd.map(j => j["@type"]).filter(Boolean).flat(),
    hreflang,
    imageCount: images.length,
    imagesMissingAlt: images.filter(i => !i.hasAlt).length,
    imagesEmptyAlt: images.filter(i => i.altEmpty).length,
    internalLinks: links.filter(l => l.internal).length,
    externalLinks: links.filter(l => !l.internal).length,
    nofollowLinks: links.filter(l => l.nofollow).length,
    wordCount,
    links,
  };
}

// ── Site-level aggregation ─────────────────────────────────
function aggregateFindings(pages, rootUrl) {
  const findings = {
    technical: [],
    onPage: [],
    content: [],
    structuredData: [],
    mobile: [],
    links: [],
    international: [],
  };
  const sev = (severity, title, detail, affected = []) => ({ severity, title, detail, affected });

  const ok = pages.filter(p => !p.empty && p.url);
  const fail = pages.filter(p => p.status >= 400 || p.status === 0);
  if (fail.length) {
    findings.technical.push(sev("critical", `${fail.length} page(s) returned an error status`,
      "These pages failed to load. Broken pages waste crawl budget and hurt UX.",
      fail.map(p => `${p.url} (${p.status || "error"})`)));
  }

  // Duplicates
  const titleMap = new Map();
  const descMap = new Map();
  for (const p of ok) {
    if (p.title) titleMap.set(p.title, (titleMap.get(p.title) || []).concat(p.url));
    if (p.metaDesc) descMap.set(p.metaDesc, (descMap.get(p.metaDesc) || []).concat(p.url));
  }
  const dupTitles = [...titleMap.entries()].filter(([, urls]) => urls.length > 1);
  const dupDescs = [...descMap.entries()].filter(([, urls]) => urls.length > 1);
  if (dupTitles.length) {
    findings.onPage.push(sev("warning", `${dupTitles.length} duplicate <title> across pages`,
      "Each page should have a unique, descriptive title.",
      dupTitles.flatMap(([t, urls]) => [`"${t.slice(0, 60)}" → ${urls.length} pages`])));
  }
  if (dupDescs.length) {
    findings.onPage.push(sev("warning", `${dupDescs.length} duplicate meta descriptions`,
      "Unique meta descriptions help CTR. Rewrite duplicates with page-specific value.",
      dupDescs.flatMap(([d, urls]) => [`"${d.slice(0, 60)}" → ${urls.length} pages`])));
  }

  // Title/meta length checks
  const noTitle = ok.filter(p => !p.title);
  const longTitle = ok.filter(p => p.titleLen > 65);
  const shortTitle = ok.filter(p => p.title && p.titleLen < 25);
  if (noTitle.length) findings.onPage.push(sev("critical", `${noTitle.length} page(s) missing <title>`,
    "Title is the single most important on-page SEO signal.", noTitle.map(p => p.url)));
  if (longTitle.length) findings.onPage.push(sev("warning", `${longTitle.length} title(s) > 65 chars`,
    "Titles get truncated in SERPs. Keep under 60 chars where possible.",
    longTitle.map(p => `${p.url} (${p.titleLen} chars)`)));
  if (shortTitle.length) findings.onPage.push(sev("info", `${shortTitle.length} title(s) under 25 chars`,
    "Short titles often miss keywords and context.", shortTitle.map(p => p.url)));

  const noDesc = ok.filter(p => !p.metaDesc);
  const longDesc = ok.filter(p => p.metaDescLen > 165);
  if (noDesc.length) findings.onPage.push(sev("warning", `${noDesc.length} page(s) missing meta description`,
    "Without a description Google generates one from page content — usually worse for CTR.",
    noDesc.map(p => p.url)));
  if (longDesc.length) findings.onPage.push(sev("info", `${longDesc.length} description(s) > 165 chars`,
    "Descriptions over 155–165 chars get truncated.", longDesc.map(p => `${p.url} (${p.metaDescLen})`)));

  // Headings
  const noH1 = ok.filter(p => p.h1Count === 0);
  const multiH1 = ok.filter(p => p.h1Count > 1);
  if (noH1.length) findings.onPage.push(sev("warning", `${noH1.length} page(s) without H1`,
    "Every page should have exactly one H1 describing its primary topic.", noH1.map(p => p.url)));
  if (multiH1.length) findings.onPage.push(sev("info", `${multiH1.length} page(s) with multiple H1s`,
    "Multiple H1s split topical focus. Prefer one H1 + H2 sections.",
    multiH1.map(p => `${p.url} (${p.h1Count} H1s)`)));

  // Content thinness
  const thin = ok.filter(p => p.wordCount > 0 && p.wordCount < 300);
  if (thin.length) findings.content.push(sev("warning", `${thin.length} thin-content page(s) (<300 words)`,
    "Thin content often underperforms unless it's a navigational/utility page.",
    thin.map(p => `${p.url} (${p.wordCount} words)`)));

  // Canonical / robots / indexability
  const noCanonical = ok.filter(p => !p.canonical);
  const noindex = ok.filter(p => /noindex/i.test(p.robots || ""));
  if (noCanonical.length) findings.technical.push(sev("info", `${noCanonical.length} page(s) without canonical`,
    "Self-referencing canonicals prevent duplicate-content issues.", noCanonical.map(p => p.url)));
  if (noindex.length) findings.technical.push(sev("warning", `${noindex.length} page(s) with noindex`,
    "Verify these pages should genuinely not be indexed.", noindex.map(p => p.url)));

  // Mobile / viewport
  const noViewport = ok.filter(p => !p.viewport);
  if (noViewport.length) findings.mobile.push(sev("critical", `${noViewport.length} page(s) missing viewport meta`,
    "Without a viewport tag pages render at desktop width on mobile.", noViewport.map(p => p.url)));

  // OG / Twitter
  const noOg = ok.filter(p => !p.og["og:title"] || !p.og["og:image"]);
  if (noOg.length) findings.onPage.push(sev("info", `${noOg.length} page(s) missing Open Graph image or title`,
    "OG tags control how links preview on social. Add og:title, og:description, og:image.",
    noOg.slice(0, 10).map(p => p.url)));

  // Structured data
  const noLd = ok.filter(p => p.jsonLdCount === 0);
  if (noLd.length === ok.length && ok.length > 0) {
    findings.structuredData.push(sev("warning", "No JSON-LD structured data found on any crawled page",
      "Structured data (Organization, WebSite, Article, Product, FAQ) unlocks rich results.",
      []));
  } else if (noLd.length) {
    findings.structuredData.push(sev("info", `${noLd.length} page(s) without structured data`,
      "Add the schema type that matches each page (Article, Product, BreadcrumbList, FAQ).",
      noLd.slice(0, 10).map(p => p.url)));
  }

  // Images
  const totalImgs = ok.reduce((a, p) => a + p.imageCount, 0);
  const missingAlt = ok.reduce((a, p) => a + p.imagesMissingAlt, 0);
  const emptyAlt = ok.reduce((a, p) => a + p.imagesEmptyAlt, 0);
  if (missingAlt > 0) findings.content.push(sev("warning", `${missingAlt} image(s) missing alt attribute`,
    "Alt text is required for accessibility and image SEO. Empty alt is acceptable for purely decorative images.",
    [`${missingAlt}/${totalImgs} images affected`]));
  if (emptyAlt > totalImgs * 0.5 && totalImgs > 5) {
    findings.content.push(sev("info", `${emptyAlt} image(s) with empty alt text`,
      "Decorative images can have alt=\"\" but content images should describe what's shown.", []));
  }

  // Hreflang
  const hasHreflang = ok.some(p => p.hreflang.length > 0);
  const inconsistentHreflang = hasHreflang && ok.some(p => p.hreflang.length === 0);
  if (inconsistentHreflang) {
    findings.international.push(sev("warning", "hreflang declared inconsistently across pages",
      "If you use hreflang, every page in the language set should declare it (with x-default).", []));
  }

  // Internal linking
  const orphans = ok.filter(p => p.internalLinks === 0);
  if (orphans.length && ok.length > 2) {
    findings.links.push(sev("info", `${orphans.length} page(s) with zero outgoing internal links`,
      "Internal linking spreads authority. Even leaf pages should link back to category/related content.",
      orphans.map(p => p.url)));
  }

  // Lang
  const noLang = ok.filter(p => !p.lang);
  if (noLang.length) findings.technical.push(sev("info", `${noLang.length} page(s) missing <html lang="..."> attribute`,
    "Helps search engines and screen readers identify the page language.", noLang.map(p => p.url)));

  return findings;
}

// ── Google PageSpeed Insights ──────────────────────────────
async function pageSpeedAudit(url, apiKey) {
  if (!apiKey) return null;
  const results = {};
  for (const strategy of ["mobile", "desktop"]) {
    try {
      const u = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
      u.searchParams.set("url", url);
      u.searchParams.set("strategy", strategy);
      u.searchParams.set("key", apiKey);
      for (const cat of ["performance", "accessibility", "best-practices", "seo"]) {
        u.searchParams.append("category", cat);
      }
      const r = await fetchWithTimeout(u.toString(), { timeout: 60000 });
      if (!r.ok) {
        results[strategy] = { error: `PSI ${r.status}` };
        continue;
      }
      const data = await r.json();
      const cats = data.lighthouseResult?.categories || {};
      const audits = data.lighthouseResult?.audits || {};
      results[strategy] = {
        scores: {
          performance: cats.performance ? Math.round(cats.performance.score * 100) : null,
          accessibility: cats.accessibility ? Math.round(cats.accessibility.score * 100) : null,
          bestPractices: cats["best-practices"] ? Math.round(cats["best-practices"].score * 100) : null,
          seo: cats.seo ? Math.round(cats.seo.score * 100) : null,
        },
        cwv: {
          lcp: audits["largest-contentful-paint"]?.displayValue || null,
          cls: audits["cumulative-layout-shift"]?.displayValue || null,
          fcp: audits["first-contentful-paint"]?.displayValue || null,
          tbt: audits["total-blocking-time"]?.displayValue || null,
          si: audits["speed-index"]?.displayValue || null,
        },
        opportunities: Object.values(audits)
          .filter(a => a.details?.type === "opportunity" && a.score !== null && a.score < 0.9)
          .map(a => ({
            id: a.id,
            title: a.title,
            description: a.description,
            savings: a.displayValue || null,
          }))
          .slice(0, 8),
      };
    } catch (e) {
      results[strategy] = { error: e.message };
    }
  }
  return results;
}

// ── Strategic review via Claude ────────────────────────────
async function strategicReview(anthropic, { rootUrl, brand, lang, pageStats, findings, psi }) {
  const isNL = lang === "NL";
  const summary = {
    rootUrl,
    pagesCrawled: pageStats.count,
    method: pageStats.method,
    findingsByCategory: Object.fromEntries(
      Object.entries(findings).map(([k, v]) => [k, v.map(f => ({ severity: f.severity, title: f.title }))])
    ),
    psiScores: psi
      ? {
          mobile: psi.mobile?.scores || psi.mobile?.error,
          desktop: psi.desktop?.scores || psi.desktop?.error,
        }
      : null,
  };

  const prompt = isNL
    ? `Je bent een senior SEO-strateeg die een beknopt strategisch oordeel geeft over een crawl-rapport. Brand: ${brand?.company_name || "—"}.

Hier is een samenvatting van wat de scan heeft gevonden voor ${rootUrl}:

\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\`

Geef in het Nederlands:
1. **Overall verdict** (1 alinea): hoe gezond is deze site SEO-technisch?
2. **Top 3 prioriteiten** (genummerd): de drie issues met de hoogste impact:potentie. Geef per prioriteit een concrete actie van max 2 zinnen.
3. **Quick wins** (3-5 bullets): laaghangend fruit dat binnen een uur fixbaar is.
4. **Strategische aanbeveling** (1 alinea): waar zou de volgende SEO-sprint zich op moeten richten?

Geen marketingfluff, geen herhalen van de findings-titels — geef echt advies.`
    : `You are a senior SEO strategist giving a concise strategic verdict on a crawl report. Brand: ${brand?.company_name || "—"}.

Here is a summary of what the scan found for ${rootUrl}:

\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\`

Provide in English:
1. **Overall verdict** (1 paragraph): how SEO-healthy is this site?
2. **Top 3 priorities** (numbered): the three highest impact:effort issues. Each with a concrete action in max 2 sentences.
3. **Quick wins** (3-5 bullets): low-hanging fruit that's fixable within an hour.
4. **Strategic recommendation** (1 paragraph): where should the next SEO sprint focus?

No marketing fluff, no rephrasing of finding titles — give real advice.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// ── Orchestrator ───────────────────────────────────────────
async function runSeoAnalysis(task, deps) {
  const { anthropic, loadBrand } = deps;
  const rootUrl = task.url;
  const maxPages = task.max_pages || DEFAULT_MAX_PAGES;
  const lang = task.language || process.env.LANGUAGE || "EN";
  const brand = loadBrand ? loadBrand() : {};

  const crawl = await crawlSite(rootUrl, maxPages);
  const analysed = crawl.pages.map(p => ({ ...analyzePage(p.html, p.url), status: p.status, error: p.error }));
  const findings = aggregateFindings(analysed, rootUrl);

  let psi = null;
  if (process.env.PSI_API_KEY) {
    psi = await pageSpeedAudit(rootUrl, process.env.PSI_API_KEY);
  }

  const strategic = await strategicReview(anthropic, {
    rootUrl, brand, lang,
    pageStats: { count: analysed.length, method: crawl.method },
    findings, psi,
  });

  // Overall score: weighted by severity counts
  const allFindings = Object.values(findings).flat();
  const critical = allFindings.filter(f => f.severity === "critical").length;
  const warning = allFindings.filter(f => f.severity === "warning").length;
  const info = allFindings.filter(f => f.severity === "info").length;
  const deduction = critical * 12 + warning * 5 + info * 1;
  const score = Math.max(0, Math.min(100, 100 - deduction));

  return {
    url: rootUrl,
    pagesCrawled: analysed.length,
    crawlMethod: crawl.method,
    sitemapCount: crawl.sitemapCount,
    score,
    counts: { critical, warning, info },
    findings,
    psi,
    strategic,
    pages: analysed.map(p => ({
      url: p.url,
      title: p.title,
      titleLen: p.titleLen,
      metaDescLen: p.metaDescLen,
      h1Count: p.h1Count,
      wordCount: p.wordCount,
      status: p.status,
    })),
  };
}

module.exports = {
  crawlSite,
  analyzePage,
  aggregateFindings,
  pageSpeedAudit,
  strategicReview,
  runSeoAnalysis,
};
