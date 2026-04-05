const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const OUTPUT_DIR = path.join(__dirname, "data", "generated-images");
const BRAND_ASSETS_DIR = path.join(__dirname, "data", "brand-assets");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Load brand logo as base64 data URI
function getBrandLogo(brand) {
  if (!brand) return null;
  const brandDir = path.join(BRAND_ASSETS_DIR, brand.toUpperCase());
  if (!fs.existsSync(brandDir)) return null;
  const files = fs.readdirSync(brandDir);
  const logoFile = files.find(f => f.startsWith("logo"));
  if (!logoFile) return null;
  const ext = path.extname(logoFile).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".svg" ? "image/svg+xml" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const data = fs.readFileSync(path.join(brandDir, logoFile));
  return `data:${mime};base64,${data.toString("base64")}`;
}

function getBrandWatermark(brand) {
  if (!brand) return null;
  const brandDir = path.join(BRAND_ASSETS_DIR, brand.toUpperCase());
  if (!fs.existsSync(brandDir)) return null;
  const files = fs.readdirSync(brandDir);
  const wmFile = files.find(f => f.startsWith("watermark"));
  if (!wmFile) return null;
  const ext = path.extname(wmFile).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".svg" ? "image/svg+xml" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const data = fs.readFileSync(path.join(brandDir, wmFile));
  return `data:${mime};base64,${data.toString("base64")}`;
}

// ── LAYOUT TEMPLATES ──
const TEMPLATES_FILE = path.join(__dirname, "data", "slide-templates.json");
function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, "utf8")); } catch { return {}; }
}
function getTemplate(name) {
  const templates = loadTemplates();
  return templates[name] || templates["default"] || {};
}

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

// ── DESIGN TYPE DIMENSIONS ──
const DIMENSIONS = {
  instagram_post:   { width: 1080, height: 1350 },
  your_story:       { width: 1080, height: 1920 },
  youtube_thumbnail: { width: 1280, height: 720 },
  youtube_banner:   { width: 2560, height: 1440 },
  twitter_post:     { width: 1200, height: 675 },
  facebook_post:    { width: 1200, height: 630 },
  infographic:      { width: 1080, height: 1920 },
  poster:           { width: 1080, height: 1350 },
  presentation:     { width: 1920, height: 1080 },
  logo:             { width: 1080, height: 1080 },
};

function getDimensions(designType) {
  return DIMENSIONS[designType] || DIMENSIONS.instagram_post;
}

// ── THEME PRESETS ──
const THEMES = {
  blockchain: {
    elements: ["hexgrid", "nodes", "connections"],
    glowStrength: 1.0,
    gridOpacity: 0.06,
    scanlines: false,
  },
  cyberpunk: {
    elements: ["circuits", "scanlines", "nodes", "glitch"],
    glowStrength: 1.4,
    gridOpacity: 0.08,
    scanlines: true,
  },
  minimal: {
    elements: [],
    glowStrength: 0.4,
    gridOpacity: 0,
    scanlines: false,
  },
  finance: {
    elements: ["candlesticks", "gridlines", "nodes"],
    glowStrength: 0.8,
    gridOpacity: 0.05,
    scanlines: false,
  },
  neon: {
    elements: ["nodes", "connections", "hexgrid", "circuits"],
    glowStrength: 2.0,
    gridOpacity: 0.10,
    scanlines: true,
  },
  clean: {
    elements: [],
    glowStrength: 0.2,
    gridOpacity: 0,
    scanlines: false,
  },
  default: {
    elements: ["nodes", "connections", "hexgrid", "circuits"],
    glowStrength: 1.0,
    gridOpacity: 0.06,
    scanlines: true,
  },
};

// Intensity multipliers
const INTENSITIES = { subtle: 0.5, normal: 1.0, bold: 1.6, intense: 2.2 };

// ── STYLE KEYWORD PARSER ──
function parseStyleKeywords(description) {
  const lower = (description || "").toLowerCase();

  // Detect theme
  let theme = "default";
  for (const t of Object.keys(THEMES)) {
    if (t !== "default" && lower.includes(t)) { theme = t; break; }
  }

  // Detect intensity
  let intensity = "normal";
  for (const i of Object.keys(INTENSITIES)) {
    if (lower.includes(i)) { intensity = i; break; }
  }

  // Detect custom primary color overrides
  let primary = null;
  if (lower.includes("blauw") || lower.includes("blue")) primary = "#3B82F6";
  if (lower.includes("groen") || lower.includes("green")) primary = "#22C55E";
  if (lower.includes("rood") || lower.includes("red")) primary = "#EF4444";
  if (lower.includes("oranje") || lower.includes("orange")) primary = "#F97316";
  if (lower.includes("goud") || lower.includes("gold")) primary = "#EAB308";
  if (lower.includes("cyan") || lower.includes("teal")) primary = "#06B6D4";
  if (lower.includes("roze") || lower.includes("pink")) primary = "#EC4899";

  return { theme, intensity, primaryOverride: primary };
}

// ── SVG ELEMENT GENERATORS ──
function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 16807 + 0) % 2147483647; return s / 2147483647; };
}

function generateNodes(seed, count, mult, w = 1080, h = 1080) {
  const rng = seededRandom(seed);
  return Array.from({ length: count }, () => ({
    x: rng() * w,
    y: rng() * h,
    size: 1.5 + rng() * 4,
    opacity: (0.12 + rng() * 0.2) * mult,
  }));
}

