// ── CARD TEMPLATE (X autopilot, image_mode "template") ──
// For subjects an AI image model can't or won't draw faithfully (trading cards,
// products): the real photo from the source post goes into a fixed house
// template, and the headline is real text. Deterministic Playwright HTML→PNG,
// so the image always shows the subject and the text never has typos.

const fs = require("fs");
const path = require("path");

const FONTS_DIR = path.join(__dirname, "assets", "fonts");
const SIZE = { width: 1080, height: 1350 };   // 4:5, the tallest X shows uncropped in the feed

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fontFace(family, file, weight) {
  const full = path.join(FONTS_DIR, file);
  if (!fs.existsSync(full)) return "";
  return `@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${fs.readFileSync(full).toString("base64")}) format('truetype');font-weight:${weight};font-display:block}`;
}

// Headline: no dashes (house rule), single spaces, max 9 words.
function cleanHeadline(s) {
  const words = String(s || "").replace(/[–—]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, 9).join(" ");
}

// hue: accent colour (default warm gold); mark: small wordmark at the bottom (optional).
function buildHtml({ imageDataUri, headline, mark = "", hue = 43, fonts = true }) {
  const h = Number.isFinite(+hue) ? +hue : 43;
  const faces = fonts ? fontFace("Display", "Montserrat-ExtraBold.ttf", 800) + fontFace("Inter", "Inter-Bold.ttf", 700) : "";
  const title = cleanHeadline(headline);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${faces}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${SIZE.width}px;height:${SIZE.height}px;background:#000;overflow:hidden}
body{position:relative;font-family:'Inter',sans-serif;color:#fff}
.bg{position:absolute;inset:-80px;background:url(${imageDataUri}) center/cover;filter:blur(70px) saturate(1.3);opacity:.32}
.veil{position:absolute;inset:0;background:
  radial-gradient(ellipse 70% 45% at 50% 58%,hsla(${h},90%,55%,.20),transparent 70%),
  linear-gradient(180deg,rgba(0,0,0,.85) 0%,rgba(0,0,0,.35) 30%,rgba(0,0,0,.45) 75%,rgba(0,0,0,.92) 100%)}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding:70px 70px 56px}
h1{font-family:'Display',sans-serif;font-weight:800;text-align:center;line-height:1.08;letter-spacing:-.01em;
  font-size:var(--fs,76px);max-width:940px;text-wrap:balance;text-shadow:0 4px 30px rgba(0,0,0,.6)}
.stage{flex:1;width:100%;display:flex;align-items:center;justify-content:center;padding:44px 0 34px;min-height:0}
.frame{position:relative;max-width:100%;max-height:100%;display:flex;border-radius:22px;padding:3px;
  background:linear-gradient(135deg,hsl(${h},85%,62%),hsl(${(h + 150) % 360},70%,60%) 35%,hsl(${(h + 260) % 360},75%,65%) 65%,hsl(${h},85%,62%));
  box-shadow:0 0 60px hsla(${h},90%,55%,.35),0 30px 80px rgba(0,0,0,.8)}
.frame img{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:19px;background:#0a0a0a}
.mark{display:flex;align-items:center;gap:18px;font-weight:700;font-size:22px;letter-spacing:.42em;color:hsl(${h},70%,72%);text-transform:uppercase}
.mark i{display:block;width:70px;height:2px;background:linear-gradient(90deg,transparent,hsl(${h},80%,60%))}
.mark i:last-child{transform:scaleX(-1)}
</style></head><body>
<div class="bg"></div><div class="veil"></div>
<div class="wrap">
${title ? `<h1 id="t">${esc(title)}</h1>` : ""}
<div class="stage" id="stage"><div class="frame" id="frame"><img id="img" src="${imageDataUri}"></div></div>
${mark ? `<div class="mark"><i></i>${esc(mark)}<i></i></div>` : ""}
</div><script>
(async()=>{try{await document.fonts.ready}catch(e){}
const img=document.getElementById('img');if(!img.complete)await new Promise(r=>{img.onload=img.onerror=r});
const t=document.getElementById('t');let fs=76;
if(t){while(fs>40&&t.offsetHeight>fs*1.08*2.05){fs-=2;document.documentElement.style.setProperty('--fs',fs+'px')}}
// The image may never be smaller than ~55% of the canvas height or wider than the stage.
const st=document.getElementById('stage').getBoundingClientRect();
img.style.maxHeight=(st.height-78)+'px';img.style.maxWidth=(st.width-6)+'px';
window.__fit={fs,imgW:img.naturalWidth,imgH:img.naturalHeight,lines:t?Math.round(t.offsetHeight/(fs*1.08)):0};})();
</script></body></html>`;
}

let _browser = null;
async function browser() {
  if (!_browser || !_browser.isConnected()) {
    const { chromium } = require("playwright");
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}

function mimeOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.slice(0, 4).toString() === "RIFF") return "image/webp";
  return "image/jpeg";
}

// imageBuf: the source photo; writes a PNG to outFile.
async function render({ imageBuf, headline, mark, hue }, outFile) {
  if (!imageBuf || imageBuf.length < 1000) throw new Error("template: source image missing");
  const imageDataUri = `data:${mimeOf(imageBuf)};base64,${imageBuf.toString("base64")}`;
  const page = await (await browser()).newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  try {
    await page.setContent(buildHtml({ imageDataUri, headline, mark, hue }), { waitUntil: "load" });
    await page.waitForFunction(() => window.__fit, null, { timeout: 15000 });
    const fit = await page.evaluate(() => window.__fit);
    if (!fit.imgW) throw new Error("template: source image did not load");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile, type: "png" });
    return { ...SIZE, fit };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { SIZE, cleanHeadline, buildHtml, render, mimeOf };