function generateConnections(nodes, maxDist, maxCount, mult) {
  const lines = [];
  for (let i = 0; i < nodes.length && lines.length < maxCount; i++) {
    for (let j = i + 1; j < nodes.length && lines.length < maxCount; j++) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < maxDist) {
        lines.push({
          x1: nodes[i].x, y1: nodes[i].y,
          x2: nodes[j].x, y2: nodes[j].y,
          opacity: (0.06 + (1 - dist / maxDist) * 0.1) * mult,
        });
      }
    }
  }
  return lines;
}

function generateHexGrid(seed, count, mult, w = 1080, h = 1080) {
  const rng = seededRandom(seed + 5000);
  return Array.from({ length: count }, () => {
    const x = rng() * w;
    const y = rng() * h;
    const size = 25 + rng() * 50;
    const rotation = rng() * 360;
    const opacity = (0.06 + rng() * 0.12) * mult;
    const pts = Array.from({ length: 6 }, (_, i) => {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      return `${x + size * Math.cos(angle)},${y + size * Math.sin(angle)}`;
    }).join(" ");
    return { pts, x, y, rotation, opacity };
  });
}

function generateCircuits(seed, count, mult, w = 1080, h = 1080) {
  const rng = seededRandom(seed + 9000);
  return Array.from({ length: count }, () => {
    const x = rng() * w;
    const y = rng() * h;
    const len = 50 + rng() * 140;
    const horizontal = rng() > 0.5;
    const x2 = horizontal ? x + len : x;
    const y2 = horizontal ? y : y + len;
    const opacity = (0.08 + rng() * 0.12) * mult;
    const hasNode = rng() > 0.6;
    // Optionally add a 90-degree turn
    const hasTurn = rng() > 0.5;
    const turnLen = 30 + rng() * 60;
    const tx = horizontal ? x2 : x2 + (rng() > 0.5 ? turnLen : -turnLen);
    const ty = horizontal ? y2 + (rng() > 0.5 ? turnLen : -turnLen) : y2;
    return { x1: x, y1: y, x2, y2, tx, ty, opacity, hasNode, hasTurn };
  });
}

function generateCandlesticks(seed, count, mult, w = 1080, h = 1080) {
  const rng = seededRandom(seed + 7000);
  return Array.from({ length: count }, () => {
    const x = rng() * w;
    const baseY = 400 + rng() * 500;
    const height = 30 + rng() * 120;
    const bodyH = 15 + rng() * 50;
    const isGreen = rng() > 0.45;
    const opacity = (0.06 + rng() * 0.10) * mult;
    return { x, y: baseY - height, height, bodyH, isGreen, opacity };
  });
}

function generateGlitch(seed, count, mult, w = 1080, h = 1080) {
  const rng = seededRandom(seed + 3000);
  return Array.from({ length: count }, () => ({
    x: rng() * w,
    y: rng() * h,
    w: 40 + rng() * 200,
    h: 1 + rng() * 3,
    opacity: (0.03 + rng() * 0.06) * mult,
    offsetX: (rng() - 0.5) * 8,
  }));
}

// ── BUILD SVG BACKGROUND ──
function buildBackgroundSVG(seed, theme, mult, primary, primaryGlow, w = 1080, h = 1080) {
  const conf = THEMES[theme] || THEMES.default;
  const elements = conf.elements;
  let svg = "";

  // Nodes
  const nodes = elements.includes("nodes") ? generateNodes(seed, 22, mult, w, h) : [];
  if (nodes.length) {
    svg += nodes.map(n =>
      `<circle cx="${n.x}" cy="${n.y}" r="${n.size}" fill="${primary}" opacity="${n.opacity}">
        ${mult > 1.2 ? `<animate attributeName="opacity" values="${n.opacity};${n.opacity * 0.5};${n.opacity}" dur="${3 + n.size}s" repeatCount="indefinite"/>` : ""}
      </circle>`
    ).join("\n");
    // Glow on larger nodes
    svg += nodes.filter(n => n.size > 3.5).map(n =>
      `<circle cx="${n.x}" cy="${n.y}" r="${n.size * 3}" fill="${primary}" opacity="${n.opacity * 0.2}" filter="url(#blur)"/>`
    ).join("\n");
  }

  // Connections
  if (elements.includes("connections") && nodes.length) {
    const conns = generateConnections(nodes, 300, 18, mult);
    svg += conns.map(l =>
      `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="${primary}" stroke-width="0.7" opacity="${l.opacity}" stroke-dasharray="${mult > 1.5 ? '' : '4 4'}"/>`
    ).join("\n");
  }

  // Hex grid
  if (elements.includes("hexgrid")) {
    const hexes = generateHexGrid(seed, 8, mult, w, h);
    svg += hexes.map(h =>
      `<polygon points="${h.pts}" fill="none" stroke="${primary}" stroke-width="0.6" opacity="${h.opacity}" transform="rotate(${h.rotation} ${h.x} ${h.y})"/>`
    ).join("\n");
  }

  // Circuits
  if (elements.includes("circuits")) {
    const circs = generateCircuits(seed, 10, mult, w, h);
    svg += circs.map(c => `
      <line x1="${c.x1}" y1="${c.y1}" x2="${c.x2}" y2="${c.y2}" stroke="${primaryGlow}" stroke-width="0.6" opacity="${c.opacity}"/>
      ${c.hasTurn ? `<line x1="${c.x2}" y1="${c.y2}" x2="${c.tx}" y2="${c.ty}" stroke="${primaryGlow}" stroke-width="0.6" opacity="${c.opacity * 0.8}"/>` : ""}
      ${c.hasNode ? `<rect x="${c.x2 - 3}" y="${c.y2 - 3}" width="6" height="6" fill="${primary}" opacity="${c.opacity * 1.2}" rx="1"/>` : ""}
    `).join("\n");
  }

  // Candlesticks
  if (elements.includes("candlesticks")) {
    const candles = generateCandlesticks(seed, 20, mult, w, h);
    svg += candles.map(c => {
      const color = c.isGreen ? "#22C55E" : "#EF4444";
      return `
        <line x1="${c.x}" y1="${c.y}" x2="${c.x}" y2="${c.y + c.height}" stroke="${color}" stroke-width="1" opacity="${c.opacity * 0.6}"/>
        <rect x="${c.x - 4}" y="${c.y + (c.height - c.bodyH) / 2}" width="8" height="${c.bodyH}" fill="${color}" opacity="${c.opacity}" rx="1"/>
      `;
    }).join("\n");
    // Add a subtle chart line
    const rng = seededRandom(seed + 7500);
    const points = Array.from({ length: 20 }, (_, i) => `${i * (w / 19)},${h * 0.45 + (rng() - 0.5) * h * 0.2}`).join(" ");
    svg += `<polyline points="${points}" fill="none" stroke="${primary}" stroke-width="1" opacity="${0.08 * mult}"/>`;
  }

  // Gridlines (for finance)
  if (elements.includes("gridlines")) {
    for (let y = h * 0.2; y < h * 0.85; y += h * 0.1) {
      svg += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${primary}" stroke-width="0.3" opacity="${0.04 * mult}" stroke-dasharray="6 6"/>`;
    }
  }

  // Glitch
  if (elements.includes("glitch")) {
    const glitches = generateGlitch(seed, 12, mult, w, h);
    svg += glitches.map(g =>
      `<rect x="${g.x + g.offsetX}" y="${g.y}" width="${g.w}" height="${g.h}" fill="${primary}" opacity="${g.opacity}"/>`
    ).join("\n");
  }

  return svg;
}

// ── MAIN HTML BUILDER ──
function buildSlideHTML(slide) {
  const {
    text = "",
    title = "",
    slideNumber = "",
    totalSlides = "",
    style = {},
    designType = "instagram_post",
    template: templateName = "default",
  } = slide;

  const dim = getDimensions(designType);
  const tpl = getTemplate(templateName);

  const keywords = parseStyleKeywords(style.mood || "");
  const themeConf = THEMES[keywords.theme] || THEMES.default;
  const mult = INTENSITIES[keywords.intensity] || 1.0;
  const glowMult = themeConf.glowStrength * mult;

  const primary = keywords.primaryOverride || style.primary || "#7C3AED";
  const primaryGlow = style.primaryGlow || lightenColor(primary, 30);
  const textColor = style.textColor || "#F8FAFC";
  const textDimColor = textColor + "bb";
  const brandName = style.brand || "";
  const brandLogo = getBrandLogo(brandName);
  const brandWatermark = getBrandWatermark(brandName);
  const fontUrl = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap";

  // Template color resolver
  function tplColor(c) {
    if (!c || c === "text") return textColor;
    if (c === "text-dim") return textDimColor;
    if (c === "primary") return primaryGlow;
    if (c.startsWith("#")) return c;
    return textColor;
  }

  // Template values with fallbacks
  const tTitle = tpl.title || {};
  const tSubtitle = tpl.subtitle || {};
  const tBody = tpl.body || {};
  const tBodyLg = tpl.bodyLarge || {};
  const tBullet = tpl.bullet || {};
  const tQuote = tpl.quote || {};
  const tPad = tpl.padding || {};

  // Bullet marker styles
  const markerStyle = tBullet.markerStyle || "square";
  const markerCSS = markerStyle === "circle"
    ? `border-radius: 50%;`
    : markerStyle === "dash"
    ? `border-radius: 1px; width: ${tBullet.markerSize || 10}px !important; height: 2px !important;`
    : `border-radius: 2px;`;

  // Layout detection
  const isQuoteSlide = text.includes('"') || text.includes('\u201C');
  const isBulletSlide = text.includes("\n-") || text.includes("\n\u2022");
  const isShortText = text.length < 120;

  // Parse body
  let bodyHTML = "";
  if (isBulletSlide) {
    const lines = text.split("\n").filter(l => l.trim());
    const titleLine = lines[0] && !lines[0].startsWith("-") ? lines.shift() : "";
    bodyHTML = `
      ${titleLine ? `<div class="slide-subtitle">${escapeHtml(titleLine)}</div>` : ""}
      <div class="bullets">
        ${lines.map(l => `<div class="bullet">${escapeHtml(l.replace(/^[-•]\s*/, ""))}</div>`).join("")}
      </div>`;
  } else if (isQuoteSlide) {
    bodyHTML = `<div class="quote-text">${escapeHtml(text)}</div>`;
  } else {
    bodyHTML = `<div class="body-text ${isShortText ? 'large' : ''}">${escapeHtml(text)}</div>`;
  }

  const seed = (parseInt(slideNumber) || 1) * 137;
  const bgSVG = buildBackgroundSVG(seed, keywords.theme, mult, primary, primaryGlow, dim.width, dim.height);
  const gridOp = themeConf.gridOpacity * mult;

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<link href="${fontUrl}" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: ${dim.width}px; height: ${dim.height}px;
    background: #050508;
    font-family: 'Inter', -apple-system, sans-serif;
    color: ${textColor};
    overflow: hidden;
    position: relative;
  }

  .bg-gradient {
    position: absolute; inset: 0; z-index: 0;
    background:
      radial-gradient(ellipse 80% 60% at 18% 12%, ${primary}${hex(0.19 * glowMult)} 0%, transparent 55%),
      radial-gradient(ellipse 60% 50% at 82% 88%, ${primary}${hex(0.13 * glowMult)} 0%, transparent 50%),
      radial-gradient(ellipse 45% 40% at 50% 50%, ${primary}${hex(0.08 * glowMult)} 0%, transparent 40%),
      radial-gradient(circle at 10% 90%, #0a0a1a 0%, transparent 40%),
      radial-gradient(circle at 90% 10%, #0a0a18 0%, transparent 40%);
  }

  .bg-network { position: absolute; inset: 0; z-index: 1; }

  ${gridOp > 0 ? `.bg-grid {
    position: absolute; inset: 0; z-index: 2;
    background-image:
      linear-gradient(${primary}${hex(gridOp)} 1px, transparent 1px),
      linear-gradient(90deg, ${primary}${hex(gridOp * 0.8)} 1px, transparent 1px);
    background-size: 54px 54px;
    mask-image: radial-gradient(ellipse 70% 70% at 50% 50%, black 20%, transparent 70%);
    -webkit-mask-image: radial-gradient(ellipse 70% 70% at 50% 50%, black 20%, transparent 70%);
  }` : ""}

  ${themeConf.scanlines ? `.bg-scanlines {
    position: absolute; inset: 0; z-index: 3;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px);
    pointer-events: none;
  }` : ""}

  .bg-noise {
    position: absolute; inset: 0; z-index: 3;
    opacity: ${(0.03 * mult).toFixed(3)};
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 256px 256px;
  }

  .bg-vignette {
    position: absolute; inset: 0; z-index: 4;
    background: radial-gradient(ellipse 75% 75% at 50% 50%, transparent 50%, rgba(0,0,0,${(0.5 + 0.1 * mult).toFixed(2)}) 100%);
  }

  .glow-orb { position: absolute; z-index: 1; border-radius: 50%; }
  .glow-orb-1 { width: 420px; height: 420px; top: -100px; right: -80px; background: radial-gradient(circle, ${primary}${hex(0.16 * glowMult)} 0%, transparent 60%); filter: blur(40px); }
  .glow-orb-2 { width: 360px; height: 360px; bottom: -60px; left: -40px; background: radial-gradient(circle, ${primary}${hex(0.12 * glowMult)} 0%, transparent 60%); filter: blur(50px); }
  .glow-orb-3 { width: 220px; height: 220px; top: 38%; left: 58%; background: radial-gradient(circle, ${primaryGlow}${hex(0.10 * glowMult)} 0%, transparent 60%); filter: blur(30px); }

  .container {
    position: relative; z-index: 10;
    width: 100%; height: 100%;
    padding: ${tPad.top || 80}px ${tPad.sides || 72}px ${tPad.bottom || 80}px;
    display: flex; flex-direction: column;
    justify-content: center;
  }

  .top-bar {
    position: absolute; top: 48px; left: 72px; right: 72px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .slide-num {
    font-size: 12px; font-weight: 700; letter-spacing: 0.2em;
    color: ${primaryGlow};
    padding: 4px 12px;
    border: 1px solid ${primary}30;
    border-radius: 4px;
    background: ${primary}08;
    font-variant-numeric: tabular-nums;
  }
  .brand-tag {
    font-size: 10px; font-weight: 600; letter-spacing: 0.25em;
    color: ${primaryGlow}70; text-transform: uppercase;
  }
  .brand-logo { height: 28px; width: auto; opacity: 0.85; }
  .watermark {
    position: absolute; z-index: 5;
    bottom: 48px; right: 48px;
    opacity: 0.06; pointer-events: none;
  }
  .watermark img { max-width: 240px; max-height: 240px; }

  .slide-title {
    font-size: ${tTitle.fontSize || 52}px; font-weight: ${tTitle.fontWeight || 800};
    letter-spacing: ${tTitle.letterSpacing || "0.02em"};
    color: ${tplColor(tTitle.color)};
    text-transform: ${tTitle.textTransform || "none"};
    margin-bottom: ${tTitle.marginBottom || 32}px;
    line-height: ${tTitle.lineHeight || 1.2};
    text-shadow: 0 0 30px ${primary}40;
  }
  .slide-subtitle {
    font-size: ${tSubtitle.fontSize || 17}px; font-weight: ${tSubtitle.fontWeight || 700};
    letter-spacing: ${tSubtitle.letterSpacing || "0.14em"};
    color: ${tplColor(tSubtitle.color)};
    text-transform: ${tSubtitle.textTransform || "uppercase"};
    margin-bottom: ${tSubtitle.marginBottom || 28}px;
    line-height: ${tSubtitle.lineHeight || 1.3};
    text-shadow: 0 0 30px ${primary}40;
  }
  .body-text {
    font-size: ${tBody.fontSize || 32}px; font-weight: ${tBody.fontWeight || 400};
    line-height: ${tBody.lineHeight || 1.6};
    color: ${tplColor(tBody.color)}; max-width: 920px;
    text-shadow: 0 2px 20px rgba(0,0,0,0.5);
  }
  .body-text.large {
    font-size: ${tBodyLg.fontSize || 44}px;
    font-weight: ${tBodyLg.fontWeight || 500};
    line-height: ${tBodyLg.lineHeight || 1.35};
  }
  .quote-text {
    font-size: ${tQuote.fontSize || 36}px; font-weight: ${tQuote.fontWeight || 500};
    line-height: ${tQuote.lineHeight || 1.45};
    color: ${tplColor(tQuote.color || "text")}; max-width: 860px;
    font-style: ${tQuote.fontStyle || "italic"};
    ${tQuote.borderLeft !== false ? `border-left: ${tQuote.borderWidth || 3}px solid ${tplColor(tQuote.borderColor || "primary")}; padding-left: 28px;` : ""}
    text-shadow: 0 2px 20px rgba(0,0,0,0.5);
  }
  .bullets { display: flex; flex-direction: column; gap: ${tBullet.gap || 20}px; }
  .bullet {
    font-size: ${tBullet.fontSize || 28}px; font-weight: ${tBullet.fontWeight || 400};
    line-height: ${tBullet.lineHeight || 1.5};
    color: ${tplColor(tBullet.color || "text")}dd; padding-left: 28px; position: relative;
    text-shadow: 0 2px 16px rgba(0,0,0,0.4);
  }
  .bullet::before {
    content: ''; position: absolute; left: 0; top: 10px;
    width: ${markerStyle === "dash" ? (tBullet.markerSize || 10) : (tBullet.markerSize || 10)}px;
    height: ${markerStyle === "dash" ? 2 : (tBullet.markerSize || 10)}px;
    background: ${tplColor(tBullet.markerColor || "primary")};
    ${markerCSS} box-shadow: 0 0 8px ${primary}80;
  }

  .bottom-bar {
    position: absolute; bottom: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, transparent 5%, ${primary}60 20%, ${primaryGlow} 50%, ${primary}60 80%, transparent 95%);
    box-shadow: 0 0 20px ${primary}40, 0 0 60px ${primary}15;
  }
  .top-line {
    position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg, transparent, ${primary}20, transparent);
  }
  .corner { position: absolute; z-index: 12; }
  .corner-tl { top: 24px; left: 24px; }
  .corner-tr { top: 24px; right: 24px; transform: scaleX(-1); }
  .corner-bl { bottom: 24px; left: 24px; transform: scaleY(-1); }
  .corner-br { bottom: 24px; right: 24px; transform: scale(-1); }
  .corner svg { display: block; }
</style>
</head>
<body>
  <div class="bg-gradient"></div>
  <svg class="bg-network" viewBox="0 0 ${dim.width} ${dim.height}" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="blur"><feGaussianBlur stdDeviation="6"/></filter></defs>
    ${bgSVG}
  </svg>
  ${gridOp > 0 ? '<div class="bg-grid"></div>' : ""}
  ${themeConf.scanlines ? '<div class="bg-scanlines"></div>' : ""}
  <div class="bg-noise"></div>
  <div class="bg-vignette"></div>

  <div class="glow-orb glow-orb-1"></div>
  <div class="glow-orb glow-orb-2"></div>
  <div class="glow-orb glow-orb-3"></div>

  <div class="top-line"></div>

  <div class="corner corner-tl"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M0 12V0h12" stroke="${primary}" stroke-width="1.2" opacity="0.4"/><path d="M0 8V0h8" stroke="${primary}" stroke-width="0.6" opacity="0.2"/></svg></div>
  <div class="corner corner-tr"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M0 12V0h12" stroke="${primary}" stroke-width="1.2" opacity="0.4"/><path d="M0 8V0h8" stroke="${primary}" stroke-width="0.6" opacity="0.2"/></svg></div>
  <div class="corner corner-bl"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M0 12V0h12" stroke="${primary}" stroke-width="1.2" opacity="0.4"/><path d="M0 8V0h8" stroke="${primary}" stroke-width="0.6" opacity="0.2"/></svg></div>
  <div class="corner corner-br"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M0 12V0h12" stroke="${primary}" stroke-width="1.2" opacity="0.4"/><path d="M0 8V0h8" stroke="${primary}" stroke-width="0.6" opacity="0.2"/></svg></div>

  <div class="container">
    <div class="top-bar">
      <span class="slide-num">${slideNumber && totalSlides ? `${String(slideNumber).padStart(2, "0")} / ${String(totalSlides).padStart(2, "0")}` : ""}</span>
      ${brandLogo
        ? `<img class="brand-logo" src="${brandLogo}" alt="${escapeHtml(brandName)}" />`
        : `<span class="brand-tag">${escapeHtml(brandName)}</span>`
      }
    </div>
    ${title ? `<div class="slide-title">${escapeHtml(title)}</div>` : ""}
    ${bodyHTML}
  </div>

  ${brandWatermark ? `<div class="watermark"><img src="${brandWatermark}" /></div>` : ""}

  <div class="bottom-bar"></div>
</body></html>`;
}

// ── AI-POWERED SLIDE BUILDER ──
function buildAISlideHTML(slide, aiDesign) {
  const {
    slideNumber = "",
    totalSlides = "",
    style = {},
    designType = "instagram_post",
  } = slide;

  const dim = getDimensions(designType);
  const d = aiDesign;

  // Theme from AI or fallback
  const theme = d.theme || "default";
  const intensity = d.intensity || "normal";
  const themeConf = THEMES[theme] || THEMES.default;
  const mult = INTENSITIES[intensity] || 1.0;
  const glowMult = themeConf.glowStrength * mult;

  const brandColors = style.brandColors || [];
  const brandFonts = style.brandFonts || [];
  const primaryBrandColor = brandColors.find(c => /primary|hoofd/i.test(c.label));
  const accentBrandColor = brandColors.find(c => /accent|secondary|secundair/i.test(c.label));
  const primary = d.colorOverride || (primaryBrandColor ? primaryBrandColor.hex : null) || style.primary || "#7C3AED";
  const primaryGlow = lightenColor(primary, 30);
  const textColor = style.textColor || "#F8FAFC";
  const brandName = style.brand || "";
  const brandLogo = getBrandLogo(brandName);
  const brandWatermark = getBrandWatermark(brandName);
  const displayFont = brandFonts.find(f => f.role === "display");
  const bodyFont = brandFonts.find(f => f.role === "body");
  const allFontFamilies = [...new Set([
    "Inter",
    ...(brandFonts.map(f => f.family)),
  ])];
  const fontUrl = `https://fonts.googleapis.com/css2?${allFontFamilies.map(f => `family=${f.replace(/ /g, '+')}:wght@300;400;500;600;700;800;900`).join('&')}&display=swap`;

  const bodyFontSize = Math.max(d.bodyFontSize || 40, 28);
  const titleSize = d.titleSize || 17;
  const textAlign = d.textAlign || "left";
  const verticalAlign = d.verticalAlign || "center";
  const hasDivider = d.dividerAfterTitle !== false && d.title;

  // Build body HTML from bodyParts
  let bodyHTML = "";
  const parts = d.bodyParts || [];
  const layout = d.layout || "hero";

  if (layout === "bullets") {
    const titlePart = parts.find(p => p.style === "bold" || p.style === "large");
    const bulletParts = parts.filter(p => p !== titlePart);
    bodyHTML = `
      ${titlePart ? `<div class="ai-subtitle">${formatPart(titlePart, primary)}</div>` : ""}
      <div class="ai-bullets">
        ${bulletParts.map(p => `<div class="ai-bullet">${formatPart(p, primary)}</div>`).join("")}
      </div>`;
  } else if (layout === "quote") {
    bodyHTML = `<div class="ai-quote">${parts.map(p => formatPart(p, primary)).join("<br/>")}</div>`;
  } else if (layout === "stats") {
    bodyHTML = `<div class="ai-stats">${parts.map(p =>
      `<div class="ai-stat-line ${p.style === "large" || p.style === "highlight" ? "ai-stat-big" : ""}">${formatPart(p, primary)}</div>`
    ).join("")}</div>`;
  } else if (layout === "cta") {
    bodyHTML = `<div class="ai-cta">${parts.map(p => `<div class="ai-cta-line">${formatPart(p, primary)}</div>`).join("")}</div>`;
  } else {
    // hero / split / default
    bodyHTML = `<div class="ai-body">${parts.map(p => `<span class="ai-part ai-part-${p.style || "normal"}">${formatPart(p, primary)}</span> `).join("")}</div>`;
  }

  // Glow position
  const glowPos = d.accentGlow || "top-left";
  const glowPositions = {
    "top-left": "top: -100px; left: -80px;",
    "top-right": "top: -100px; right: -80px;",
    "bottom-left": "bottom: -60px; left: -40px;",
    "bottom-right": "bottom: -60px; right: -40px;",
    "center": "top: 30%; left: 35%;",
    "spread": "top: 20%; left: 20%; width: 600px; height: 600px;",
  };

  const justifyMap = { center: "center", top: "flex-start", bottom: "flex-end" };
  const seed = (parseInt(slideNumber) || 1) * 137;
  const bgSVG = buildBackgroundSVG(seed, theme, mult, primary, primaryGlow, dim.width, dim.height);
  const gridOp = themeConf.gridOpacity * mult;

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<link href="${fontUrl}" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: ${dim.width}px; height: ${dim.height}px;
    background: #050508;
    font-family: '${bodyFont ? bodyFont.family : 'Inter'}', 'Inter', -apple-system, sans-serif;
    color: ${textColor};
    overflow: hidden;
    position: relative;
  }

  .ai-title, .brand-top { font-family: '${displayFont ? displayFont.family : (bodyFont ? bodyFont.family : 'Inter')}', 'Inter', sans-serif; }

  .bg-gradient {
    position: absolute; inset: 0; z-index: 0;
    background:
      radial-gradient(ellipse 80% 60% at 20% 15%, ${primary}${hex(0.19 * glowMult)} 0%, transparent 55%),
      radial-gradient(ellipse 60% 50% at 82% 88%, ${primary}${hex(0.13 * glowMult)} 0%, transparent 50%),
      radial-gradient(ellipse 45% 40% at 50% 50%, ${primary}${hex(0.08 * glowMult)} 0%, transparent 40%);
  }
  .bg-network { position: absolute; inset: 0; z-index: 1; }
  ${gridOp > 0 ? `.bg-grid {
    position: absolute; inset: 0; z-index: 2;
    background-image: linear-gradient(${primary}${hex(gridOp)} 1px, transparent 1px), linear-gradient(90deg, ${primary}${hex(gridOp * 0.8)} 1px, transparent 1px);
    background-size: 54px 54px;
    mask-image: radial-gradient(ellipse 70% 70% at 50% 50%, black 20%, transparent 70%);
    -webkit-mask-image: radial-gradient(ellipse 70% 70% at 50% 50%, black 20%, transparent 70%);
  }` : ""}
  ${themeConf.scanlines ? `.bg-scanlines { position: absolute; inset: 0; z-index: 3; background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px); pointer-events: none; }` : ""}
  .bg-noise { position: absolute; inset: 0; z-index: 3; opacity: ${(0.03 * mult).toFixed(3)}; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); background-size: 256px 256px; }
  .bg-vignette { position: absolute; inset: 0; z-index: 4; background: radial-gradient(ellipse 75% 75% at 50% 50%, transparent 50%, rgba(0,0,0,${(0.5 + 0.1 * mult).toFixed(2)}) 100%); }

  .glow-main {
    position: absolute; z-index: 1; width: 420px; height: 420px;
    ${glowPositions[glowPos] || glowPositions["top-left"]}
    background: radial-gradient(circle, ${primary}${hex(0.18 * glowMult)} 0%, transparent 60%);
    border-radius: 50%; filter: blur(40px);
  }
  .glow-secondary {
    position: absolute; z-index: 1; width: 300px; height: 300px;
    ${glowPositions[glowPos === "top-left" ? "bottom-right" : "top-left"] || "bottom: -60px; right: -40px;"}
    background: radial-gradient(circle, ${primary}${hex(0.10 * glowMult)} 0%, transparent 60%);
    border-radius: 50%; filter: blur(50px);
  }

  .container {
    position: relative; z-index: 10;
    width: 100%; height: 100%;
    padding: 80px 72px;
    display: flex; flex-direction: column;
    justify-content: ${justifyMap[verticalAlign] || "center"};
    text-align: ${textAlign};
  }

  .top-bar {
    position: absolute; top: 48px; left: 72px; right: 72px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .slide-num {
    font-size: 12px; font-weight: 700; letter-spacing: 0.2em;
    color: ${primaryGlow}; padding: 4px 12px;
    border: 1px solid ${primary}30; border-radius: 4px;
    background: ${primary}08; font-variant-numeric: tabular-nums;
  }
  .brand-tag { font-size: 10px; font-weight: 600; letter-spacing: 0.25em; color: ${primaryGlow}70; text-transform: uppercase; }
  .brand-logo { height: 28px; width: auto; opacity: 0.85; }

  /* Title */
  .ai-title {
    font-size: ${titleSize}px; font-weight: 700; letter-spacing: 0.14em;
    color: ${primaryGlow}; text-transform: uppercase;
    margin-bottom: ${hasDivider ? "20" : "28"}px; line-height: 1.3;
    text-shadow: 0 0 30px ${primary}40;
  }
  .ai-divider {
    width: 60px; height: 2px; margin-bottom: 24px;
    background: linear-gradient(90deg, ${primary}, transparent);
    ${textAlign === "center" ? "margin-left: auto; margin-right: auto;" : ""}
  }

  /* Hero body */
  .ai-body {
    font-size: ${bodyFontSize}px; font-weight: ${bodyFontSize > 34 ? 600 : 500};
    line-height: ${bodyFontSize > 34 ? 1.3 : 1.55};
    color: ${textColor}; max-width: 95%;
    text-shadow: 0 2px 20px rgba(0,0,0,0.5);
  }

  /* Parts styling */
  .ai-part-normal { }
  .ai-part-bold { font-weight: 700; }
  .ai-part-highlight { color: ${primaryGlow}; font-weight: 600; text-shadow: 0 0 20px ${primary}50; }
  .ai-part-dim { color: ${textColor}90; font-weight: 400; }
  .ai-part-large { font-size: ${Math.round(bodyFontSize * 1.3)}px; font-weight: 700; display: block; margin-bottom: 8px; }

  /* Subtitle */
  .ai-subtitle {
    font-size: ${Math.round(bodyFontSize * 0.95)}px; font-weight: 700;
    color: ${textColor}; margin-bottom: 22px; line-height: 1.3;
  }

  /* Bullets */
  .ai-bullets { display: flex; flex-direction: column; gap: 16px; }
  .ai-bullet {
    font-size: ${bodyFontSize}px; font-weight: 400; line-height: 1.5;
    color: ${textColor}dd; padding-left: 28px; position: relative;
    text-shadow: 0 2px 16px rgba(0,0,0,0.4);
  }
  .ai-bullet::before {
    content: ''; position: absolute; left: 0; top: ${Math.round(bodyFontSize * 0.38)}px;
    width: 10px; height: 10px; background: ${primary};
    border-radius: 2px; box-shadow: 0 0 8px ${primary}80;
  }

  /* Quote */
  .ai-quote {
    font-size: ${bodyFontSize}px; font-weight: 500; line-height: 1.5;
    color: ${textColor}; border-left: 3px solid ${primary};
    padding-left: 28px; max-width: 90%; font-style: italic;
    text-shadow: 0 2px 20px rgba(0,0,0,0.5);
  }

  /* Stats */
  .ai-stats { display: flex; flex-direction: column; gap: 12px; }
  .ai-stat-line {
    font-size: ${bodyFontSize}px; font-weight: 500; line-height: 1.4;
    color: ${textColor}; text-shadow: 0 2px 16px rgba(0,0,0,0.4);
  }
  .ai-stat-big {
    font-size: ${Math.round(bodyFontSize * 1.5)}px; font-weight: 800;
    color: ${primaryGlow}; text-shadow: 0 0 30px ${primary}40;
    margin: 4px 0;
  }

  /* CTA */
  .ai-cta { text-align: center; }
  .ai-cta-line {
    font-size: ${bodyFontSize}px; font-weight: 600; line-height: 1.5;
    color: ${textColor}; text-shadow: 0 2px 20px rgba(0,0,0,0.5);
    margin-bottom: 8px;
  }

  .watermark { position: absolute; z-index: 5; bottom: 48px; right: 48px; opacity: 0.06; pointer-events: none; }
  .watermark img { max-width: 240px; max-height: 240px; }

  .bottom-bar {
    position: absolute; bottom: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, transparent 5%, ${primary}60 20%, ${primaryGlow} 50%, ${primary}60 80%, transparent 95%);
    box-shadow: 0 0 20px ${primary}40, 0 0 60px ${primary}15;
  }
  .top-line { position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, ${primary}20, transparent); }

  .corner { position: absolute; z-index: 12; }
  .corner-tl { top: 24px; left: 24px; }
  .corner-tr { top: 24px; right: 24px; transform: scaleX(-1); }
  .corner-bl { bottom: 24px; left: 24px; transform: scaleY(-1); }
  .corner-br { bottom: 24px; right: 24px; transform: scale(-1); }
  .corner svg { display: block; }
</style>
</head>
<body>
  <div class="bg-gradient"></div>
  <svg class="bg-network" viewBox="0 0 ${dim.width} ${dim.height}" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="blur"><feGaussianBlur stdDeviation="6"/></filter></defs>
    ${bgSVG}
  </svg>
  ${gridOp > 0 ? '<div class="bg-grid"></div>' : ""}
  ${themeConf.scanlines ? '<div class="bg-scanlines"></div>' : ""}
  <div class="bg-noise"></div>
  <div class="bg-vignette"></div>
  <div class="glow-main"></div>
  <div class="glow-secondary"></div>
  <div class="top-line"></div>

  <div class="corner corner-tl"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M0 12V0h12" stroke="${primary}" stroke-width="1.2" opacity="0.4"/></svg></div>
  <div class="corner corner-tr"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M0 12V0h12" stroke="${primary}" stroke-width="1.2" opacity="0.4"/></svg></div>
  <div class="corner corner-bl"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M0 12V0h12" stroke="${primary}" stroke-width="1.2" opacity="0.4"/></svg></div>
  <div class="corner corner-br"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M0 12V0h12" stroke="${primary}" stroke-width="1.2" opacity="0.4"/></svg></div>

  <div class="container">
    <div class="top-bar">
      <span class="slide-num">${slideNumber && totalSlides ? `${String(slideNumber).padStart(2, "0")} / ${String(totalSlides).padStart(2, "0")}` : ""}</span>
      ${brandLogo
        ? `<img class="brand-logo" src="${brandLogo}" alt="${escapeHtml(brandName)}" />`
        : `<span class="brand-tag">${escapeHtml(brandName)}</span>`
      }
    </div>
    ${d.title ? `<div class="ai-title">${escapeHtml(d.title)}</div>` : ""}
    ${hasDivider ? '<div class="ai-divider"></div>' : ""}
    ${bodyHTML}
  </div>

  ${brandWatermark ? `<div class="watermark"><img src="${brandWatermark}" /></div>` : ""}
  <div class="bottom-bar"></div>
</body></html>`;
}

function formatPart(part, primary) {
  const text = escapeHtml(part.text || "");
  switch (part.style) {
    case "highlight": return `<span style="color:${lightenColor(primary, 30)};font-weight:600;text-shadow:0 0 20px ${primary}50">${text}</span>`;
    case "bold": return `<strong>${text}</strong>`;
    case "dim": return `<span style="opacity:0.7">${text}</span>`;
    case "large": return `<span style="font-size:1.3em;font-weight:700;display:block;margin-bottom:6px">${text}</span>`;
    default: return text;
  }
}

// ── HELPERS ──
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hex(opacity) {
  // Convert 0-1 opacity to 2-char hex
  return Math.round(Math.min(1, Math.max(0, opacity)) * 255).toString(16).padStart(2, "0");
}

function lightenColor(hexColor, amount) {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  return "#" + [r, g, b].map(c => Math.min(255, c + amount).toString(16).padStart(2, "0")).join("");
}

// ── RENDER FUNCTIONS ──
async function renderSlide(slide, aiDesign = null) {
  const html = aiDesign ? buildAISlideHTML(slide, aiDesign) : buildSlideHTML(slide);
  const dim = getDimensions(slide.designType || "instagram_post");
  const br = await getBrowser();
  const page = await br.newPage({ viewport: { width: dim.width, height: dim.height } });

  await page.setContent(html, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  const filename = `slide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const filepath = path.join(OUTPUT_DIR, filename);

  await page.screenshot({ path: filepath, type: "png" });
  await page.close();

  return { filename, filepath, url: `/generated-images/${filename}` };
}

async function renderCarousel(slides, aiDesigns = null) {
  const results = [];
  for (let i = 0; i < slides.length; i++) {
    const aiDesign = aiDesigns ? aiDesigns[i] : null;
    const result = await renderSlide(slides[i], aiDesign);
    results.push(result);
  }
  return results;
}

async function cleanup() {
  if (browser) await browser.close();
}

module.exports = { renderSlide, renderCarousel, buildSlideHTML, buildAISlideHTML, parseStyleKeywords, cleanup };
