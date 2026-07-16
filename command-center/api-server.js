const _path = require("path");
const _fs = require("fs");
const _envPaths = [_path.join(__dirname, ".env"), _path.join(__dirname, "..", ".env")];
const _envPath = _envPaths.find(p => _fs.existsSync(p)) || _envPaths[1];
// override: true so the .env file is authoritative. Without this, anything
// already in process.env (e.g. stale shell exports, systemd EnvironmentFile
// values loaded before .env was rewritten by the setup wizard) silently wins,
// which can make new/changed API keys appear to not take effect.
require("dotenv").config({ path: _envPath, override: true });

// One-off: if the Inference.sh CLI is already authenticated locally but
// INFERENCE_API_KEY isn't in .env yet, mirror the CLI key in so the Settings
// page and `/api/settings` reflect the real configuration state. (The reverse
// direction — settings → infsh config — happens in writeEnvFile.)
try {
  if (!process.env.INFERENCE_API_KEY) {
    const _infshCfg = _path.join(process.env.HOME || "/root", ".inferencesh", "config.json");
    if (_fs.existsSync(_infshCfg)) {
      const _key = (JSON.parse(_fs.readFileSync(_infshCfg, "utf8")) || {}).api_key;
      if (_key) {
        process.env.INFERENCE_API_KEY = _key;
        let _content = "";
        try { _content = _fs.readFileSync(_envPath, "utf8"); } catch {}
        if (!/^INFERENCE_API_KEY=/m.test(_content)) {
          _content = _content.replace(/\s+$/, "") + `\nINFERENCE_API_KEY=${_key}\n`;
          _fs.writeFileSync(_envPath, _content, { mode: 0o600 });
          console.log("[INFSH] Imported existing CLI key into .env as INFERENCE_API_KEY");
        }
      }
    }
  }
} catch (e) {
  console.warn("[INFSH] Could not import CLI key:", e.message);
}
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const Stripe = require("stripe");

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const { renderSlide, renderCarousel } = require("./slide-renderer");
const { designSlides } = require("./slide-designer-ai");
const { execFile, spawn } = require("child_process");
const { createProxyMiddleware } = require("http-proxy-middleware");
const {
  BROWSER_TOOLS,
  BROWSE_PAGE_TOOL,
  handleBrowserTool,
  browsePage,
} = require("./browser-tools");

const app = express();

// Stripe webhook must receive the RAW body for signature verification,
// so register it BEFORE express.json(). The handler itself is defined later
// in the file (handleStripeWebhook); function-scoped hoisting keeps it
// available at request time even though we reference it here.
app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => handleStripeWebhook(req, res));

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use("/generated-images", express.static(path.join(__dirname, "data", "generated-images")));
app.use("/ugc-avatars", express.static(path.join(__dirname, "data", "ugc-avatars")));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cookie");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
});

const PORT = Number(process.env.PORT) || 3004;

// ── AUTH ──────────────────────────────────────
const CC_PASSWORD = process.env.CC_PASSWORD;
const SESSION_SECRET = process.env.CC_SESSION_SECRET;
if (!CC_PASSWORD || !SESSION_SECRET) {
  console.error("FATAL: CC_PASSWORD and CC_SESSION_SECRET must be set in .env");
  process.exit(1);
}

// Shared secret for internal callers (scheduler, Telegram worker, etc.) that need to
// bypass the auth-cookie check. Auto-generated on first boot and persisted to .env.
const _INTERNAL_ENV_PATH = [path.join(__dirname, ".env"), path.join(__dirname, "..", ".env")].find(p => fs.existsSync(p)) || path.join(__dirname, ".env");
if (!process.env.INTERNAL_SECRET) {
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    let content = "";
    try { content = fs.readFileSync(_INTERNAL_ENV_PATH, "utf8"); } catch {}
    if (!/^INTERNAL_SECRET=/m.test(content)) {
      content = content.replace(/\s+$/, "") + `\nINTERNAL_SECRET=${generated}\n`;
      fs.writeFileSync(_INTERNAL_ENV_PATH, content, { mode: 0o600 });
      console.log(`[AUTH] Generated INTERNAL_SECRET and persisted to ${_INTERNAL_ENV_PATH}`);
    }
  } catch (e) {
    console.warn("[AUTH] Could not persist INTERNAL_SECRET to .env:", e.message);
  }
  process.env.INTERNAL_SECRET = generated;
}
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
function createSessionToken() {
  const payload = Date.now().toString(36) + "." + crypto.randomBytes(16).toString("hex");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return payload + "." + sig;
}

function isValidSession(token) {
  if (!token || typeof token !== "string") return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = token.substring(0, lastDot);
  const sig = token.substring(lastDot + 1);
  if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  const sigBuf = Buffer.from(sig, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  try { return crypto.timingSafeEqual(sigBuf, expBuf); } catch { return false; }
}

// Login endpoint
app.post("/auth/login", (req, res) => {
  const { password } = req.body;
  if (password === CC_PASSWORD) {
    const token = createSessionToken();
    res.cookie("cc_session", token, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "Incorrect password" });
  }
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie("cc_session");
  res.json({ ok: true });
});

app.get("/auth/check", (req, res) => {
  res.json({ authenticated: isValidSession(req.cookies?.cc_session) });
});

// Returns whether the installation has completed initial setup.
// Setup is considered incomplete if brand.json is missing, company_name is empty,
// or company_name matches one of the placeholder values.
app.get("/api/setup-status", (_req, res) => {
  const placeholders = new Set(["", "MyBrand", "Command Center"]);
  let companyName = "";
  try {
    const brand = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "brand.json"), "utf8"));
    companyName = (brand && typeof brand.company_name === "string") ? brand.company_name.trim() : "";
  } catch {}
  const needs_setup = placeholders.has(companyName);
  res.json({ needs_setup, company_name: companyName });
});

// Allow login page and static assets without auth
app.use("/login.html", express.static(path.join(__dirname, "login.html")));
app.use("/setup.html", express.static(path.join(__dirname, "setup.html")));
app.use("/theme.css", express.static(path.join(__dirname, "public", "theme.css")));
app.use("/brand-loader.js", express.static(path.join(__dirname, "public", "brand-loader.js")));
// Public, unauthenticated audio for UGC talking-avatar: Higgsfield's servers
// fetch the generated voice file by URL (no session cookie). Filenames are
// random task ids, served read-only from data/ugc-audio.
app.get("/ugc-media/:file", (req, res) => {
  const file = String(req.params.file).replace(/[^a-zA-Z0-9._-]/g, "");
  const p = path.join(__dirname, "data", "ugc-audio", file);
  if (!file || !fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// Protect all other routes (API + HTML pages)
app.use((req, res, next) => {
  if (req.path.startsWith("/auth/") || req.path === "/api/setup-status") return next();
  // Stripe webhook authenticates via signature, not cookie — it was already
  // handled by the raw-body route above, but allow as a safety net.
  if (req.path === "/stripe/webhook") return next();
  if (
    (req.headers["x-internal"] === "scheduler" || req.headers["x-internal"] === "telegram") &&
    req.headers["x-internal-secret"] === INTERNAL_SECRET
  ) return next();
  if (isValidSession(req.cookies?.cc_session)) return next();
  if (req.path.endsWith(".html") || req.path === "/") return res.redirect("/login.html");
  res.status(401).json({ error: "Unauthorized" });
});

// ── Remotion Studio reverse proxy ────────────────────────────────────────
// Studio runs as a child process bound to 127.0.0.1:3150. We proxy it through
// /remotion-studio/* so customers don't need an extra reverse proxy / port.
// Also catches absolute asset paths (e.g. "/static/x.js") by inspecting the
// Referer header, since Studio's HTML emits root-relative URLs.
const REMOTION_STUDIO_PORT = 3150;
const remotionStudioProxy = createProxyMiddleware({
  target: `http://127.0.0.1:${REMOTION_STUDIO_PORT}`,
  changeOrigin: true,
  ws: true,
  logLevel: "warn",
  pathRewrite: (p) => p.replace(/^\/remotion-studio\/?/, "/"),
});

// Asset interceptor: Studio's Assets panel + composition preview request media
// files at raw paths (e.g. "/logo.png") because it expects fingerprinted paths
// like "/static-<hash>/logo.png". Vite then returns the Studio SPA HTML as
// fallback instead of the actual file. We catch these and serve the asset
// directly from the active project's public/ directory.
const STUDIO_MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp|mp4|webm|mov|m4v|mp3|wav|ogg|flac|m4a|woff2?|ttf|otf|eot|json|lottie)$/i;
app.use((req, res, next) => {
  const ref = req.headers.referer || "";
  if (!ref.includes("/remotion-studio")) return next();
  if (req.path.startsWith("/remotion-studio")) return next();
  if (!STUDIO_MEDIA_EXT_RE.test(req.path)) return next();
  if (!currentStudio) return next();
  try {
    const meta = readProjectMeta(currentStudio.projectId);
    if (!meta || !meta.entry) return next();
    const projectDir = path.join(VIDEO_PROJECTS_DIR, currentStudio.projectId);
    const { root: remotionRoot } = resolveRemotionRoot(projectDir, meta.entry);
    const publicDir = path.join(remotionRoot, "public");
    const safeRel = decodeURIComponent(req.path).replace(/^\/+/, "").replace(/\.\./g, "");
    const filePath = path.resolve(publicDir, safeRel);
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) return next();
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next();
    return res.sendFile(filePath);
  } catch { return next(); }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/remotion-studio")) return remotionStudioProxy(req, res, next);
  const ref = req.headers.referer || "";
  if (ref.includes("/remotion-studio")) return remotionStudioProxy(req, res, next);
  next();
});

// Serve all static files (HTML, JS, CSS) — protected by auth middleware above
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "public")));

// ── SETTINGS API ─────────────────────────────
const ENV_PATH = [path.join(__dirname, ".env"), path.join(__dirname, "..", ".env")].find(p => fs.existsSync(p)) || path.join(__dirname, ".env");


function readEnvFile() {
  const env = {};
  // Read .env file
  try {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  // Merge from process.env (picks up vars from other sources like dotenv loading)
  const envKeys = ["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "HIGGSFIELD_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "COMPOSIO_API_KEY", "INFERENCE_API_KEY", "META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET", "CANVA_REDIRECT_URI", "YOUTUBE_API_KEY", "OPUSCLIP_API_KEY", "ELEVENLABS_API_KEY", "COMPANY_NAME", "ASSISTANT_NAME", "TAGLINE", "PRIMARY_COLOR_HUE", "PRIMARY_COLOR_SAT", "PRIMARY_COLOR_LIT"];
  for (const key of envKeys) {
    if (!env[key] && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function writeEnvFile(updates) {
  let content = "";
  try { content = fs.readFileSync(ENV_PATH, "utf8"); } catch {}
  for (const [key, val] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) content = content.replace(re, `${key}=${val}`);
    else content += `\n${key}=${val}`;
  }
  fs.writeFileSync(ENV_PATH, content.trim() + "\n", { mode: 0o600 });
  for (const [key, val] of Object.entries(updates)) {
    process.env[key] = val;
  }
  // Mirror the Inference.sh API key into the infsh CLI config so the binary
  // can authenticate without an interactive `infsh login`. The CLI reads
  // ~/.inferencesh/config.json and the format is just { "api_key": "..." }.
  if (updates.INFERENCE_API_KEY) {
    try {
      const dir = path.join(process.env.HOME || "/root", ".inferencesh");
      fs.mkdirSync(dir, { recursive: true });
      const cfgPath = path.join(dir, "config.json");
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
      existing.api_key = updates.INFERENCE_API_KEY;
      fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    } catch (e) {
      console.warn("[INFSH] Failed to write CLI config:", e.message);
    }
  }
}

function maskKey(val) {
  if (!val) return "";
  if (val.length <= 10) return "***";
  return val.slice(0, 6) + "..." + val.slice(-4);
}

// Detect the public origin the Command Center is currently being reached on,
// so OAuth integrations (Meta Ads, Canva) can show the customer the exact
// callback URI to paste into the third-party developer dashboard.
function detectPublicOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return { proto, host, origin: host ? `${proto}://${host}` : "" };
}
function looksPublicHost(host) {
  if (!host) return false;
  const h = String(host).split(":")[0].toLowerCase();
  if (h === "localhost" || h === "0.0.0.0") return false;
  // Numeric IPv4 or bare IPv6 address — not a domain name.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  if (h.includes(":") && !/[a-z]/.test(h)) return false;
  return h.includes(".");
}

app.get("/api/settings", (req, res) => {
  const env = readEnvFile();
  // Read brand.json, fall back to loadBrand() defaults
  let brand = {};
  try { brand = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "brand.json"), "utf8")); } catch {}
  if (!brand.company_name && typeof loadBrand === "function") { try { brand = loadBrand(); } catch {} }
  const pub = detectPublicOrigin(req);
  res.json({
    server: {
      origin: pub.origin,
      host: pub.host,
      looks_public: looksPublicHost(pub.host),
      meta_callback: env.META_REDIRECT_URI || (pub.origin ? `${pub.origin}/social/meta/callback` : ""),
      canva_callback: env.CANVA_REDIRECT_URI || (pub.origin ? `${pub.origin}/canva/callback` : ""),
    },
    branding: {
      company_name: brand.company_name || env.COMPANY_NAME || "",
      assistant_name: brand.assistant_name || env.ASSISTANT_NAME || "",
      tagline: brand.tagline || env.TAGLINE || "",
      primary_hue: brand.primary_hue || parseInt(env.PRIMARY_COLOR_HUE || "264"),
      primary_sat: brand.primary_sat || parseInt(env.PRIMARY_COLOR_SAT || "65"),
      primary_lit: brand.primary_lit || parseInt(env.PRIMARY_COLOR_LIT || "49"),
    },
    integrations: {
      anthropic: { has_key: !!env.ANTHROPIC_API_KEY, masked: maskKey(env.ANTHROPIC_API_KEY) },
      telegram: { has_key: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), token_masked: maskKey(env.TELEGRAM_BOT_TOKEN), chat_id: env.TELEGRAM_CHAT_ID || "" },
      higgsfield: { has_key: (env.HIGGSFIELD_API_KEY || "").includes(":") && (env.HIGGSFIELD_API_KEY || "").split(":").every(Boolean), has_id: !!((env.HIGGSFIELD_API_KEY || "").split(":")[0]), has_secret: !!((env.HIGGSFIELD_API_KEY || "").split(":").slice(1).join(":")), masked: maskKey(env.HIGGSFIELD_API_KEY) },
      stripe: { has_key: !!env.STRIPE_SECRET_KEY, masked: maskKey(env.STRIPE_SECRET_KEY), has_webhook_secret: !!env.STRIPE_WEBHOOK_SECRET, webhook_url: pub.origin ? `${pub.origin}/stripe/webhook` : "" },
      inference: { has_key: !!env.INFERENCE_API_KEY, masked: maskKey(env.INFERENCE_API_KEY) },
      composio: { has_key: !!env.COMPOSIO_API_KEY, masked: maskKey(env.COMPOSIO_API_KEY) },
      meta: { has_app_id: !!env.META_APP_ID, app_id_masked: maskKey(env.META_APP_ID), has_secret: !!env.META_APP_SECRET, redirect_uri: env.META_REDIRECT_URI || "" },
      canva: { has_client_id: !!env.CANVA_CLIENT_ID, client_id_masked: maskKey(env.CANVA_CLIENT_ID), has_secret: !!env.CANVA_CLIENT_SECRET, redirect_uri: env.CANVA_REDIRECT_URI || "" },
      youtube: { has_key: !!env.YOUTUBE_API_KEY, masked: maskKey(env.YOUTUBE_API_KEY) },
      opusclip: { has_key: !!env.OPUSCLIP_API_KEY, masked: maskKey(env.OPUSCLIP_API_KEY) },
      elevenlabs: { has_key: !!env.ELEVENLABS_API_KEY, masked: maskKey(env.ELEVENLABS_API_KEY) },
    }
  });
});

app.post("/api/settings", (req, res) => {
  const { branding, integrations } = req.body;
  const updates = {};

  if (branding) {
    if (branding.company_name !== undefined) updates.COMPANY_NAME = branding.company_name;
    if (branding.assistant_name !== undefined) updates.ASSISTANT_NAME = branding.assistant_name;
    if (branding.tagline !== undefined) updates.TAGLINE = branding.tagline;
    if (branding.primary_hue !== undefined) updates.PRIMARY_COLOR_HUE = String(branding.primary_hue);
    if (branding.primary_sat !== undefined) updates.PRIMARY_COLOR_SAT = String(branding.primary_sat);
    if (branding.primary_lit !== undefined) updates.PRIMARY_COLOR_LIT = String(branding.primary_lit);
  }

  if (integrations) {
    const keyMap = {
      anthropic_key: "ANTHROPIC_API_KEY",
      telegram_token: "TELEGRAM_BOT_TOKEN",
      telegram_chat_id: "TELEGRAM_CHAT_ID",
      stripe_key: "STRIPE_SECRET_KEY",
      stripe_webhook_secret: "STRIPE_WEBHOOK_SECRET",
      composio_key: "COMPOSIO_API_KEY",
      inference_key: "INFERENCE_API_KEY",
      meta_app_id: "META_APP_ID",
      meta_app_secret: "META_APP_SECRET",
      meta_redirect_uri: "META_REDIRECT_URI",
      canva_client_id: "CANVA_CLIENT_ID",
      canva_client_secret: "CANVA_CLIENT_SECRET",
      canva_redirect_uri: "CANVA_REDIRECT_URI",
      youtube_api_key: "YOUTUBE_API_KEY",
      opusclip_key: "OPUSCLIP_API_KEY",
      elevenlabs_key: "ELEVENLABS_API_KEY",
    };
    for (const [field, envKey] of Object.entries(keyMap)) {
      if (integrations[field] !== undefined && integrations[field] !== "") {
        updates[envKey] = integrations[field].trim();
      }
    }
    // Higgsfield credentials are a KEY_ID:KEY_SECRET pair entered as two
    // separate fields; combine them into the single HIGGSFIELD_API_KEY env
    // var. Each field is "kept if empty", so updating one preserves the other.
    if (integrations.higgsfield_key_id !== undefined || integrations.higgsfield_secret !== undefined) {
      const cur = (readEnvFile().HIGGSFIELD_API_KEY || "").split(":");
      const curId = cur[0] || "";
      const curSecret = cur.slice(1).join(":") || "";
      const newId = (integrations.higgsfield_key_id || "").trim() || curId;
      const newSecret = (integrations.higgsfield_secret || "").trim() || curSecret;
      if (newId || newSecret) updates.HIGGSFIELD_API_KEY = `${newId}:${newSecret}`;
    }
  }

  try {
    if (Object.keys(updates).length) {
      writeEnvFile(updates);
      // Regenerate brand.json if branding changed
      if (branding) {
        const brandPath = path.join(__dirname, "data", "brand.json");
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(brandPath, "utf8")); } catch {}
        if (branding.company_name !== undefined) existing.company_name = branding.company_name;
        if (branding.assistant_name !== undefined) existing.assistant_name = branding.assistant_name;
        if (branding.tagline !== undefined) existing.tagline = branding.tagline;
        if (branding.primary_hue !== undefined) existing.primary_hue = branding.primary_hue;
        if (branding.primary_sat !== undefined) existing.primary_sat = branding.primary_sat;
        if (branding.primary_lit !== undefined) existing.primary_lit = branding.primary_lit;
        fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
        fs.writeFileSync(brandPath, JSON.stringify(existing, null, 2));
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generic task file helpers
function readTaskFile(file) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "data", file), "utf8")); }
  catch { return []; }
}
function writeTaskFile(file, tasks) {
  fs.writeFileSync(path.join(__dirname, "data", file), JSON.stringify(tasks, null, 2));
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── COMMUNITY MANAGER DATA LAYER ──
const COMMUNITY_DIR = path.join(__dirname, "data", "community");
const COMMUNITY_ARCHETYPE_DIR = path.join(COMMUNITY_DIR, "archetypes");
const COMMUNITY_CHANNELS_FILE = path.join(COMMUNITY_DIR, "channels.json");
const COMMUNITY_TASKS_FILE = "community-tasks.json";

function readChannels() {
  try { return JSON.parse(fs.readFileSync(COMMUNITY_CHANNELS_FILE, "utf8")); }
  catch { return []; }
}
function writeChannels(channels) {
  fs.mkdirSync(COMMUNITY_DIR, { recursive: true });
  fs.writeFileSync(COMMUNITY_CHANNELS_FILE, JSON.stringify(channels, null, 2));
}
function getChannel(id) {
  return readChannels().find(c => c.id === id) || null;
}
function sanitizeSetName(name) {
  const safe = String(name || "").trim().replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  if (!safe) throw new Error("Invalid archetype set name");
  return safe;
}
function listArchetypeSets() {
  try {
    return fs.readdirSync(COMMUNITY_ARCHETYPE_DIR)
      .filter(f => f.endsWith(".md"))
      .map(f => f.slice(0, -3))
      .sort();
  } catch { return []; }
}
function readArchetypeSet(name) {
  return fs.readFileSync(path.join(COMMUNITY_ARCHETYPE_DIR, sanitizeSetName(name) + ".md"), "utf8");
}
function writeArchetypeSet(name, content) {
  fs.mkdirSync(COMMUNITY_ARCHETYPE_DIR, { recursive: true });
  fs.writeFileSync(path.join(COMMUNITY_ARCHETYPE_DIR, sanitizeSetName(name) + ".md"), content);
}
function deleteArchetypeSet(name) {
  const p = path.join(COMMUNITY_ARCHETYPE_DIR, sanitizeSetName(name) + ".md");
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
function renameArchetypeSet(oldName, newName) {
  const from = sanitizeSetName(oldName);
  const to = sanitizeSetName(newName);
  if (from === to) return to;
  const fromPath = path.join(COMMUNITY_ARCHETYPE_DIR, from + ".md");
  const toPath = path.join(COMMUNITY_ARCHETYPE_DIR, to + ".md");
  if (!fs.existsSync(fromPath)) throw new Error(`Archetype set "${from}" does not exist`);
  if (fs.existsSync(toPath)) throw new Error(`Archetype set "${to}" already exists`);
  fs.renameSync(fromPath, toPath);
  const channels = readChannels();
  let dirty = false;
  for (const c of channels) {
    if (c.archetype_set === from) { c.archetype_set = to; c.updated_at = new Date().toISOString(); dirty = true; }
  }
  if (dirty) writeChannels(channels);
  return to;
}
function channelsUsingArchetypeSet(name) {
  const n = sanitizeSetName(name);
  return readChannels().filter(c => c.archetype_set === n).map(c => ({ id: c.id, name: c.name, platform: c.platform }));
}

// One-time migration from legacy "social-media" naming to "community"
function migrateSocialToCommunity() {
  if (fs.existsSync(COMMUNITY_CHANNELS_FILE)) return;
  try {
    fs.mkdirSync(COMMUNITY_ARCHETYPE_DIR, { recursive: true });

    const legacyArch = path.join(__dirname, "data", "social-media", "archetypes.md");
    const newArch = path.join(COMMUNITY_ARCHETYPE_DIR, "default.md");
    if (fs.existsSync(legacyArch) && !fs.existsSync(newArch)) {
      fs.copyFileSync(legacyArch, newArch);
    }

    const legacyPosts = path.join(__dirname, "data", "social-media", "posts_week17.md");
    const newPosts = path.join(COMMUNITY_DIR, "posts_week17.md");
    if (fs.existsSync(legacyPosts) && !fs.existsSync(newPosts)) {
      fs.copyFileSync(legacyPosts, newPosts);
    }

    const defaultChannel = {
      id: "default",
      name: "Main Community",
      platform: "telegram",
      chat_id: process.env.SOCIAL_TARGET_CHAT_ID || "",
      topic_id: process.env.SOCIAL_TOPIC_ID || "",
      archetype_set: fs.existsSync(newArch) ? "default" : "",
      enabled: true,
      review: {
        enabled: true,
        day: "sunday",
        time: "18:00",
        dm_chat_id: "",
      },
      schedule_window_days: 7,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    writeChannels([defaultChannel]);

    const legacyTasks = path.join(__dirname, "data", "social-media-tasks.json");
    const newTasks = path.join(__dirname, "data", COMMUNITY_TASKS_FILE);
    if (!fs.existsSync(newTasks)) {
      let tasks = [];
      if (fs.existsSync(legacyTasks)) {
        try { tasks = JSON.parse(fs.readFileSync(legacyTasks, "utf8")); } catch {}
      }
      for (const t of tasks) if (!t.channel_id) t.channel_id = "default";
      fs.writeFileSync(newTasks, JSON.stringify(tasks, null, 2));
    }

    console.log("[MIGRATION] Community manager initialized (default channel + archetype set)");
  } catch (e) {
    console.error("[MIGRATION] Community manager migration failed:", e.message);
  }
}
migrateSocialToCommunity();

// ── DESIGNER STYLE TAGS (customer-editable) ──
const STYLE_TAGS_FILE = path.join(__dirname, "data", "style-tags.json");
const DEFAULT_STYLE_TAGS = {
  categories: [
    {
      label: "Style",
      tags: [
        { name: "photorealistic", kw: "photorealistic" },
        { name: "cinematic", kw: "cinematic" },
        { name: "3D render", kw: "3D render" },
        { name: "digital art", kw: "digital art" },
        { name: "illustration", kw: "illustration" },
      ],
    },
    {
      label: "Mood",
      tags: [
        { name: "vibrant", kw: "vibrant" },
        { name: "dark moody", kw: "dark moody" },
        { name: "futuristic", kw: "futuristic" },
        { name: "minimal clean", kw: "minimal clean" },
        { name: "retro", kw: "retro vintage" },
      ],
    },
    {
      label: "Theme",
      tags: [
        { name: "abstract", kw: "abstract geometric" },
        { name: "nature", kw: "nature organic" },
        { name: "urban", kw: "urban city" },
        { name: "technology", kw: "technology tech" },
        { name: "lifestyle", kw: "lifestyle people" },
      ],
    },
    {
      label: "Lighting",
      tags: [
        { name: "dramatic", kw: "dramatic lighting" },
        { name: "golden hour", kw: "golden hour" },
        { name: "studio", kw: "studio lighting" },
        { name: "natural", kw: "natural light" },
        { name: "neon", kw: "neon glow" },
      ],
    },
  ],
};

function readStyleTags() {
  try {
    const raw = JSON.parse(fs.readFileSync(STYLE_TAGS_FILE, "utf8"));
    if (raw && Array.isArray(raw.categories)) return raw;
  } catch {}
  return DEFAULT_STYLE_TAGS;
}

function writeStyleTags(data) {
  fs.writeFileSync(STYLE_TAGS_FILE, JSON.stringify(data, null, 2));
}

app.get("/style-tags", (_req, res) => res.json(readStyleTags()));

app.put("/style-tags", (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.categories)) {
    return res.status(400).json({ error: "Body must contain a 'categories' array" });
  }
  const cleaned = {
    categories: body.categories.map(cat => ({
      label: String(cat.label || "").trim().slice(0, 40) || "Tags",
      tags: Array.isArray(cat.tags)
        ? cat.tags.map(t => ({
            name: String(t.name || "").trim().slice(0, 40),
            kw: String(t.kw || t.name || "").trim().slice(0, 80),
          })).filter(t => t.name && t.kw)
        : [],
    })).filter(c => c.tags.length > 0),
  };
  writeStyleTags(cleaned);
  res.json(cleaned);
});

// ── DESIGNER TASKS ────────────────────────────
app.get("/designer/tasks", (_req, res) => res.json(readTaskFile("designer-tasks.json")));

const designerUpload = require("multer")({
  storage: require("multer").diskStorage({
    destination: path.join(__dirname, "data", "ai-video-uploads"),
    filename: (_req, file, cb) => cb(null, "ref-" + Date.now() + path.extname(file.originalname || ".png")),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Wrap the multer middleware so an oversized/invalid reference image returns a
// clean 400 JSON error instead of crashing into Express's default 500 handler.
const DESIGNER_MAX_MB = 50;
function designerUploadMw(req, res, next) {
  designerUpload.array("ref_image", 10)(req, res, (err) => {
    if (err) {
      console.error("[DESIGNER] Upload error:", err.code || err.name, err.message);
      const msg = err.code === "LIMIT_FILE_SIZE"
        ? `Reference image too large (max ${DESIGNER_MAX_MB}MB per file)`
        : `Reference image upload failed: ${err.message}`;
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

function loadBrandContext(brandName) {
  const brand = String(brandName || (loadBrand().company_name || "DEFAULT")).toUpperCase();
  let brandConfig = { colors: [], fonts: [] };
  try { brandConfig = readBrandConfigs()[brand] || brandConfig; } catch {}
  const brandAssetsDir = path.join(BRAND_ASSETS_DIR, brand);
  const logos = [];
  try {
    if (fs.existsSync(brandAssetsDir)) {
      for (const f of fs.readdirSync(brandAssetsDir)) {
        if (f.startsWith(".")) continue;
        logos.push({ name: f, url: `/brand-assets/${brand}/${f}` });
      }
    }
  } catch {}
  return {
    name: brand,
    logos,
    colors: brandConfig.colors || [],
    fonts: brandConfig.fonts || [],
  };
}

app.post("/designer/tasks", designerUploadMw, async (req, res) => {
  const tasks = readTaskFile("designer-tasks.json");
  const desc = req.body.description || "";
  const refImagePaths = Array.isArray(req.files) ? req.files.map(f => f.path) : [];
  const refImagePath = refImagePaths[0] || null; // backwards-compat for engines that only use one
  const designType = req.body.design_type || "instagram_post";
  const brand = req.body.brand || (loadBrand().company_name || "DEFAULT").toUpperCase();
  const brandKitId = req.body.brand_kit_id || null;
  const engine = req.body.engine || "playwright"; // "playwright", "canva", or "claude"
  const logoPosition = req.body.logo_position || "SouthEast"; // ImageMagick gravity
  const logoSize = ["small", "medium", "large"].includes(req.body.logo_size) ? req.body.logo_size : "medium";
  const templateName = req.body.template || "default"; // slide layout template
  const requestedSlideCount = req.body.slide_count || null;
  // Accept aspect_ratios as array, single string, or comma-separated. Fall back to legacy aspect_ratio.
  const rawAspects = req.body.aspect_ratios ?? req.body.aspect_ratio ?? null;
  const customAspectRatios = (Array.isArray(rawAspects) ? rawAspects
    : (typeof rawAspects === "string" && rawAspects ? rawAspects.split(",") : []))
    .map(s => String(s).trim()).filter(Boolean);
  const customAspectRatio = customAspectRatios[0] || null;

  const brandContext = loadBrandContext(brand);

  // Detect carousel / multi-slide: split numbered slides
  // Supports: **1 — title** — body  OR  1 — title — body  OR  1. title — body
  const slides = [];
  // Try bold format first: **1 — title** — body
  const boldPattern = /\*\*(\d{1,2})\s*[–—.-]?\s*([^*]*?)\*\*\s*[–—.-]?\s*([\s\S]*?)(?=\*\*\d{1,2}|$)/g;
  let match;
  while ((match = boldPattern.exec(desc)) !== null) {
    slides.push({ num: match[1].trim(), title: match[2].trim(), body: match[3].trim() });
  }
  // If no bold slides found, try plain format: lines starting with "1 — " or "1. " or "1 - "
  if (slides.length === 0) {
    const lines = desc.split(/\n/).filter(l => l.trim());
    const plainPattern = /^(\d{1,2})\s*[–—.\-)\s]+\s*(.+)/;
    for (const line of lines) {
      const m = line.trim().match(plainPattern);
      if (m) {
        // Split on first — or - after the number to get title and body
        const rest = m[2];
        const sepIdx = rest.search(/\s[–—-]\s/);
        if (sepIdx > 0) {
          slides.push({ num: m[1], title: rest.substring(0, sepIdx).trim(), body: rest.substring(sepIdx).replace(/^\s*[–—-]\s*/, '').trim() });
        } else {
          slides.push({ num: m[1], title: rest.trim(), body: rest.trim() });
        }
      }
    }
  }
  // Try "Slide N:" or "Slide N -" format (common from AI-generated descriptions)
  if (slides.length === 0) {
    const slidePattern = /[Ss]lide\s*(\d{1,2})\s*[:–—-]\s*"?([^"\n]+)"?/g;
    let sm;
    while ((sm = slidePattern.exec(desc)) !== null) {
      slides.push({ num: sm[1].trim(), title: sm[2].trim(), body: sm[2].trim() });
    }
  }

  // If design type is carousel and no numbered slides detected, create N placeholder slides
  // Each slide gets an individual prompt for just that slide, not the full description
  if (designType === "instagram_carousel" && slides.length === 0 && requestedSlideCount > 1) {
    for (let i = 1; i <= requestedSlideCount; i++) {
      slides.push({ num: String(i), title: `Slide ${i} of ${requestedSlideCount}`, body: desc });
    }
  }

  // Extract global style instructions (text before first slide)
  const firstSlideIdx = desc.search(/\*\*\d{1,2}/);
  const globalStyle = firstSlideIdx > 0 ? desc.substring(0, firstSlideIdx).trim() : (slides.length > 0 && designType === "instagram_carousel" ? desc : "");

  if (engine === "playwright" && slides.length > 1) {
    // Playwright carousel: Claude designs, then Playwright renders
    const parentId = genId();
    const totalSlides = slides.length;
    try {
      // Step 1: Ask Claude to design the slides
      console.log(`[DESIGNER] Requesting AI design for ${totalSlides} slides...`);
      const aiDesigns = await designSlides(slides, globalStyle, brand, designType, brandContext);
      if (aiDesigns) {
        console.log(`[DESIGNER] AI returned ${aiDesigns.length} designs`);
      }

      const slideData = slides.map((s, i) => ({
        text: s.body || s.title,
        title: s.title || "",
        slideNumber: parseInt(s.num) || (i + 1),
        totalSlides,
        designType,
        template: templateName,
        style: { brand, mood: globalStyle, brandColors: brandContext.colors, brandFonts: brandContext.fonts },
      }));

      // Step 2: Render with AI designs (falls back to template if AI failed)
      const results = await renderCarousel(slideData, aiDesigns);
      const createdTasks = slides.map((s, i) => ({
        id: genId(), status: "completed",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        design_type: designType, brand, brand_kit_id: brandKitId, engine: "playwright",
        carousel_parent: parentId,
        carousel_slide: parseInt(s.num) || (i + 1),
        carousel_total: totalSlides,
        description: `${globalStyle ? globalStyle + " | " : ""}Slide ${s.num}/${totalSlides}${s.title ? " — " + s.title : ""}`,
        result_url: results[i].url,
        result_thumbnail: results[i].url,
        result_design_id: null, error: null,
      }));
      tasks.unshift(...createdTasks);
      writeTaskFile("designer-tasks.json", tasks);
      console.log(`[DESIGNER] Playwright carousel: ${totalSlides} slides rendered`);
      return res.status(201).json(createdTasks);
    } catch (e) {
      console.error("[DESIGNER] Playwright carousel failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (engine === "playwright") {
    // Single Playwright render — strip style prefix from content
    const stylePrefix = /^stijl\s*:\s*[^\n]+\n*/i;
    const cleanDesc = desc.replace(stylePrefix, "").trim();
    try {
      // Ask Claude for design
      const aiDesigns = await designSlides([{ num: "1", title: "", body: cleanDesc }], globalStyle || desc.match(stylePrefix)?.[0] || "", brand, designType, brandContext);
      const aiDesign = aiDesigns?.[0] || null;

      const result = await renderSlide({
        text: cleanDesc,
        title: "",
        slideNumber: "",
        totalSlides: "",
        designType,
        template: templateName,
        style: { brand, mood: desc, brandColors: brandContext.colors, brandFonts: brandContext.fonts },
      }, aiDesign);
      const task = {
        id: genId(), status: "completed",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        design_type: designType, brand, brand_kit_id: brandKitId, engine: "playwright",
        description: desc,
        result_url: result.url, result_thumbnail: result.url,
        result_design_id: null, error: null,
      };
      tasks.unshift(task);
      writeTaskFile("designer-tasks.json", tasks);
      console.log(`[DESIGNER] Playwright single slide rendered`);
      return res.status(201).json(task);
    } catch (e) {
      console.error("[DESIGNER] Playwright render failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // Claude AI engine: invoke Claude Code CLI with /designer skill
  if (engine === "nanobanana") {
    // Nano Banana engine: generate image via Gemini 3.1 Flash through infsh CLI
    const aspectMap = {
      instagram_post: "4:5", instagram_carousel: "4:5", your_story: "9:16",
      youtube_thumbnail: "16:9", youtube_banner: "16:9", twitter_post: "16:9",
      facebook_post: "1:1", ad_creative: "1:1", infographic: "9:16", poster: "3:4",
      presentation: "16:9", logo: "1:1",
    };
    const defaultAspect = aspectMap[designType] || "1:1";
    // For ad_creative + multiple aspect ratios: one task per ratio.
    // For other types: keep slide/carousel semantics and use a single aspect (custom or mapped).
    const isAdVariantMode = designType === "ad_creative" && customAspectRatios.length > 1;
    const taskAspects = isAdVariantMode ? customAspectRatios : null;
    const aspect = customAspectRatio || defaultAspect; // used when not in variant mode
    const numImages = isAdVariantMode ? taskAspects.length
      : slides.length > 1 ? slides.length
      : (designType === "instagram_carousel" && requestedSlideCount) ? requestedSlideCount : 1;

    const createdTasks = [];
    const carouselParentId = !isAdVariantMode && numImages > 1 ? genId() : null;
    const variantParentId = isAdVariantMode ? genId() : null;
    for (let i = 0; i < numImages; i++) {
      const thisAspect = isAdVariantMode ? taskAspects[i] : aspect;
      createdTasks.push({
        id: genId(), status: "processing",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        design_type: designType, brand, brand_kit_id: brandKitId, engine: "nanobanana",
        aspect_ratio: thisAspect,
        logo_position: logoPosition,
        logo_size: logoSize,
        carousel_parent: carouselParentId,
        carousel_slide: !isAdVariantMode && numImages > 1 ? i + 1 : null,
        carousel_total: !isAdVariantMode && numImages > 1 ? numImages : null,
        variant_parent: variantParentId,
        variant_index: isAdVariantMode ? i + 1 : null,
        variant_total: isAdVariantMode ? numImages : null,
        description: isAdVariantMode ? `${desc} (${thisAspect})`
          : (numImages > 1 && slides[i] ? `Slide ${i+1}/${numImages}: ${slides[i].title}` : desc),
        result_url: null, result_thumbnail: null, result_design_id: null, error: null,
      });
    }
    tasks.unshift(...createdTasks);
    writeTaskFile("designer-tasks.json", tasks);
    res.status(201).json(createdTasks);

    // Run infsh for each task in sequential batches of 2 (avoid Gemini rate limits)
    const NB_CONCURRENCY = 2;
    const runSlideQueue = async () => {
      for (let _qi = 0; _qi < createdTasks.length; _qi += NB_CONCURRENCY) {
        const batch = createdTasks.slice(_qi, _qi + NB_CONCURRENCY);
        await Promise.all(batch.map((task) => new Promise((resolveBatch) => {
      const slideIdx = createdTasks.indexOf(task);
      const slide = slides.length > 1 ? slides[slideIdx] : null;
      let slideDesc;
      if (slide && slide.title !== slide.body) {
        slideDesc = `${slide.title}: ${slide.body}`;
      } else if (slide) {
        slideDesc = slide.body;
      } else {
        slideDesc = desc;
      }
      // For carousel: try to extract only this slide's content from the full description
      // to prevent Gemini from rendering all slides on one image
      if (numImages > 1 && slide && slide.body === desc) {
        // Body is the full description — try to extract just this slide's portion
        const slideNum = slideIdx + 1;
        const slideExtract = desc.match(new RegExp(`[Ss]lide\\s*${slideNum}\\s*[:–—-]\\s*"?([^"\\n]+)"?`));
        if (slideExtract) {
          slideDesc = slideExtract[1].trim();
        } else {
          // Can't extract — give Gemini the topic with a clear single-slide instruction
          const topicMatch = desc.match(/^([^.\n]+)/);
          const topic = topicMatch ? topicMatch[1].trim() : desc.substring(0, 100);
          slideDesc = `${topic} — content for slide ${slideNum} of ${numImages}`;
        }
      }

      // Build brand-aware prompt — avoid putting brand name or design_type as text
      // (Gemini renders those as visible text on the image)
      const isCarouselSlide = numImages > 1 && task.carousel_slide;
      const slideInstruction = isCarouselSlide
        ? `This is slide ${task.carousel_slide} of ${task.carousel_total} in an Instagram carousel. Generate ONLY this single slide image — do NOT combine multiple slides into one image.`
        : "";
      const brandParts = [slideInstruction, `${slideDesc}`, `Style: professional, modern`].filter(Boolean);
      if (brandContext.colors.length) {
        brandParts.push("Use these colors: " + brandContext.colors.map(c => `${c.hex}`).join(", "));
      }
      if (brandContext.fonts.length) {
        brandParts.push("Font style: " + brandContext.fonts.map(f => f.family).join(", "));
      }
      // If this is a parsed slide or contains structured content, render text on the image
      const hasStructuredContent = slide || /\*\*\d|slide|titel|headline/i.test(slideDesc);
      if (hasStructuredContent) {
        brandParts.push("Render the text/titles/headlines described above clearly and legibly on the image as part of the design. Do NOT add watermarks, logos, or brand names.");
      } else {
        brandParts.push("Do NOT add any text, titles, watermarks, logos, or brand names to the image unless explicitly described in the prompt above.");
      }
      const prompt = brandParts.join(". ");

      // Logo files for ImageMagick composite AFTER generation (not sent to Gemini)
      const logoFiles = brandContext.logos
        .filter(l => l.name.startsWith("logo") || l.name.startsWith("icon"))
        .map(l => path.join(BRAND_ASSETS_DIR, brand.toUpperCase(), l.name))
        .filter(f => fs.existsSync(f));
      const inputObj = { prompt, aspect_ratio: task.aspect_ratio || aspect, resolution: "2K", num_images: 1 };
      const validRefPaths = refImagePaths.filter(p => p && fs.existsSync(p));
      if (validRefPaths.length > 0) inputObj.images = validRefPaths;
      const input = JSON.stringify(inputObj);

      // Write input to temp file to avoid shell escaping issues
      const tmpInput = path.join(__dirname, "data", `nb-input-${task.id}.json`);
      fs.writeFileSync(tmpInput, input);

      const runInfsh = (attempt) => {
        // On retry: prefix prompt with "Generate an image:" to force image output from Gemini
        if (attempt > 1) {
          try {
            const prevInput = JSON.parse(fs.readFileSync(tmpInput, "utf8"));
            if (!prevInput.prompt.startsWith("Generate an image:")) {
              prevInput.prompt = "Generate an image: " + prevInput.prompt;
              fs.writeFileSync(tmpInput, JSON.stringify(prevInput));
              console.log(`[DESIGNER] Nano Banana attempt ${attempt}: prefixed prompt with 'Generate an image:'`);
            }
          } catch {}
        }
        execFile("infsh", ["app", "run", "google/gemini-3-1-flash-image-preview", "--input", tmpInput, "--json"], {
          timeout: 120000,
          maxBuffer: 1024 * 1024 * 50,
          env: { ...process.env, HOME: "/root" },
        }, (err, stdout, stderr) => {
          if (err && attempt < 3) {
            console.warn(`[DESIGNER] Nano Banana attempt ${attempt} failed, retrying in 5s:`, (stderr || err.message).slice(0, 200));
            return setTimeout(() => runInfsh(attempt + 1), 5000);
          }

          // Parse result even if no exec error — check for empty images
          let images = [];
          let result = null;
          let parseError = null;
          if (!err && stdout) {
            try {
              const jsonStart = stdout.indexOf("{");
              const cleanOutput = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
              result = JSON.parse(cleanOutput);
              images = result.output?.images || result.images || [];
            } catch (e) {
              parseError = e;
            }
          }

          // Retry on empty images (Gemini returned text-only / FinishReason.STOP)
          if (!err && images.length === 0 && attempt < 3) {
            const reason = result?.output?.description || result?.error || "No images generated (Gemini returned text-only response)";
            console.warn(`[DESIGNER] Nano Banana attempt ${attempt}: no images returned, retrying in 5s. Reason: ${reason.slice(0, 200)}`);
            return setTimeout(() => runInfsh(attempt + 1), 5000);
          }

          try { fs.unlinkSync(tmpInput); } catch {}
          const allTasks = readTaskFile("designer-tasks.json");
          const idx = allTasks.findIndex(t => t.id === task.id);
          if (idx === -1) { resolveBatch(); return; }

          if (err) {
            const detail = stderr ? stderr.replace(/\x1b\[[0-9;]*m/g, '').trim() : err.message;
            console.error("[DESIGNER] Nano Banana failed after retries:", detail.slice(0, 300));
            allTasks[idx].status = "failed";
            allTasks[idx].error = detail.slice(0, 500);
            writeTaskFile("designer-tasks.json", allTasks);
            resolveBatch(); return;
          }

          if (parseError) {
            console.error("[DESIGNER] Nano Banana parse error:", parseError.message);
            allTasks[idx].status = "failed";
            allTasks[idx].error = "Failed to parse output: " + parseError.message.slice(0, 200);
            allTasks[idx].updated_at = new Date().toISOString();
            writeTaskFile("designer-tasks.json", allTasks);
            resolveBatch(); return;
          }

          if (images.length > 0) {
            const imgUrl = images[0];
            const imgDir = path.join(__dirname, "data", "generated-images");
            if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
            const outFile = path.join(imgDir, `nanobanana-${task.id}.png`);

            // Find the brand logo to overlay
            const logoFile = logoFiles.find(f => f.includes("logo"));
            const taskLogoPos = task.logo_position || "SouthEast";
            const SIZE_MAP = { small: "8%", medium: "12%", large: "18%" };
            const logoResize = SIZE_MAP[task.logo_size] || SIZE_MAP.medium;
            if (logoFile && taskLogoPos !== "none") {
              // Download generated image, composite logo
              execFile("curl", ["-s", "-o", outFile, imgUrl], { timeout: 30000 }, (dlErr) => {
                if (dlErr) {
                  // Fallback: use remote URL without logo overlay
                  allTasks[idx].status = "completed";
                  allTasks[idx].result_url = imgUrl;
                  allTasks[idx].result_thumbnail = imgUrl;
                  allTasks[idx].updated_at = new Date().toISOString();
                  writeTaskFile("designer-tasks.json", allTasks);
                  resolveBatch(); return;
                }
                // Composite logo at chosen position with size-mapped resize and 40px padding
                execFile("convert", [
                  outFile,
                  "(", logoFile, "-resize", logoResize, ")",
                  "-gravity", taskLogoPos, "-geometry", "+40+40",
                  "-composite", outFile
                ], { timeout: 15000 }, (compErr) => {
                  if (compErr) console.error("[DESIGNER] Logo composite failed:", compErr.message);
                  allTasks[idx].status = "completed";
                  allTasks[idx].result_url = `/generated-images/nanobanana-${task.id}.png`;
                  allTasks[idx].result_thumbnail = `/generated-images/nanobanana-${task.id}.png`;
                  allTasks[idx].updated_at = new Date().toISOString();
                  writeTaskFile("designer-tasks.json", allTasks);
                  console.log(`[DESIGNER] Nano Banana task ${task.id} completed (with logo overlay)`);
                  resolveBatch();
                });
              });
              return;
            }

            // No logo — just use remote URL
            allTasks[idx].status = "completed";
            allTasks[idx].result_url = imgUrl;
            allTasks[idx].result_thumbnail = imgUrl;
          } else {
            allTasks[idx].status = "failed";
            allTasks[idx].error = result?.output?.description || result?.error || "No images returned after all retries (Gemini FinishReason.STOP — model returned text instead of image)";
          }

        allTasks[idx].updated_at = new Date().toISOString();
        writeTaskFile("designer-tasks.json", allTasks);
        if (allTasks[idx].status === "completed") console.log(`[DESIGNER] Nano Banana task ${task.id} completed`);
        resolveBatch();
        });
      };
      runInfsh(1);
        })));
      }
      // After all batches finish, clean up uploaded reference images
      for (const p of refImagePaths) { try { fs.unlinkSync(p); } catch {} }
    };
    runSlideQueue();
    return;
  }

  if (engine === "claude") {
    // Determine how many slides are needed
    const isCarousel = designType === "instagram_carousel" || slides.length > 1;
    const slideCount = slides.length > 1 ? slides.length : (requestedSlideCount || (isCarousel ? 3 : 1));

    // Build brand guidelines block
    const brandLines = [];
    if (brandContext.colors.length) {
      brandLines.push("BRAND COLORS — apply these as the design's color palette:");
      brandContext.colors.forEach(c => brandLines.push(`  ${c.label || 'Color'}: ${c.hex}`));
    }
    if (brandContext.fonts.length) {
      brandLines.push("BRAND FONTS — use these exact Google Fonts in the design:");
      brandContext.fonts.forEach(f => brandLines.push(`  ${f.role}: ${f.family}`));
    }
    if (brandContext.logos.length) {
      brandLines.push("BRAND LOGOS — you MUST add the logo to every design. Call upload-asset-from-url with these public URLs, then place the logo in the design:");
      const brandAssetBase = process.env.BRAND_ASSET_URL || "";
      brandContext.logos.forEach(l => brandLines.push(`  ${l.name}: ${brandAssetBase}/${brand.toUpperCase()}/${l.name}`));
    }
    const brandBlock = brandLines.length ? brandLines.join("\n") : "";

    // Build the prompt
    let prompt;
    if (isCarousel && slideCount > 1) {
      const slideDescs = slides.length > 1
        ? slides.map(s => `Slide ${s.num}: ${s.title ? s.title + " — " : ""}${s.body}`).join("\n")
        : "";
      prompt = `Create ${slideCount} Instagram carousel slides as SEPARATE Canva designs for brand "${brand}".

You are running NON-INTERACTIVELY. There is NO user to respond. You MUST:
- NEVER call request-outline-review
- NEVER ask the user to choose or approve anything
- ALWAYS pick the first candidate yourself and call create-design-from-candidate immediately
- Complete ALL ${slideCount} slides before stopping

${brandBlock ? "## Brand Guidelines\n" + brandBlock + "\n" : ""}
## Slide Content
${slideDescs || desc}

## For EACH slide, do these 3 steps:
Step 1: Call generate-design with design_type "instagram_post" and a detailed query describing colors, style, and text content for that slide.
Step 2: Immediately call create-design-from-candidate with the FIRST candidate. Do NOT present options. Do NOT ask the user.
Step 3: Edit text — call start-editing-transaction, then get-design-content, then perform-editing-operations to set the correct text, then commit-editing-transaction.
Step 4: If brand logos are listed above, call upload-asset-from-url with the logo URL, then add it to the design via perform-editing-operations (place it top-left or top-right, small size).

After ALL ${slideCount} slides are done, output each design URL on its own line like:
DESIGN_URL: https://...`;
    } else {
      prompt = `Create a ${designType} design in Canva for brand "${brand}".

You are running NON-INTERACTIVELY. There is NO user to respond. You MUST:
- NEVER call request-outline-review
- NEVER ask the user to choose or approve anything
- ALWAYS pick the first candidate yourself and call create-design-from-candidate immediately

${brandBlock ? "## Brand Guidelines\n" + brandBlock + "\n" : ""}
## Content
${desc}

## Steps:
Step 1: Call generate-design with design_type "${designType}" and a detailed query describing colors, style, and text content.
Step 2: Immediately call create-design-from-candidate with the FIRST candidate. Do NOT present options.
Step 3: Edit text — call start-editing-transaction, then get-design-content, then perform-editing-operations to set the correct text, then commit-editing-transaction.
Step 4: If brand logos are listed above, call upload-asset-from-url with the logo URL, then add it to the design via perform-editing-operations (place it top-left or top-right, small size).

Output the final design URL like:
DESIGN_URL: https://...`;
    }

    // Create task(s)
    const parentId = isCarousel ? genId() : null;
    const createdTasks = [];
    for (let i = 0; i < slideCount; i++) {
      createdTasks.push({
        id: genId(), status: "processing",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        design_type: designType, brand, brand_kit_id: brandKitId, engine: "claude",
        carousel_parent: parentId,
        carousel_slide: isCarousel ? i + 1 : null,
        carousel_total: isCarousel ? slideCount : null,
        description: slides.length > 1 ? `Slide ${slides[i]?.num || i + 1}${slides[i]?.title ? " — " + slides[i].title : ""}: ${slides[i]?.body || desc}` : desc,
        result_url: null, result_thumbnail: null, result_design_id: null, error: null,
      });
    }
    tasks.unshift(...createdTasks);
    writeTaskFile("designer-tasks.json", tasks);
    res.status(201).json(createdTasks);

    // Run Claude Code in background
    const child = execFile("/root/.local/bin/claude", ["-p", prompt, "--output-format", "json", "--allowedTools", "mcp__claude_ai_Canva__*"], {
      timeout: 600000,
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, HOME: "/root" },
    }, (err, stdout, stderr) => {
      const allTasks = readTaskFile("designer-tasks.json");
      const taskIds = createdTasks.map(t => t.id);

      if (err) {
        console.error("[DESIGNER] Claude engine failed:", err.message);
        for (const tid of taskIds) {
          const idx = allTasks.findIndex(t => t.id === tid);
          if (idx !== -1) {
            allTasks[idx].status = "failed";
            allTasks[idx].error = err.message.slice(0, 500);
          }
        }
        writeTaskFile("designer-tasks.json", allTasks);
        return;
      }

      // Extract design URLs from output
      const allUrls = [];
      let fullText = stdout;
      try {
        const parsed = JSON.parse(stdout);
        fullText = String(parsed.result || parsed.content || stdout);
      } catch {}

      // First try explicit DESIGN_URL: markers
      const markerMatches = fullText.match(/DESIGN_URL:\s*(https:\/\/[^\s"')\\]+)/gi);
      if (markerMatches && markerMatches.length > 0) {
        for (const m of markerMatches) {
          const url = m.replace(/^DESIGN_URL:\s*/i, '').trim();
          if (!allUrls.includes(url)) allUrls.push(url);
        }
      }

      // Fallback: extract all unique Canva URLs from the full output (including tool results)
      if (allUrls.length === 0) {
        const canvaMatches = fullText.match(/https:\/\/www\.canva\.com\/design\/[^\s"')\\]+/gi)
          || fullText.match(/https:\/\/[^\s"')\\]*canva[^\s"')\\]*/gi)
          || [];
        for (const url of [...new Set(canvaMatches)]) {
          if (!allUrls.includes(url)) allUrls.push(url);
        }
      }

      // Also scan the raw stdout for URLs in tool result blocks (they may contain the actual design URLs)
      if (allUrls.length === 0) {
        const rawMatches = stdout.match(/https:\/\/www\.canva\.com\/design\/[^\s"')\\]+/gi)
          || stdout.match(/https:\/\/[^\s"')\\]*canva[^\s"')\\]*/gi)
          || [];
        for (const url of [...new Set(rawMatches)]) {
          if (!allUrls.includes(url)) allUrls.push(url);
        }
      }

      console.log(`[DESIGNER] Claude output URLs found: ${allUrls.length}`, allUrls);

      // Assign URLs to tasks
      for (let i = 0; i < taskIds.length; i++) {
        const idx = allTasks.findIndex(t => t.id === taskIds[i]);
        if (idx === -1) continue;
        const url = allUrls[i] || (allUrls.length === 1 ? allUrls[0] : null);
        allTasks[idx].status = "completed";
        allTasks[idx].result_url = url;
        allTasks[idx].updated_at = new Date().toISOString();
      }
      // Store full output on first task for debugging
      const firstIdx = allTasks.findIndex(t => t.id === taskIds[0]);
      if (firstIdx !== -1) allTasks[firstIdx].claude_output = stdout.slice(0, 3000);

      writeTaskFile("designer-tasks.json", allTasks);
      console.log(`[DESIGNER] Claude engine completed ${taskIds.length} task(s), found ${allUrls.length} URL(s)`);
    });
    return;
  }

  // Canva engine: carousel split or single task (async via worker)
  if (slides.length > 1) {
    const parentId = genId();
    const globalStyle = desc.substring(0, desc.search(/\*\*\d{1,2}/) || 0).trim();
    const createdTasks = slides.map((s, i) => ({
      id: genId(), status: "pending",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      design_type: designType, brand, brand_kit_id: brandKitId, engine: "canva",
      brand_context: brandContext,
      carousel_parent: parentId,
      carousel_slide: parseInt(s.num) || (i + 1),
      carousel_total: slides.length,
      description: `${globalStyle ? globalStyle + "\n\n" : ""}Slide ${s.num}/${slides.length}${s.title ? " — " + s.title : ""}:\n${s.body || s.title}`,
      result_url: null, result_thumbnail: null, result_design_id: null, error: null,
    }));
    tasks.unshift(...createdTasks);
    writeTaskFile("designer-tasks.json", tasks);
    return res.status(201).json(createdTasks);
  }

  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    design_type: designType, brand, brand_kit_id: brandKitId, engine: "canva",
    brand_context: brandContext,
    description: desc,
    result_url: null, result_thumbnail: null, result_design_id: null, error: null,
  };
  tasks.unshift(task);
  writeTaskFile("designer-tasks.json", tasks);
  res.status(201).json(task);
});

app.patch("/designer/tasks/:id", (req, res) => {
  const tasks = readTaskFile("designer-tasks.json");
  const idx = tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  Object.assign(tasks[idx], req.body, { updated_at: new Date().toISOString() });
  writeTaskFile("designer-tasks.json", tasks);
  res.json(tasks[idx]);
});

app.delete("/designer/tasks/:id", (req, res) => {
  writeTaskFile("designer-tasks.json", readTaskFile("designer-tasks.json").filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

// ── VIDEO TASKS ──────────────────────────────
app.get("/video/tasks", (_req, res) => res.json(readTaskFile("video-tasks.json")));

app.post("/video/tasks", (req, res) => {
  const tasks = readTaskFile("video-tasks.json");
  const brandContext = loadBrandContext(req.body.brand);
  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    template: req.body.template || "social-clip",
    aspect_ratio: req.body.aspect_ratio || "9:16",
    brand: brandContext.name,
    brand_context: brandContext,
    description: req.body.description || "",
    scenes_override: req.body.scenes_override || null,
    media_files: req.body.media_files || [],
    result_url: null, error: null,
  };
  tasks.unshift(task);
  writeTaskFile("video-tasks.json", tasks);
  res.status(201).json(task);
});

app.patch("/video/tasks/:id", (req, res) => {
  const tasks = readTaskFile("video-tasks.json");
  const idx = tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  Object.assign(tasks[idx], req.body, { updated_at: new Date().toISOString() });
  writeTaskFile("video-tasks.json", tasks);
  res.json(tasks[idx]);
});

app.delete("/video/tasks/:id", (req, res) => {
  writeTaskFile("video-tasks.json", readTaskFile("video-tasks.json").filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

// ── AI VIDEO GENERATION (inference.sh) ────────────────
const aiVideoUpload = require("multer")({
  storage: require("multer").diskStorage({
    destination: path.join(__dirname, "data", "ai-video-uploads"),
    filename: (_req, file, cb) => cb(null, Date.now() + path.extname(file.originalname || ".png")),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.get("/video/ai-generate", (_req, res) => res.json(readTaskFile("ai-video-tasks.json")));

app.post("/video/ai-generate", aiVideoUpload.single("ref_image"), (req, res) => {
  const tasks = readTaskFile("ai-video-tasks.json");
  const model = req.body.model || "google/veo-3";
  const prompt = req.body.prompt || "";
  // aspect_ratio is optional — some providers (e.g. Seedance) don't accept it.
  // Front-end omits the field when the model has no supported ratios.
  const aspectRatio = (req.body.aspect_ratio || "").trim() || null;
  const duration = parseInt(req.body.duration) || 8;
  const refImagePath = req.file ? req.file.path : null;
  const brandContext = loadBrandContext(req.body.brand);

  const task = {
    id: genId(), status: "processing",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    model, prompt, aspect_ratio: aspectRatio, duration,
    brand: brandContext.name,
    brand_context: brandContext,
    ref_image: refImagePath ? true : false,
    result_url: null, error: null,
  };
  tasks.unshift(task);
  writeTaskFile("ai-video-tasks.json", tasks);
  res.status(201).json(task);

  // Build infsh input. Inference.sh apps with `format: "file"` fields (Kling,
  // Seedance, Veo, Wan, etc.) expect a local file path or public URL — the CLI
  // uploads the file itself. Passing a base64 data URL is rejected with
  // "[1201] File is not in a valid base64 format".
  const inputObj = { prompt };
  if (aspectRatio) inputObj.aspect_ratio = aspectRatio;
  if (duration) inputObj.duration = duration;
  let resizedPath = null;
  if (refImagePath && fs.existsSync(refImagePath)) {
    // Resize / re-encode to JPEG max 1024px to satisfy provider size limits
    // (Kling caps at 10MB). Falls back to the original file on failure.
    resizedPath = refImagePath.replace(/\.\w+$/, "-resized.jpg");
    try {
      require("child_process").execSync(
        `convert "${refImagePath}" -resize "1024x1024>" -quality 85 "${resizedPath}"`,
        { timeout: 15000 }
      );
      inputObj.image = resizedPath;
    } catch (resizeErr) {
      console.error("[AI-VIDEO] Image resize failed, using original:", resizeErr.message);
      resizedPath = null;
      inputObj.image = refImagePath;
    }
  }

  const tmpInput = path.join(__dirname, "data", `ai-vid-input-${task.id}.json`);
  fs.writeFileSync(tmpInput, JSON.stringify(inputObj));

  execFile("infsh", ["app", "run", model, "--input", tmpInput, "--json"], {
    timeout: 600000,  // 10 min — video gen can be slow
    maxBuffer: 1024 * 1024 * 50,
    env: { ...process.env, HOME: "/root" },
  }, (err, stdout, stderr) => {
    try { fs.unlinkSync(tmpInput); } catch {}
    if (refImagePath) try { fs.unlinkSync(refImagePath); } catch {}
    if (resizedPath) try { fs.unlinkSync(resizedPath); } catch {}

    const allTasks = readTaskFile("ai-video-tasks.json");
    const idx = allTasks.findIndex(t => t.id === task.id);
    if (idx === -1) return;

    if (err) {
      console.error("[AI-VIDEO] Generation failed:", err.message, stderr?.substring(0, 200));
      allTasks[idx].status = "failed";
      const errText = (stderr || "").replace(/\x1b\[[0-9;]*m/g, "").trim() || err.message || "Unknown error";
      allTasks[idx].error = errText.slice(0, 500);
      allTasks[idx].updated_at = new Date().toISOString();
      writeTaskFile("ai-video-tasks.json", allTasks);
      return;
    }

    try {
      // Strip ANSI codes and find JSON (object or array)
      const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, "");
      const jsonStart = Math.min(
        ...[stripped.indexOf("{"), stripped.indexOf("[")].filter(i => i >= 0).concat([Infinity])
      );
      if (jsonStart === Infinity) throw new Error("No JSON in output: " + stripped.substring(0, 200));
      const cleanOutput = stripped.slice(jsonStart);
      const result = JSON.parse(cleanOutput);

      // Extract video URL — different models return in different formats
      const output = result.output || result;
      const videoUrl = output.video || output.video_url || output.url
        || (output.videos && output.videos[0])
        || (output.files && output.files[0])
        || null;

      if (videoUrl) {
        allTasks[idx].status = "completed";
        allTasks[idx].result_url = videoUrl;
        console.log(`[AI-VIDEO] Task ${task.id} completed: ${videoUrl}`);
      } else {
        // Try to find any URL in the output
        const urlMatch = JSON.stringify(output).match(/https?:\/\/[^\s"']+\.(mp4|webm|mov)[^\s"']*/i);
        if (urlMatch) {
          allTasks[idx].status = "completed";
          allTasks[idx].result_url = urlMatch[0];
          console.log(`[AI-VIDEO] Task ${task.id} completed (extracted): ${urlMatch[0]}`);
        } else {
          allTasks[idx].status = "failed";
          const errMsg = typeof result.error === "string" ? result.error : (result.error ? JSON.stringify(result.error) : result.status_text || "No video URL in output");
          allTasks[idx].error = errMsg.slice(0, 500);
          console.error("[AI-VIDEO] No video URL found in:", JSON.stringify(output).slice(0, 500));
        }
      }
    } catch (e) {
      console.error("[AI-VIDEO] Parse error:", e.message);
      allTasks[idx].status = "failed";
      allTasks[idx].error = "Failed to parse output: " + e.message.slice(0, 200);
    }

    allTasks[idx].updated_at = new Date().toISOString();
    writeTaskFile("ai-video-tasks.json", allTasks);
  });
});

app.delete("/video/ai-generate/:id", (req, res) => {
  writeTaskFile("ai-video-tasks.json", readTaskFile("ai-video-tasks.json").filter(t => t.id !== req.params.id));
  res.json({ ok: true });
});



// ── SCRIPTWRITER TASKS ────────────────────────
app.get("/scriptwriter/tasks", (_req, res) => res.json(readTaskFile("scriptwriter-tasks.json")));

app.post("/scriptwriter/tasks", (req, res) => {
  const tasks = readTaskFile("scriptwriter-tasks.json");
  const brandContext = loadBrandContext(req.body.brand);
  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    type: req.body.type || "video_script",
    topic: req.body.topic || "",
    format: req.body.format || "short-form",
    tone: req.body.tone || "educational",
    description: req.body.description || "",
    brand: brandContext.name,
    brand_context: brandContext,
    result: null, error: null,
  };
  tasks.unshift(task);
  writeTaskFile("scriptwriter-tasks.json", tasks);
  res.status(201).json(task);
});

app.patch("/scriptwriter/tasks/:id", (req, res) => {
  const tasks = readTaskFile("scriptwriter-tasks.json");
  const idx = tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  Object.assign(tasks[idx], req.body, { updated_at: new Date().toISOString() });
  writeTaskFile("scriptwriter-tasks.json", tasks);
  res.json(tasks[idx]);
});

app.delete("/scriptwriter/tasks/:id", (req, res) => {
  writeTaskFile("scriptwriter-tasks.json", readTaskFile("scriptwriter-tasks.json").filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

// ── COMMUNITY MANAGER: CHANNELS ───────────────
app.get("/community/channels", (_req, res) => res.json(readChannels()));

app.post("/community/channels", (req, res) => {
  const channels = readChannels();
  const id = (req.body.id || genId()).toString().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (channels.some(c => c.id === id)) return res.status(409).json({ error: "Channel id already exists" });
  const platform = ["discord", "twitter"].includes(req.body.platform) ? req.body.platform : "telegram";
  const channel = {
    id,
    name: req.body.name || "Unnamed channel",
    platform,
    chat_id: req.body.chat_id || "",
    topic_id: req.body.topic_id || "",
    guild_id: req.body.guild_id || "",
    webhook_url: req.body.webhook_url || "",
    archetype_set: req.body.archetype_set || "",
    enabled: req.body.enabled !== false,
    review: {
      enabled: req.body.review?.enabled !== false,
      day: req.body.review?.day || "sunday",
      time: req.body.review?.time || "18:00",
      dm_chat_id: req.body.review?.dm_chat_id || "",
    },
    schedule_window_days: Number(req.body.schedule_window_days) || 7,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  channels.push(channel);
  writeChannels(channels);
  res.status(201).json(channel);
});

app.patch("/community/channels/:id", (req, res) => {
  const channels = readChannels();
  const idx = channels.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const current = channels[idx];
  const next = { ...current, ...req.body, id: current.id, updated_at: new Date().toISOString() };
  if (req.body.review) next.review = { ...current.review, ...req.body.review };
  channels[idx] = next;
  writeChannels(channels);
  res.json(next);
});

app.delete("/community/channels/:id", (req, res) => {
  const channels = readChannels().filter(c => c.id !== req.params.id);
  writeChannels(channels);
  res.json({ ok: true });
});

// Validate a channel's configured chat (Telegram only)
app.post("/community/channels/:id/validate", async (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.status(404).json({ ok: false, error: "Channel not found" });
  if (channel.platform === "twitter") {
    try {
      const me = await twitterVerifyCredentials();
      const usage = twitterUsageSummary();
      return res.json({ ok: true, title: `@${me.username}`, type: "X account", usage });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  }
  if (channel.platform !== "telegram") {
    return res.status(400).json({ ok: false, error: `Validation not available for ${channel.platform}` });
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !channel.chat_id) return res.status(400).json({ ok: false, error: "TELEGRAM_BOT_TOKEN or channel.chat_id missing" });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(channel.chat_id)}`);
    const d = await r.json();
    if (!d.ok) return res.status(400).json({ ok: false, error: d.description });
    res.json({ ok: true, title: d.result.title, type: d.result.type, chat_id: channel.chat_id, topic_id: channel.topic_id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Twitter/X monthly post usage (free tier = 500 writes/month)
app.get("/community/twitter/usage", (_req, res) => res.json(twitterUsageSummary()));

// ── COMMUNITY MANAGER: ARCHETYPE SETS ─────────
app.get("/community/archetype-sets", (_req, res) => {
  const names = listArchetypeSets();
  res.json(names.map(name => ({ name, channels: channelsUsingArchetypeSet(name) })));
});

app.get("/community/archetype-sets/:name", (req, res) => {
  try {
    res.json({
      name: sanitizeSetName(req.params.name),
      content: readArchetypeSet(req.params.name),
      channels: channelsUsingArchetypeSet(req.params.name),
    });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.put("/community/archetype-sets/:name", (req, res) => {
  try {
    writeArchetypeSet(req.params.name, req.body?.content || "");
    res.json({ ok: true, name: sanitizeSetName(req.params.name) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch("/community/archetype-sets/:name", (req, res) => {
  try {
    const { new_name, channel_ids } = req.body || {};
    let currentName = sanitizeSetName(req.params.name);
    if (new_name && sanitizeSetName(new_name) !== currentName) {
      currentName = renameArchetypeSet(currentName, new_name);
    }
    if (Array.isArray(channel_ids)) {
      const wanted = new Set(channel_ids);
      const channels = readChannels();
      let dirty = false;
      for (const c of channels) {
        const currentlyLinked = c.archetype_set === currentName;
        const shouldBeLinked = wanted.has(c.id);
        if (shouldBeLinked && !currentlyLinked) { c.archetype_set = currentName; c.updated_at = new Date().toISOString(); dirty = true; }
        else if (!shouldBeLinked && currentlyLinked) { c.archetype_set = null; c.updated_at = new Date().toISOString(); dirty = true; }
      }
      if (dirty) writeChannels(channels);
    }
    res.json({ ok: true, name: currentName, channels: channelsUsingArchetypeSet(currentName) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/community/archetype-sets/:name", (req, res) => {
  try { deleteArchetypeSet(req.params.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── COMMUNITY MANAGER: TASKS ──────────────────
app.get("/community/tasks", (req, res) => {
  const all = readTaskFile(COMMUNITY_TASKS_FILE);
  const filtered = req.query.channel_id ? all.filter(t => t.channel_id === req.query.channel_id) : all;
  res.json(filtered);
});

app.get("/community-manager/tasks", (_req, res) => {
  res.json(readTaskFile("community-manager-tasks.json"));
});

// Generate drafts for a channel right now — same engine as the weekly scheduler,
// but triggered manually from the UI. Fire-and-forget; poll /community-manager/tasks
// (schedule_id match) for progress.
const communityGenerating = new Set();
app.post("/community/generate", (req, res) => {
  const channelId = req.body?.channel_id;
  if (!channelId) return res.status(400).json({ error: "channel_id required" });
  const channel = getChannel(channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  if (channel.enabled === false) return res.status(400).json({ error: "Channel is disabled" });
  if (!channel.archetype_set) return res.status(400).json({ error: "Channel has no archetype set assigned" });
  if (communityGenerating.has(channelId)) return res.status(409).json({ error: "Generation already running for this channel" });

  const syntheticSchedule = {
    id: `manual-${genId()}`,
    name: `Generate Posts — ${channel.name}`,
    payload: {
      channel_id: channelId,
      post_count: req.body?.post_count,
      language: req.body?.language || process.env.LANGUAGE || "NL",
      notify: req.body?.notify === true,
    },
  };
  communityGenerating.add(channelId);
  executeCommunityManagerSchedule(syntheticSchedule, new Date())
    .catch((e) => console.error(`[COMMUNITY] Manual generation for ${channelId} failed: ${e.message}`))
    .finally(() => communityGenerating.delete(channelId));
  res.status(202).json({ ok: true, started: true, schedule_id: syntheticSchedule.id, channel_id: channelId });
});

app.post("/community/tasks", (req, res) => {
  const tasks = readTaskFile(COMMUNITY_TASKS_FILE);
  const allowedStatus = ["draft", "scheduled", "manual"];
  const status = allowedStatus.includes(req.body.status) ? req.body.status : "draft";
  const channels = readChannels();
  const channel_id = req.body.channel_id || (channels[0] && channels[0].id) || null;
  if (!channel_id) return res.status(400).json({ error: "No channels configured; create a channel first" });
  if (!channels.some(c => c.id === channel_id)) return res.status(400).json({ error: `Unknown channel_id: ${channel_id}` });
  const mediaPaths = Array.isArray(req.body.media_paths) ? req.body.media_paths.filter(Boolean) : [];
  const mediaPath = req.body.media_path || mediaPaths[0] || null;
  const task = {
    id: req.body.id || genId(),
    channel_id,
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    scheduled_at: req.body.scheduled_at || new Date().toISOString(),
    scheduled_local: req.body.scheduled_local || null,
    archetype: req.body.archetype || null,
    trigger_word: req.body.trigger_word || null,
    media_path: mediaPath,
    media_paths: mediaPaths,
    text: req.body.text || "",
    published_at: null,
    message_id: null,
    attempts: 0,
    error: null,
  };
  tasks.push(task);
  writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
  res.status(201).json(task);
});

app.patch("/community/tasks/:id", (req, res) => {
  const tasks = readTaskFile(COMMUNITY_TASKS_FILE);
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  Object.assign(tasks[idx], req.body, { updated_at: new Date().toISOString() });
  writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
  res.json(tasks[idx]);
});

app.delete("/community/tasks/:id", (req, res) => {
  writeTaskFile(COMMUNITY_TASKS_FILE, readTaskFile(COMMUNITY_TASKS_FILE).filter(t => t.id !== req.params.id));
  res.json({ ok: true });
});

app.post("/community/tasks/:id/publish-now", async (req, res) => {
  const tasks = readTaskFile(COMMUNITY_TASKS_FILE);
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  if (task.status === "published") return res.status(400).json({ error: "Already published" });
  try {
    const channel = getChannel(task.channel_id);
    const result = await publishToChannel(task, channel);
    task.status = "published";
    task.published_at = new Date().toISOString();
    task.message_id = result.message_id;
    task.attempts = (task.attempts || 0) + 1;
    task.updated_at = task.published_at;
    task.error = null;
    writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
    res.json({ ok: true, message_id: result.message_id });
  } catch (e) {
    task.attempts = (task.attempts || 0) + 1;
    task.error = e.message;
    task.updated_at = new Date().toISOString();
    writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/community/send-review", async (req, res) => {
  try {
    const count = await sendCommunityReviewBatch({ channel_id: req.body?.channel_id || null, force: true });
    res.json({ ok: true, sent: count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const INSTALL_DIR = process.env.INSTALL_DIR || path.join(__dirname, "..");

// ── RESEARCH TASKS ────────────────────────────
app.get("/research/tasks", (_req, res) => res.json(readTaskFile("research-tasks.json")));

app.post("/research/tasks", (req, res) => {
  const tasks = readTaskFile("research-tasks.json");
  const brandContext = loadBrandContext(req.body.brand);
  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    type: req.body.type || "trending",
    query: req.body.query || "",
    platforms: req.body.platforms || ["tiktok", "x", "reddit"],
    niche: req.body.niche || "crypto trading",
    language: req.body.language || "NL",
    brand: brandContext.name,
    brand_context: brandContext,
    error: null,
  };
  tasks.unshift(task);
  writeTaskFile("research-tasks.json", tasks);
  res.status(201).json(task);
});

app.patch("/research/tasks/:id", (req, res) => {
  const tasks = readTaskFile("research-tasks.json");
  const idx = tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  Object.assign(tasks[idx], req.body, { updated_at: new Date().toISOString() });
  writeTaskFile("research-tasks.json", tasks);
  res.json(tasks[idx]);
});

app.delete("/research/tasks/:id", (req, res) => {
  writeTaskFile("research-tasks.json", readTaskFile("research-tasks.json").filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

// Daily auto-research: trigger manually or via cron
app.post("/research/daily", (_req, res) => {
  const tasks = readTaskFile("research-tasks.json");
  const today = new Date().toISOString().slice(0, 10);

  // Check if already ran today
  const alreadyRan = tasks.some(t => t.type === "daily" && t.created_at?.startsWith(today));
  if (alreadyRan) return res.json({ ok: false, message: "Daily research already ran today" });

  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    type: "daily",
    query: `Daily crypto & trading research — ${today}. Onderzoek de belangrijkste crypto ontwikkelingen, marktbewegingen, trending topics op X/Reddit/TikTok, en genereer concrete content suggesties voor Instagram en Twitter.`,
    platforms: ["x", "reddit", "tiktok", "coingecko", "coinmarketcap"],
    niche: "crypto trading",
    language: "NL",
    error: null,
  };
  tasks.unshift(task);
  writeTaskFile("research-tasks.json", tasks);
  console.log(`[RESEARCH] Daily research triggered for ${today}`);
  res.status(201).json(task);
});

// Research reports (results)
app.get("/research/reports", (_req, res) => res.json(readTaskFile("research-reports.json")));

app.post("/research/reports", (req, res) => {
  const reports = readTaskFile("research-reports.json");
  const report = {
    id: genId(),
    task_id: req.body.task_id || null,
    created_at: new Date().toISOString(),
    type: req.body.type || "daily",
    title: req.body.title || "",
    sections: req.body.sections || [],
  };
  reports.unshift(report);
  if (reports.length > 30) reports.length = 30; // keep last 30
  writeTaskFile("research-reports.json", reports);
  res.status(201).json(report);
});

app.delete("/research/reports/:id", (req, res) => {
  writeTaskFile("research-reports.json", readTaskFile("research-reports.json").filter((r) => r.id !== req.params.id));
  res.json({ ok: true });
});

// ── SEO AUDIT ─────────────────────────────────
app.get("/seo/tasks", (_req, res) => res.json(readTaskFile("seo-tasks.json")));

app.post("/seo/tasks", (req, res) => {
  const rawUrl = (req.body.url || "").trim();
  if (!rawUrl) return res.status(400).json({ error: "url is required" });
  let normalised;
  try {
    normalised = new URL(rawUrl.match(/^https?:\/\//i) ? rawUrl : `https://${rawUrl}`).toString();
  } catch { return res.status(400).json({ error: "Invalid URL" }); }

  const tasks = readTaskFile("seo-tasks.json");
  const task = {
    id: genId(),
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    url: normalised,
    max_pages: Math.min(Math.max(parseInt(req.body.max_pages, 10) || 25, 1), 100),
    language: req.body.language || process.env.LANGUAGE || "EN",
    error: null,
  };
  tasks.unshift(task);
  if (tasks.length > 50) tasks.length = 50;
  writeTaskFile("seo-tasks.json", tasks);
  res.status(201).json(task);
});

app.delete("/seo/tasks/:id", (req, res) => {
  writeTaskFile("seo-tasks.json", readTaskFile("seo-tasks.json").filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

app.get("/seo/reports", (_req, res) => res.json(readTaskFile("seo-reports.json")));

app.get("/seo/reports/:id", (req, res) => {
  const reports = readTaskFile("seo-reports.json");
  const report = reports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: "Not found" });
  res.json(report);
});

app.delete("/seo/reports/:id", (req, res) => {
  writeTaskFile("seo-reports.json", readTaskFile("seo-reports.json").filter((r) => r.id !== req.params.id));
  res.json({ ok: true });
});

// ── OPUSCLIP TASKS ────────────────────────────
app.get("/opusclip/tasks", (_req, res) => res.json(readTaskFile("opusclip-tasks.json")));

app.post("/opusclip/tasks", (req, res) => {
  const rawUrl = (req.body.video_url || req.body.url || "").trim();
  if (!rawUrl) return res.status(400).json({ error: "video_url is required" });
  let normalised;
  try {
    normalised = new URL(rawUrl.match(/^https?:\/\//i) ? rawUrl : `https://${rawUrl}`).toString();
  } catch { return res.status(400).json({ error: "Invalid URL" }); }
  if (!process.env.OPUSCLIP_API_KEY) {
    return res.status(400).json({ error: "OpusClip API key not configured. Add it in Settings." });
  }

  const tasks = readTaskFile("opusclip-tasks.json");
  const minD = parseInt(req.body.min_duration, 10);
  const maxD = parseInt(req.body.max_duration, 10);
  const task = {
    id: genId(),
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    video_url: normalised,
    min_duration: Number.isFinite(minD) && minD > 0 ? minD : 30,
    max_duration: Number.isFinite(maxD) && maxD > 0 ? maxD : 90,
    source_lang: req.body.source_lang || "auto",
    topic_keywords: Array.isArray(req.body.topic_keywords) ? req.body.topic_keywords : [],
    description: (req.body.description || "").toString().slice(0, 200),
    project_id: null,
    stage: null,
    clips: [],
    error: null,
  };
  tasks.unshift(task);
  if (tasks.length > 50) tasks.length = 50;
  writeTaskFile("opusclip-tasks.json", tasks);
  res.status(201).json(task);
});

app.delete("/opusclip/tasks/:id", (req, res) => {
  writeTaskFile("opusclip-tasks.json", readTaskFile("opusclip-tasks.json").filter(t => t.id !== req.params.id));
  res.json({ ok: true });
});

// ── UGC TASKS (Higgsfield) ───────────────────────────────────────────
app.get("/ugc/tasks", (_req, res) => res.json(readTaskFile("ugc-tasks.json")));

app.post("/ugc/tasks", (req, res) => {
  const b = req.body || {};
  const mode = b.mode === "speak" ? "speak" : "clip";
  const tasks = readTaskFile("ugc-tasks.json");
  const task = {
    id: "ugc_" + Date.now().toString(36),
    status: "pending",
    mode,
    image_url: b.image_url || "",
    prompt: b.prompt || "",
    script: b.script || "",
    model: b.model || "dop-lite",
    motion_id: b.motion_id || "",
    voice_id: b.voice_id || "",
    speak_model: b.speak_model || "higgsfield",
    avatar_prompt: b.avatar_prompt || "",
    avatar_request_id: "",
    audio_url: b.audio_url || "",
    audio_duration: 0,
    public_origin: detectPublicOrigin(req).origin || "",
    brand: b.brand || "",
    description: b.description || "",
    request_id: "",
    result_url: "",
    created_at: new Date().toISOString(),
  };
  tasks.unshift(task);
  if (tasks.length > 50) tasks.length = 50;
  writeTaskFile("ugc-tasks.json", tasks);
  res.json({ ok: true, task });
});

app.patch("/ugc/tasks/:id", (req, res) => {
  const tasks = readTaskFile("ugc-tasks.json");
  const t = tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  Object.assign(t, req.body || {});
  writeTaskFile("ugc-tasks.json", tasks);
  res.json({ ok: true, task: t });
});

app.delete("/ugc/tasks/:id", (req, res) => {
  writeTaskFile("ugc-tasks.json", readTaskFile("ugc-tasks.json").filter(x => x.id !== req.params.id));
  res.json({ ok: true });
});

// ── UGC MOTIONS (Higgsfield) — cached list for the Clip-mode dropdown ─
let _ugcMotionsCache = null, _ugcMotionsAt = 0;
app.get("/ugc/motions", async (_req, res) => {
  try {
    if (_ugcMotionsCache && Date.now() - _ugcMotionsAt < 3600000) return res.json(_ugcMotionsCache);
    const r = await fetch(HIGGSFIELD.base + HIGGSFIELD.endpoints.motions, { headers: higgsfieldHeaders() });
    const data = await r.json();
    const list = Array.isArray(data) ? data.map(m => ({ id: m.id, name: m.name })) : [];
    if (list.length) { _ugcMotionsCache = list; _ugcMotionsAt = Date.now(); }
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UGC VOICES (ElevenLabs) — for the Talking-Avatar voice dropdown ──
app.get("/ugc/voices", async (_req, res) => {
  try {
    const key = (process.env.ELEVENLABS_API_KEY || "").trim();
    if (!key) return res.json([]);
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    const data = await r.json();
    const list = Array.isArray(data.voices) ? data.voices.map(v => ({ id: v.voice_id, name: v.name })) : [];
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UGC AVATAR LIBRARY (Higgsfield Soul portraits) ──────────────────
// Create reusable avatar portraits from a prompt; the Talking Avatar mode
// selects them by their generated image URL.
app.get("/ugc/avatars", (_req, res) => res.json(readTaskFile("ugc-avatars.json")));

app.post("/ugc/avatars", async (req, res) => {
  const b = req.body || {};
  const prompt = (b.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  try {
    const r = await fetch(HIGGSFIELD.base + HIGGSFIELD.endpoints.text2image, {
      method: "POST", headers: higgsfieldHeaders(),
      body: JSON.stringify({ params: { prompt, width_and_height: HIGGSFIELD.avatarSize } }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: (data && data.detail ? JSON.stringify(data.detail) : JSON.stringify(data)).slice(0, 300) });
    const request_id = data.id || data.job_set_id || (data.job_set && data.job_set.id) || "";
    if (!request_id) return res.status(502).json({ error: "no job-set id: " + JSON.stringify(data).slice(0, 200) });
    const avatars = readTaskFile("ugc-avatars.json");
    const avatar = { id: "av_" + Date.now().toString(36), name: b.name || "Avatar", prompt, status: "processing", request_id, image_url: "", created_at: new Date().toISOString() };
    avatars.unshift(avatar);
    if (avatars.length > 100) avatars.length = 100;
    writeTaskFile("ugc-avatars.json", avatars);
    res.json({ ok: true, avatar });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/ugc/avatars/:id", (req, res) => {
  writeTaskFile("ugc-avatars.json", readTaskFile("ugc-avatars.json").filter(x => x.id !== req.params.id));
  res.json({ ok: true });
});

// ── UGC IMAGE UPLOAD PROXY ──────────────────────────────────────────
app.post("/ugc/upload", async (req, res) => {
  try {
    const { image_base64, format } = req.body || {};
    if (!image_base64) return res.status(400).json({ error: "image_base64 required" });
    const r = await fetch(HIGGSFIELD.base + HIGGSFIELD.endpoints.upload, {
      method: "POST", headers: higgsfieldHeaders(),
      body: JSON.stringify({ image: image_base64, format: format || "jpeg" }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: "upload failed", detail: data });
    res.json({ url: data.url || data.image_url || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MEDIA LIBRARY ─────────────────────────────
const MEDIA_DIR = path.join(__dirname, "public", "media");

app.get("/media/list", (_req, res) => {
  try {
    const files = fs.readdirSync(MEDIA_DIR)
      .filter(f => !f.startsWith("."))
      .map(f => {
        const stat = fs.statSync(path.join(MEDIA_DIR, f));
        const ext = path.extname(f).toLowerCase();
        const type = [".mp4",".mov",".webm",".avi"].includes(ext) ? "video"
                   : [".mp3",".wav",".ogg",".aac"].includes(ext) ? "audio"
                   : [".jpg",".jpeg",".png",".gif",".webp",".svg"].includes(ext) ? "image"
                   : "other";
        return { name: f, size: stat.size, type, modified: stat.mtime.toISOString(), path: "/media/" + f };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json(files);
  } catch { res.json([]); }
});

// ── BRAND ASSETS ──
const BRAND_ASSETS_DIR = path.join(__dirname, "data", "brand-assets");
if (!fs.existsSync(BRAND_ASSETS_DIR)) fs.mkdirSync(BRAND_ASSETS_DIR, { recursive: true });
app.use("/brand-assets", express.static(BRAND_ASSETS_DIR));

// ── SETTINGS / INTEGRATIONS ──────────────────────────────
app.get("/settings/integrations", (_req, res) => {
  const integrations = [];

  // 1. Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
  integrations.push({
    id: "anthropic", status: anthropicKey ? "connected" : "not-configured",
    details: [
      { label: "API Key", value: anthropicKey, secret: true },
      { label: "Model", value: "claude-sonnet-4-6" },
      { label: "Used by", value: "AI Chat, Research, Analyst, Designer (Claude engine)" },
    ],
  });

  // 3. Stripe
  const stripeKey = process.env.STRIPE_SECRET_KEY || "";
  integrations.push({
    id: "stripe", status: stripeKey ? "connected" : "not-configured",
    details: [
      { label: "Secret Key", value: stripeKey, secret: true },
      { label: "Mode", value: stripeKey.startsWith("sk_live") ? "LIVE" : stripeKey.startsWith("sk_test") ? "TEST" : "—" },
      { label: "Used by", value: "Performance page — revenue & subscriptions" },
    ],
  });

  // 4. Canva (Connect API via customer's Canva Developer App)
  const canvaClientId = process.env.CANVA_CLIENT_ID || "";
  const canvaClientSecret = process.env.CANVA_CLIENT_SECRET || "";
  let canvaStatus = "not-configured";
  let canvaDetails = [
    { label: "Client ID", value: canvaClientId || "—", secret: !!canvaClientId },
    { label: "Client Secret", value: canvaClientSecret ? "•••" : "—" },
    { label: "OAuth", value: canvaClientId && canvaClientSecret ? "Awaiting authorization" : "Not configured" },
    { label: "Used by", value: "Designer (brand templates lookup)" },
  ];
  let canvaActions = [];
  if (canvaClientId && canvaClientSecret) {
    let hasToken = false, expired = false, expiresAt = null;
    try {
      const canvaTokens = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "canva-oauth.json"), "utf8"));
      hasToken = !!canvaTokens.access_token;
      expired = !!(canvaTokens.expires_at && canvaTokens.expires_at < Date.now());
      expiresAt = canvaTokens.expires_at || null;
    } catch {}
    canvaStatus = hasToken && !expired ? "connected" : "not-configured";
    canvaDetails = [
      { label: "Client ID", value: canvaClientId, secret: true },
      { label: "Client Secret", value: "•••" },
      { label: "OAuth", value: hasToken ? (expired ? "Expired — re-authorize" : "Authorized") : "Not authorized" },
      { label: "Expires", value: expiresAt ? new Date(expiresAt).toLocaleString() : "—" },
      { label: "Used by", value: "Designer (brand templates lookup)" },
    ];
    canvaActions.push({
      type: "oauth-popup",
      url: "/canva/connect",
      label: hasToken && !expired ? "Reconnect Canva" : "Connect Canva",
    });
  }
  integrations.push({ id: "canva", status: canvaStatus, details: canvaDetails, actions: canvaActions });

  // 5. Telegram
  integrations.push({
    id: "telegram", status: TG_TOKEN ? "connected" : "not-configured",
    details: TG_TOKEN ? [
      { label: "Bot Token", value: TG_TOKEN, secret: true },
      { label: "Used by", value: "Task completion notifications" },
    ] : [{ label: "Status", value: "Set TELEGRAM_BOT_TOKEN in .env to enable" }],
  });

  // 6. Inference.sh (Nano Banana)
  let infshStatus = "not-configured";
  try {
    const infshConfig = fs.readFileSync(path.join(process.env.HOME || "/root", ".inferencesh", "config.json"), "utf8");
    const parsed = JSON.parse(infshConfig);
    infshStatus = parsed.api_key || parsed.token ? "connected" : "not-configured";
  } catch {}
  integrations.push({
    id: "inference", status: infshStatus,
    details: [
      { label: "CLI", value: "infsh (inference.sh)" },
      { label: "Model", value: "google/gemini-3-1-flash-image-preview" },
      { label: "Used by", value: "Designer (Nano Banana engine)" },
    ],
  });

  // 7. Composio
  const composioKey = process.env.COMPOSIO_API_KEY || "";
  integrations.push({
    id: "composio", status: composioKey ? "connected" : "not-configured",
    details: [
      { label: "API Key", value: composioKey, secret: true },
      { label: "Endpoint", value: "https://backend.composio.dev/api/v2" },
      { label: "Used by", value: "Tool integrations — GitHub, Slack, Gmail, Calendar & more" },
    ],
  });

  // 8. OpusClip
  const opusclipKey = process.env.OPUSCLIP_API_KEY || "";
  integrations.push({
    id: "opusclip", status: opusclipKey ? "connected" : "not-configured",
    details: [
      { label: "API Key", value: opusclipKey, secret: true },
      { label: "Endpoint", value: "https://api.opus.pro" },
      { label: "Used by", value: "Content Creator — Clipper tab (long-form → short-form clips)" },
    ],
  });

  // 9. Higgsfield
  const higgsfieldKey = process.env.HIGGSFIELD_API_KEY || "";
  integrations.push({
    id: "higgsfield", status: higgsfieldKey ? "connected" : "not-configured",
    details: [
      { label: "API Key", value: higgsfieldKey, secret: true },
      { label: "Endpoint", value: "https://platform.higgsfield.ai" },
      { label: "Used by", value: "UGC video generation — image-to-video and talking avatar" },
    ],
  });

  res.json({ integrations });
});

app.post("/settings/integrations/:id/test", async (req, res) => {
  const { id } = req.params;
  try {
    if (id === "anthropic") {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic();
      const msg = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "ping" }] });
      res.json({ ok: true, message: `Model responded (${msg.usage.input_tokens + msg.usage.output_tokens} tokens)` });
    } else if (id === "stripe") {
      const bal = await stripe.balance.retrieve();
      const amount = (bal.available?.[0]?.amount || 0) / 100;
      res.json({ ok: true, message: `Balance: €${amount.toFixed(2)}` });
    } else if (id === "canva") {
      if (!process.env.CANVA_CLIENT_ID || !process.env.CANVA_CLIENT_SECRET) {
        return res.json({ ok: false, message: "Client ID/Secret not configured" });
      }
      const token = await getCanvaAccessToken();
      if (!token) return res.json({ ok: false, message: "Not authorized — click Connect Canva" });
      const r = await fetch("https://api.canva.com/rest/v1/users/me", { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return res.json({ ok: false, message: `API call failed (${r.status})` });
      const d = await r.json();
      res.json({ ok: true, message: d?.team_user?.user_id ? `Authorized as ${d.team_user.user_id}` : "Authorized" });
    } else if (id === "telegram") {
      if (!TG_TOKEN) return res.json({ ok: false, message: "TELEGRAM_BOT_TOKEN not set in .env" });
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`);
      const d = await r.json();
      res.json({ ok: d.ok, message: d.ok ? `Bot: @${d.result.username}` : "Auth failed" });
    } else if (id === "composio") {
      const r = await fetch("https://backend.composio.dev/api/v2/connectedAccounts?limit=1", {
        headers: { "X-API-Key": process.env.COMPOSIO_API_KEY || "" },
      });
      const d = await r.json();
      res.json({ ok: r.ok, message: r.ok ? `API reachable — ${d.totalPages || 0} connected accounts` : d.message || "Auth failed" });
    } else if (id === "inference") {
      const { execFile: ef } = require("child_process");
      ef("infsh", ["app", "sample", "google/gemini-3-1-flash-image-preview", "--save", "/dev/null"], { timeout: 10000 }, (err, stdout, stderr) => {
        const output = (stdout || "") + (stderr || "");
        const ok = !err || output.includes("Function") || output.includes("inference.sh");
        res.json({ ok, message: ok ? "CLI authenticated & model available" : "CLI not authenticated" });
      });
      return;
    } else if (id === "higgsfield") {
      if (!process.env.HIGGSFIELD_API_KEY) return res.json({ ok: false, message: "HIGGSFIELD_API_KEY not set in .env" });
      const r = await fetch(HIGGSFIELD.base + HIGGSFIELD.endpoints.status("ping"), { headers: higgsfieldHeaders() });
      res.json({ ok: r.status !== 401 && r.status !== 403, status: r.status, message: r.status !== 401 && r.status !== 403 ? "API key accepted" : "Auth failed" });
    } else {
      res.json({ ok: false, message: "Unknown integration" });
    }
  } catch (e) {
    res.json({ ok: false, message: e.message.slice(0, 200) });
  }
});

// ── SOCIAL CONNECTIONS (Instagram/Facebook via Meta Graph API) ──
const SOCIAL_FILE = "social-connections.json";
function readSocial() { return readTaskFile(SOCIAL_FILE); }
function writeSocial(list) { writeTaskFile(SOCIAL_FILE, list); }

app.get("/social/connections", (_req, res) => {
  const list = readSocial().map((c) => ({
    id: c.id, platform: c.platform, username: c.username, name: c.name,
    ig_user_id: c.ig_user_id, page_id: c.page_id,
    account_id: c.account_id, currency: c.currency, account_status: c.account_status, business_name: c.business_name,
    profile_picture: c.profile_picture, handle: c.handle,
    connected_at: c.connected_at,
  }));
  res.json({ connections: list });
});

app.post("/social/yt/add", express.json(), async (req, res) => {
  const raw = (req.body?.handle || "").trim();
  if (!raw) return res.status(400).json({ error: "Handle vereist" });
  const handle = raw.startsWith("@") ? raw : "@" + raw;
  const ytKey = process.env.YOUTUBE_API_KEY;
  let name = handle.replace(/^@/, "");
  let profile_picture = null;
  try {
    if (ytKey) {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${encodeURIComponent(handle)}&key=${ytKey}`);
      const d = await r.json();
      const ch = d.items?.[0];
      if (!ch) return res.status(404).json({ error: "Channel not found" });
      name = ch.snippet?.title || name;
      profile_picture = ch.snippet?.thumbnails?.default?.url || null;
    }
  } catch (e) { /* fall through — add without metadata */ }
  const existing = readSocial();
  const record = {
    id: "yt_" + handle.replace(/^@/, ""),
    platform: "youtube",
    handle, name, profile_picture,
    connected_at: Date.now(),
  };
  const idx = existing.findIndex(c => c.id === record.id);
  if (idx >= 0) existing[idx] = record; else existing.push(record);
  writeSocial(existing);
  res.json({ ok: true, connection: record });
});

app.delete("/social/connections/:id", (req, res) => {
  writeSocial(readSocial().filter((c) => c.id !== req.params.id));
  res.json({ ok: true });
});

// Start Meta OAuth — redirects user to Facebook login
app.get("/social/meta/auth", (req, res) => {
  const appId = process.env.META_APP_ID;
  const redirect = process.env.META_REDIRECT_URI;
  if (!appId || !redirect) return res.status(400).send("META_APP_ID and META_REDIRECT_URI are not set — configure them in Settings.");
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("meta_oauth_state", state, { httpOnly: true, maxAge: 600_000, sameSite: "lax" });
  const scope = [
    "pages_show_list", "pages_read_engagement",
    "business_management",
    "ads_read", "ads_management",
    "instagram_basic", "instagram_manage_insights",
  ].join(",");
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirect)}&scope=${scope}&state=${state}&response_type=code`;
  res.redirect(url);
});

// Meta OAuth callback — exchange code, discover IG Business accounts, store
app.get("/social/meta/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.send(`<h2>Connect failed</h2><p>${error}: ${error_description || ""}</p><a href="/settings.html">Back</a>`);
  if (state !== req.cookies?.meta_oauth_state) return res.status(400).send("Invalid state (CSRF)");
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirect = process.env.META_REDIRECT_URI;
  try {
    // 1. code → short-lived user token
    const tokRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirect)}&code=${code}`);
    const tok = await tokRes.json();
    if (!tok.access_token) throw new Error(tok.error?.message || "No user token");
    // 2. short → long-lived user token (~60 dagen)
    const llRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tok.access_token}`);
    const ll = await llRes.json();
    const userToken = ll.access_token || tok.access_token;
    // 3. Ophalen pages (incl. page access tokens — die verlopen niet als user token long-lived is)
    const pagesRes = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}&access_token=${userToken}`);
    const pagesJson = await pagesRes.json();
    const pages = pagesJson.data || [];
    console.log(`[META OAuth] /me/accounts returned ${pages.length} page(s)`);
    if (pagesJson.error) console.log(`[META OAuth] /me/accounts error:`, pagesJson.error);
    for (const p of pages) {
      console.log(`[META OAuth] Page: ${p.name} (id=${p.id}) — IG linked: ${p.instagram_business_account ? 'YES (' + p.instagram_business_account.username + ')' : 'NO'}`);
    }
    // 4. Elk page met IG Business account opslaan
    const existing = readSocial();
    let added = 0;
    for (const p of pages) {
      const ig = p.instagram_business_account;
      if (!ig) continue;
      const record = {
        id: "ig_" + ig.id,
        platform: "instagram",
        ig_user_id: ig.id,
        username: ig.username,
        name: ig.name || p.name,
        profile_picture: ig.profile_picture_url || null,
        page_id: p.id,
        page_name: p.name,
        page_access_token: p.access_token,
        user_access_token: userToken,
        connected_at: Date.now(),
      };
      const idx = existing.findIndex((c) => c.id === record.id);
      if (idx >= 0) existing[idx] = record; else existing.push(record);
      added++;
    }
    // 5. Ophalen ad accounts (Marketing API)
    let adAccountsAdded = 0;
    try {
      const adRes = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,account_id,name,currency,account_status,business{id,name}&access_token=${userToken}`);
      const adAccounts = (await adRes.json()).data || [];
      for (const a of adAccounts) {
        const record = {
          id: "ads_" + a.account_id,
          platform: "meta_ads",
          ad_account_id: a.id,
          account_id: a.account_id,
          name: a.name,
          currency: a.currency,
          account_status: a.account_status,
          business_name: a.business?.name || null,
          user_access_token: userToken,
          connected_at: Date.now(),
        };
        const idx = existing.findIndex((c) => c.id === record.id);
        if (idx >= 0) existing[idx] = record; else existing.push(record);
        adAccountsAdded++;
      }
    } catch (e) { console.warn("[META] ad accounts fetch failed:", e.message); }

    writeSocial(existing);
    res.send(`<!doctype html><meta charset="utf-8"><title>Connected</title><style>body{background:#000;color:#eee;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}a{color:hsl(264 65% 65%)}</style><div><h2>✓ ${added} Instagram account${added===1?"":"s"} + ${adAccountsAdded} ad account${adAccountsAdded===1?"":"s"} connected</h2><p>You can close this tab.</p><a href="/settings.html">← Back to Settings</a><script>setTimeout(()=>window.close(),2000)</script></div>`);
  } catch (e) {
    res.status(500).send(`<h2>Connect failed</h2><pre>${e.message}</pre><a href="/settings.html">Back</a>`);
  }
});

// Instagram stats via Graph API (gebruikt opgeslagen page access token)
app.get("/social/ig/stats", async (req, res) => {
  const { id, handle } = req.query;
  const conns = readSocial();
  const conn = id ? conns.find((c) => c.id === id) : conns.find((c) => c.username === handle);
  if (!conn) return res.status(404).json({ error: "Account not connected — connect it first via Settings" });
  try {
    const fields = "username,followers_count,media_count,media.limit(10){id,caption,like_count,comments_count,media_type,media_url,thumbnail_url,permalink,timestamp,insights.metric(reach,impressions)}";
    const r = await fetch(`https://graph.facebook.com/v21.0/${conn.ig_user_id}?fields=${encodeURIComponent(fields)}&access_token=${conn.page_access_token}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    // Normaliseren naar bestaande performance.html format
    const posts = (d.media?.data || []).map((m) => {
      const insights = (m.insights?.data || []).reduce((a, x) => ({ ...a, [x.name]: x.values?.[0]?.value || 0 }), {});
      return {
        caption: m.caption || "",
        likesCount: m.like_count || 0,
        commentsCount: m.comments_count || 0,
        videoViewCount: insights.reach || insights.impressions || 0,
        reach: insights.reach || 0,
        impressions: insights.impressions || 0,
        mediaType: m.media_type,
        permalink: m.permalink,
        timestamp: m.timestamp,
      };
    });
    res.json({
      username: d.username,
      followersCount: d.followers_count || 0,
      mediaCount: d.media_count || 0,
      latestPosts: posts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS (Marketing API) ──
app.get("/ads/accounts", (_req, res) => {
  const accounts = readSocial()
    .filter((c) => c.platform === "meta_ads")
    .map((c) => ({
      id: c.id,
      account_id: c.account_id,
      ad_account_id: c.ad_account_id,
      name: c.name,
      currency: c.currency,
      account_status: c.account_status,
      business_name: c.business_name,
      connected_at: c.connected_at,
    }));
  res.json({ accounts });
});

app.get("/ads/campaigns", async (req, res) => {
  const { account_id } = req.query;
  const conn = readSocial().find((c) => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not connected" });
  try {
    const fields = "id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time,updated_time";
    const r = await fetch(`https://graph.facebook.com/v21.0/${conn.ad_account_id}/campaigns?fields=${fields}&limit=100&access_token=${conn.user_access_token}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ campaigns: d.data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/ads/insights", async (req, res) => {
  const { account_id, date_preset = "last_7d", level = "campaign" } = req.query;
  const conn = readSocial().find((c) => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not connected" });
  try {
    const fields = [
      "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
      "spend", "impressions", "clicks", "ctr", "cpm", "cpc", "reach", "frequency",
      "actions", "action_values", "purchase_roas", "website_purchase_roas",
    ].join(",");
    const url = `https://graph.facebook.com/v21.0/${conn.ad_account_id}/insights?fields=${fields}&date_preset=${date_preset}&level=${level}&limit=200&access_token=${conn.user_access_token}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ insights: d.data || [], currency: conn.currency });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS — write actions (phase 2) ──

app.post("/ads/campaigns/:campaignId/status", async (req, res) => {
  const { campaignId } = req.params;
  const { status, account_id } = req.body;
  if (!["ACTIVE", "PAUSED"].includes(status)) return res.status(400).json({ error: "Status must be ACTIVE or PAUSED" });
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${campaignId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, access_token: conn.user_access_token }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ads/campaigns/:campaignId/budget", async (req, res) => {
  const { campaignId } = req.params;
  const { daily_budget, lifetime_budget, account_id } = req.body;
  if (!daily_budget && !lifetime_budget) return res.status(400).json({ error: "Provide daily_budget or lifetime_budget (in cents)" });
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const body = { access_token: conn.user_access_token };
    if (daily_budget) body.daily_budget = Math.round(Number(daily_budget));
    if (lifetime_budget) body.lifetime_budget = Math.round(Number(lifetime_budget));
    const r = await fetch(`https://graph.facebook.com/v21.0/${campaignId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS — create & duplicate campaign ──

app.post("/ads/campaigns", async (req, res) => {
  const { account_id, name, objective, buying_type, daily_budget, lifetime_budget, special_ad_categories, bid_strategy } = req.body;
  if (!name || !objective) return res.status(400).json({ error: "name and objective are required" });
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const body = {
      name,
      objective,
      status: "PAUSED", // always create paused so nothing goes live by accident
      buying_type: buying_type || "AUCTION",
      special_ad_categories: Array.isArray(special_ad_categories) ? special_ad_categories : [],
      access_token: conn.user_access_token,
    };
    // Campaign-level budget (CBO) requires a bid strategy
    if (daily_budget) body.daily_budget = Math.round(Number(daily_budget));
    if (lifetime_budget) body.lifetime_budget = Math.round(Number(lifetime_budget));
    if (daily_budget || lifetime_budget) {
      body.bid_strategy = bid_strategy || "LOWEST_COST_WITHOUT_CAP";
    } else {
      // Meta requires this flag explicitly when there is no campaign-level budget
      body.is_adset_budget_sharing_enabled = false;
    }
    const r = await fetch(`https://graph.facebook.com/v21.0/${conn.ad_account_id}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.error_user_msg || d.error.message);
    res.json({ ok: true, id: d.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ads/campaigns/:campaignId/copy", async (req, res) => {
  const { campaignId } = req.params;
  const { account_id, rename_suffix } = req.body;
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const body = {
      deep_copy: true, // copy campaign + all its adsets + ads
      status_option: "PAUSED", // copy stays paused regardless of source status
      rename_options: { rename_strategy: "DEEP_RENAME", rename_suffix: rename_suffix || " - Copy" },
      access_token: conn.user_access_token,
    };
    const r = await fetch(`https://graph.facebook.com/v21.0/${campaignId}/copies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.error_user_msg || d.error.message);
    res.json({ ok: true, copied_campaign_id: d.copied_campaign_id || d.id, ad_object_ids: d.ad_object_ids });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS — adset management (phase 3) ──

app.get("/ads/adsets", async (req, res) => {
  const { account_id, campaign_id } = req.query;
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const fields = "id,name,status,effective_status,daily_budget,lifetime_budget,targeting,optimization_goal,bid_strategy,start_time,end_time,campaign_id";
    let url = `https://graph.facebook.com/v21.0/${conn.ad_account_id}/adsets?fields=${fields}&limit=200&access_token=${conn.user_access_token}`;
    if (campaign_id) url += `&filtering=[{"field":"campaign.id","operator":"EQUAL","value":"${campaign_id}"}]`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ adsets: d.data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ads/adsets/:adsetId/status", async (req, res) => {
  const { adsetId } = req.params;
  const { status, account_id } = req.body;
  if (!["ACTIVE", "PAUSED"].includes(status)) return res.status(400).json({ error: "Status must be ACTIVE or PAUSED" });
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${adsetId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, access_token: conn.user_access_token }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ads/adsets/:adsetId/budget", async (req, res) => {
  const { adsetId } = req.params;
  const { daily_budget, lifetime_budget, account_id } = req.body;
  if (!daily_budget && !lifetime_budget) return res.status(400).json({ error: "Provide daily_budget or lifetime_budget (in cents)" });
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const body = { access_token: conn.user_access_token };
    if (daily_budget) body.daily_budget = Math.round(Number(daily_budget));
    if (lifetime_budget) body.lifetime_budget = Math.round(Number(lifetime_budget));
    const r = await fetch(`https://graph.facebook.com/v21.0/${adsetId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS — ad creative management (phase 3) ──

app.get("/ads/ads", async (req, res) => {
  const { account_id, campaign_id, adset_id } = req.query;
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const fields = "id,name,status,effective_status,creative{id,name,title,body,image_url,thumbnail_url,object_story_spec},adset_id,campaign_id";
    const filtering = [];
    if (campaign_id) filtering.push(`{"field":"campaign.id","operator":"EQUAL","value":"${campaign_id}"}`);
    if (adset_id) filtering.push(`{"field":"adset.id","operator":"EQUAL","value":"${adset_id}"}`);
    let url = `https://graph.facebook.com/v21.0/${conn.ad_account_id}/ads?fields=${fields}&limit=200&access_token=${conn.user_access_token}`;
    if (filtering.length) url += `&filtering=[${filtering.join(",")}]`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ ads: d.data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ads/ads/:adId/status", async (req, res) => {
  const { adId } = req.params;
  const { status, account_id } = req.body;
  if (!["ACTIVE", "PAUSED"].includes(status)) return res.status(400).json({ error: "Status must be ACTIVE or PAUSED" });
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${adId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, access_token: conn.user_access_token }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS — targeting + placements update (phase 3) ──
// Accepts a partial targeting object and merges it into the adset's existing targeting.
// Supports demographics (age_min/max, genders), geo (geo_locations), interests, custom audiences,
// flexible_spec, AND placement fields (publisher_platforms, facebook_positions, instagram_positions,
// messenger_positions, audience_network_positions, device_platforms).
app.post("/ads/adsets/:adsetId/targeting", async (req, res) => {
  const { adsetId } = req.params;
  const { account_id, targeting, replace } = req.body;
  if (!targeting || typeof targeting !== "object") return res.status(400).json({ error: "targeting object required" });
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    let finalTargeting = targeting;
    if (!replace) {
      const getR = await fetch(`https://graph.facebook.com/v21.0/${adsetId}?fields=targeting&access_token=${conn.user_access_token}`);
      const getD = await getR.json();
      if (getD.error) throw new Error(getD.error.message);
      finalTargeting = { ...(getD.targeting || {}), ...targeting };
    }
    const r = await fetch(`https://graph.facebook.com/v21.0/${adsetId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targeting: finalTargeting, access_token: conn.user_access_token }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ ok: true, targeting: finalTargeting });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS — creative update (phase 3) ──
// Either assigns an existing creative_id to the ad, or creates a new adcreative from raw fields
// (page_id + message + link + image_url/video_id + headline + description + call_to_action) and assigns it.
app.post("/ads/ads/:adId/creative", async (req, res) => {
  const { adId } = req.params;
  const {
    account_id, creative_id,
    page_id, message, link, image_url, image_hash, video_id,
    headline, description, call_to_action,
  } = req.body;
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    let creativeIdToUse = creative_id;
    if (!creativeIdToUse) {
      if (!page_id) return res.status(400).json({ error: "page_id required when creating a new creative" });
      const link_data = { message, link };
      if (image_hash) link_data.image_hash = image_hash;
      if (image_url) link_data.picture = image_url;
      if (headline) link_data.name = headline;
      if (description) link_data.description = description;
      if (call_to_action) link_data.call_to_action = call_to_action;
      const object_story_spec = video_id
        ? { page_id, video_data: { video_id, message, title: headline, call_to_action } }
        : { page_id, link_data };
      const createR = await fetch(`https://graph.facebook.com/v21.0/${conn.ad_account_id}/adcreatives`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: headline || message?.slice(0, 60) || `creative_${Date.now()}`,
          object_story_spec,
          access_token: conn.user_access_token,
        }),
      });
      const createD = await createR.json();
      if (createD.error) throw new Error(createD.error.message);
      creativeIdToUse = createD.id;
    }
    const updR = await fetch(`https://graph.facebook.com/v21.0/${adId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creative: { creative_id: creativeIdToUse }, access_token: conn.user_access_token }),
    });
    const updD = await updR.json();
    if (updD.error) throw new Error(updD.error.message);
    res.json({ ok: true, creative_id: creativeIdToUse });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS — pixels list + promoted_object update (phase 3) ──

app.get("/ads/pixels", async (req, res) => {
  const { account_id } = req.query;
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    const fields = "id,name,code,last_fired_time,is_unavailable,creation_time,owner_business";
    const r = await fetch(`https://graph.facebook.com/v21.0/${conn.ad_account_id}/adspixels?fields=${fields}&limit=100&access_token=${conn.user_access_token}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ pixels: d.data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update the conversion target (pixel) on an adset. Merges into existing promoted_object.
// Optionally also sets conversion_domain on the adset (top-level field, not inside promoted_object).
app.post("/ads/adsets/:adsetId/promoted-object", async (req, res) => {
  const { adsetId } = req.params;
  const { account_id, pixel_id, custom_event_type, custom_conversion_id, application_id, object_store_url, page_id, conversion_domain, replace } = req.body;
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    let finalPO = {};
    if (!replace) {
      const getR = await fetch(`https://graph.facebook.com/v21.0/${adsetId}?fields=promoted_object&access_token=${conn.user_access_token}`);
      const getD = await getR.json();
      if (getD.error) throw new Error(getD.error.message);
      finalPO = { ...(getD.promoted_object || {}) };
    }
    if (pixel_id !== undefined) finalPO.pixel_id = pixel_id;
    if (custom_event_type !== undefined) finalPO.custom_event_type = custom_event_type;
    if (custom_conversion_id !== undefined) finalPO.custom_conversion_id = custom_conversion_id;
    if (application_id !== undefined) finalPO.application_id = application_id;
    if (object_store_url !== undefined) finalPO.object_store_url = object_store_url;
    if (page_id !== undefined) finalPO.page_id = page_id;

    const body = { promoted_object: finalPO, access_token: conn.user_access_token };
    if (conversion_domain !== undefined) body.conversion_domain = conversion_domain;

    const r = await fetch(`https://graph.facebook.com/v21.0/${adsetId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.json({ ok: true, promoted_object: finalPO, conversion_domain: conversion_domain });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS — create adset & ad (build campaigns from scratch) ──

// Create a new ad set under a campaign. Always PAUSED.
// Requires campaign_id, name, optimization_goal and targeting (with geo_locations).
// Needs an adset-level budget unless the campaign uses campaign budget (CBO).
// For conversion goals, pass promoted_object fields (pixel_id + custom_event_type).
app.post("/ads/adsets", async (req, res) => {
  const {
    account_id, campaign_id, name,
    optimization_goal, billing_event, bid_amount, bid_strategy,
    daily_budget, lifetime_budget, start_time, end_time,
    targeting, destination_type, conversion_domain,
    pixel_id, custom_event_type, custom_conversion_id, application_id, object_store_url, page_id,
  } = req.body;
  if (!campaign_id || !name || !optimization_goal) return res.status(400).json({ error: "campaign_id, name and optimization_goal are required" });
  if (!targeting || typeof targeting !== "object" || !targeting.geo_locations) return res.status(400).json({ error: "targeting with at least geo_locations is required" });
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  // Meta requires Advantage audience to be explicitly on (1) or off (0); default off
  if (!targeting.targeting_automation) targeting.targeting_automation = { advantage_audience: 0 };
  try {
    const body = {
      name,
      campaign_id,
      optimization_goal,
      billing_event: billing_event || "IMPRESSIONS",
      status: "PAUSED", // never go live by accident
      targeting,
      access_token: conn.user_access_token,
    };
    if (daily_budget) body.daily_budget = Math.round(Number(daily_budget));
    if (lifetime_budget) body.lifetime_budget = Math.round(Number(lifetime_budget));
    if (daily_budget || lifetime_budget) body.bid_strategy = bid_strategy || "LOWEST_COST_WITHOUT_CAP";
    if (bid_amount) body.bid_amount = Math.round(Number(bid_amount));
    if (start_time) body.start_time = start_time;
    if (end_time) body.end_time = end_time;
    if (destination_type) body.destination_type = destination_type;
    if (conversion_domain) body.conversion_domain = conversion_domain;
    // promoted_object — required for conversion-optimized adsets
    const po = {};
    if (pixel_id) po.pixel_id = pixel_id;
    if (custom_event_type) po.custom_event_type = custom_event_type;
    if (custom_conversion_id) po.custom_conversion_id = custom_conversion_id;
    if (application_id) po.application_id = application_id;
    if (object_store_url) po.object_store_url = object_store_url;
    if (page_id) po.page_id = page_id;
    if (Object.keys(po).length) body.promoted_object = po;
    const r = await fetch(`https://graph.facebook.com/v21.0/${conn.ad_account_id}/adsets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.error_user_msg || d.error.message);
    res.json({ ok: true, id: d.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a new ad under an ad set. Always PAUSED.
// Either pass an existing creative_id, or page_id + creative fields to build one.
app.post("/ads/ads", async (req, res) => {
  const {
    account_id, adset_id, name, creative_id,
    page_id, message, link, image_url, image_hash, video_id,
    headline, description, call_to_action,
  } = req.body;
  if (!adset_id || !name) return res.status(400).json({ error: "adset_id and name are required" });
  const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === account_id || c.ad_account_id === account_id));
  if (!conn) return res.status(404).json({ error: "Ad account not found" });
  try {
    let creativeIdToUse = creative_id;
    if (!creativeIdToUse) {
      if (!page_id) return res.status(400).json({ error: "creative_id, or page_id + creative fields, required" });
      const link_data = { message, link };
      if (image_hash) link_data.image_hash = image_hash;
      if (image_url) link_data.picture = image_url;
      if (headline) link_data.name = headline;
      if (description) link_data.description = description;
      if (call_to_action) link_data.call_to_action = call_to_action;
      const object_story_spec = video_id
        ? { page_id, video_data: { video_id, message, title: headline, call_to_action } }
        : { page_id, link_data };
      const createR = await fetch(`https://graph.facebook.com/v21.0/${conn.ad_account_id}/adcreatives`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: headline || message?.slice(0, 60) || `creative_${Date.now()}`,
          object_story_spec,
          access_token: conn.user_access_token,
        }),
      });
      const createD = await createR.json();
      if (createD.error) throw new Error(createD.error.error_user_msg || createD.error.message);
      creativeIdToUse = createD.id;
    }
    const r = await fetch(`https://graph.facebook.com/v21.0/${conn.ad_account_id}/ads`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        adset_id,
        creative: { creative_id: creativeIdToUse },
        status: "PAUSED", // never go live by accident
        access_token: conn.user_access_token,
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.error_user_msg || d.error.message);
    res.json({ ok: true, id: d.id, creative_id: creativeIdToUse });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── META ADS — automated rules (phase 3) ──

app.get("/ads/rules", (_req, res) => {
  try {
    const rules = readTaskFile("ads-rules.json");
    res.json({ rules });
  } catch { res.json({ rules: [] }); }
});

app.post("/ads/rules", (req, res) => {
  const { name, account_id, metric, operator, threshold, action, action_value, check_period, enabled } = req.body;
  if (!name || !account_id || !metric || !operator || !threshold || !action) {
    return res.status(400).json({ error: "Missing required fields: name, account_id, metric, operator, threshold, action" });
  }
  let rules = [];
  try { rules = readTaskFile("ads-rules.json"); } catch {}
  const rule = {
    id: "rule_" + genId(), name, account_id, metric, operator, threshold: Number(threshold),
    action, action_value: action_value || null,
    check_period: check_period || "last_7d", enabled: enabled !== false,
    created_at: new Date().toISOString(), last_triggered: null, trigger_count: 0,
  };
  rules.push(rule);
  writeTaskFile("ads-rules.json", rules);
  res.status(201).json(rule);
});

app.patch("/ads/rules/:id", (req, res) => {
  const rules = readTaskFile("ads-rules.json");
  const rule = rules.find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  for (const key of ["name", "metric", "operator", "threshold", "action", "action_value", "check_period", "enabled"]) {
    if (req.body[key] !== undefined) rule[key] = req.body[key];
  }
  if (rule.threshold !== undefined) rule.threshold = Number(rule.threshold);
  writeTaskFile("ads-rules.json", rules);
  res.json(rule);
});

app.delete("/ads/rules/:id", (req, res) => {
  writeTaskFile("ads-rules.json", readTaskFile("ads-rules.json").filter(r => r.id !== req.params.id));
  res.json({ ok: true });
});

app.get("/settings/services", async (_req, res) => {
  const services = [
    { label: "Command Center API", url: "http://localhost:3004", desc: "Main API server — tasks, brands, chat" },
  ];
  const results = [];
  for (const svc of services) {
    try {
      const r = await fetch(svc.url, { signal: AbortSignal.timeout(3000) });
      results.push({ ...svc, status: "online" });
    } catch {
      results.push({ ...svc, status: "offline" });
    }
  }
  res.json(results);
});

app.get("/brands", (_req, res) => {
  // List all brands and their assets
  const brands = {};
  if (fs.existsSync(BRAND_ASSETS_DIR)) {
    for (const dir of fs.readdirSync(BRAND_ASSETS_DIR)) {
      const brandDir = path.join(BRAND_ASSETS_DIR, dir);
      if (!fs.statSync(brandDir).isDirectory()) continue;
      const files = fs.readdirSync(brandDir).filter(f => !f.startsWith("."));
      brands[dir] = files.map(f => ({
        name: f,
        type: f.startsWith("logo") ? "logo" : f.startsWith("watermark") ? "watermark" : "asset",
        url: `/brand-assets/${dir}/${f}`,
      }));
    }
  }
  res.json(brands);
});

// ── BRAND CONFIG (colors + fonts) ──
const BRAND_CONFIG_FILE = path.join(__dirname, "data", "brand-configs.json");

function readBrandConfigs() {
  try { return JSON.parse(fs.readFileSync(BRAND_CONFIG_FILE, "utf-8")); } catch { return {}; }
}

function writeBrandConfigs(data) {
  fs.writeFileSync(BRAND_CONFIG_FILE, JSON.stringify(data, null, 2));
}

app.get("/brands/config", (_req, res) => {
  res.json(readBrandConfigs());
});

app.post("/brands/:brand/config", (req, res) => {
  const brand = req.params.brand.toUpperCase();
  const configs = readBrandConfigs();
  configs[brand] = { colors: req.body.colors || [], fonts: req.body.fonts || [] };
  writeBrandConfigs(configs);
  console.log(`[BRAND] Config updated for ${brand}: ${(req.body.colors||[]).length} colors, ${(req.body.fonts||[]).length} fonts`);
  res.json({ ok: true });
});

try {
  const brandUpload = require("multer")({
    storage: require("multer").diskStorage({
      destination: (req, _file, cb) => {
        const brand = (req.params.brand || "unknown").toUpperCase();
        const dir = path.join(BRAND_ASSETS_DIR, brand);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const assetType = req.params.type || "asset";
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${assetType}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  app.post("/brands/:brand/assets/:type", brandUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const brand = req.params.brand.toUpperCase();
    const url = `/brand-assets/${brand}/${req.file.filename}`;
    console.log(`[BRAND] Uploaded ${req.params.type} for ${brand}: ${req.file.filename}`);
    res.json({ ok: true, url, brand, type: req.params.type });
  });
} catch {
  app.post("/brands/:brand/assets/:type", (_req, res) => res.status(501).json({ error: "Upload not available" }));
}

app.delete("/brands/:brand/assets/:filename", (req, res) => {
  const brand = req.params.brand.toUpperCase();
  const filePath = path.join(BRAND_ASSETS_DIR, brand, path.basename(req.params.filename));
  try { fs.unlinkSync(filePath); res.json({ ok: true }); }
  catch { res.status(404).json({ error: "File not found" }); }
});

// ── BRAND CREATE / RENAME / DELETE ──
function sanitizeBrandName(name) {
  const clean = String(name || "").toUpperCase().trim().replace(/[^A-Z0-9_-]/g, "");
  return clean.slice(0, 40);
}

app.post("/brands/:brand", (req, res) => {
  const brand = sanitizeBrandName(req.params.brand);
  if (!brand) return res.status(400).json({ error: "Invalid brand name" });
  const dir = path.join(BRAND_ASSETS_DIR, brand);
  if (fs.existsSync(dir)) return res.status(409).json({ error: "Brand already exists" });
  fs.mkdirSync(dir, { recursive: true });
  const configs = readBrandConfigs();
  if (!configs[brand]) { configs[brand] = { colors: [], fonts: [] }; writeBrandConfigs(configs); }
  console.log(`[BRAND] Created ${brand}`);
  res.json({ ok: true, brand });
});

app.delete("/brands/:brand", (req, res) => {
  const brand = sanitizeBrandName(req.params.brand);
  if (!brand) return res.status(400).json({ error: "Invalid brand name" });
  const dir = path.join(BRAND_ASSETS_DIR, brand);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const configs = readBrandConfigs();
  if (configs[brand]) { delete configs[brand]; writeBrandConfigs(configs); }
  console.log(`[BRAND] Deleted ${brand}`);
  res.json({ ok: true });
});

app.post("/brands/:brand/rename", (req, res) => {
  const oldName = sanitizeBrandName(req.params.brand);
  const newName = sanitizeBrandName(req.body && req.body.newName);
  if (!oldName || !newName) return res.status(400).json({ error: "Invalid brand name" });
  if (oldName === newName) return res.json({ ok: true, brand: newName });
  const oldDir = path.join(BRAND_ASSETS_DIR, oldName);
  const newDir = path.join(BRAND_ASSETS_DIR, newName);
  if (fs.existsSync(newDir)) return res.status(409).json({ error: "Target brand already exists" });
  try {
    if (fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir);
    else fs.mkdirSync(newDir, { recursive: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
  const configs = readBrandConfigs();
  if (configs[oldName]) { configs[newName] = configs[oldName]; delete configs[oldName]; writeBrandConfigs(configs); }
  console.log(`[BRAND] Renamed ${oldName} → ${newName}`);
  res.json({ ok: true, brand: newName });
});

// Upload via multipart (simple: read raw body and save)
const multer = require("multer") || null;
try {
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const upload = require("multer")({ dest: MEDIA_DIR, limits: { fileSize: 500 * 1024 * 1024 } });
  app.post("/media/upload", (req, res) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        console.error("[MEDIA] Upload error:", err.code || err.name, err.message);
        const msg = err.code === "LIMIT_FILE_SIZE" ? "File too large (max 500MB)" : err.message;
        return res.status(400).json({ error: msg });
      }
      if (!req.file) return res.status(400).json({ error: "No file received" });
      try {
        const ext = path.extname(req.file.originalname) || "";
        const finalName = req.file.filename + ext;
        fs.renameSync(req.file.path, path.join(MEDIA_DIR, finalName));
        console.log(`[MEDIA] Uploaded ${req.file.originalname} → ${finalName} (${req.file.size} bytes)`);
        res.json({ name: finalName, path: "/media/" + finalName });
      } catch (e) {
        console.error("[MEDIA] Rename failed:", e.message);
        res.status(500).json({ error: "Failed to save: " + e.message });
      }
    });
  });
} catch (e) {
  console.error("[MEDIA] multer init failed:", e.message);
  app.post("/media/upload", (_req, res) => res.status(501).json({ error: "Upload not available, install multer" }));
}

app.delete("/media/:name", (req, res) => {
  const filePath = path.join(MEDIA_DIR, path.basename(req.params.name));
  try { fs.unlinkSync(filePath); res.json({ ok: true }); }
  catch { res.status(404).json({ error: "File not found" }); }
});

// ── TELEGRAM ──────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || "";

const SEVERITY_EMOJI = { success: "\u2705", danger: "\u274c", warning: "\u26a0\ufe0f", info: "\u2139\ufe0f" };

function sendTelegram(title, message, severity) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const emoji = SEVERITY_EMOJI[severity] || "\U0001f514";
  const text = `${emoji} <b>${title}</b>\n${message}`;
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(err => console.error("[TG] Send failed:", err.message));
}

// ── TELEGRAM BOT (two-way: AI chat via Telegram) ─────────
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
let tgPollingActive = false;
let tgOffset = 0;

function tgSend(chatId, text) {
  // Telegram has a 4096 char limit per message
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 4000));
    remaining = remaining.slice(4000);
  }
  for (const chunk of chunks) {
    fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    }).catch(err => {
      // Fallback without Markdown if it fails
      fetch(`${TG_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
      }).catch(e2 => console.error("[TG-BOT] Send failed:", e2.message));
    });
  }
}

async function handleTgMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text;

  // Only respond to authorized user
  if (chatId !== TG_CHAT) {
    tgSend(chatId, "Niet geautoriseerd.");
    return;
  }

  if (!text) return;

  // Community manager review: edit-text capture
  if (communityEditState.has(chatId)) {
    const { postId } = communityEditState.get(chatId);
    if (text === "/cancel") {
      communityEditState.delete(chatId);
      tgSend(chatId, "Edit geannuleerd.");
      return;
    }
    const tasks = readTaskFile(COMMUNITY_TASKS_FILE);
    const task = tasks.find(t => t.id === postId);
    if (!task) {
      communityEditState.delete(chatId);
      tgSend(chatId, `Post \`${postId}\` niet meer gevonden.`);
      return;
    }
    task.text = text;
    task.updated_at = new Date().toISOString();
    writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
    communityEditState.delete(chatId);
    tgSend(chatId, `✏ Tekst bijgewerkt voor *${task.archetype || postId}*.\n_Status blijft \`draft\`. Trigger opnieuw /review om te approven._`);
    return;
  }

  // Handle /start command
  if (text === "/start") {
    const brand = loadBrand();
    tgSend(chatId, `Hey! Ik ben *${brand.assistant_name}*, je ${brand.company_name} AI assistant.\n\nIk heb toegang tot alles in het Command Center:\n- 8 agents aansturen (designer, video, researcher, scriptwriter, marketeer, calendar, etc.)\n- 49 skills (marketing, SEO, CRO, design, development)\n- Google Calendar beheren\n- Web search voor actueel nieuws & marktdata\n\nCommando's:\n/ads — Meta Ads overview & beheer\n/clear — Chat history wissen\n\nOf stuur gewoon een bericht om te beginnen.`);
    return;
  }

  // Handle /clear command
  if (text === "/clear") {
    delete chatSessions["telegram"];
    tgSend(chatId, "Chat history gewist.");
    return;
  }

  // Handle /review — trigger community review batch manually (all channels)
  if (text === "/review") {
    try {
      const sent = await sendCommunityReviewBatch({ force: true });
      if (sent === 0) tgSend(chatId, "Geen drafts voor komende week.");
    } catch (e) {
      tgSend(chatId, "Review error: " + e.message);
    }
    return;
  }

  // Handle /ads command
  if (text === "/ads" || text.startsWith("/ads ")) {
    try {
      const accounts = readSocial().filter(c => c.platform === "meta_ads");
      if (!accounts.length) { tgSend(chatId, "Geen Meta ad accounts gekoppeld."); return; }
      const sub = text.slice(5).trim();

      // /ads — overview of all accounts
      if (!sub) {
        const lines = ["*📊 Meta Ads Overview*\n"];
        for (const acc of accounts) {
          try {
            const insUrl = `https://graph.facebook.com/v21.0/${acc.ad_account_id}/insights?fields=spend,impressions,clicks,ctr,actions,purchase_roas&date_preset=last_7d&access_token=${acc.user_access_token}`;
            const d = await fetch(insUrl).then(r => r.json());
            const row = d.data?.[0] || {};
            const spend = Number(row.spend) || 0;
            const clicks = Number(row.clicks) || 0;
            const ctr = Number(row.ctr) || 0;
            let roas = 0;
            if (Array.isArray(row.purchase_roas) && row.purchase_roas[0]) roas = Number(row.purchase_roas[0].value) || 0;
            const roasIcon = roas >= 2 ? "🟢" : (roas > 0 ? "🟡" : "⚪");
            lines.push(`*${acc.name}* (${acc.currency})`);
            lines.push(`  Spend: €${spend.toFixed(2)} | Clicks: ${clicks} | CTR: ${ctr.toFixed(2)}%`);
            lines.push(`  ${roasIcon} ROAS: ${roas > 0 ? roas.toFixed(2) + "x" : "—"}\n`);
          } catch { lines.push(`*${acc.name}* — data unavailable\n`); }
        }
        lines.push("_Last 7 days. Commands:_");
        lines.push("`/ads campaigns` — list campaigns");
        lines.push("`/ads pause <id>` — pause campaign");
        lines.push("`/ads activate <id>` — activate campaign");
        tgSend(chatId, lines.join("\n"));
        return;
      }

      const acc = accounts[0]; // default to first account

      // /ads campaigns
      if (sub === "campaigns" || sub === "camp") {
        const campUrl = `https://graph.facebook.com/v21.0/${acc.ad_account_id}/campaigns?fields=id,name,status,effective_status,daily_budget&limit=20&access_token=${acc.user_access_token}`;
        const d = await fetch(campUrl).then(r => r.json());
        if (!d.data?.length) { tgSend(chatId, "Geen campagnes gevonden."); return; }
        const lines = [`*Campaigns — ${acc.name}*\n`];
        for (const c of d.data) {
          const status = c.effective_status || c.status;
          const icon = status === "ACTIVE" ? "🟢" : (status === "PAUSED" ? "🟡" : "⚪");
          const budget = c.daily_budget ? `€${(Number(c.daily_budget)/100).toFixed(2)}/day` : "";
          lines.push(`${icon} *${c.name}*`);
          lines.push(`  ID: \`${c.id}\` | ${status} ${budget}`);
        }
        tgSend(chatId, lines.join("\n"));
        return;
      }

      // /ads pause <id> or /ads activate <id>
      const pauseMatch = sub.match(/^(pause|activate)\s+(\d+)$/);
      if (pauseMatch) {
        const [, action, campId] = pauseMatch;
        const newStatus = action === "pause" ? "PAUSED" : "ACTIVE";
        const r = await fetch(`https://graph.facebook.com/v21.0/${campId}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus, access_token: acc.user_access_token }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);
        tgSend(chatId, `✅ Campaign \`${campId}\` is nu *${newStatus}*`);
        return;
      }

      tgSend(chatId, "Gebruik: `/ads`, `/ads campaigns`, `/ads pause <id>`, `/ads activate <id>`");
    } catch (e) {
      tgSend(chatId, "Error: " + e.message);
    }
    return;
  }

  // Forward to AI assistant chat
  try {
    tgSend(chatId, "⏳");

    // Use internal chat logic directly
    const sessionId = "telegram";
    if (!chatSessions[sessionId]) chatSessions[sessionId] = [];
    const history = chatSessions[sessionId];
    history.push({ role: "user", content: text });
    if (history.length > 30) chatSessions[sessionId] = chatSessions[sessionId].slice(-30);

    const res = await fetch("http://localhost:3004/ctrl/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal": "telegram", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ message: text, sessionId: "telegram" }),
    });

    const data = await res.json();
    const reply = data.reply || data.error || "Geen antwoord.";

    // Delete the ⏳ "typing" message (best effort)
    tgSend(chatId, reply);
  } catch (e) {
    console.error("[TG-BOT] Chat error:", e.message);
    tgSend(chatId, "Fout bij verwerken: " + e.message);
  }
}

// ── COMMUNITY MANAGER REVIEW FLOW ──
const communityEditState = new Map();
const DAY_NUM = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DAY_SHORT_TO_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function tgApiCall(method, body) {
  return fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

function formatScheduled(task) {
  return task.scheduled_local || (task.scheduled_at ? new Date(task.scheduled_at).toISOString() : "—");
}

async function sendCommunityReviewCard(chatId, task, channel) {
  if (task.media_path) {
    try {
      const { full, name } = resolveMediaPath(task.media_path);
      const kind = mediaKindFor(name);
      const buffer = fs.readFileSync(full);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", `📎 Media voor review — ${task.archetype || task.id}`);
      form.append(kind.field, new Blob([buffer]), name);
      await fetch(`${TG_API}/${kind.method}`, { method: "POST", body: form });
    } catch (e) {
      console.error(`[COMMUNITY-REVIEW] Media preview failed for ${task.id}: ${e.message}`);
    }
  }
  const mediaNote = task.media_path ? `🖼 ${path.basename(task.media_path)}\n` : "";
  const channelNote = channel ? `📡 ${channel.name}\n` : "";
  const header = `*Review — ${task.archetype || "post"}*\n${channelNote}📅 ${formatScheduled(task)}${task.trigger_word ? `  |  🔑 ${task.trigger_word}` : ""}\n${mediaNote}\n`;
  const body = task.text || "";
  const maxBody = 3500 - header.length;
  const text = header + (body.length > maxBody ? body.slice(0, maxBody) + "…" : body);
  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `sm:approve:${task.id}` },
      { text: "❌ Skip", callback_data: `sm:skip:${task.id}` },
      { text: "✏ Edit", callback_data: `sm:edit:${task.id}` },
    ]],
  };
  const r = await tgApiCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: keyboard,
  });
  if (!r.ok) {
    await tgApiCall("sendMessage", {
      chat_id: chatId,
      text: `Review — ${task.id} (Markdown faalde; ruwe tekst volgt)\n\n${task.text}`,
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
  }
  return r;
}

async function sendChannelReviewBatch(channel, { force = false } = {}) {
  const dmChatId = (channel.review && channel.review.dm_chat_id) || process.env.TELEGRAM_CHAT_ID;
  if (!dmChatId) { console.error(`[COMMUNITY-REVIEW] No DM chat for channel ${channel.id}`); return 0; }

  const now = Date.now();
  const windowDays = Number(channel.schedule_window_days) || 7;
  const windowEnd = now + windowDays * 24 * 60 * 60 * 1000;
  const tasks = readTaskFile(COMMUNITY_TASKS_FILE);

  const dueWithinWindow = t => {
    const when = Date.parse(t.scheduled_at || "");
    return when && when >= now && when <= windowEnd;
  };
  const belongsToChannel = t => t.channel_id === channel.id;

  const drafts = tasks.filter(t => belongsToChannel(t) && t.status === "draft" && dueWithinWindow(t))
    .sort((a, b) => (a.scheduled_at || "").localeCompare(b.scheduled_at || ""));
  const manuals = tasks.filter(t => belongsToChannel(t) && t.status === "manual" && dueWithinWindow(t))
    .sort((a, b) => (a.scheduled_at || "").localeCompare(b.scheduled_at || ""));

  const total = drafts.length + manuals.length;
  if (!total) {
    if (force) await tgApiCall("sendMessage", { chat_id: dmChatId, text: `Geen drafts voor channel *${channel.name}* (${windowDays} dagen).`, parse_mode: "Markdown" });
    return 0;
  }

  await tgApiCall("sendMessage", {
    chat_id: dmChatId,
    text: `*📬 Community review — ${channel.name}*\n\n${drafts.length} draft${drafts.length === 1 ? "" : "s"} (Approve / Skip / Edit)\n${manuals.length} handmatige suggestie${manuals.length === 1 ? "" : "s"} (copy/paste zelf posten)`,
    parse_mode: "Markdown",
  });

  let changed = false;
  for (const task of drafts) {
    await sendCommunityReviewCard(dmChatId, task, channel);
    task.review_sent_at = new Date().toISOString();
    changed = true;
  }

  if (manuals.length) {
    await tgApiCall("sendMessage", {
      chat_id: dmChatId,
      text: `*📝 Handmatig plaatsen (${manuals.length})*\n\nOnderstaande posts zijn voor jou om zelf te plaatsen. Copy-paste de tekst als reply naar je groep.`,
      parse_mode: "Markdown",
    });
    for (const task of manuals) {
      await sendManualSuggestion(dmChatId, task);
      task.review_sent_at = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
  return total;
}

async function sendCommunityReviewBatch({ channel_id = null, force = false } = {}) {
  const allChannels = readChannels();
  const selected = allChannels.filter(c => {
    if (!c.enabled) return false;
    if (channel_id) return c.id === channel_id;
    return c.review && c.review.enabled !== false;
  });
  if (!selected.length) {
    if (force && process.env.TELEGRAM_CHAT_ID) {
      await tgApiCall("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, text: channel_id ? `Channel \`${channel_id}\` niet gevonden of disabled.` : "Geen channels met review enabled." });
    }
    return 0;
  }
  let total = 0;
  for (const channel of selected) total += await sendChannelReviewBatch(channel, { force });
  return total;
}

async function sendManualSuggestion(chatId, task) {
  const header = `*${task.archetype || "Manual post"}*  |  📅 ${formatScheduled(task)}\n\n`;
  await tgApiCall("sendMessage", {
    chat_id: chatId,
    text: header + (task.text || ""),
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

async function handleTgCallback(cq) {
  const chatId = String(cq.message?.chat?.id || cq.from?.id || "");
  const data = cq.data || "";
  const msgId = cq.message?.message_id;

  if (chatId !== TG_CHAT) {
    await tgApiCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Niet geautoriseerd." });
    return;
  }

  if (!data.startsWith("sm:")) {
    await tgApiCall("answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }

  const [, action, postId] = data.split(":");
  const tasks = readTaskFile(COMMUNITY_TASKS_FILE);
  const task = tasks.find(t => t.id === postId);
  if (!task) {
    await tgApiCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Post niet gevonden.", show_alert: true });
    return;
  }

  if (action === "approve") {
    task.status = "scheduled";
    task.updated_at = new Date().toISOString();
    task.error = null;
    writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
    await tgApiCall("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Approved" });
    await tgApiCall("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: `✅ Approved — fires ${formatScheduled(task)}`, callback_data: "sm:noop" }]] },
    });
  } else if (action === "skip") {
    task.status = "cancelled";
    task.updated_at = new Date().toISOString();
    writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
    await tgApiCall("answerCallbackQuery", { callback_query_id: cq.id, text: "❌ Skipped" });
    await tgApiCall("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: "❌ Skipped", callback_data: "sm:noop" }]] },
    });
  } else if (action === "edit") {
    communityEditState.set(chatId, { postId, startedAt: Date.now() });
    await tgApiCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Stuur de nieuwe tekst" });
    await tgApiCall("sendMessage", {
      chat_id: chatId,
      text: `✏ *Edit mode — ${task.archetype || postId}*\n\nStuur de nieuwe volledige post-tekst als reply. /cancel om af te breken.`,
      parse_mode: "Markdown",
    });
  } else {
    await tgApiCall("answerCallbackQuery", { callback_query_id: cq.id });
  }
}

// Per-channel review cron: each channel has its own day/time
const lastReviewFireByChannel = new Map();
function maybeFireCommunityReviewCron() {
  try {
    const channels = readChannels().filter(c => c.enabled && c.review && c.review.enabled !== false);
    if (!channels.length) return;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: process.env.TIMEZONE || "Europe/Amsterdam",
        weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit",
        hour12: false,
      }).formatToParts(new Date()).map(p => [p.type, p.value])
    );
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    const currentDayNum = DAY_SHORT_TO_NUM[parts.weekday];
    const hour = parseInt(parts.hour, 10);
    const minute = parseInt(parts.minute, 10);

    for (const channel of channels) {
      const targetDay = DAY_NUM[(channel.review.day || "sunday").toLowerCase()];
      if (targetDay == null || targetDay !== currentDayNum) continue;
      const [th, tm = 0] = (channel.review.time || "18:00").split(":").map(n => parseInt(n, 10));
      if (hour !== th) continue;
      if (minute < tm || minute >= tm + 5) continue;
      if (lastReviewFireByChannel.get(channel.id) === dateKey) continue;
      lastReviewFireByChannel.set(channel.id, dateKey);
      console.log(`[COMMUNITY-REVIEW] ${channel.id} — ${channel.review.day} ${channel.review.time} trigger`);
      sendChannelReviewBatch(channel).catch(e => console.error(`[COMMUNITY-REVIEW] ${channel.id} error:`, e.message));
    }
  } catch (e) {
    console.error("[COMMUNITY-REVIEW] Cron check failed:", e.message);
  }
}
setInterval(maybeFireCommunityReviewCron, 60_000);

async function tgPoll() {
  if (tgPollingActive) return;
  tgPollingActive = true;
  console.log("[TG-BOT] Telegram bot polling started — assistant is now reachable via Telegram");

  while (tgPollingActive) {
    try {
      const r = await fetch(`${TG_API}/getUpdates?offset=${tgOffset}&timeout=30&allowed_updates=["message","callback_query"]`, {
        signal: AbortSignal.timeout(35000),
      });
      const data = await r.json();

      if (data.ok && data.result?.length) {
        for (const update of data.result) {
          tgOffset = update.update_id + 1;
          if (update.message) {
            handleTgMessage(update.message).catch(e => console.error("[TG-BOT] Handler error:", e.message));
          } else if (update.callback_query) {
            handleTgCallback(update.callback_query).catch(e => console.error("[TG-BOT] Callback error:", e.message));
          }
        }
      }
    } catch (e) {
      if (!e.message?.includes("abort")) {
        console.error("[TG-BOT] Poll error:", e.message);
      }
      // Wait before retrying on error
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// Start Telegram bot polling
if (TG_TOKEN) {
  setTimeout(() => tgPoll(), 2000);
}

// ── NOTIFICATIONS ─────────────────────────────
app.get("/notifications", (_req, res) => {
  const all = readTaskFile("notifications.json");
  const unread = _req.query.unread === "true";
  const limit = parseInt(_req.query.limit) || 50;
  const filtered = unread ? all.filter(n => !n.read) : all;
  res.json(filtered.slice(0, limit));
});

app.get("/notifications/unread-count", (_req, res) => {
  const all = readTaskFile("notifications.json");
  res.json({ count: all.filter(n => !n.read).length });
});

app.post("/notifications", (req, res) => {
  const notifs = readTaskFile("notifications.json");
  const n = {
    id: genId(), type: req.body.type || "system", agent: req.body.agent || null,
    title: req.body.title || "", message: req.body.message || "",
    severity: req.body.severity || "info", read: false,
    created_at: new Date().toISOString(),
  };
  notifs.unshift(n);
  if (notifs.length > 100) notifs.length = 100;
  writeTaskFile("notifications.json", notifs);
  res.status(201).json(n);
});

app.patch("/notifications/:id/read", (req, res) => {
  const notifs = readTaskFile("notifications.json");
  const n = notifs.find(n => n.id === req.params.id);
  if (!n) return res.status(404).json({ error: "Not found" });
  n.read = true;
  writeTaskFile("notifications.json", notifs);
  res.json(n);
});

app.post("/notifications/read-all", (_req, res) => {
  const notifs = readTaskFile("notifications.json");
  notifs.forEach(n => n.read = true);
  writeTaskFile("notifications.json", notifs);
  res.json({ ok: true });
});

app.delete("/notifications/:id", (req, res) => {
  writeTaskFile("notifications.json", readTaskFile("notifications.json").filter(n => n.id !== req.params.id));
  res.json({ ok: true });
});

// ── TASK COMPLETION WATCHER ───────────────────
const WATCHED_TASKS = {
  Designer: "designer-tasks.json",
  "Video Editor": "video-tasks.json",
  Researcher: "research-tasks.json",
  "Script Writer": "scriptwriter-tasks.json",
  "UGC Video": "ugc-tasks.json",
};

let prevSnapshot = {};

function buildSnapshot() {
  const snap = {};
  for (const [agent, file] of Object.entries(WATCHED_TASKS)) {
    for (const task of readTaskFile(file)) {
      snap[task.id] = { status: task.status, agent, desc: task.description || task.type || "", result_url: task.result_url || null, result_video_id: task.result_video_id || null, result: task.result || null };
    }
  }
  return snap;
}

prevSnapshot = buildSnapshot();

setInterval(() => {
  const current = buildSnapshot();
  const notifs = readTaskFile("notifications.json");
  let changed = false;

  for (const [id, cur] of Object.entries(current)) {
    const prev = prevSnapshot[id];
    // Notify on: new task already completed, OR existing task that just completed
    const isNewAndCompleted = !prev && cur.status === "completed";
    const justCompleted = prev && prev.status !== "completed" && cur.status === "completed";
    if (isNewAndCompleted || justCompleted) {
      const title = `${cur.agent} klaar`;
      let message = cur.desc || "Taak afgerond";
      if (cur.result_url) message += `\nDownload: ${cur.result_url}`;
      notifs.unshift({
        id: genId(), type: "task_completed", agent: cur.agent,
        title, message, severity: "success", read: false, created_at: new Date().toISOString(),
        result_url: cur.result_url || null,
      });
      sendTelegram(title, cur.desc || "Taak afgerond", "success");
      changed = true;
    }
    const isNewAndError = !prev && cur.status === "error";
    const justErrored = prev && !prev.status?.startsWith("error") && cur.status === "error";
    if (isNewAndError || justErrored) {
      const title = `${cur.agent} fout`;
      const message = cur.desc || "Taak mislukt";
      notifs.unshift({
        id: genId(), type: "task_error", agent: cur.agent,
        title, message, severity: "danger", read: false, created_at: new Date().toISOString(),
      });
      sendTelegram(title, message, "danger");
      changed = true;
    }
  }

  if (changed) {
    if (notifs.length > 100) notifs.length = 100;
    writeTaskFile("notifications.json", notifs);
  }
  prevSnapshot = current;
}, 15_000);

// ── AI CHAT ───────────────────────────────────
const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic();

// Chat history per session (in-memory, resets on server restart)
const chatSessions = {};
const MAX_HISTORY = 40;

function gatherContext() {
  // Gather live system state for Claude's context
  const parts = [];

  // Agent tasks
  for (const [agent, file] of Object.entries(WATCHED_TASKS)) {
    const tasks = readTaskFile(file);
    const pending = tasks.filter(t => t.status === "pending").length;
    const processing = tasks.filter(t => t.status === "processing").length;
    const completed = tasks.filter(t => t.status === "completed").length;
    const recent = tasks.slice(0, 3).map(t => `  - [${t.status}] ${t.description || t.type || t.id}`).join("\n");
    parts.push(`${agent}: ${pending} pending, ${processing} processing, ${completed} completed\n${recent}`);
  }

  // Notifications
  const notifs = readTaskFile("notifications.json").slice(0, 10);
  if (notifs.length) {
    parts.push("Recent notifications:\n" + notifs.map(n => `  - [${n.severity}] ${n.title}: ${n.message}`).join("\n"));
  }

  return parts.join("\n\n");
}

// ── BRAND CONFIG ──────────────────────────────
function loadBrand() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "brand.json"), "utf8"));
  } catch {
    return { company_name: "Command Center", assistant_name: "Assistant", tagline: "" };
  }
}

app.get("/brand", (_req, res) => {
  const brand = loadBrand();
  brand.features = {
    telegram: !!TG_TOKEN,
    higgsfield: !!process.env.HIGGSFIELD_API_KEY,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    composio: !!process.env.COMPOSIO_API_KEY,
    youtube: !!process.env.YOUTUBE_API_KEY,
  };
  res.json(brand);
});

app.get("/youtube-key", (_req, res) => {
  res.json({ key: process.env.YOUTUBE_API_KEY || null });
});

function buildSystemPrompt() {
  const brand = loadBrand();
  if (!IS_NL) {
    return `You are ${brand.assistant_name}, the AI assistant for ${brand.company_name}, built into the ${brand.company_name} Command Center.
You help the user orchestrate agents and answer questions about the system.
You are the central brain of the Command Center — you have access to ALL agents and ALL skills.

COMMAND CENTER AGENTS:
- Designer — social media designs, carousels, thumbnails, banners, infographics (engines: Nano Banana, Playwright, Canva)
- Video Editor — video editing via Remotion
- Content Creator — Higgsfield UGC videos + OpusClip clipper
- Analyst — performance analyses, risk reports, daily reports
- Researcher — trending content, competitor analysis, market research, keyword research
- Script Writer — video scripts, social posts, threads, newsletters
- Marketeer — 25 marketing skills: copywriting, SEO, CRO, ads, email sequences, pricing, launch strategy, and more
- Calendar — Google Calendar management (events, free slots, planning)
- Every agent has a task list (pending/processing/completed)

You can:
1. Explain what agents do and how they perform
2. Analyze tasks and make suggestions
3. Answer questions about performance and results
4. Propose content ideas and scripts
5. Search the web for current news, market data, and real-time information
6. ORCHESTRATE AGENTS — create tasks for any agent via tools:
   - create_script: write a script (Script Writer)
   - create_design: create a design (Designer). For carousels: design_type="instagram_carousel" + slide_count. Engine: "nanobanana" (AI image), "playwright" (HTML), "claude" (Canva). Default engine is nanobanana.
   - create_video_edit: edit a video via Remotion (Video Editor)
   - create_research: run research (Researcher)
   - calendar_query: manage Google Calendar — view, create, delete events, find free slots
   - marketeer_query: marketing STRATEGY & advice — content planning, copywriting, SEO, CRO, launch/ad strategy. This agent has NO access to your live ad accounts.
   - ads_query: read LIVE Meta Ads data from the connected ad accounts — accounts, campaigns, adsets, ads, insights/ROAS/spend, pixels. Use this for any question about campaign status, performance, spend or results.
   - ads_action: take LIVE actions on Meta Ads — create/duplicate campaigns/adsets/ads, pause/activate, set budget, update targeting/placements/creative/pixel.

IMPORTANT when orchestrating agents:
- Use the tools to actually create tasks, don't just describe what you would do
- Always confirm which tasks you created and at which agent
- For LIVE Meta Ads data/status (campaigns, ROAS, spend, results) or actions (pause/budget/create) → use ads_query / ads_action, NOT marketeer_query. Meta Ads IS connected; first call ads_query type="accounts" to get the account_id, then query campaigns/insights with that account_id.
- For marketing STRATEGY/advice only (no live account data) → use marketeer_query
- For calendar questions → use calendar_query

You have access to web search. Use it when the user asks for current news, price movement, or information more recent than your training data.

Reply in the user's language. Be concise and direct. Do not use emoji unless asked.`;
  }
  return `Je bent ${brand.assistant_name}, de AI assistant van ${brand.company_name}, ingebouwd in het ${brand.company_name} Command Center.
Je helpt de gebruiker met het aansturen van agents, het monitoren van bots, en het beantwoorden van vragen over het systeem.
Je bent het centrale brein van het Command Center — je hebt toegang tot ALLE agents en ALLE skills.

COMMAND CENTER AGENTS:
- Designer — Social media designs, carousels, thumbnails, banners, infographics (engines: Nano Banana, Playwright, Canva)
- Video Editor — Video editing via Remotion (React-based video)
- Content Creator — Higgsfield UGC videos + OpusClip clipper
- Researcher — Trending content, competitor analysis, marktonderzoek, keyword research
- Script Writer — Video scripts, social posts, threads, newsletters
- Marketeer — 25 marketing skills: copywriting, SEO, CRO, ads, email sequences, pricing, launch strategie, en meer
- Calendar — Google Calendar beheer (events, vrije slots, planning)
- Alle agents hebben een takenlijst (pending/processing/completed)

GEÏNSTALLEERDE SKILLS (48 totaal):
Media & Design:
  /avatar-video — Avatar video met exacte controle over script, stem, scenes
  /designer — Carousels, thumbnails, banners, infographics
  /nano-banana-2 — AI image generation via Google Gemini Flash
  /remotion-best-practices — Remotion video creation best practices
  /canvas-design — Posters, art, designs als PNG/PDF
  /web-artifacts-builder — Multi-component HTML artifacts (React + Tailwind + shadcn/ui)

Marketing (25 skills via Marketeer agent):
  /copywriting, /copy-editing — Marketing copy schrijven en reviewen
  /email-sequence — Drip campaigns, welcome sequences, lifecycle emails
  /social-content — LinkedIn, Twitter/X, Instagram, TikTok content
  /content-strategy — Content planning, topic clusters
  /launch-strategy — Product launches, go-to-market
  /pricing-strategy — Pricing tiers, packaging, monetization
  /paid-ads — Google Ads, Meta, LinkedIn campaigns
  /marketing-psychology — 70+ mental models voor marketing
  /marketing-ideas — 139 bewezen marketing tactieken
  /referral-program — Referral & affiliate programma's
  /free-tool-strategy — Lead gen tools bouwen
  /product-marketing-context — Positionering & context document
  /competitor-alternatives — "vs" en "alternative to" pagina's

SEO & Analytics:
  /seo-audit — Technische SEO audit
  /analytics-tracking — GA4, GTM, conversion tracking
  /programmatic-seo — SEO pagina's op schaal
  /schema-markup — JSON-LD structured data

CRO & Conversion:
  /page-cro — Landing page optimalisatie
  /signup-flow-cro — Signup/registratie flows
  /onboarding-cro — Post-signup activatie
  /form-cro — Formulier optimalisatie
  /popup-cro — Popups, modals, exit-intent
  /paywall-upgrade-cro — In-app paywalls, upgrade screens
  /ab-test-setup — A/B tests plannen en opzetten

Development (Superpowers):
  /brainstorming — Requirements & design verkennen voor implementatie
  /dispatching-parallel-agents — Parallelle taken dispatchen
  /executing-plans — Implementatieplannen uitvoeren
  /finishing-a-development-branch — Branch completion (merge/PR/cleanup)
  /receiving-code-review — Code review feedback verwerken
  /requesting-code-review — Code review aanvragen
  /subagent-driven-development — Subagent-driven implementatie
  /systematic-debugging — Methodisch debuggen
  /test-driven-development — TDD workflow
  /using-git-worktrees — Git worktree isolatie
  /verification-before-completion — Verificatie voor completion claims
  /writing-plans — Implementatieplannen schrijven
  /writing-skills — Nieuwe skills maken en testen

System:
  /claude-api — Claude API / Anthropic SDK apps bouwen
  /loop — Commands op interval herhalen
  /schedule — Cron-based scheduled agents
  /find-skills — Nieuwe skills ontdekken en installeren

Je kunt:
1. Uitleggen wat bots/agents doen en hoe ze presteren
2. Adviseren over bot configuratie en strategie
3. Taken analyseren en suggesties doen
4. Vragen beantwoorden over trades, PnL, en performance
5. Content ideeën en scripts voorstellen
6. Het web doorzoeken voor actueel nieuws, marktdata, crypto events en andere real-time informatie
7. AGENTS AANSTUREN — je kunt taken aanmaken bij alle agents via tools:
   - create_script: Script laten schrijven (Script Writer)
   - create_design: Design laten maken (Designer) — BELANGRIJK: gebruik altijd de juiste parameters! Bij carousel: design_type="instagram_carousel" + slide_count. Engine: "nanobanana" (AI image), "playwright" (HTML), "claude" (Canva). Standaard engine is nanobanana.
   - create_video_edit: Video laten editen via Remotion (Video Editor)
   - create_research: Onderzoek laten doen (Researcher)
   - calendar_query: Google Calendar beheren — events bekijken, aanmaken, verwijderen, vrije slots vinden
   - marketeer_query: Marketing STRATEGIE & advies — content planning, copywriting, SEO, CRO, launch/ad-strategie. Deze agent heeft GEEN toegang tot je live ad accounts.
   - ads_query: LIVE Meta Ads data ophalen uit de gekoppelde ad accounts — accounts, campaigns, adsets, ads, insights/ROAS/spend, pixels. Gebruik dit voor elke vraag over campagne-status, performance, spend of resultaten.
   - ads_action: LIVE acties op Meta Ads — campagnes/adsets/ads aanmaken/dupliceren, pauzeren/activeren, budget aanpassen, targeting/placements/creative/pixel wijzigen.
8. SKILLS KENNIS — als de gebruiker vraagt over een skill, leg uit wat het doet en hoe het aan te roepen. Skills worden aangeroepen als /skill-name in Claude Code.
9. MARKETING EXPERTISE — via de marketeer_query tool kun je alle 25 marketing skills inzetten. Route marketing-gerelateerde vragen naar de Marketeer agent.

BELANGRIJK bij het aansturen van agents:
- Gebruik de tools om taken daadwerkelijk aan te maken, niet alleen beschrijven wat je zou doen
- Als de gebruiker vraagt om een video te maken, maak dan direct de taak aan
- Bevestig altijd welke taken je hebt aangemaakt en bij welke agent
- Bij LIVE Meta Ads data/status (campagnes, ROAS, spend, resultaten) of acties (pauzeren/budget/aanmaken) → gebruik ads_query / ads_action, NIET marketeer_query. Meta Ads IS verbonden; roep eerst ads_query type="accounts" aan voor het account_id, en query daarna campaigns/insights met dat account_id.
- Bij marketing STRATEGIE/advies zonder live accountdata (SEO, copy, CRO, etc.) → gebruik marketeer_query
- Bij calendar vragen → gebruik calendar_query
- Je bent proactief: stel voor om meerdere agents tegelijk in te zetten als dat zinvol is

Je hebt toegang tot web search. Gebruik dit wanneer de gebruiker vraagt naar actueel nieuws, prijsbewegingen, of informatie recenter dan je training data.

Je spreekt Nederlands tenzij de gebruiker Engels praat.
Wees beknopt en direct. Gebruik geen emoji tenzij gevraagd.`;
}

// Built per-request so it always reflects current brand.json

app.post("/ctrl/chat", async (req, res) => {
  const { message, sessionId = "default" } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  if (!chatSessions[sessionId]) chatSessions[sessionId] = [];
  const history = chatSessions[sessionId];

  // Add user message
  history.push({ role: "user", content: message });

  // Trim history if too long
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  // Sanitize history: ensure every tool_use has a following tool_result
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const toolUseIds = msg.content.filter(b => b.type === "tool_use").map(b => b.id);
      if (toolUseIds.length > 0) {
        const next = history[i + 1];
        if (!next || next.role !== "user" || !Array.isArray(next.content)) {
          console.warn(`[CHAT] Removing orphaned tool_use message at index ${i}`);
          history.splice(i, 1);
        } else {
          const resultIds = new Set(next.content.filter(b => b.type === "tool_result").map(b => b.tool_use_id));
          const missing = toolUseIds.filter(id => !resultIds.has(id));
          if (missing.length) {
            console.warn(`[CHAT] Patching ${missing.length} missing tool_results at index ${i + 1}`);
            for (const id of missing) {
              next.content.push({ type: "tool_result", tool_use_id: id, content: "Tool result unavailable." });
            }
          }
        }
      }
    }
  }

  try {
    // Prompt caching: split the system prompt into a STABLE block (cached across all
    // chats — brand-based, byte-identical) and a VOLATILE block (live agent/task status,
    // never cached). The cache_control marker on the stable block caches tools + that block.
    const systemWithContext = [
      { type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } },
      { type: "text", text: "\n\nAGENT & TAAK STATUS:\n" + gatherContext() },
    ];

    const agentTools = [
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      // Browser automation tools (Playwright)
      ...BROWSER_TOOLS.map(t => ({ type: "custom", ...t })),
      {
        type: "custom",
        name: "create_script",
        description: "Maak een scriptwriter task aan bij de Script Writer agent.",
        input_schema: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Onderwerp van het script" },
            description: { type: "string", description: "Extra context en instructies voor het script" },
            format: { type: "string", enum: ["short-form", "long-form", "hook", "thread"], description: "Formaat. Standaard: short-form" },
            tone: { type: "string", enum: ["educational", "casual", "professional", "hype", "storytelling"], description: "Toon. Standaard: educational" },
            type: { type: "string", enum: ["video_script", "social_post", "thread", "newsletter"], description: "Type. Standaard: video_script" },
          },
          required: ["topic", "description"],
        },
      },
      {
        type: "custom",
        name: "create_design",
        description: "Maak een design task aan bij de Designer agent. Ondersteunt meerdere engines en carousel slides.",
        input_schema: {
          type: "object",
          properties: {
            description: { type: "string", description: "Beschrijving van het gewenste design" },
            design_type: { type: "string", enum: ["instagram_post", "instagram_carousel", "instagram_story", "youtube_thumbnail", "youtube_banner", "twitter_post", "facebook_post", "ad_creative", "infographic", "poster", "presentation", "logo"], description: "Type design. Standaard: instagram_post. Gebruik instagram_carousel voor meerdere slides. Gebruik ad_creative voor advertentie creatives (combineer met aspect_ratio)." },
            brand: { type: "string", description: "Brand naam. Wordt geladen uit brand configuratie." },
            engine: { type: "string", enum: ["nanobanana", "playwright", "claude", "canva"], description: "Rendering engine. Standaard: nanobanana. Nano Banana = AI image generation (Gemini), Playwright = instant HTML-to-image, Claude = Canva MCP" },
            slide_count: { type: "integer", description: "Aantal slides voor carousels (2-10). Alleen nodig bij instagram_carousel." },
            aspect_ratio: { type: "string", enum: ["1:1", "4:5", "9:16", "16:9", "1.91:1"], description: "Aspect ratio override (single). Alleen nodig bij ad_creative (of om de auto-mapping te overschrijven). Gebruik aspect_ratios voor meerdere varianten." },
            aspect_ratios: { type: "array", items: { type: "string", enum: ["1:1", "4:5", "9:16", "16:9", "1.91:1"] }, description: "Meerdere aspect ratios voor ad_creative — er wordt 1 creative per ratio gegenereerd." },
            logo_position: { type: "string", enum: ["SouthEast", "South", "SouthWest", "NorthEast", "North", "NorthWest", "Center", "none"], description: "Logo positie. Standaard: SouthEast" },
            logo_size: { type: "string", enum: ["small", "medium", "large"], description: "Logo grootte. Standaard: medium" },
            template: { type: "string", enum: ["default", "bold-impact", "clean-minimal", "data-dense"], description: "Layout template. Standaard: default" },
          },
          required: ["description"],
        },
      },
      {
        type: "custom",
        name: "create_video_edit",
        description: "Maak een video editing task aan bij de Video Editor agent (Remotion).",
        input_schema: {
          type: "object",
          properties: {
            description: { type: "string", description: "Beschrijving van de video edit" },
            template: { type: "string", enum: ["social-clip", "recap", "tutorial", "promo"], description: "Template. Standaard: social-clip" },
            aspect_ratio: { type: "string", enum: ["9:16", "16:9", "1:1"], description: "Aspect ratio. Standaard: 9:16" },
          },
          required: ["description"],
        },
      },
      {
        type: "custom",
        name: "create_research",
        description: "Maak een research task aan bij de Researcher agent.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "De onderzoeksvraag of zoekopdracht" },
            type: { type: "string", enum: ["trending", "competitor", "market", "content_ideas", "keywords"], description: "Type onderzoek. Standaard: trending" },
            platforms: { type: "array", items: { type: "string" }, description: "Platformen om te onderzoeken. Standaard: [tiktok, x, reddit]" },
            niche: { type: "string", description: "Niche/markt. Standaard: crypto trading" },
          },
          required: ["query"],
        },
      },
      {
        type: "custom",
        name: "calendar_query",
        description: "Beheer de Google Calendar van de gebruiker. Gebruik voor: agenda bekijken, events aanmaken/verwijderen, vrije slots vinden, meetings plannen. Stuur een natuurlijke-taal opdracht die de Calendar Assistant uitvoert.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "De vraag of opdracht voor de calendar, bijv. 'wat staat er vandaag op mijn agenda?' of 'plan een meeting morgen om 14:00 voor 1 uur genaamd Teamoverleg'" },
          },
          required: ["query"],
        },
      },
      {
        type: "custom",
        name: "marketeer_query",
        description: "Vraag de Marketeer agent om marketing advies, content strategie, copywriting, SEO audits, ad campagnes, social media planning, pricing strategie, en meer. De Marketeer heeft 25 professionele marketing skills als kennisbasis.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "De marketing vraag of opdracht, bijv. 'maak een social media plan voor deze week' of 'schrijf copy voor onze landing page'" },
          },
          required: ["query"],
        },
      },
      {
        type: "custom",
        name: "ads_query",
        description: "Haal Meta Ads data op: accounts, campaigns, adsets, ads, of insights. Gebruik voor performance vragen, ROAS checks, spend overzichten, etc.",
        input_schema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["accounts", "campaigns", "adsets", "ads", "insights", "pixels"], description: "Type data om op te halen. 'pixels' = beschikbare Meta pixels op het ad account." },
            account_id: { type: "string", description: "Ad account ID (verplicht voor campaigns/adsets/ads/insights/pixels). Haal eerst accounts op om IDs te vinden." },
            campaign_id: { type: "string", description: "Optioneel: filter op campaign ID (voor adsets/ads)" },
            date_preset: { type: "string", enum: ["today", "yesterday", "last_7d", "last_14d", "last_30d", "this_month", "last_month"], description: "Periode voor insights. Default: last_7d" },
          },
          required: ["type"],
        },
      },
      {
        type: "custom",
        name: "ads_action",
        description: "Voer een actie uit op Meta Ads: nieuwe campagne/adset/ad aanmaken, campagne dupliceren, pauzeren/activeren, budget aanpassen, targeting/placements/creative/pixel wijzigen. Gebruik na ads_query om context te hebben. Een complete campagne van nul bouw je in 3 stappen: create_campaign → create_adset (met campaign_id uit stap 1) → create_ad (met adset_id uit stap 2). Alles komt altijd PAUSED binnen. create_campaign: vereist name + objective, object_id niet nodig. duplicate_campaign: kopieert bestaande campagne incl. adsets+ads, object_id = campaign ID. create_adset: vereist campaign_id, name, optimization_goal en targeting (minstens geo_locations via de geo_locations/age_min/genders/etc velden); geef daily_budget of lifetime_budget tenzij de campagne campagnebudget (CBO) heeft; voor conversie-doelen geef pixel_id + custom_event_type. create_ad: vereist adset_id + name, plus óf creative_id óf page_id + creative-velden (message/link/image_url/headline/call_to_action). Voor update_targeting/update_placements/update_pixel is level='adset' verplicht; voor update_creative is level='ad' verplicht. Voor update_pixel kun je eerst ads_query met type='pixels' doen om beschikbare pixel IDs te vinden.",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create_campaign", "create_adset", "create_ad", "duplicate_campaign", "pause", "activate", "set_budget", "update_targeting", "update_placements", "update_creative", "update_pixel"], description: "De actie" },
            level: { type: "string", enum: ["campaign", "adset", "ad"], description: "Op welk niveau. Default: campaign" },
            object_id: { type: "string", description: "Het ID van de campaign/adset/ad. Verplicht voor alle acties behalve create_campaign. Voor duplicate_campaign = het campaign ID dat je wilt kopiëren." },
            account_id: { type: "string", description: "Ad account ID" },
            name: { type: "string", description: "Campagnenaam. Verplicht voor create_campaign." },
            objective: { type: "string", enum: ["OUTCOME_TRAFFIC", "OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_ENGAGEMENT", "OUTCOME_AWARENESS", "OUTCOME_APP_PROMOTION"], description: "Campagne-doel. Verplicht voor create_campaign." },
            buying_type: { type: "string", enum: ["AUCTION", "RESERVED"], description: "Buying type voor create_campaign. Default AUCTION." },
            special_ad_categories: { type: "array", items: { type: "string" }, description: "Speciale advertentiecategorieën voor create_campaign, bijv. ['CREDIT'], ['EMPLOYMENT'], ['HOUSING'], ['FINANCIAL_PRODUCTS_SERVICES'], ['ISSUES_ELECTIONS_POLITICS']. Default leeg ([])." },
            rename_suffix: { type: "string", description: "Optioneel suffix voor de gedupliceerde campagne (duplicate_campaign). Default ' - Copy'." },
            campaign_id: { type: "string", description: "Campaign ID waaronder de nieuwe ad set valt (verplicht voor create_adset)." },
            adset_id: { type: "string", description: "Ad set ID waaronder de nieuwe ad valt (verplicht voor create_ad)." },
            optimization_goal: { type: "string", description: "Optimalisatiedoel voor create_adset, bijv. LINK_CLICKS, LANDING_PAGE_VIEWS, OFFSITE_CONVERSIONS, REACH, IMPRESSIONS, THRUPLAY, POST_ENGAGEMENT, LEAD_GENERATION, QUALITY_CALL." },
            billing_event: { type: "string", description: "Facturatie-event voor create_adset, bijv. IMPRESSIONS of LINK_CLICKS. Default IMPRESSIONS." },
            bid_amount: { type: "number", description: "Bod in euro's (niet centen) voor create_adset. Alleen nodig bij bid_strategy met cap (LOWEST_COST_WITH_BID_CAP / COST_CAP)." },
            bid_strategy: { type: "string", description: "Bod-strategie bij adset-budget, bijv. LOWEST_COST_WITHOUT_CAP (default), LOWEST_COST_WITH_BID_CAP, COST_CAP." },
            start_time: { type: "string", description: "Starttijd ISO-8601, bijv. '2026-06-01T09:00:00+0200' (create_adset, optioneel)." },
            end_time: { type: "string", description: "Eindtijd ISO-8601 (create_adset). Verplicht bij lifetime_budget." },
            destination_type: { type: "string", description: "Bestemmingstype voor create_adset, bijv. WEBSITE, MESSENGER, WHATSAPP, INSTAGRAM_DIRECT, APP." },
            advantage_audience: { type: "integer", description: "Meta Advantage-doelgroep voor create_adset/update_targeting: 1=aan (Meta verbreedt je targeting), 0=uit. Default 0 als niet opgegeven." },
            daily_budget: { type: "number", description: "Nieuw daily budget in euro's (niet centen). Alleen voor set_budget." },
            lifetime_budget: { type: "number", description: "Nieuw lifetime budget in euro's. Alleen voor set_budget." },
            geo_locations: { type: "object", description: "Geo targeting object voor update_targeting. Bijv. {countries:['NL','BE'], cities:[{key:'2421344'}], regions:[{key:'4040'}]}." },
            age_min: { type: "integer", description: "Minimum leeftijd (13-65) voor update_targeting." },
            age_max: { type: "integer", description: "Maximum leeftijd (13-65) voor update_targeting." },
            genders: { type: "array", items: { type: "integer" }, description: "Geslacht voor update_targeting: [1]=man, [2]=vrouw, [1,2]=beide." },
            interests: { type: "array", items: { type: "object" }, description: "Interesses voor update_targeting, bijv. [{id:'6003107902433', name:'Bitcoin'}]." },
            custom_audiences: { type: "array", items: { type: "object" }, description: "Custom audiences voor update_targeting: [{id:'...'}]." },
            excluded_custom_audiences: { type: "array", items: { type: "object" }, description: "Uit te sluiten custom audiences." },
            flexible_spec: { type: "array", description: "Geavanceerde flexibele targeting spec (interests/behaviors per AND-groep)." },
            publisher_platforms: { type: "array", items: { type: "string" }, description: "Placements (update_placements): bijv. ['facebook','instagram','messenger','audience_network']." },
            facebook_positions: { type: "array", items: { type: "string" }, description: "Facebook posities: feed, marketplace, video_feeds, story, search, instream_video, facebook_reels." },
            instagram_positions: { type: "array", items: { type: "string" }, description: "Instagram posities: stream, story, explore, reels, profile_feed." },
            messenger_positions: { type: "array", items: { type: "string" }, description: "Messenger posities: messenger_home, story, sponsored_messages." },
            audience_network_positions: { type: "array", items: { type: "string" }, description: "Audience Network posities: classic, rewarded_video." },
            device_platforms: { type: "array", items: { type: "string" }, description: "Device platforms: ['mobile','desktop']." },
            creative_id: { type: "string", description: "Bestaande creative ID koppelen aan de ad (update_creative)." },
            page_id: { type: "string", description: "Facebook page ID (verplicht bij nieuwe creative)." },
            message: { type: "string", description: "Primary text / body van de creative." },
            link: { type: "string", description: "Bestemmings-URL van de creative." },
            image_url: { type: "string", description: "URL naar afbeelding voor de creative (alternatief voor image_hash)." },
            image_hash: { type: "string", description: "Image hash uit Meta's library (alternatief voor image_url)." },
            video_id: { type: "string", description: "Video ID uit Meta's library voor een video-creative." },
            headline: { type: "string", description: "Headline / titel van de creative." },
            description: { type: "string", description: "Beschrijving onder de headline." },
            call_to_action: { type: "object", description: "CTA, bijv. {type:'SHOP_NOW', value:{link:'https://...'}}." },
            pixel_id: { type: "string", description: "Meta pixel ID voor update_pixel. Gebruik ads_query type='pixels' om beschikbare IDs te vinden." },
            custom_event_type: { type: "string", description: "Conversion event voor update_pixel: PURCHASE, LEAD, COMPLETE_REGISTRATION, ADD_TO_CART, INITIATE_CHECKOUT, ADD_PAYMENT_INFO, VIEW_CONTENT, SEARCH, SUBSCRIBE, START_TRIAL, CONTACT, CUSTOMIZE_PRODUCT, DONATE, FIND_LOCATION, SCHEDULE, SUBMIT_APPLICATION, OTHER." },
            custom_conversion_id: { type: "string", description: "Custom conversion ID (alternatief voor custom_event_type) voor update_pixel." },
            application_id: { type: "string", description: "App ID voor app-install/event campagnes (update_pixel)." },
            object_store_url: { type: "string", description: "App store URL voor app-campagnes (update_pixel)." },
            conversion_domain: { type: "string", description: "Geverifieerd domein voor conversies, bijv. 'example.com' (update_pixel, top-level adset field)." },
          },
          required: ["action", "account_id"],
        },
      },
      {
        type: "custom",
        name: "transcribe_audio",
        description: "Transcribeer een audio- of videobestand naar tekst met OpenAI Whisper. Het bestand moet al geüpload zijn in de media library. Geeft het volledige transcript terug, optioneel met tijdcodes (SRT).",
        input_schema: {
          type: "object",
          properties: {
            file_name: { type: "string", description: "Bestandsnaam in de media library, bijv. 'interview.mp4' of 'podcast.mp3'" },
            language: { type: "string", description: "Taalcode, bijv. 'nl', 'en', 'de'. Standaard: auto-detect" },
            format: { type: "string", enum: ["txt", "srt", "vtt", "json"], description: "Output formaat. 'txt' = platte tekst, 'srt' = ondertiteling met tijdcodes. Standaard: txt" },
            model: { type: "string", enum: ["tiny", "base", "small", "medium", "large"], description: "Whisper model. Groter = nauwkeuriger maar trager. Standaard: medium" },
          },
          required: ["file_name"],
        },
      },
      {
        type: "custom",
        name: "read_pdf",
        description: "Lees de tekst uit een PDF bestand dat in de media library is geüpload. Geeft de volledige tekst terug zodat je vragen kunt beantwoorden over de inhoud, samenvattingen kunt maken, etc.",
        input_schema: {
          type: "object",
          properties: {
            file_name: { type: "string", description: "Bestandsnaam in de media library, bijv. 'rapport.pdf'" },
          },
          required: ["file_name"],
        },
      },
      {
        type: "custom",
        name: "seo_analyze",
        description: "Start een SEO-analyse voor een website. Crawlt tot ~25 pagina's, checkt on-page/technical SEO, en (indien PSI_API_KEY ingesteld) Core Web Vitals. Levert een task_id op; gebruik daarna seo_query om het rapport op te halen zodra status='completed'. Duurt ~1-3 minuten.",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Volledige URL van de site die geanalyseerd moet worden, bijv. https://example.com" },
            max_pages: { type: "integer", description: "Max aantal te crawlen pagina's (1-100). Default 25." },
          },
          required: ["url"],
        },
      },
      {
        type: "custom",
        name: "seo_query",
        description: "Haal SEO-rapporten op. Zonder report_id: lijst van alle rapporten. Met report_id: het volledige rapport (findings per categorie, score, PSI scores, strategische review).",
        input_schema: {
          type: "object",
          properties: {
            report_id: { type: "string", description: "Optioneel: ID van een specifiek rapport. Zonder ID krijg je de lijst." },
            category: { type: "string", enum: ["technical", "onPage", "content", "structuredData", "mobile", "links", "international"], description: "Optioneel: filter een rapport op één categorie." },
          },
        },
      },
      {
        type: "custom",
        name: "opusclip_create",
        description: "Submit een long-form video (YouTube/Vimeo/directe URL) naar OpusClip om er korte virale clips van te maken. Geeft een task_id terug. Verwerking duurt enkele minuten — gebruik opusclip_status om voortgang en clips op te halen.",
        input_schema: {
          type: "object",
          properties: {
            video_url: { type: "string", description: "Volledige URL van de bronvideo, bijv. https://www.youtube.com/watch?v=..." },
            min_duration: { type: "integer", description: "Minimale cliplengte in seconden. Default 30." },
            max_duration: { type: "integer", description: "Maximale cliplengte in seconden. Default 90." },
            source_lang: { type: "string", description: "Bron-taalcode (bijv. 'en', 'nl', 'es') of 'auto'. Default: 'auto'." },
            topic_keywords: { type: "array", items: { type: "string" }, description: "Optionele onderwerpen om op te focussen, bijv. ['hook', 'key takeaway']." },
            description: { type: "string", description: "Korte interne omschrijving (max 200 tekens)." },
          },
          required: ["video_url"],
        },
      },
      {
        type: "custom",
        name: "opusclip_status",
        description: "Haal OpusClip taken op. Zonder task_id: laatste 20 taken (status, stage, aantal clips). Met task_id: volledig detail incl. clips array met preview/download URLs en virality scores.",
        input_schema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Optioneel: ID van een specifieke taak. Zonder ID krijg je de lijst." },
          },
        },
      },
      {
        type: "custom",
        name: "create_ugc_video",
        description: "Create a UGC video via Higgsfield. mode 'clip' animates an image with a UGC motion preset; mode 'speak' makes a talking avatar from an image + script (built-in TTS).",
        input_schema: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["clip", "speak"] },
            image_url: { type: "string", description: "URL of the source/product/avatar image" },
            prompt: { type: "string", description: "Clip mode: animation prompt" },
            script: { type: "string", description: "Speak mode: the script the avatar speaks" },
            motion_preset: { type: "string", description: "Clip mode preset, e.g. ugc, unboxing, product-review" },
            aspect_ratio: { type: "string", enum: ["9:16", "1:1", "16:9"] },
            description: { type: "string" },
          },
          required: ["mode", "image_url"],
        },
      },
      {
        type: "custom",
        name: "run_skill",
        description: `Voer een skill uit met een prompt. Gebruik dit voor taken die een specifieke skill vereisen, zoals SEO audits, CRO analyses, content strategie, brainstorming, design briefs, plan writing, etc.

Beschikbare skills:
SEO & Analytics: seo-audit, analytics-tracking, programmatic-seo, schema-markup
CRO & Conversion: page-cro, signup-flow-cro, onboarding-cro, form-cro, popup-cro, paywall-upgrade-cro, ab-test-setup
Content & Marketing: content-strategy, copywriting, copy-editing, email-sequence, social-content, launch-strategy, pricing-strategy, paid-ads, marketing-psychology, marketing-ideas, referral-program, free-tool-strategy, product-marketing-context, competitor-alternatives, youtube-optimizer
Design & Media: designer, canvas-design, nano-banana-2, web-artifacts-builder, create-video, avatar-video, remotion-best-practices
Planning & Process: brainstorming, writing-plans, executing-plans, writing-skills, find-skills, dispatching-parallel-agents
Engineering: systematic-debugging, test-driven-development, verification-before-completion, requesting-code-review, receiving-code-review, subagent-driven-development, finishing-a-development-branch, using-git-worktrees, using-superpowers

Gebruik NIET voor simpele marketing vragen — daarvoor heb je marketeer_query. Gebruik run_skill voor wanneer je een volledige skill-gebaseerde analyse, audit, of plan nodig hebt met diepgaande output.

BELANGRIJK: Het originele bericht van de gebruiker (inclusief geplakte content, transcripten, links) wordt AUTOMATISCH als context toegevoegd aan de skill. Je hoeft het transcript of lange content NIET over te typen in het prompt veld. Schrijf in het prompt veld alleen een korte instructie, bijv. "Optimaliseer dit transcript voor YouTube volgens de skill regels".

KRITIEK: De 'output' van deze tool is al volledig geformatteerd voor de eindgebruiker. Toon die output VERBATIM in je antwoord. NIET samenvatten, NIET herformuleren, NIET inkorten, NIET sectiekoppen of opmaak wijzigen. Hooguit 1 regel intro toevoegen (bijv. "Hier is je YouTube pakket:"), daarna exact de skill-output.`,
        input_schema: {
          type: "object",
          properties: {
            skill: { type: "string", description: "De skill slug, bijv. 'seo-audit', 'page-cro', 'copywriting', 'brainstorming', 'writing-plans'" },
            prompt: { type: "string", description: "De volledige opdracht EN alle benodigde input/context voor de skill. Stuur ALTIJD alle relevante data mee: het volledige transcript, de URL, de paginatekst, etc. De skill draait in een aparte sessie en heeft GEEN toegang tot de chathistorie. Alles wat de skill nodig heeft moet in dit veld staan." },
          },
          required: ["skill", "prompt"],
        },
      },
    ];

    // Map tool names to internal API endpoints and body builders
    const TOOL_ACTIONS = {
      create_script: (input) => ({
        url: "http://localhost:3004/scriptwriter/tasks",
        body: {
          topic: input.topic,
          description: input.description,
          format: input.format || "short-form",
          tone: input.tone || "educational",
          type: input.type || "video_script",
        },
      }),
      create_design: (input) => ({
        url: "http://localhost:3004/designer/tasks",
        body: {
          description: input.description,
          design_type: input.design_type || "instagram_post",
          brand: input.brand || (loadBrand().company_name || "DEFAULT").toUpperCase(),
          engine: input.engine || "nanobanana",
          slide_count: input.slide_count || null,
          aspect_ratio: input.aspect_ratio || null,
          aspect_ratios: Array.isArray(input.aspect_ratios) ? input.aspect_ratios : null,
          logo_position: input.logo_position || "SouthEast",
          logo_size: input.logo_size || "medium",
          template: input.template || "default",
        },
      }),
      create_video_edit: (input) => ({
        url: "http://localhost:3004/video/tasks",
        body: {
          description: input.description,
          template: input.template || "social-clip",
          aspect_ratio: input.aspect_ratio || "9:16",
        },
      }),
      create_research: (input) => ({
        url: "http://localhost:3004/research/tasks",
        body: {
          query: input.query,
          type: input.type || "trending",
          platforms: input.platforms || ["tiktok", "x", "reddit"],
          niche: input.niche || "crypto trading",
        },
      }),
      calendar_query: (input) => ({
        url: "http://localhost:3004/calendar/chat",
        body: {
          message: input.query,
          sessionId: "assistant_calendar",
        },
        isCalendar: true,
      }),
      marketeer_query: (input) => ({
        url: "http://localhost:3004/marketeer/chat",
        body: {
          message: input.query,
          sessionId: "assistant_marketeer",
        },
        isCalendar: true, // same response format: { reply: "..." }
      }),
      ads_query: (input) => {
        const t = input.type || "accounts";
        const qs = new URLSearchParams();
        if (input.account_id) qs.set("account_id", input.account_id);
        if (input.campaign_id) qs.set("campaign_id", input.campaign_id);
        if (input.date_preset) qs.set("date_preset", input.date_preset);
        const endpoints = {
          accounts: "/ads/accounts",
          campaigns: "/ads/campaigns",
          adsets: "/ads/adsets",
          ads: "/ads/ads",
          insights: "/ads/insights",
          pixels: "/ads/pixels",
        };
        return { url: `http://localhost:3004${endpoints[t] || "/ads/accounts"}?${qs}`, method: "GET", isAds: true };
      },
      ads_action: (input) => {
        const level = input.level || "campaign";
        const endpoints = { campaign: "campaigns", adset: "adsets", ad: "ads" };
        const seg = endpoints[level] || "campaigns";
        // Assemble a targeting object from the individual targeting fields
        const buildTargeting = () => {
          const t = {};
          if (input.geo_locations !== undefined) t.geo_locations = input.geo_locations;
          if (input.age_min !== undefined) t.age_min = input.age_min;
          if (input.age_max !== undefined) t.age_max = input.age_max;
          if (input.genders !== undefined) t.genders = input.genders;
          if (input.interests !== undefined) t.interests = input.interests;
          if (input.custom_audiences !== undefined) t.custom_audiences = input.custom_audiences;
          if (input.excluded_custom_audiences !== undefined) t.excluded_custom_audiences = input.excluded_custom_audiences;
          if (input.flexible_spec !== undefined) t.flexible_spec = input.flexible_spec;
          if (input.publisher_platforms !== undefined) t.publisher_platforms = input.publisher_platforms;
          if (input.facebook_positions !== undefined) t.facebook_positions = input.facebook_positions;
          if (input.instagram_positions !== undefined) t.instagram_positions = input.instagram_positions;
          if (input.messenger_positions !== undefined) t.messenger_positions = input.messenger_positions;
          if (input.audience_network_positions !== undefined) t.audience_network_positions = input.audience_network_positions;
          if (input.device_platforms !== undefined) t.device_platforms = input.device_platforms;
          if (input.advantage_audience !== undefined) t.targeting_automation = { advantage_audience: input.advantage_audience };
          return t;
        };
        if (input.action === "create_adset") {
          return {
            url: `http://localhost:3004/ads/adsets`,
            body: {
              account_id: input.account_id,
              campaign_id: input.campaign_id,
              name: input.name,
              optimization_goal: input.optimization_goal,
              billing_event: input.billing_event,
              bid_amount: input.bid_amount ? Math.round(input.bid_amount * 100) : undefined,
              bid_strategy: input.bid_strategy,
              daily_budget: input.daily_budget ? Math.round(input.daily_budget * 100) : undefined,
              lifetime_budget: input.lifetime_budget ? Math.round(input.lifetime_budget * 100) : undefined,
              start_time: input.start_time,
              end_time: input.end_time,
              destination_type: input.destination_type,
              conversion_domain: input.conversion_domain,
              targeting: buildTargeting(),
              pixel_id: input.pixel_id,
              custom_event_type: input.custom_event_type,
              custom_conversion_id: input.custom_conversion_id,
              application_id: input.application_id,
              object_store_url: input.object_store_url,
              page_id: input.page_id,
            },
          };
        }
        if (input.action === "create_ad") {
          return {
            url: `http://localhost:3004/ads/ads`,
            body: {
              account_id: input.account_id,
              adset_id: input.adset_id || input.object_id,
              name: input.name,
              creative_id: input.creative_id,
              page_id: input.page_id,
              message: input.message,
              link: input.link,
              image_url: input.image_url,
              image_hash: input.image_hash,
              video_id: input.video_id,
              headline: input.headline,
              description: input.description,
              call_to_action: input.call_to_action,
            },
          };
        }
        if (input.action === "create_campaign") {
          return {
            url: `http://localhost:3004/ads/campaigns`,
            body: {
              account_id: input.account_id,
              name: input.name,
              objective: input.objective,
              buying_type: input.buying_type,
              special_ad_categories: Array.isArray(input.special_ad_categories) ? input.special_ad_categories : [],
              daily_budget: input.daily_budget ? Math.round(input.daily_budget * 100) : undefined,
              lifetime_budget: input.lifetime_budget ? Math.round(input.lifetime_budget * 100) : undefined,
            },
          };
        }
        if (input.action === "duplicate_campaign") {
          return {
            url: `http://localhost:3004/ads/campaigns/${input.object_id}/copy`,
            body: { account_id: input.account_id, rename_suffix: input.rename_suffix },
          };
        }
        if (input.action === "set_budget") {
          return {
            url: `http://localhost:3004/ads/${seg}/${input.object_id}/budget`,
            body: {
              account_id: input.account_id,
              daily_budget: input.daily_budget ? Math.round(input.daily_budget * 100) : undefined,
              lifetime_budget: input.lifetime_budget ? Math.round(input.lifetime_budget * 100) : undefined,
            },
          };
        }
        if (input.action === "update_targeting" || input.action === "update_placements") {
          return {
            url: `http://localhost:3004/ads/adsets/${input.object_id}/targeting`,
            body: { account_id: input.account_id, targeting: buildTargeting() },
          };
        }
        if (input.action === "update_creative") {
          return {
            url: `http://localhost:3004/ads/ads/${input.object_id}/creative`,
            body: {
              account_id: input.account_id,
              creative_id: input.creative_id,
              page_id: input.page_id,
              message: input.message,
              link: input.link,
              image_url: input.image_url,
              image_hash: input.image_hash,
              video_id: input.video_id,
              headline: input.headline,
              description: input.description,
              call_to_action: input.call_to_action,
            },
          };
        }
        if (input.action === "update_pixel") {
          return {
            url: `http://localhost:3004/ads/adsets/${input.object_id}/promoted-object`,
            body: {
              account_id: input.account_id,
              pixel_id: input.pixel_id,
              custom_event_type: input.custom_event_type,
              custom_conversion_id: input.custom_conversion_id,
              application_id: input.application_id,
              object_store_url: input.object_store_url,
              page_id: input.page_id,
              conversion_domain: input.conversion_domain,
            },
          };
        }
        return {
          url: `http://localhost:3004/ads/${seg}/${input.object_id}/status`,
          body: { status: input.action === "pause" ? "PAUSED" : "ACTIVE", account_id: input.account_id },
        };
      },
      seo_analyze: (input) => ({
        url: "http://localhost:3004/seo/tasks",
        body: {
          url: input.url,
          max_pages: input.max_pages || 25,
        },
      }),
      seo_query: (input) => {
        if (input.report_id) {
          return { url: `http://localhost:3004/seo/reports/${input.report_id}`, method: "GET", isSeo: true, seoCategory: input.category || null };
        }
        return { url: "http://localhost:3004/seo/reports", method: "GET", isSeo: true };
      },
      opusclip_create: (input) => ({
        url: "http://localhost:3004/opusclip/tasks",
        body: {
          video_url: input.video_url,
          min_duration: input.min_duration,
          max_duration: input.max_duration,
          source_lang: input.source_lang,
          topic_keywords: Array.isArray(input.topic_keywords) ? input.topic_keywords : [],
          description: input.description || "",
        },
      }),
      opusclip_status: (input) => ({
        url: "http://localhost:3004/opusclip/tasks",
        method: "GET",
        isOpusclip: true,
        opusclipTaskId: input.task_id || null,
      }),
      create_ugc_video: (input) => ({
        url: "http://localhost:3004/ugc/tasks",
        body: {
          mode: input.mode || "clip",
          image_url: input.image_url,
          prompt: input.prompt || "",
          script: input.script || "",
          motion_preset: input.motion_preset || "ugc",
          aspect_ratio: input.aspect_ratio || "9:16",
          description: input.description || "",
        },
      }),
    };

    const apiParams = {
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemWithContext,
      messages: history,
      tools: agentTools,
    };

    // Prompt caching: rolling breakpoint on the last block of the growing history so each
    // tool-loop iteration reads the prior conversation prefix from cache. Clears old message
    // markers first to stay under the 4-marker cap (system already uses 1).
    const setMsgCache = (msgs) => {
      for (const m of msgs) {
        if (Array.isArray(m.content)) for (const b of m.content) { if (b && b.cache_control) delete b.cache_control; }
      }
      const last = msgs[msgs.length - 1];
      if (!last) return;
      if (typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
      } else if (Array.isArray(last.content) && last.content.length) {
        last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
      }
    };

    setMsgCache(history);
    console.log(`[CHAT] API call #1 starting — history: ${JSON.stringify(history).length} chars, ${history.length} msgs`);
    let response = await anthropic.messages.create(apiParams);
    console.log(`[CHAT] API call #1 done — stop_reason: ${response.stop_reason}, blocks: [${response.content.map(b => b.type).join(",")}], text_len: ${response.content.filter(b => b.type === "text").map(b => (b.text||"").length).reduce((a,b) => a+b, 0)}`);
    { const u = response.usage || {}; console.log(`[CHAT][cache] in:${u.input_tokens} cache_write:${u.cache_creation_input_tokens||0} cache_read:${u.cache_read_input_tokens||0}`); }
    // Handle tool use loop (web search + agent actions)
    let loopCount = 0;
    const MAX_TOOL_LOOPS = 20; // multi-step ads flows (campaign→adset→ad) need headroom
    while (response.stop_reason === "tool_use" && loopCount < MAX_TOOL_LOOPS) {
      loopCount++;
      history.push({ role: "assistant", content: response.content });

      const toolResults = [];

      for (const block of response.content) {
        // Server-side tools (web_search) are handled entirely by Anthropic:
        // the assistant message already contains server_tool_use + web_search_tool_result
        // blocks. We must NOT emit user-side tool_results for them, or the next round will
        // 400 with "unexpected tool_use_id in tool_result blocks: srvtoolu_*".
        if (block.type === "server_tool_use" || block.type === "web_search_tool_result") {
          continue;
        }
        // Browser automation — Playwright session bound to this chat sessionId
        if (block.type === "tool_use" && typeof block.name === "string" && block.name.startsWith("browser_")) {
          try {
            console.log(`[BROWSER] ${block.name}:`, JSON.stringify(block.input).slice(0, 200));
            const result = await handleBrowserTool(sessionId, block.name, block.input || {});
            // Trim very large snapshots so we don't blow the context
            const content = JSON.stringify(result).slice(0, 12000);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
          } catch (e) {
            console.error(`[BROWSER] ${block.name} error:`, e.message);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: e.message }), is_error: true });
          }
          continue;
        }
        // Whisper transcription — runs locally
        if (block.type === "tool_use" && block.name === "transcribe_audio") {
          try {
            console.log(`[WHISPER] transcribe_audio:`, JSON.stringify(block.input));
            const fileName = path.basename(block.input.file_name);
            // Case-insensitive file lookup (upload may use different case than AI)
            let filePath = path.join(MEDIA_DIR, fileName);
            if (!fs.existsSync(filePath)) {
              const match = fs.readdirSync(MEDIA_DIR).find(f => f.toLowerCase() === fileName.toLowerCase());
              if (match) {
                filePath = path.join(MEDIA_DIR, match);
                console.log(`[WHISPER] Case mismatch resolved: ${fileName} → ${match}`);
              } else {
                console.log(`[WHISPER] File not found: ${fileName}`);
                toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: false, error: `Bestand niet gevonden: ${fileName}. Upload het bestand eerst via de media library.` }), is_error: true });
                continue;
              }
            }
            const actualFileName = path.basename(filePath);
            const whisperModel = block.input.model || "small";
            const outputFormat = block.input.format || "txt";
            const outputDir = path.join(__dirname, "data", "transcripts");
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            const args = [filePath, "--model", whisperModel, "--output_format", outputFormat, "--output_dir", outputDir, "--fp16", "False"];
            if (block.input.language) args.push("--language", block.input.language);
            console.log(`[WHISPER] Running: whisper ${args.join(" ")}`);
            const transcript = await new Promise((resolve, reject) => {
              const child = execFile("/root/whisper-env/bin/whisper", args, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) {
                  console.error(`[WHISPER] Error:`, stderr || err.message);
                  return reject(new Error(stderr || err.message));
                }
                console.log(`[WHISPER] Done. Checking output...`);
                const baseName = path.basename(actualFileName, path.extname(actualFileName));
                const outFile = path.join(outputDir, `${baseName}.${outputFormat}`);
                if (fs.existsSync(outFile)) {
                  const content = fs.readFileSync(outFile, "utf8");
                  console.log(`[WHISPER] Output: ${outFile} (${content.length} chars)`);
                  resolve(content);
                } else {
                  console.log(`[WHISPER] Output file not found: ${outFile}, using stdout`);
                  resolve(stdout || "Transcript gegenereerd maar output bestand niet gevonden.");
                }
              });
            });
            const truncated = transcript.length > 12000 ? transcript.substring(0, 12000) + "\n\n[...transcript afgekapt, totaal " + transcript.length + " tekens]" : transcript;
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: true, transcript: truncated, format: outputFormat, model: whisperModel }) });
          } catch (e) {
            console.error(`[WHISPER] Fatal:`, e.message);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: false, error: e.message }), is_error: true });
          }
          continue;
        }
        // PDF text extraction — runs locally
        if (block.type === "tool_use" && block.name === "read_pdf") {
          try {
            console.log(`[PDF] read_pdf:`, JSON.stringify(block.input));
            const fileName = path.basename(block.input.file_name);
            let filePath = path.join(MEDIA_DIR, fileName);
            if (!fs.existsSync(filePath)) {
              const match = fs.readdirSync(MEDIA_DIR).find(f => f.toLowerCase() === fileName.toLowerCase());
              if (match) {
                filePath = path.join(MEDIA_DIR, match);
              } else {
                toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: false, error: `Bestand niet gevonden: ${fileName}. Upload het bestand eerst via de media library.` }), is_error: true });
                continue;
              }
            }
            const pdfText = await new Promise((resolve, reject) => {
              execFile("pdftotext", ["-layout", filePath, "-"], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr || err.message));
                resolve(stdout);
              });
            });
            const truncated = pdfText.length > 15000 ? pdfText.substring(0, 15000) + "\n\n[...tekst afgekapt, totaal " + pdfText.length + " tekens]" : pdfText;
            console.log(`[PDF] Extracted ${pdfText.length} chars from ${fileName}`);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: true, text: truncated, total_chars: pdfText.length }) });
          } catch (e) {
            console.error(`[PDF] Error:`, e.message);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: false, error: e.message }), is_error: true });
          }
          continue;
        }
        // Run skill — loads SKILL.md as system prompt + sends user prompt to Claude API directly
        if (block.type === "tool_use" && block.name === "run_skill") {
          try {
            const skill = block.input.skill;
            const aiPrompt = block.input.prompt;
            // Auto-inject the user's original message (which may contain transcripts, URLs, pasted content)
            const lastUserMsg = [...history].reverse().find(m => m.role === "user" && typeof m.content === "string");
            const userContext = lastUserMsg ? lastUserMsg.content : "";
            const prompt = userContext
              ? `${aiPrompt}\n\n=== ORIGINEEL GEBRUIKERSBERICHT (volledige context) ===\n${userContext}`
              : aiPrompt;
            console.log(`[SKILL] Running /${skill}: ${aiPrompt.substring(0, 100)}... (+ ${userContext.length} chars user context)`);

            // Try to load skill instructions from marketing skills, then bundled Claude Code skills
            let skillContent = null;
            const marketingPath = path.join(__dirname, "data", "marketingskills", "skills", skill, "SKILL.md");
            const claudeSkillPath = path.join(__dirname, "data", "claudeskills", skill, "SKILL.md");
            if (fs.existsSync(marketingPath)) {
              skillContent = fs.readFileSync(marketingPath, "utf8");
              console.log(`[SKILL] Loaded marketing skill: ${marketingPath}`);
            } else if (fs.existsSync(claudeSkillPath)) {
              skillContent = fs.readFileSync(claudeSkillPath, "utf8");
              console.log(`[SKILL] Loaded bundled Claude skill: ${claudeSkillPath}`);
            }

            if (!skillContent) {
              console.log(`[SKILL] Unknown skill: ${skill}`);
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: false, error: `Skill '${skill}' niet gevonden. Beschikbare skills staan in data/marketingskills/skills/ en data/claudeskills/.` }), is_error: true });
              continue;
            }

            // Direct API call with skill as system prompt and user prompt as message
            const Anthropic = require("@anthropic-ai/sdk");
            const skillClient = new Anthropic();
            const brand = loadBrand();
            const skillSystem = IS_NL
              ? `Je bent ${brand.assistant_name}, de AI assistant van ${brand.company_name}.\n\n${skillContent}\n\nBELANGRIJK: Volg de instructies in de skill hierboven exact. Genereer ALLE gevraagde secties. Spreek Nederlands tenzij de input Engels is.`
              : `You are ${brand.assistant_name}, the AI assistant for ${brand.company_name}.\n\n${skillContent}\n\nIMPORTANT: Follow the instructions in the skill above exactly. Generate ALL requested sections. Reply in the user's language.`;
            const skillResponse = await skillClient.messages.create({
              model: "claude-sonnet-4-6",
              max_tokens: 8192,
              system: skillSystem,
              messages: [{ role: "user", content: prompt }],
            });
            const skillOutput = skillResponse.content.filter(b => b.type === "text").map(b => b.text).join("\n");
            const truncated = skillOutput.length > 15000 ? skillOutput.substring(0, 15000) + "\n\n[...output afgekapt, totaal " + skillOutput.length + " tekens]" : skillOutput;
            console.log(`[SKILL] /${skill} done (${skillOutput.length} chars)`);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: true, skill, output: truncated }) });
          } catch (e) {
            console.log(`[SKILL] Error:`, e.message);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: false, error: e.message }), is_error: true });
          }
          continue;
        }
        // Custom tools (agent actions) — execute locally
        if (block.type === "tool_use" && TOOL_ACTIONS[block.name]) {
          try {
            console.log(`[CHAT-TOOL] ${block.name}:`, JSON.stringify(block.input));
            const action = TOOL_ACTIONS[block.name](block.input);
            const authHeader = req.cookies?.cc_session
              ? { Cookie: `cc_session=${req.cookies.cc_session}` }
              : { "x-internal": "telegram", "x-internal-secret": INTERNAL_SECRET };
            const isGet = action.method === "GET";
            console.log(`[CHAT-TOOL] → ${isGet ? "GET" : "POST"} ${action.url}`, isGet ? "" : JSON.stringify(action.body));
            const taskRes = await fetch(action.url, isGet ? {
              headers: { ...authHeader },
            } : {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeader },
              body: JSON.stringify(action.body),
            });
            const task = await taskRes.json();
            let resultContent;
            if (action.isAds) {
              resultContent = JSON.stringify({ success: true, data: task });
            } else if (action.isCalendar) {
              resultContent = JSON.stringify({ success: true, calendar_response: task.reply || task.error || "Geen antwoord" });
            } else if (action.isSeo) {
              // List view: trim heavy fields. Single-report view: optionally filter to one category.
              let payload = task;
              if (Array.isArray(task)) {
                payload = task.slice(0, 20).map(r => ({
                  id: r.id, created_at: r.created_at, url: r.url, score: r.score,
                  pagesCrawled: r.pagesCrawled, counts: r.counts,
                }));
              } else if (action.seoCategory && task?.findings) {
                payload = {
                  id: task.id, url: task.url, score: task.score,
                  category: action.seoCategory,
                  findings: task.findings[action.seoCategory] || [],
                  strategic: task.strategic,
                };
              } else if (task?.findings) {
                payload = {
                  id: task.id, url: task.url, score: task.score, counts: task.counts,
                  pagesCrawled: task.pagesCrawled, findings: task.findings,
                  psi: task.psi ? { mobile: task.psi.mobile?.scores, desktop: task.psi.desktop?.scores } : null,
                  strategic: task.strategic,
                };
              }
              resultContent = JSON.stringify({ success: true, data: payload });
            } else if (action.isOpusclip) {
              let payload;
              if (action.opusclipTaskId) {
                const found = Array.isArray(task) ? task.find(t => t.id === action.opusclipTaskId) : null;
                if (!found) {
                  payload = { error: `Geen taak gevonden met id ${action.opusclipTaskId}` };
                } else {
                  const clips = Array.isArray(found.clips) ? found.clips.slice(0, 30).map(c => ({
                    title: c.title || c.name || c.clipTitle || null,
                    duration: c.duration || (c.endTime != null && c.startTime != null ? Math.round(c.endTime - c.startTime) : null),
                    virality_score: c.viralityScore ?? null,
                    preview_url: c.previewUrl || c.thumbnailUrl || c.thumbnail || null,
                    download_url: c.exportUrl || c.downloadUrl || c.videoUrl || c.url || null,
                  })) : [];
                  payload = {
                    id: found.id, status: found.status, stage: found.stage,
                    video_url: found.video_url, description: found.description,
                    project_id: found.project_id, created_at: found.created_at,
                    error: found.error, clip_count: clips.length, clips,
                  };
                }
              } else {
                payload = (Array.isArray(task) ? task : []).slice(0, 20).map(t => ({
                  id: t.id, status: t.status, stage: t.stage,
                  video_url: t.video_url, description: t.description,
                  created_at: t.created_at, clip_count: Array.isArray(t.clips) ? t.clips.length : 0,
                }));
              }
              resultContent = JSON.stringify({ success: true, data: payload });
            } else {
              resultContent = JSON.stringify({ success: true, task_id: task.id, status: task.status, message: `Task aangemaakt: ${task.id}` });
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: resultContent,
            });
          } catch (e) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({ success: false, error: e.message }),
              is_error: true,
            });
          }
        }
      }

      // Catch-all: ensure every tool_use block has a matching tool_result
      for (const block of response.content) {
        if (block.type === "tool_use" && !toolResults.find(r => r.tool_use_id === block.id)) {
          console.log(`[CHAT] Unhandled tool_use: ${block.name} (${block.id}) — returning empty result`);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ success: false, error: `Tool '${block.name}' is niet beschikbaar.` }), is_error: true });
        }
      }

      if (toolResults.length) {
        history.push({ role: "user", content: toolResults });
      }

      console.log(`[CHAT] Tool loop #${loopCount} — ${toolResults.length} results collected`);
      const historyChars = JSON.stringify(history).length;
      console.log(`[CHAT] API call #${loopCount + 1} starting — history: ${historyChars} chars, ${history.length} msgs`);
      try {
        setMsgCache(history);
        response = await anthropic.messages.create(apiParams);
        console.log(`[CHAT] API call #${loopCount + 1} done — stop_reason: ${response.stop_reason}`);
      } catch (apiErr) {
        console.log(`[CHAT] API call #${loopCount + 1} FAILED: ${apiErr?.status || 'no-status'} — ${apiErr?.error?.error?.message || apiErr.message}`);
        throw apiErr;
      }
    }

    // If we exited because the tool-loop cap was hit, the model still wants to call
    // tools and produced no text. Answer the pending tool_use blocks, then force one
    // final text-only reply so the user always gets a real answer.
    if (response.stop_reason === "tool_use") {
      console.log(`[CHAT] Tool-loop cap (${MAX_TOOL_LOOPS}) hit — forcing final text reply`);
      history.push({ role: "assistant", content: response.content });
      const pending = response.content
        .filter(b => b.type === "tool_use")
        .map(b => ({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify({ success: false, error: "Tool-limiet bereikt. Rond af en vat samen wat al is uitgevoerd." }), is_error: true }));
      if (pending.length) history.push({ role: "user", content: pending });
      try {
        setMsgCache(history);
        response = await anthropic.messages.create({ ...apiParams, tool_choice: { type: "none" } });
      } catch (finalErr) {
        console.log(`[CHAT] Final forced reply FAILED: ${finalErr?.error?.error?.message || finalErr.message}`);
      }
    }

    // Extract final text reply
    const textBlocks = response.content.filter(b => b.type === "text");
    const reply = textBlocks.map(b => b.text).join("\n") || "Geen antwoord ontvangen.";

    // Add assistant message to history
    history.push({ role: "assistant", content: response.content });

    console.log(`[CHAT] Reply sent (${reply.length} chars)`);
    res.json({ reply, sessionId });
  } catch (err) {
    const errDetail = err?.status ? `API ${err.status}: ${err?.error?.error?.message || err.message}` : err.message;
    console.log("[CHAT] Error:", errDetail);
    // Remove the user message on failure
    history.pop();
    res.status(500).json({ error: "AI request failed: " + errDetail });
  }
});

app.delete("/ctrl/chat/:sessionId", (req, res) => {
  delete chatSessions[req.params.sessionId];
  res.json({ ok: true });
});

// ── CALENDAR ASSISTANT (Composio + Google Calendar) ──────────
const { Composio } = require("composio-core");
const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY || "";
const COMPOSIO_ENTITY = "default";
const COMPOSIO_ACCOUNT_ID = process.env.COMPOSIO_ACCOUNT_ID || "";
const TIMEZONE = process.env.TIMEZONE || "Europe/Amsterdam";

const calendarSessions = {};

const CALENDAR_TOOLS = [
  "GOOGLECALENDAR_LIST_CALENDARS",
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_FIND_EVENT",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT",
  "GOOGLECALENDAR_EVENTS_MOVE",
  "GOOGLECALENDAR_FIND_FREE_SLOTS",
  "GOOGLECALENDAR_GET_CURRENT_DATE_TIME",
];

function buildCalendarTools() {
  return CALENDAR_TOOLS.map(name => ({
    name,
    description: {
      GOOGLECALENDAR_LIST_CALENDARS: "List all Google Calendars the user has access to.",
      GOOGLECALENDAR_EVENTS_LIST: "List upcoming events from a calendar. Params: calendar_id (default 'primary'), time_min (ISO), time_max (ISO), max_results (int), query (string).",
      GOOGLECALENDAR_FIND_EVENT: "Search for events matching a query. Params: calendar_id, query (string to search for).",
      GOOGLECALENDAR_CREATE_EVENT: `Create a new calendar event. Params: summary (title), start_datetime (ISO 8601 with timezone offset), end_datetime (ISO 8601 with timezone offset — MUST reflect the requested duration, e.g. 3 hours = start + 3h), timezone (always '${TIMEZONE}'), description, location, attendees (comma-separated emails), calendar_id. CRITICAL: Always calculate end_datetime from the requested duration. If the user asks for '3 hours' then end = start + 3 hours. Never default to 30 minutes.`,
      GOOGLECALENDAR_DELETE_EVENT: "Delete an event. Params: event_id, calendar_id.",
      GOOGLECALENDAR_EVENTS_MOVE: "Move an event to a different calendar or time. Params: event_id, calendar_id, destination_calendar_id.",
      GOOGLECALENDAR_FIND_FREE_SLOTS: "Find free time slots. Params: calendar_id, time_min (ISO), time_max (ISO), duration_minutes (int).",
      GOOGLECALENDAR_GET_CURRENT_DATE_TIME: "Get the current date and time in the user's timezone.",
    }[name] || name,
    input_schema: name === "GOOGLECALENDAR_CREATE_EVENT"
      ? {
          type: "object",
          properties: {
            summary: { type: "string", description: "Event title" },
            start_datetime: { type: "string", description: "Start time in ISO 8601 with timezone offset, e.g. 2026-04-10T14:00:00+02:00" },
            end_datetime: { type: "string", description: "End time in ISO 8601 with timezone offset. MUST reflect requested duration (e.g. 3 hour event: start + 3h). Never default to 30 min." },
            timezone: { type: "string", description: `Always '${TIMEZONE}'` },
            description: { type: "string", description: "Event description (optional)" },
            location: { type: "string", description: "Event location (optional)" },
            attendees: { type: "string", description: "Comma-separated emails (optional)" },
            calendar_id: { type: "string", description: "Calendar ID, default 'primary'" },
          },
          required: ["summary", "start_datetime", "end_datetime", "timezone"],
        }
      : { type: "object", properties: {}, additionalProperties: true },
  }));
}

const IS_NL = (process.env.LANGUAGE || "").toUpperCase() === "NL";

const CALENDAR_SYSTEM = IS_NL ? `Je bent de Calendar Assistant, ingebouwd in het Command Center.
Je beheert de Google Calendar van de gebruiker via Composio tools.

BESCHIKBARE TOOLS:
- GOOGLECALENDAR_GET_CURRENT_DATE_TIME: Haal huidige datum/tijd op. Gebruik dit ALTIJD als eerste bij relatieve tijdsaanduidingen ("morgen", "volgende week", etc.).
- GOOGLECALENDAR_LIST_CALENDARS: Toon alle calendars.
- GOOGLECALENDAR_EVENTS_LIST: Toon events. Gebruik calendar_id "primary" tenzij anders gevraagd. Stuur time_min en time_max als ISO 8601 strings.
- GOOGLECALENDAR_FIND_EVENT: Zoek events op tekst.
- GOOGLECALENDAR_CREATE_EVENT: Maak een event aan. Vereist: summary, start_datetime, end_datetime (ISO 8601 met timezone offset), timezone (altijd "${TIMEZONE}"). Optioneel: description, location, attendees.
  KRITIEK DUUR REGEL: Bereken end_datetime ALTIJD op basis van de gevraagde duur. Als de gebruiker zegt "3 uur" → end = start + 3 uur. NOOIT standaard 30 minuten gebruiken. Als geen duur opgegeven, vraag ernaar of gebruik 1 uur als default.
- GOOGLECALENDAR_DELETE_EVENT: Verwijder een event (event_id nodig).
- GOOGLECALENDAR_FIND_FREE_SLOTS: Vind vrije slots (time_min, time_max, duration_minutes).

REGELS:
- Spreek Nederlands tenzij de gebruiker Engels praat.
- Wees beknopt en direct. Geen emoji tenzij gevraagd.
- KRITIEK TIMEZONE REGEL: De gebruiker zit in ${TIMEZONE}. Gebruik ALTIJD de juiste UTC-offset in ISO 8601 datetimes. Stuur ALTIJD timezone: "${TIMEZONE}" mee als parameter bij CREATE_EVENT. NOOIT UTC (+00:00) gebruiken voor tijden die de gebruiker opgeeft.
- Bij "vandaag", "morgen", "deze week" etc.: gebruik eerst GET_CURRENT_DATE_TIME om de juiste datum te bepalen.
- Toon tijden in 24-uurs formaat (14:00 niet 2 PM).
- Als je een event aanmaakt, bevestig met de details (titel, datum, tijd, duur).` : `You are the Calendar Assistant, built into the Command Center.
You manage the user's Google Calendar via Composio tools.

AVAILABLE TOOLS:
- GOOGLECALENDAR_GET_CURRENT_DATE_TIME: Get the current date/time. ALWAYS call this first for relative references ("tomorrow", "next week", etc.).
- GOOGLECALENDAR_LIST_CALENDARS: List all calendars.
- GOOGLECALENDAR_EVENTS_LIST: List events. Use calendar_id "primary" unless specified. Pass time_min and time_max as ISO 8601 strings.
- GOOGLECALENDAR_FIND_EVENT: Search events by text.
- GOOGLECALENDAR_CREATE_EVENT: Create an event. Required: summary, start_datetime, end_datetime (ISO 8601 with timezone offset), timezone (always "${TIMEZONE}"). Optional: description, location, attendees.
  CRITICAL DURATION RULE: Always calculate end_datetime from the requested duration. If the user says "3 hours" → end = start + 3h. Never default to 30 minutes. If no duration given, ask or default to 1 hour.
- GOOGLECALENDAR_DELETE_EVENT: Delete an event (event_id required).
- GOOGLECALENDAR_FIND_FREE_SLOTS: Find free slots (time_min, time_max, duration_minutes).

RULES:
- Reply in the user's language. Be concise and direct. No emoji unless requested.
- CRITICAL TIMEZONE RULE: The user is in ${TIMEZONE}. Always use the correct UTC offset in ISO 8601 datetimes. Always send timezone: "${TIMEZONE}" with CREATE_EVENT. Never use UTC (+00:00) for times the user gives you.
- For "today", "tomorrow", "this week", etc.: first call GET_CURRENT_DATE_TIME to determine the actual date.
- Use 24-hour time (14:00, not 2 PM).
- When creating an event, confirm with details (title, date, time, duration).`;

async function executeCalendarTool(toolName, params) {
  const composio = new Composio({ apiKey: COMPOSIO_KEY });
  const entity = composio.getEntity(COMPOSIO_ENTITY);
  const result = await entity.execute({
    actionName: toolName,
    params,
    connectedAccountId: COMPOSIO_ACCOUNT_ID,
  });
  return result;
}

app.get("/calendar/status", async (_req, res) => {
  if (!COMPOSIO_KEY) return res.json({ connected: false, reason: "No Composio API key" });
  try {
    const composio = new Composio({ apiKey: COMPOSIO_KEY });
    const entity = composio.getEntity(COMPOSIO_ENTITY);
    const conns = await entity.getConnections();
    const gcal = conns.find(c => c.appName === "googlecalendar" && c.status === "ACTIVE");
    res.json({ connected: !!gcal, accountId: gcal?.id });
  } catch (e) {
    res.json({ connected: false, reason: e.message });
  }
});

app.delete("/calendar/chat/:sessionId", (req, res) => {
  delete calendarSessions[req.params.sessionId];
  res.json({ ok: true });
});

app.post("/calendar/chat", async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });
  if (!COMPOSIO_KEY) return res.status(500).json({ error: "Composio API key not configured" });

  const sid = sessionId || "default";
  if (!calendarSessions[sid]) calendarSessions[sid] = [];
  const history = calendarSessions[sid];

  history.push({ role: "user", content: message });

  // Keep last 30 messages to avoid token overflow
  if (history.length > 30) {
    calendarSessions[sid] = history.slice(-30);
  }

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic();

    const tools = buildCalendarTools();

    let messages = [...history];
    let finalReply = "";
    let loopCount = 0;

    while (loopCount < 6) {
      loopCount++;

      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: CALENDAR_SYSTEM,
        tools,
        messages,
      });

      // Collect text parts
      const textParts = response.content.filter(b => b.type === "text").map(b => b.text);
      const toolUses = response.content.filter(b => b.type === "tool_use");

      if (toolUses.length === 0) {
        finalReply = textParts.join("\n");
        break;
      }

      // Execute tool calls
      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const tu of toolUses) {
        try {
          console.log(`[CALENDAR] Executing ${tu.name} with params:`, JSON.stringify(tu.input));
          const result = await executeCalendarTool(tu.name, tu.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result),
          });
        } catch (e) {
          console.error(`[CALENDAR] Tool ${tu.name} failed:`, e.message);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: e.message }),
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });

      if (response.stop_reason === "end_turn" && textParts.length > 0) {
        finalReply = textParts.join("\n");
        break;
      }
    }

    // Store the final assistant reply in session history
    if (finalReply) {
      history.push({ role: "assistant", content: finalReply });
    }

    res.json({ reply: finalReply || "Geen antwoord ontvangen." });
  } catch (err) {
    console.error("[CALENDAR] Chat error:", err.message);
    history.pop();
    res.status(500).json({ error: "Calendar AI request failed: " + err.message });
  }
});

// ── MARKETEER AGENT (Marketing Skills + Chat) ───────────────
const MARKETING_SKILLS = {
  'social-content': 'Social media content strategy, pillars, hooks, batching',
  'copywriting': 'Landing page copy, features vs benefits, clarity over cleverness',
  'content-strategy': 'Searchable vs shareable content, prioritization, buyer stages',
  'marketing-ideas': '139 proven SaaS marketing tactics, smart matching by stage/budget',
  'paid-ads': 'Google/Meta/LinkedIn/TikTok ads, campaign structure, optimization',
  'launch-strategy': 'ORB framework, five-phase launches, owned/rented/borrowed channels',
  'pricing-strategy': 'Packaging, pricing metrics, value-based pricing, tier design',
  'competitor-alternatives': 'Comparison pages, positioning, honest competitor analysis',
  'email-sequence': 'Email flows, onboarding sequences, nurture campaigns',
  'seo-audit': 'Technical SEO, content audit, keyword analysis',
  'programmatic-seo': 'Template-based pages, database-driven SEO at scale',
  'schema-markup': 'Structured data, rich snippets, schema types',
  'page-cro': 'Landing page conversion optimization, layout, CTAs',
  'signup-flow-cro': 'Sign-up funnel optimization, friction reduction',
  'form-cro': 'Form optimization, field reduction, multi-step forms',
  'popup-cro': 'Exit-intent, timed popups, scroll-triggered offers',
  'onboarding-cro': 'User onboarding flows, activation optimization',
  'paywall-upgrade-cro': 'Upgrade prompts, premium conversion, paywall design',
  'ab-test-setup': 'A/B test design, statistical significance, test prioritization',
  'analytics-tracking': 'Event tracking, UTM parameters, conversion funnels',
  'marketing-psychology': 'Persuasion principles, cognitive biases, decision triggers',
  'copy-editing': 'Editing frameworks, clarity, tone consistency',
  'free-tool-strategy': 'Free tools as acquisition, viral loops, lead magnets',
  'referral-program': 'Referral mechanics, incentive design, viral coefficients',
  'product-marketing-context': 'Positioning, messaging, go-to-market strategy',
  'youtube-optimizer': 'Transcript to full YouTube package: 10 clickbait titles, description, timestamps, tags, thumbnail text + AI prompts',
};

const SKILLS_DIR = path.join(__dirname, "data", "marketingskills", "skills");

function loadMarketingSkill(slug) {
  try {
    return fs.readFileSync(path.join(SKILLS_DIR, slug, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

const marketeerSessions = {};

function buildMarketeerSystem() {
  const skillList = Object.entries(MARKETING_SKILLS)
    .map(([slug, desc]) => `- ${slug}: ${desc}`)
    .join("\n");

  const brand = loadBrand();
  if (!IS_NL) {
    return `You are the Marketeer, the AI marketing strategist for ${brand.company_name}, built into the Command Center.

You have access to 25 professional marketing skill libraries that you can load with the load_marketing_skill tool. ALWAYS load the relevant skill(s) before giving advice.

AVAILABLE SKILLS:
${skillList}

TOOLS:
- load_marketing_skill: Load a specific marketing skill for detailed frameworks and methodologies. Always load 1-3 relevant skills before advising. Use the skill slug as parameter.
- create_marketing_task: Create a task for another agent to execute (designer, scriptwriter, researcher).

RULES:
- Reply in the user's language. Be strategic but practical — give concrete action items, not vague advice.
- Use frameworks from the loaded skills and reference them.
- When building plans, give specific timelines and owners.
- You can delegate tasks to other agents via create_marketing_task.
- No emoji unless asked.`;
  }
  return `Je bent de Marketeer, de AI marketing strategist van ${brand.company_name}, ingebouwd in het Command Center.

Je hebt toegang tot 25 professionele marketing skill-bibliotheken die je kunt laden met de load_marketing_skill tool. Laad ALTIJD de relevante skill(s) voordat je advies geeft.

BESCHIKBARE SKILLS:
${skillList}

TOOLS:
- load_marketing_skill: Laad een specifieke marketing skill voor gedetailleerde frameworks en methodologieën. Laad ALTIJD 1-3 relevante skills voordat je advies geeft. Gebruik de skill slug als parameter.
- create_marketing_task: Maak een taak aan die door andere agents uitgevoerd kan worden (designer, scriptwriter, researcher).

REGELS:
- Spreek Nederlands tenzij de gebruiker Engels praat.
- Wees strategisch maar praktisch — geef concrete actiepunten, geen vage adviezen.
- Gebruik frameworks uit de geladen skills, verwijs ernaar.
- Bij het maken van planningen, geef specifieke tijdlijnen en verantwoordelijkheden.
- Je kunt taken delegeren naar andere agents via create_marketing_task.
- Geen emoji tenzij gevraagd.`;
}

const MARKETEER_TOOLS = [
  {
    name: "load_marketing_skill",
    description: "Load a marketing skill guide for detailed frameworks and methodologies. Always load relevant skills before giving advice.",
    input_schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "The skill slug, e.g. 'social-content', 'copywriting', 'paid-ads'" },
      },
      required: ["skill"],
    },
  },
  {
    name: "create_marketing_task",
    description: "Create a task for another agent to execute: designer (visual assets), scriptwriter (scripts/copy), researcher (market research).",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["designer", "scriptwriter", "researcher"], description: "Which agent should execute this task" },
        description: { type: "string", description: "What the task should produce" },
      },
      required: ["agent", "description"],
    },
  },
];

const MARKETEER_TASK_APIS = {
  designer: "/designer/tasks",
  scriptwriter: "/scriptwriter/tasks",
  researcher: "/research/tasks",
};

app.get("/marketeer/status", (_req, res) => {
  const skillCount = Object.keys(MARKETING_SKILLS).length;
  res.json({ active: true, skills_count: skillCount });
});

app.delete("/marketeer/chat/:sessionId", (req, res) => {
  delete marketeerSessions[req.params.sessionId];
  res.json({ ok: true });
});

app.post("/marketeer/chat", async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  const sid = sessionId || "default";
  if (!marketeerSessions[sid]) marketeerSessions[sid] = [];
  const history = marketeerSessions[sid];

  history.push({ role: "user", content: message });
  if (history.length > 30) marketeerSessions[sid] = history.slice(-30);

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic();

    let messages = [...history];
    let finalReply = "";
    let loopCount = 0;

    while (loopCount < 8) {
      loopCount++;

      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: buildMarketeerSystem(),
        tools: MARKETEER_TOOLS,
        messages,
      });

      const textParts = response.content.filter(b => b.type === "text").map(b => b.text);
      const toolUses = response.content.filter(b => b.type === "tool_use");

      if (toolUses.length === 0) {
        finalReply = textParts.join("\n");
        break;
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const tu of toolUses) {
        try {
          if (tu.name === "load_marketing_skill") {
            const content = loadMarketingSkill(tu.input.skill);
            if (content) {
              console.log(`[MARKETEER] Loaded skill: ${tu.input.skill} (${content.length} chars)`);
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: content.substring(0, 12000),
              });
            } else {
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: `Skill '${tu.input.skill}' not found. Available: ${Object.keys(MARKETING_SKILLS).join(", ")}`,
                is_error: true,
              });
            }
          } else if (tu.name === "create_marketing_task") {
            const apiPath = MARKETEER_TASK_APIS[tu.input.agent];
            if (!apiPath) {
              toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "Unknown agent: " + tu.input.agent, is_error: true });
              continue;
            }
            const taskBody = tu.input.agent === "researcher"
              ? { query: tu.input.description, type: "trending", platforms: ["x", "reddit", "tiktok"], niche: "crypto trading" }
              : { description: tu.input.description };
            const taskRes = await fetch(`http://localhost:3004${apiPath}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-internal": "telegram", "x-internal-secret": INTERNAL_SECRET },
              body: JSON.stringify(taskBody),
            });
            const task = await taskRes.json();
            console.log(`[MARKETEER] Created ${tu.input.agent} task: ${task.id}`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify({ success: true, agent: tu.input.agent, task_id: task.id, status: task.status }),
            });
          }
        } catch (e) {
          console.error(`[MARKETEER] Tool ${tu.name} failed:`, e.message);
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: e.message, is_error: true });
        }
      }

      messages.push({ role: "user", content: toolResults });

      if (response.stop_reason === "end_turn" && textParts.length > 0) {
        finalReply = textParts.join("\n");
        break;
      }
    }

    if (finalReply) {
      history.push({ role: "assistant", content: finalReply });
    }

    res.json({ reply: finalReply || "Geen antwoord ontvangen." });
  } catch (err) {
    console.error("[MARKETEER] Chat error:", err.message);
    history.pop();
    res.status(500).json({ error: "Marketeer AI request failed: " + err.message });
  }
});

// ── CANVA OAUTH (Connect API via customer's own Canva Developer App) ──
// Customer registers an Integration in https://www.canva.com/developers,
// puts Client ID + Secret in Settings, and the displayed callback URI in
// the Canva integration's Authentication tab. The callback URI uses the
// Command Center's public host (x-forwarded headers) — Canva no longer
// accepts only localhost like the old MCP DCR flow did.
const CANVA_TOKENS_FILE = path.join(__dirname, "data", "canva-oauth.json");
const CANVA_AUTH_URL = "https://www.canva.com/api/oauth/authorize";
const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
const CANVA_API_BASE = "https://api.canva.com/rest/v1";
const CANVA_SCOPES = [
  "profile:read",
  "design:meta:read",
  "design:content:read",
  "brandtemplate:meta:read",
  "brandtemplate:content:read",
  "asset:read",
].join(" ");

function readCanvaTokens() {
  try { return JSON.parse(fs.readFileSync(CANVA_TOKENS_FILE, "utf8")); }
  catch { return null; }
}
function writeCanvaTokens(data) {
  fs.writeFileSync(CANVA_TOKENS_FILE, JSON.stringify(data, null, 2));
}

// Generate PKCE code verifier + challenge
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function canvaCallbackUri(req) {
  if (process.env.CANVA_REDIRECT_URI) return process.env.CANVA_REDIRECT_URI;
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/canva/callback`;
}

// In-memory OAuth state for pending flows
let canvaOAuthState = null;
let canvaBrandKitsCache = null; // { at, kits }

// Start OAuth flow
app.get("/canva/connect", async (req, res) => {
  try {
    const clientId = process.env.CANVA_CLIENT_ID;
    if (!clientId) {
      return res.status(400).send('<html><body style="background:#000;color:#ef4444;font-family:Inter,sans-serif;padding:40px"><h1>Canva not configured</h1><p>Add Canva Client ID + Secret in Settings first.</p></body></html>');
    }
    const callbackUri = canvaCallbackUri(req);
    const pkce = generatePKCE();
    const state = crypto.randomBytes(16).toString("hex");
    canvaOAuthState = { verifier: pkce.verifier, state, callbackUri };

    const authUrl = `${CANVA_AUTH_URL}?` + new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callbackUri,
      scope: CANVA_SCOPES,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });

    console.log("[CANVA] redirecting to authorize, callback:", callbackUri);
    res.redirect(authUrl);
  } catch (e) {
    console.error("[CANVA] OAuth start failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// OAuth callback — Canva redirects here after authorization
app.get("/canva/callback", async (req, res) => {
  try {
    const clientId = process.env.CANVA_CLIENT_ID;
    const clientSecret = process.env.CANVA_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("Canva not configured");
    if (!canvaOAuthState) throw new Error("No pending OAuth flow");
    if (req.query.state !== canvaOAuthState.state) throw new Error("State mismatch");
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: canvaOAuthState.callbackUri,
        code_verifier: canvaOAuthState.verifier,
      }),
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
    const tokens = await tokenRes.json();

    writeCanvaTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in || 14400) * 1000,
    });

    canvaOAuthState = null;
    canvaBrandKitsCache = null;
    console.log("[CANVA] OAuth connected successfully");
    res.send('<html><body style="background:#000;color:#fff;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h1 style="color:#7C3AED">Canva Connected</h1><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>');
  } catch (e) {
    console.error("[CANVA] OAuth callback failed:", e.message);
    canvaOAuthState = null;
    res.status(500).send(`<html><body style="background:#000;color:#ef4444;font-family:Inter,sans-serif;padding:40px"><h1>Connection Failed</h1><p>${e.message}</p></body></html>`);
  }
});

// Auto-refresh token
async function getCanvaAccessToken() {
  const data = readCanvaTokens();
  if (!data) return null;

  // Token still valid (with 5 min buffer)
  if (data.expires_at && Date.now() < data.expires_at - 300000) {
    return data.access_token;
  }

  // Refresh
  if (!data.refresh_token) return null;
  const clientId = process.env.CANVA_CLIENT_ID;
  const clientSecret = process.env.CANVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: data.refresh_token,
      }),
    });
    if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
    const tokens = await res.json();
    data.access_token = tokens.access_token;
    if (tokens.refresh_token) data.refresh_token = tokens.refresh_token;
    data.expires_at = Date.now() + (tokens.expires_in || 14400) * 1000;
    writeCanvaTokens(data);
    console.log("[CANVA] Token refreshed");
    return data.access_token;
  } catch (e) {
    console.error("[CANVA] Token refresh failed:", e.message);
    return null;
  }
}

// Status endpoint — returns config + connection state + the callback URI
// the customer needs to paste in their Canva developer dashboard.
app.get("/canva/status", async (req, res) => {
  const configured = !!(process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET);
  const token = configured ? await getCanvaAccessToken() : null;
  res.json({
    configured,
    connected: !!token,
    callback_uri: canvaCallbackUri(req),
  });
});

app.post("/canva/disconnect", async (_req, res) => {
  try {
    if (fs.existsSync(CANVA_TOKENS_FILE)) fs.unlinkSync(CANVA_TOKENS_FILE);
    canvaBrandKitsCache = null;
    console.log("[CANVA] Disconnected");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List brand templates from the connected Canva account.
// Surfaced as "brand kits" in the UI. Returns { kits: [{id, name}] },
// or { kits: [] } when not connected / on error.
app.get("/canva/brand-kits", async (_req, res) => {
  const token = await getCanvaAccessToken();
  if (!token) return res.json({ kits: [] });
  if (canvaBrandKitsCache && Date.now() - canvaBrandKitsCache.at < 5 * 60 * 1000) {
    return res.json({ kits: canvaBrandKitsCache.kits });
  }
  try {
    const r = await fetch(`${CANVA_API_BASE}/brand-templates`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`brand-templates ${r.status}`);
    const data = await r.json();
    const items = data?.items || data?.brand_templates || [];
    const kits = items.map(t => ({
      id: t.id,
      name: t.title || t.name || t.id,
    }));
    canvaBrandKitsCache = { at: Date.now(), kits };
    res.json({ kits });
  } catch (e) {
    console.error("[CANVA] brand-templates failed:", e.message);
    res.json({ kits: [] });
  }
});

// ── TASK WORKERS (auto-execute pending tasks) ─────────

// ── HIGGSFIELD CONFIG ────────────────────────────────────────────────
// Credentials are a single "KEY_ID:KEY_SECRET" string in HIGGSFIELD_API_KEY.
// Field names / enums below are the one place to adjust against the live API.
// Validated against the live platform API (June 2026):
//   auth header `Authorization: Key KEY_ID:KEY_SECRET`
//   clip  POST /v1/image2video/dop  body { params: { model, prompt, input_images:[{type:"image_url",image_url}], motion_id? } }
//   speak POST /v1/speak/higgsfield body { params: { input_image:{type:"image_url",image_url}, input_audio:{type:"audio_url",audio_url}, prompt } }
//   poll  GET  /v1/job-sets/{id}
const HIGGSFIELD = {
  base: "https://platform.higgsfield.ai",
  endpoints: {
    clip:      "/v1/image2video/dop",   // image-to-video
    speak:     "/v1/speak/higgsfield",  // talking avatar (requires input_audio)
    text2image:"/v1/text2image/soul",   // generate an avatar portrait from a prompt
    motions:   "/v1/motions",           // list of motions { id, name, description }
    jobSet:    (id) => `/v1/job-sets/${id}`,
  },
  models: ["dop-lite", "dop-preview", "dop-turbo"],
  speakModels: ["higgsfield", "kling"], // talking-avatar models (/v1/speak/{model})
  avatarSize: "1152x2048",              // 9:16 portrait for generated avatars
};
function higgsfieldHeaders() {
  const creds = (process.env.HIGGSFIELD_API_KEY || "").trim();
  return { "Authorization": `Key ${creds}`, "Content-Type": "application/json" };
}
// Avatar images are stored locally (/ugc-avatars/...), but Higgsfield needs a
// fully-qualified, publicly reachable URL to fetch the input image. Resolve any
// relative path against the task's public_origin; leave absolute URLs untouched.
function resolveHiggsfieldImageUrl(url, origin) {
  if (!url || /^https?:\/\//i.test(url)) return url;
  const base = (origin || "").replace(/\/$/, "");
  return base ? base + (url.startsWith("/") ? url : "/" + url) : url;
}

// Talking-avatar voice: Higgsfield's speak endpoint needs a public audio URL and
// has no TTS, so we generate the voice from the script via ElevenLabs, save it to
// data/ugc-audio and serve it at <public_origin>/ugc-media/<id>.mp3 for Higgsfield.
const ELEVENLABS_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel
async function generateUgcAudio(task) {
  const key = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  if (!task.public_origin) throw new Error("no public_origin — server must be reachable for Higgsfield to fetch the audio");
  const text = (task.script || task.prompt || "").trim();
  if (!text) throw new Error("no script for the avatar to speak");
  const voiceId = task.voice_id || ELEVENLABS_DEFAULT_VOICE;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!r.ok) throw new Error("ElevenLabs TTS " + r.status + ": " + (await r.text()).slice(0, 200));
  const buf = Buffer.from(await r.arrayBuffer());
  const dir = path.join(__dirname, "data", "ugc-audio");
  fs.mkdirSync(dir, { recursive: true });
  const mp3Path = path.join(dir, task.id + ".mp3");
  const wavPath = path.join(dir, task.id + ".wav");
  fs.writeFileSync(mp3Path, buf);
  // Higgsfield's speak endpoint rejects mp3 ("invalid_audio_format") — convert
  // to 16-bit PCM WAV (mono, 44.1 kHz) with ffmpeg, which it accepts.
  await new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-i", mp3Path, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      { timeout: 60000 }, (err) => err ? reject(new Error("ffmpeg mp3->wav failed: " + err.message)) : resolve());
  });
  try { fs.unlinkSync(mp3Path); } catch {}
  // Duration from WAV size (PCM 16-bit mono 44.1kHz = 88200 bytes/sec) so we can
  // pick Higgsfield's speak length (5/10/15s) to fit the voice without truncating.
  try { task.audio_duration = Math.max(1, (fs.statSync(wavPath).size - 44) / 88200); } catch { task.audio_duration = 0; }
  return task.public_origin.replace(/\/$/, "") + "/ugc-media/" + task.id + ".wav";
}

// Track which tasks are already being processed to avoid duplicates
const processingTasks = new Set();

// ── UGC WORKER — submit pending tasks to Higgsfield ─────────────────
async function processUgcTasks() {
  const tasks = readTaskFile("ugc-tasks.json");
  let changed = false;
  for (const t of tasks) {
    if (t.status !== "pending" || processingTasks.has(t.id)) continue;
    processingTasks.add(t.id);
    try {
      const isSpeak = t.mode === "speak";
      if (isSpeak) {
        // 1. Voice from the script (ElevenLabs), hosted publicly for Higgsfield.
        if (!t.audio_url) {
          t.audio_url = await generateUgcAudio(t);
          changed = true;
          writeTaskFile("ugc-tasks.json", tasks);
        }
        // 2. No avatar image yet but a face prompt is given → generate the
        //    avatar portrait via Higgsfield Soul first. It's async, so set the
        //    gen_avatar state; pollUgcStatus stores the image and resumes.
        if (!t.image_url && t.avatar_prompt) {
          const ar = await fetch(HIGGSFIELD.base + HIGGSFIELD.endpoints.text2image, {
            method: "POST", headers: higgsfieldHeaders(),
            body: JSON.stringify({ params: { prompt: t.avatar_prompt, width_and_height: HIGGSFIELD.avatarSize } }),
          });
          const ad = await ar.json().catch(() => ({}));
          if (!ar.ok) {
            t.status = "failed";
            t.error = "avatar: " + (ad && ad.detail ? JSON.stringify(ad.detail) : JSON.stringify(ad)).slice(0, 300);
          } else {
            t.avatar_request_id = ad.id || ad.job_set_id || (ad.job_set && ad.job_set.id) || "";
            t.status = t.avatar_request_id ? "gen_avatar" : "failed";
            if (!t.avatar_request_id) t.error = "avatar: no job-set id " + JSON.stringify(ad).slice(0, 200);
          }
          changed = true;
          processingTasks.delete(t.id);
          continue;
        }
      }
      const speakModel = HIGGSFIELD.speakModels.includes(t.speak_model) ? t.speak_model : "higgsfield";
      const ep = isSpeak ? ("/v1/speak/" + speakModel) : HIGGSFIELD.endpoints.clip;
      const inputImageUrl = resolveHiggsfieldImageUrl(t.image_url, t.public_origin);
      let params;
      if (isSpeak) {
        params = {
          input_image: { type: "image_url", image_url: inputImageUrl },
          input_audio: { type: "audio_url", audio_url: t.audio_url },
          prompt: t.prompt || t.description || "",
        };
        if (speakModel === "higgsfield") {
          // WAN caps at 5/10/15s — pick the smallest that fits the voice.
          const d = t.audio_duration || 0;
          params.duration = d > 10 ? 15 : d > 5 ? 10 : 5;
          params.quality = "high";
        }
      } else {
        params = {
          model: HIGGSFIELD.models.includes(t.model) ? t.model : "dop-lite",
          prompt: t.prompt || t.description || "",
          input_images: [{ type: "image_url", image_url: inputImageUrl }],
        };
        if (t.motion_id) params.motion_id = t.motion_id;
      }
      const r = await fetch(HIGGSFIELD.base + ep, { method: "POST", headers: higgsfieldHeaders(), body: JSON.stringify({ params }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        t.status = "failed";
        t.error = (data && data.detail ? JSON.stringify(data.detail) : JSON.stringify(data)).slice(0, 400);
      } else {
        // Submit returns a job-set; its id is what we poll. Field name not yet
        // confirmed against a successful (credited) response — try known shapes
        // and keep the raw response when none match so it can be corrected.
        t.request_id = data.id || data.job_set_id || (data.job_set && data.job_set.id) || "";
        t.status = t.request_id ? "processing" : "failed";
        if (!t.request_id) t.error = "no job-set id in response: " + JSON.stringify(data).slice(0, 300);
      }
      changed = true;
      processingTasks.delete(t.id);
    } catch (e) { t.status = "failed"; t.error = e.message; changed = true; processingTasks.delete(t.id); }
  }
  if (changed) writeTaskFile("ugc-tasks.json", tasks);
}

// ── UGC WORKER — poll processing tasks ──────────────────────────────
async function pollUgcStatus() {
  const tasks = readTaskFile("ugc-tasks.json");
  let changed = false;
  for (const t of tasks) {
    // Avatar-generation stage (speak with a face prompt): when the portrait is
    // ready, store it as the avatar image and resume to the speak submit.
    if (t.status === "gen_avatar" && t.avatar_request_id) {
      try {
        const r = await fetch(HIGGSFIELD.base + HIGGSFIELD.endpoints.jobSet(t.avatar_request_id), { headers: higgsfieldHeaders() });
        const data = await r.json().catch(() => ({}));
        const job = (Array.isArray(data.jobs) && data.jobs[0]) || data;
        const status = String(job.status || data.status || "").toLowerCase();
        const url = (job.results && ((job.results.raw && job.results.raw.url) || (job.results.min && job.results.min.url)))
          || job.result_url || (job.image && job.image.url) || (job.result && job.result.url) || "";
        if ((status === "completed" || status === "success") && url) {
          t.image_url = url; t.status = "pending"; changed = true;
        } else if (status === "failed" || status === "nsfw" || status === "error") {
          t.status = "failed"; t.error = "avatar " + status; changed = true;
        }
      } catch (e) { /* transient — retry next tick */ }
      continue;
    }
    if (t.status !== "processing" || !t.request_id) continue;
    try {
      const r = await fetch(HIGGSFIELD.base + HIGGSFIELD.endpoints.jobSet(t.request_id), { headers: higgsfieldHeaders() });
      const data = await r.json().catch(() => ({}));
      // A job-set holds one or more jobs; read the first job's status + result.
      const job = (Array.isArray(data.jobs) && data.jobs[0]) || data;
      const status = String(job.status || data.status || "").toLowerCase();
      const url = (job.results && ((job.results.raw && job.results.raw.url) || (job.results.min && job.results.min.url)))
        || job.result_url || (job.video && job.video.url) || (job.result && job.result.url) || "";
      if (status === "completed" || status === "success") {
        t.status = "completed"; t.result_url = url; changed = true;
      } else if (status === "failed" || status === "nsfw" || status === "error") {
        t.status = "failed"; t.error = status; changed = true;
      }
    } catch (e) { /* transient — retry next tick */ }
  }
  if (changed) writeTaskFile("ugc-tasks.json", tasks);
}

// ── AVATAR LIBRARY WORKER — poll Soul portrait generations ──────────
// Download a generated avatar portrait to data/ugc-avatars/<id>.png and return
// the local served path. Throws on any network/write error (caller falls back).
async function downloadAvatarImage(id, url) {
  const dir = path.join(__dirname, "data", "ugc-avatars");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error("download failed: " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const outFile = path.join(dir, `${id}.png`);
  fs.writeFileSync(outFile, buf);
  return `/ugc-avatars/${id}.png`;
}

async function pollAvatarCreator() {
  const avatars = readTaskFile("ugc-avatars.json");
  let changed = false;
  for (const a of avatars) {
    if (a.status !== "processing" || !a.request_id) continue;
    try {
      const r = await fetch(HIGGSFIELD.base + HIGGSFIELD.endpoints.jobSet(a.request_id), { headers: higgsfieldHeaders() });
      const data = await r.json().catch(() => ({}));
      const job = (Array.isArray(data.jobs) && data.jobs[0]) || data;
      const status = String(job.status || data.status || "").toLowerCase();
      const url = (job.results && ((job.results.raw && job.results.raw.url) || (job.results.min && job.results.min.url)))
        || job.result_url || (job.image && job.image.url) || (job.result && job.result.url) || "";
      if ((status === "completed" || status === "success") && url) {
        // Higgsfield's CloudFront URLs expire after ~2 weeks, so download the
        // image to local disk and serve it from /ugc-avatars/ to keep it forever.
        const local = await downloadAvatarImage(a.id, url).catch(() => "");
        a.status = "ready"; a.image_url = local || url; changed = true;
      }
      else if (status === "failed" || status === "nsfw" || status === "error") { a.status = "failed"; a.error = status; changed = true; }
    } catch (e) { /* transient — retry next tick */ }
  }
  if (changed) writeTaskFile("ugc-avatars.json", avatars);
}

// ── SCRIPT WRITER WORKER (Claude) ──
async function processScriptwriterTasks() {
  const tasks = readTaskFile("scriptwriter-tasks.json");
  for (const task of tasks) {
    if (task.status !== "pending" || processingTasks.has(task.id)) continue;
    processingTasks.add(task.id);
    console.log(`[WORKER] Processing scriptwriter task ${task.id}`);

    try {
      task.status = "processing";
      task.updated_at = new Date().toISOString();
      writeTaskFile("scriptwriter-tasks.json", tasks);

      const _brand = loadBrand();
      const _niche = process.env.DEFAULT_NICHE || "content platform";
      const prompt = IS_NL
        ? `Je bent een professionele scriptwriter voor ${_brand.company_name} — een ${_niche}.

Schrijf een ${task.format || "short-form"} ${task.type || "video_script"} over: ${task.topic}

Extra context: ${task.description}

Toon: ${task.tone || "educational"}
Stijl: Professioneel maar toegankelijk. Geen hype. Data-driven.

${task.type === "video_script" ? "Formaat het als een spreekscript met duidelijke pauzes en secties. Voeg [SCENE] markers toe voor visuele overgangen." : ""}
${task.format === "short-form" ? "Houd het kort: max 60 seconden spreektijd (~150 woorden)." : ""}
${task.format === "hook" ? "Schrijf 5 verschillende hooks/openers die direct de aandacht pakken." : ""}`
        : `You are a professional scriptwriter for ${_brand.company_name} — a ${_niche}.

Write a ${task.format || "short-form"} ${task.type || "video_script"} about: ${task.topic}

Additional context: ${task.description}

Tone: ${task.tone || "educational"}
Style: Professional but accessible. No hype. Data-driven.

${task.type === "video_script" ? "Format as a spoken script with clear pauses and sections. Add [SCENE] markers for visual transitions." : ""}
${task.format === "short-form" ? "Keep it short: max 60 seconds of spoken time (~150 words)." : ""}
${task.format === "hook" ? "Write 5 different hooks/openers that grab attention immediately." : ""}`;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      });

      const result = response.content[0]?.text || "";
      task.status = "completed";
      task.result = result;
      task.updated_at = new Date().toISOString();
      writeTaskFile("scriptwriter-tasks.json", tasks);
      processingTasks.delete(task.id);
      console.log(`[WORKER] Scriptwriter task ${task.id} completed`);
    } catch (e) {
      console.error(`[WORKER] Scriptwriter task ${task.id} failed:`, e.message);
      task.status = "failed";
      task.error = e.message;
      task.updated_at = new Date().toISOString();
      writeTaskFile("scriptwriter-tasks.json", tasks);
      processingTasks.delete(task.id);
    }
  }
}

// ── MARKET ANALYSIS PUBLISH (optioneel, extern kanaal) ──
// Publiceert het marktanalyse-gedeelte van een daily research naar een extern
// content-kanaal (bijv. een membership-/academy-platform) zodra beide env-vars
// zijn ingesteld. Generiek en opt-in: zonder MARKET_ANALYSIS_WEBHOOK_URL gebeurt
// er niets, zodat dit white-label blijft.
async function publishMarketAnalysis(report) {
  const url = process.env.MARKET_ANALYSIS_WEBHOOK_URL;
  const key = process.env.MARKET_ANALYSIS_WEBHOOK_KEY || "";
  if (!url) return;

  // Alleen de marktanalyse-secties (geen social-media contentsuggesties).
  const norm = (s) => (s || "").replace(/[^\p{L}\p{N} ]/gu, "").trim().toLowerCase();
  const WANTED = [
    ["marktoverzicht", "market overview"],
    ["belangrijkste trends", "key trends"],
    ["nieuws ontwikkelingen", "news developments", "nieuws", "news"],
  ];
  const picked = [];
  for (const group of WANTED) {
    const sec = (report.sections || []).find(
      (s) => group.some((g) => norm(s.title).startsWith(g)) && !picked.includes(s),
    );
    if (sec) picked.push(sec);
  }
  if (picked.length === 0) {
    console.log("[MARKET] geen marktanalyse-secties gevonden — niets gepubliceerd");
    return;
  }

  const body = picked.map((s) => `## ${s.title.trim()}\n\n${s.content.trim()}`).join("\n\n");
  const isNL = (report.language || process.env.LANGUAGE || "NL").toUpperCase() === "NL";
  const dateLabel = new Date().toLocaleDateString(isNL ? "nl-NL" : "en-GB", {
    weekday: "long", day: "numeric", month: "long",
    timeZone: process.env.TIMEZONE || "Europe/Amsterdam",
  });
  const title = isNL ? `Marktanalyse — ${dateLabel}` : `Market analysis — ${dateLabel}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-key": key },
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[MARKET] publiceren mislukt (${res.status}):`, data.error || "");
      return;
    }
    console.log(`[MARKET] marktanalyse ${data.updated ? "bijgewerkt" : "gepubliceerd"} → ${data.url || url}`);
    // Telegram-notificatie zodat het team achteraf kan nalezen/bijsturen.
    if (TG_TOKEN && TG_CHAT) {
      const preview = body.replace(/[#*_>`]/g, "").replace(/\s+/g, " ").slice(0, 320);
      const verb = isNL
        ? (data.updated ? "bijgewerkt" : "gepubliceerd")
        : (data.updated ? "updated" : "published");
      const line = isNL
        ? `📊 *${title}* is ${verb} in het marktanalyse-kanaal.`
        : `📊 *${title}* was ${verb} to the market-analysis channel.`;
      tgSend(TG_CHAT, `${line}\n\n${preview}…\n\n${data.url || url}`);
    }
  } catch (e) {
    console.error("[MARKET] publiceren mislukt:", e.message);
  }
}

// ── RESEARCHER WORKER (Claude + Web Search) ──
async function processResearchTasks() {
  const tasks = readTaskFile("research-tasks.json");
  for (const task of tasks) {
    if (task.status !== "pending" || processingTasks.has(task.id)) continue;
    processingTasks.add(task.id);
    console.log(`[WORKER] Processing research task ${task.id}`);

    try {
      task.status = "processing";
      task.updated_at = new Date().toISOString();
      writeTaskFile("research-tasks.json", tasks);

      const lang = task.language || "NL";
      const isNL = lang === "NL";

      const brand = loadBrand();
      const defaultNiche = process.env.DEFAULT_NICHE || "content platform";
      const prompt = `${isNL ? "Je bent een researcher en content strategist" : "You are a researcher and content strategist"} voor ${brand.company_name} — een ${defaultNiche}.

${isNL ? "BELANGRIJK: Schrijf het VOLLEDIGE rapport in het Nederlands. Alle secties, analyses, suggesties, captions, tweets en beschrijvingen moeten in het Nederlands zijn. Alleen merknamen, platformnamen en technische termen mogen in het Engels blijven." : "IMPORTANT: Write the FULL report in English."}

## ${isNL ? "Research opdracht" : "Research assignment"}
${isNL ? "Onderwerp" : "Topic"}: ${task.query}
${isNL ? "Type" : "Type"}: ${task.type || "trending"}
${isNL ? "Platformen" : "Platforms"}: ${(task.platforms || ["tiktok", "x", "reddit"]).join(", ")}
Niche: ${task.niche || defaultNiche}

## ${isNL ? "Instructies" : "Instructions"}
${isNL
  ? "Je hebt twee tools: `web_search` (snelle zoekopdracht, geeft snippets) en `browse_page` (opent een URL in een echte headless browser en leest de volledige main-content — ook van JS-heavy sites). Strategie: gebruik web_search om kandidaat-URLs te vinden, en browse_page om die artikelen/pagina's echt uit te lezen voor diepere context. Gebruik browse_page vooral voor kwaliteitsbronnen (CoinDesk, The Block, Messari research, project blogs, exchange dashboards zonder API) waar snippets tekort schieten."
  : "You have two tools: `web_search` (fast query, returns snippets) and `browse_page` (opens a URL in a real headless browser and reads the full main content — including JS-heavy sites). Strategy: use web_search to find candidate URLs, then browse_page to actually read those articles for deeper context. Prefer browse_page for high-quality sources (CoinDesk, The Block, Messari research, project blogs, exchange dashboards without an API) where snippets are insufficient."}

${isNL ? "Geef een gestructureerd rapport met deze secties" : "Provide a structured report with these sections"}:

## ${isNL ? "Marktoverzicht" : "Market Overview"}
${isNL ? "Samenvatting van de huidige stand van zaken, belangrijkste prijsbewegingen, sentimentindicatoren." : "Summary of current state of affairs, key price movements, sentiment indicators."}

## ${isNL ? "Belangrijkste Trends" : "Key Trends"}
${isNL ? "Top 3-5 trends die nu spelen. Per trend: wat, waarom het relevant is, en de potentiële impact." : "Top 3-5 current trends. Per trend: what, why it's relevant, and potential impact."}

## ${isNL ? "Nieuws & Ontwikkelingen" : "News & Developments"}
${isNL ? "Belangrijkste nieuwsberichten van de afgelopen 24-48 uur met bronnen." : "Key news stories from the past 24-48 hours with sources."}

## ${isNL ? "Voorgestelde Instagram Posts" : "Suggested Instagram Posts"}
${isNL
  ? `Geef 3-5 VOLLEDIGE, KANT-EN-KLARE Instagram posts. Geen losse titels — schrijf de complete caption zoals die gepost zou worden.

Per post, gebruik exact dit format:

### Post [nummer]: [onderwerp]
**Caption:**
[Schrijf hier de volledige Instagram caption: hook + body + CTA. Minimaal 4-6 zinnen. Gebruik line breaks, emoji's waar passend, en een duidelijke CTA aan het einde.]

**Image prompt:** [Beschrijf in detail de afbeelding die bij deze post hoort. Schrijf dit als een Engelse AI image generation prompt die direct bruikbaar is voor Nano Banana / Gemini. Wees specifiek over compositie, kleuren, stijl, tekst-overlays en sfeer. Bijv: "Dark futuristic trading dashboard with neon purple glow, Bitcoin chart going up, bold text overlay 'BTC $100K', cyberpunk style, 1080x1080"]
**Hashtags:** #tag1 #tag2 #tag3 #tag4 #tag5
**Format:** carousel / single image / reel
**Stijl tip:** [welke stijl-keywords voor de designer, bijv. 'cyberpunk bold', 'neon intense']`
  : `Provide 3-5 COMPLETE, READY-TO-POST Instagram posts. No loose titles — write the full caption as it would be posted.

Per post, use exactly this format:

### Post [number]: [topic]
**Caption:**
[Write the full Instagram caption here: hook + body + CTA. Minimum 4-6 sentences. Use line breaks, emojis where appropriate, and a clear CTA at the end.]

**Image prompt:** [Describe in detail the image for this post. Write this as an English AI image generation prompt ready to use with Nano Banana / Gemini. Be specific about composition, colors, style, text overlays and mood. E.g: "Dark futuristic trading dashboard with neon purple glow, Bitcoin chart going up, bold text overlay 'BTC $100K', cyberpunk style, 1080x1080"]
**Hashtags:** #tag1 #tag2 #tag3 #tag4 #tag5
**Format:** carousel / single image / reel
**Style tip:** [which style keywords for the designer, e.g. 'cyberpunk bold', 'neon intense']`}

## ${isNL ? "Voorgestelde Twitter/X Posts" : "Suggested Twitter/X Posts"}
${isNL
  ? `Geef 3-5 VOLLEDIGE, KANT-EN-KLARE tweets. Schrijf de exacte tweet tekst zoals die geplaatst zou worden.

Per tweet, gebruik exact dit format:

### Tweet [nummer]
**Tweet:**
[Schrijf hier de VOLLEDIGE tweet tekst, max 280 tekens. Klaar om te copy-pasten en te posten.]

**Type:** hot take / thread opener / data-driven / opinion / news reaction
**Engagement tip:** [hoe engagement te maximaliseren met deze tweet]`
  : `Provide 3-5 COMPLETE, READY-TO-POST tweets. Write the exact tweet text as it would be posted.

Per tweet, use exactly this format:

### Tweet [number]
**Tweet:**
[Write the FULL tweet text here, max 280 characters. Ready to copy-paste and post.]

**Type:** hot take / thread opener / data-driven / opinion / news reaction
**Engagement tip:** [how to maximize engagement with this tweet]`}

## ${isNL ? "Carousel Voorstel" : "Carousel Proposal"}
${isNL
  ? `Kies het sterkste onderwerp uit dit rapport en maak een kant-en-klare Instagram carousel (5-8 slides). Geef per slide:
- **Slide 1 (Cover)**: Pakkende hook / titel die aandacht trekt
- **Slide 2-6 (Content)**: Één kernpunt per slide, max 2-3 zinnen, educatief en to-the-point
- **Laatste slide (CTA)**: Call-to-action (volg, bewaar, deel)

Gebruik het exacte format:
**1 — [titel]** — [tekst]
**2 — [titel]** — [tekst]
etc.

Dit format is belangrijk zodat het direct in de designer als carousel gerenderd kan worden.`
  : `Pick the strongest topic from this report and create a ready-to-use Instagram carousel (5-8 slides). Per slide:
- **Slide 1 (Cover)**: Attention-grabbing hook / title
- **Slide 2-6 (Content)**: One key point per slide, max 2-3 sentences, educational and to-the-point
- **Last slide (CTA)**: Call-to-action (follow, save, share)

Use the exact format:
**1 — [title]** — [text]
**2 — [title]** — [text]
etc.

This format is important so it can be directly rendered as a carousel in the designer.`}

## ${isNL ? "Content Kalender Suggestie" : "Content Calendar Suggestion"}
${isNL ? "Wat zou er de komende 3 dagen gepost moeten worden? Geef een mini-planning." : "What should be posted in the next 3 days? Provide a mini-plan."}

${isNL ? "Schrijf in het Nederlands." : "Write in English."} ${isNL ? "Wees concreet, geen vage suggesties. Geef kant-en-klare teksten." : "Be concrete, no vague suggestions. Provide ready-to-use copy."}`;

      const researchTools = [
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        { type: "custom", ...BROWSE_PAGE_TOOL },
      ];
      const researchMessages = [{ role: "user", content: prompt }];
      const researchParams = {
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: researchMessages,
        tools: researchTools,
      };

      let response = await anthropic.messages.create(researchParams);

      // Tool-use loop — web_search is resolved by Anthropic internally, browse_page is
      // a custom tool we handle here. We accumulate message history properly so chained
      // reads work.
      let loops = 0;
      while (response.stop_reason === "tool_use" && loops < 10) {
        loops++;
        researchMessages.push({ role: "assistant", content: response.content });

        const toolResults = [];
        for (const block of response.content) {
          if (block.type === "tool_use" && block.name === "browse_page") {
            try {
              console.log(`[RESEARCH] browse_page: ${block.input.url}`);
              const r = await browsePage(block.input.url, { maxChars: block.input.max_chars || 8000 });
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify(r).slice(0, 12000),
              });
            } catch (e) {
              console.error(`[RESEARCH] browse_page error:`, e.message);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({ error: e.message }),
                is_error: true,
              });
            }
          }
          // server_tool_use / web_search_tool_result: handled by Anthropic, do not emit tool_results
        }

        if (toolResults.length === 0) break; // no custom tool_uses; nothing to advance with

        researchMessages.push({ role: "user", content: toolResults });
        response = await anthropic.messages.create(researchParams);
      }

      const textBlocks = response.content.filter(b => b.type === "text");
      const result = textBlocks.map(b => b.text).join("\n");

      // Save as research report
      const reports = readTaskFile("research-reports.json");
      const sections = result.split(/\n##\s+/).filter(Boolean).map((s, i) => {
        const lines = s.trim().split("\n");
        return { title: lines[0].replace(/^#+\s*/, ""), content: lines.slice(1).join("\n").trim() };
      });
      reports.unshift({
        id: genId(), task_id: task.id, created_at: new Date().toISOString(),
        type: task.type || "trending", title: task.query,
        language: task.language || "NL",
        sections: sections.length ? sections : [{ title: task.query, content: result }],
      });
      if (reports.length > 30) reports.length = 30;
      writeTaskFile("research-reports.json", reports);

      task.status = "completed";
      task.updated_at = new Date().toISOString();
      writeTaskFile("research-tasks.json", tasks);
      processingTasks.delete(task.id);
      console.log(`[WORKER] Research task ${task.id} completed`);

      // Dagelijkse marktanalyse doorzetten naar een extern kanaal (opt-in via env).
      if (task.type === "daily") {
        publishMarketAnalysis(reports[0]).catch((e) => console.error("[MARKET]", e.message));
      }
    } catch (e) {
      console.error(`[WORKER] Research task ${task.id} failed:`, e.message);
      task.status = "failed";
      task.error = e.message;
      task.updated_at = new Date().toISOString();
      writeTaskFile("research-tasks.json", tasks);
      processingTasks.delete(task.id);
    }
  }
}

// ── SEO WORKER ──
const { runSeoAnalysis } = require("./seo-agent");
const opusclip = require("./opusclip-agent");

async function processOpusclipTasks() {
  const tasks = readTaskFile("opusclip-tasks.json");
  let changed = false;

  // 1) Submit pending tasks → OpusClip API, transition to "processing"
  for (const task of tasks) {
    if (task.status !== "pending" || processingTasks.has(task.id)) continue;
    if (!process.env.OPUSCLIP_API_KEY) continue;
    processingTasks.add(task.id);
    try {
      console.log(`[WORKER] OpusClip submitting ${task.video_url}`);
      const proj = await opusclip.createProject({
        videoUrl: task.video_url,
        minDuration: task.min_duration,
        maxDuration: task.max_duration,
        sourceLang: task.source_lang,
        topicKeywords: task.topic_keywords,
      });
      task.project_id = proj.projectId || proj.id;
      task.stage = proj.stage || "QUEUED";
      task.status = "processing";
      task.updated_at = new Date().toISOString();
      changed = true;
    } catch (e) {
      console.error(`[WORKER] OpusClip submit failed for ${task.id}:`, e.message);
      task.status = "failed";
      task.error = e.message;
      task.updated_at = new Date().toISOString();
      changed = true;
    } finally {
      processingTasks.delete(task.id);
    }
  }

  // 2) Poll processing tasks → update stage, fetch clips on COMPLETE
  for (const task of tasks) {
    if (task.status !== "processing" || !task.project_id) continue;
    if (processingTasks.has(task.id)) continue;
    processingTasks.add(task.id);
    try {
      const proj = await opusclip.getProject(task.project_id);
      const stage = String(proj.stage || "").toUpperCase();
      if (stage && stage !== task.stage) {
        task.stage = stage;
        task.updated_at = new Date().toISOString();
        changed = true;
      }
      if (opusclip.isTerminal(stage)) {
        if (stage === "COMPLETE") {
          const clips = await opusclip.listClips(task.project_id);
          task.clips = (clips || []).map(c => ({
            id: c.id,
            title: c.title || "",
            description: c.description || "",
            duration_ms: c.durationMs || 0,
            download_url: c.uriForExport || "",
            preview_url: c.uriForPreview || "",
            thumbnail_url: c.uriForThumbnail || "",
            keywords: c.keywords || c.clipKeywords || [],
            hashtags: c.hashtags || "",
          }));
          task.status = "completed";
        } else {
          task.status = "failed";
          task.error = `OpusClip ended in stage ${stage}`;
        }
        task.updated_at = new Date().toISOString();
        changed = true;
        console.log(`[WORKER] OpusClip task ${task.id} ${task.status} (${task.clips?.length || 0} clips)`);
      }
    } catch (e) {
      console.error(`[WORKER] OpusClip poll failed for ${task.id}:`, e.message);
      // Transient errors: don't fail the task, just leave it for next cycle
    } finally {
      processingTasks.delete(task.id);
    }
  }

  if (changed) writeTaskFile("opusclip-tasks.json", tasks);
}

async function processSeoTasks() {
  const tasks = readTaskFile("seo-tasks.json");
  for (const task of tasks) {
    if (task.status !== "pending" || processingTasks.has(task.id)) continue;
    processingTasks.add(task.id);
    console.log(`[WORKER] SEO analysing ${task.url}`);
    try {
      task.status = "processing";
      task.updated_at = new Date().toISOString();
      writeTaskFile("seo-tasks.json", tasks);

      const result = await runSeoAnalysis(task, { anthropic, loadBrand });

      const reports = readTaskFile("seo-reports.json");
      reports.unshift({
        id: genId(),
        task_id: task.id,
        created_at: new Date().toISOString(),
        language: task.language,
        ...result,
      });
      if (reports.length > 30) reports.length = 30;
      writeTaskFile("seo-reports.json", reports);

      task.status = "completed";
      task.updated_at = new Date().toISOString();
      writeTaskFile("seo-tasks.json", tasks);
      console.log(`[WORKER] SEO task ${task.id} completed (${result.pagesCrawled} pages, score ${result.score})`);
    } catch (e) {
      console.error(`[WORKER] SEO task ${task.id} failed:`, e.message);
      task.status = "failed";
      task.error = e.message;
      task.updated_at = new Date().toISOString();
      writeTaskFile("seo-tasks.json", tasks);
    } finally {
      processingTasks.delete(task.id);
    }
  }
}

// ── DESIGNER WORKER (Canva via Anthropic MCP Connector) ──
async function processDesignerTasks() {
  const canvaToken = await getCanvaAccessToken();
  if (!canvaToken) return; // Skip if Canva not connected
  const tasks = readTaskFile("designer-tasks.json");
  for (const task of tasks) {
    if (task.status !== "pending" || processingTasks.has(task.id)) continue;
    processingTasks.add(task.id);
    console.log(`[WORKER] Processing designer task ${task.id} via Canva MCP`);

    try {
      task.status = "processing";
      task.updated_at = new Date().toISOString();
      writeTaskFile("designer-tasks.json", tasks);

      const designType = task.design_type || "instagram_post";
      const brandKitLine = task.brand_kit_id ? `Use brand kit ID: ${task.brand_kit_id}` : "";
      const isCarouselSlide = task.carousel_parent ? `\nThis is slide ${task.carousel_slide} of ${task.carousel_total} in a carousel set. Keep the visual style consistent: same color scheme, same layout structure, same typography.` : "";

      // Build brand style from brand_context if available, otherwise use defaults
      const bc = task.brand_context || { colors: [], fonts: [], logos: [] };
      const bcColors = bc.colors || [];
      const bcFonts = bc.fonts || [];
      const primaryColor = (bcColors.find(c => /primary|hoofd/i.test(c.label)) || {}).hex || "#7C3AED";
      const accentColor = (bcColors.find(c => /accent|secondary|secundair/i.test(c.label)) || {}).hex || "#A78BFA";
      const colorLines = bcColors.length
        ? bcColors.map(c => `- ${c.label || 'Color'}: ${c.hex}`).join("\n")
        : `- Primary color: ${primaryColor}\n- Accent/glow: ${accentColor}`;
      const fontLines = bcFonts.length
        ? bcFonts.map(f => `- ${f.role}: ${f.family}`).join("\n")
        : "- Typography: large bold headlines, clean sans-serif";

      // Build logo upload instructions for Canva worker
      const bcLogos = (bc.logos || []);
      const logoInstructions = bcLogos.length
        ? `\n5. Upload the brand logo using upload-asset-from-url with URL: ${process.env.BRAND_ASSET_URL || ""}/${(task.brand || "").toUpperCase()}/${bcLogos[0].name} — then add it to the design (top-left or top-right, small).`
        : "";

      const prompt = `You are a world-class social media designer. Create ONE ${designType} design in Canva.

## Brand Style
- Background: pure black or very dark (#000000 – #111111)
${colorLines}
- Text: white (#FFFFFF) or light gray (#F8FAFC)
- Aesthetic: dark, premium, bold, high-contrast
${fontLines}
${brandKitLine}${isCarouselSlide}

## Content for this design
${task.description}

## Steps
1. Call generate-design with design_type "${designType}" and a detailed query. The query must describe the VISUAL design: "dark black background, bold white text, accent elements in the brand colors above, modern style" + include the actual text content.
2. Pick the best candidate. Call create-design-from-candidate with that candidate_id.
3. Customize the text:
   a. Call start-editing-transaction with the design ID
   b. Call get-design-content to see current elements
   c. Call perform-editing-operations to update text elements with the EXACT text from the content above
   d. Call commit-editing-transaction to save${logoInstructions}

Return the final design URL when done.`;

      const response = await anthropic.beta.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 16384,
        betas: ["mcp-client-2025-11-20"],
        mcp_servers: [{
          type: "url",
          url: CANVA_MCP_BASE + "/mcp",
          name: "canva",
          authorization_token: canvaToken,
        }],
        tools: [{
          type: "mcp_toolset",
          mcp_server_name: "canva",
        }],
        messages: [{ role: "user", content: prompt }],
      });

      // Log full response for debugging
      console.log(`[WORKER] Designer response stop_reason: ${response.stop_reason}`);
      console.log(`[WORKER] Designer response content types: ${response.content.map(b => b.type).join(", ")}`);
      for (const block of response.content) {
        if (block.type === "text") console.log(`[WORKER] Designer text: ${block.text.substring(0, 500)}`);
        if (block.type === "mcp_tool_use") console.log(`[WORKER] Designer tool_use: ${block.name}`);
        if (block.type === "mcp_tool_result") console.log(`[WORKER] Designer tool_result: ${JSON.stringify(block).substring(0, 500)}`);
      }

      // Extract ALL text — from text blocks AND mcp_tool_result blocks
      const allText = response.content.map(b => {
        if (b.type === "text") return b.text;
        if (b.type === "mcp_tool_result") return JSON.stringify(b);
        return "";
      }).join("\n");
      const textBlocks = response.content.filter(b => b.type === "text");
      const resultText = textBlocks.map(b => b.text).join("\n");

      // Try to extract design info from mcp_tool_result (create-design-from-candidate response)
      let parsed = null;
      for (const block of response.content) {
        if (block.type === "mcp_tool_result" && !block.is_error) {
          const raw = JSON.stringify(block);
          const viewUrlMatch = raw.match(/"view_url"\s*:\s*"(https:\/\/www\.canva\.com\/d\/[^"]+)"/);
          const editUrlMatch = raw.match(/"edit_url"\s*:\s*"(https:\/\/www\.canva\.com\/d\/[^"]+)"/);
          const designIdMatch = raw.match(/"id"\s*:\s*"([^"]+)"/);
          const thumbMatch = raw.match(/https:\/\/design\.canva\.ai\/[^\s"')\\]+/);
          if (viewUrlMatch || editUrlMatch) {
            parsed = {
              result_url: viewUrlMatch?.[1] || editUrlMatch?.[1] || null,
              result_design_id: designIdMatch?.[1] || null,
              result_thumbnail: thumbMatch?.[0] || null,
            };
            break;
          }
        }
      }

      // Fallback: try text blocks
      if (!parsed) {
        const jsonMatch = resultText.match(/\{[^{}]*"result_url"[^{}]*\}/s);
        if (jsonMatch) {
          try { parsed = JSON.parse(jsonMatch[0]); } catch {}
        }
      }

      // Fallback: regex across all content
      if (!parsed) {
        const urlMatch = allText.match(/https:\/\/www\.canva\.com\/d\/[^\s"')\\]+/);
        const thumbMatch = allText.match(/https:\/\/design\.canva\.ai\/[^\s"')\\]+/);
        parsed = {
          result_url: urlMatch?.[0] || null,
          result_design_id: null,
          result_thumbnail: thumbMatch?.[0] || null,
        };
      }

      task.status = "completed";
      task.result_url = parsed.result_url;
      task.result_design_id = parsed.result_design_id;
      task.result_thumbnail = parsed.result_thumbnail;
      task.updated_at = new Date().toISOString();
      writeTaskFile("designer-tasks.json", tasks);
      processingTasks.delete(task.id);
      console.log(`[WORKER] Designer task ${task.id} completed: ${task.result_url}`);
    } catch (e) {
      console.error(`[WORKER] Designer task ${task.id} failed:`, e.message);
      task.status = "failed";
      task.error = e.message;
      task.updated_at = new Date().toISOString();
      writeTaskFile("designer-tasks.json", tasks);
      processingTasks.delete(task.id);
    }
  }
}

// ── COMMUNITY MANAGER PUBLISHER ──
function resolveMediaPath(mediaPath) {
  if (!mediaPath) return null;
  const name = mediaPath.startsWith("/media/") ? mediaPath.slice(7) : path.basename(mediaPath);
  const full = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(full)) throw new Error(`Media not found: ${name}`);
  return { full, name };
}

function mediaKindFor(name) {
  const ext = name.toLowerCase().split(".").pop();
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) return { method: "sendPhoto", field: "photo", capLimit: 1024 };
  if (ext === "gif") return { method: "sendAnimation", field: "animation", capLimit: 1024 };
  if (["mp4", "mov", "m4v"].includes(ext)) return { method: "sendVideo", field: "video", capLimit: 1024 };
  throw new Error(`Unsupported media type: .${ext}`);
}

async function publishToChannel(task, channel) {
  if (!channel) throw new Error(`Channel "${task.channel_id}" not found`);
  if (channel.enabled === false) throw new Error(`Channel "${channel.id}" is disabled`);
  if (channel.platform === "telegram") return publishTelegramPost(task, channel);
  if (channel.platform === "twitter") return publishTwitterPost(task);
  if (channel.platform === "discord") throw new Error("Discord publishing is not yet implemented");
  throw new Error(`Unknown platform: ${channel.platform}`);
}

// ── TWITTER / X PUBLISHING ────────────────────
// Auth: OAuth 1.0a user context (4 static keys from the developer portal, no token refresh).
// Posting: POST /2/tweets. Media: chunked upload via POST /2/media/upload (INIT/APPEND/FINALIZE).
const TWITTER_USAGE_FILE = path.join(__dirname, "data", "twitter-usage.json");
const TWITTER_UPLOAD_URL = "https://api.x.com/2/media/upload";

function twitterCreds() {
  const { TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET } = process.env;
  if (!TWITTER_API_KEY || !TWITTER_API_SECRET || !TWITTER_ACCESS_TOKEN || !TWITTER_ACCESS_SECRET) {
    throw new Error("X credentials missing — set TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN and TWITTER_ACCESS_SECRET in .env");
  }
  return { key: TWITTER_API_KEY, secret: TWITTER_API_SECRET, token: TWITTER_ACCESS_TOKEN, tokenSecret: TWITTER_ACCESS_SECRET };
}

// OAuth 1.0a HMAC-SHA1 signature. Only oauth_* params and URL query params are signed —
// JSON and multipart bodies are excluded per spec, which is exactly what we send.
function twitterOAuthHeader(method, url, creds) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const oauth = {
    oauth_consumer_key: creds.key,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const [baseUrl, qs] = url.split("?");
  const params = { ...oauth };
  if (qs) for (const [k, v] of new URLSearchParams(qs)) params[k] = v;
  const paramStr = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&");
  const base = [method.toUpperCase(), enc(baseUrl), enc(paramStr)].join("&");
  const signingKey = `${enc(creds.secret)}&${enc(creds.tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  return "OAuth " + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(", ");
}

function twitterMonthKey() { return new Date().toISOString().slice(0, 7); }
function twitterPostLimit() { return Number(process.env.TWITTER_MONTHLY_POST_LIMIT) || 500; }
function twitterPostsUsed() {
  try { return Number(JSON.parse(fs.readFileSync(TWITTER_USAGE_FILE, "utf8"))[twitterMonthKey()]) || 0; } catch { return 0; }
}
function twitterUsageSummary() { return { month: twitterMonthKey(), used: twitterPostsUsed(), limit: twitterPostLimit() }; }
function bumpTwitterUsage() {
  let usage = {};
  try { usage = JSON.parse(fs.readFileSync(TWITTER_USAGE_FILE, "utf8")); } catch {}
  const key = twitterMonthKey();
  usage[key] = (Number(usage[key]) || 0) + 1;
  fs.writeFileSync(TWITTER_USAGE_FILE, JSON.stringify(usage, null, 2));
}

// X counts every URL as 23 chars; other chars counted as code points (close enough for a guard)
function twitterWeightedLength(text) {
  const urlRe = /https?:\/\/\S+/g;
  let len = 0, last = 0, m;
  while ((m = urlRe.exec(text))) {
    len += [...text.slice(last, m.index)].length + 23;
    last = m.index + m[0].length;
  }
  return len + [...text.slice(last)].length;
}

async function twitterApi(method, url, creds, { json, form } = {}) {
  const headers = { Authorization: twitterOAuthHeader(method, url, creds) };
  let body;
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  else if (form) body = form;
  const r = await fetch(url, { method, headers, body });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const msg = data.detail || data.title || (Array.isArray(data.errors) && data.errors.map((e) => e.message || e.detail).join("; ")) || `HTTP ${r.status}`;
    throw new Error(`X API: ${msg}`);
  }
  return data;
}

async function twitterVerifyCredentials() {
  const creds = twitterCreds();
  const d = await twitterApi("GET", "https://api.x.com/2/users/me", creds);
  if (!d.data?.username) throw new Error("X API: unexpected /users/me response");
  return d.data;
}

const TWITTER_MEDIA_TYPES = {
  jpg: { mime: "image/jpeg", category: "tweet_image", max: 5 * 1024 * 1024 },
  jpeg: { mime: "image/jpeg", category: "tweet_image", max: 5 * 1024 * 1024 },
  png: { mime: "image/png", category: "tweet_image", max: 5 * 1024 * 1024 },
  webp: { mime: "image/webp", category: "tweet_image", max: 5 * 1024 * 1024 },
  gif: { mime: "image/gif", category: "tweet_gif", max: 15 * 1024 * 1024 },
  mp4: { mime: "video/mp4", category: "tweet_video", max: 512 * 1024 * 1024 },
  mov: { mime: "video/quicktime", category: "tweet_video", max: 512 * 1024 * 1024 },
  m4v: { mime: "video/mp4", category: "tweet_video", max: 512 * 1024 * 1024 },
};

async function twitterUploadMedia(mediaPath, creds) {
  const { full, name } = resolveMediaPath(mediaPath);
  const ext = name.toLowerCase().split(".").pop();
  const kind = TWITTER_MEDIA_TYPES[ext];
  if (!kind) throw new Error(`Unsupported media type for X: .${ext}`);
  const buffer = fs.readFileSync(full);
  if (buffer.length > kind.max) throw new Error(`${name} is too large for X (${Math.round(buffer.length / 1024 / 1024)}MB > ${Math.round(kind.max / 1024 / 1024)}MB)`);

  const init = new FormData();
  init.append("command", "INIT");
  init.append("media_type", kind.mime);
  init.append("total_bytes", String(buffer.length));
  init.append("media_category", kind.category);
  let d = await twitterApi("POST", TWITTER_UPLOAD_URL, creds, { form: init });
  const mediaId = d.data?.id || d.media_id_string;
  if (!mediaId) throw new Error("X API: media INIT returned no id");

  const CHUNK = 4 * 1024 * 1024;
  for (let offset = 0, seg = 0; offset < buffer.length; offset += CHUNK, seg++) {
    const append = new FormData();
    append.append("command", "APPEND");
    append.append("media_id", mediaId);
    append.append("segment_index", String(seg));
    append.append("media", new Blob([buffer.subarray(offset, offset + CHUNK)]), name);
    await twitterApi("POST", TWITTER_UPLOAD_URL, creds, { form: append });
  }

  const fin = new FormData();
  fin.append("command", "FINALIZE");
  fin.append("media_id", mediaId);
  d = await twitterApi("POST", TWITTER_UPLOAD_URL, creds, { form: fin });

  // Videos/GIFs are processed async — poll STATUS until done
  let info = d.data?.processing_info || d.processing_info;
  while (info && info.state !== "succeeded") {
    if (info.state === "failed") throw new Error(`X media processing failed: ${info.error?.message || "unknown error"}`);
    await new Promise((res) => setTimeout(res, Math.min(info.check_after_secs || 2, 15) * 1000));
    const statusUrl = `${TWITTER_UPLOAD_URL}?command=STATUS&media_id=${mediaId}`;
    d = await twitterApi("GET", statusUrl, creds);
    info = d.data?.processing_info || d.processing_info;
  }
  return String(mediaId);
}

async function publishTwitterPost(task) {
  const creds = twitterCreds();
  const { used, limit } = twitterUsageSummary();
  if (used >= limit) {
    throw new Error(`X monthly post limit reached (${used}/${limit}). Resets next month, or raise TWITTER_MONTHLY_POST_LIMIT if your API tier allows more.`);
  }

  const text = task.text || "";
  const wLen = twitterWeightedLength(text);
  if (wLen > 280) throw new Error(`Post is too long for X: ~${wLen}/280 chars (URLs count as 23)`);
  const mediaPaths = (Array.isArray(task.media_paths) && task.media_paths.length
    ? task.media_paths
    : (task.media_path ? [task.media_path] : [])).filter(Boolean);
  if (!text.trim() && !mediaPaths.length) throw new Error("X post needs text or media");
  if (mediaPaths.length > 4) throw new Error("X supports max 4 media items per post");
  if (mediaPaths.length > 1) {
    const nonImage = mediaPaths.some((p) => !["jpg", "jpeg", "png", "webp"].includes(p.toLowerCase().split(".").pop()));
    if (nonImage) throw new Error("X allows multiple media only for images (video/GIF must be a single item)");
  }

  const mediaIds = [];
  for (const p of mediaPaths) mediaIds.push(await twitterUploadMedia(p, creds));

  const body = { text };
  if (mediaIds.length) body.media = { media_ids: mediaIds };
  const d = await twitterApi("POST", "https://api.x.com/2/tweets", creds, { json: body });
  if (!d.data?.id) throw new Error("X API: tweet created but no id returned");
  bumpTwitterUsage();
  return { message_id: d.data.id };
}

async function publishTelegramPost(task, channel) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const chatId = channel.chat_id;
  if (!chatId) throw new Error(`Channel "${channel.id}" has no chat_id`);
  const topicId = channel.topic_id || null;
  const text = task.text || "";

  const mediaPaths = Array.isArray(task.media_paths) && task.media_paths.length
    ? task.media_paths.filter(Boolean)
    : (task.media_path ? [task.media_path] : []);

  if (!mediaPaths.length) {
    const body = { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true };
    if (topicId) body.message_thread_id = Number(topicId);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(`Telegram: ${data.description || "unknown error"}`);
    return { message_id: data.result.message_id };
  }

  if (mediaPaths.length === 1) {
    const { full, name } = resolveMediaPath(mediaPaths[0]);
    const kind = mediaKindFor(name);
    const captionFits = text.length <= kind.capLimit;

    const buffer = fs.readFileSync(full);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (topicId) form.append("message_thread_id", String(topicId));
    if (captionFits && text) {
      form.append("caption", text);
      form.append("parse_mode", "Markdown");
    }
    form.append(kind.field, new Blob([buffer]), name);

    const r = await fetch(`https://api.telegram.org/bot${token}/${kind.method}`, { method: "POST", body: form });
    const data = await r.json();
    if (!data.ok) throw new Error(`Telegram (${kind.method}): ${data.description || "unknown error"}`);
    const primaryMsgId = data.result.message_id;

    if (!captionFits && text) {
      const body2 = { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true, reply_to_message_id: primaryMsgId };
      if (topicId) body2.message_thread_id = Number(topicId);
      const r2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body2),
      });
      const data2 = await r2.json();
      if (!data2.ok) throw new Error(`Telegram (follow-up text): ${data2.description || "unknown error"}`);
    }
    return { message_id: primaryMsgId };
  }

  // Album: sendMediaGroup (2-10 items)
  if (mediaPaths.length > 10) throw new Error("Telegram albums support max 10 items");
  const items = mediaPaths.map(p => {
    const { full, name } = resolveMediaPath(p);
    const ext = name.toLowerCase().split(".").pop();
    let type;
    if (["jpg", "jpeg", "png", "webp"].includes(ext)) type = "photo";
    else if (["mp4", "mov", "m4v"].includes(ext)) type = "video";
    else throw new Error(`Unsupported media type in album: .${ext} (gif/animation cannot be grouped)`);
    return { full, name, type };
  });
  const albumCapLimit = 1024;
  const captionFits = text.length <= albumCapLimit;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (topicId) form.append("message_thread_id", String(topicId));
  const mediaJson = items.map((it, i) => {
    const entry = { type: it.type, media: `attach://file${i}` };
    if (i === 0 && captionFits && text) {
      entry.caption = text;
      entry.parse_mode = "Markdown";
    }
    return entry;
  });
  form.append("media", JSON.stringify(mediaJson));
  items.forEach((it, i) => {
    const buffer = fs.readFileSync(it.full);
    form.append(`file${i}`, new Blob([buffer]), it.name);
  });

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: "POST", body: form });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram (sendMediaGroup): ${data.description || "unknown error"}`);
  const primaryMsgId = data.result[0].message_id;

  if (!captionFits && text) {
    const body2 = { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true, reply_to_message_id: primaryMsgId };
    if (topicId) body2.message_thread_id = Number(topicId);
    const r2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body2),
    });
    const data2 = await r2.json();
    if (!data2.ok) throw new Error(`Telegram (follow-up text): ${data2.description || "unknown error"}`);
  }
  return { message_id: primaryMsgId };
}

async function processCommunityTasks() {
  const tasks = readTaskFile(COMMUNITY_TASKS_FILE);
  const channelMap = Object.fromEntries(readChannels().map(c => [c.id, c]));
  const now = Date.now();
  let changed = false;
  for (const task of tasks) {
    if (task.status !== "scheduled") continue;
    if (processingTasks.has(task.id)) continue;
    const when = Date.parse(task.scheduled_at || "");
    if (!when || when > now) continue;
    if ((task.attempts || 0) >= 5) {
      task.status = "failed";
      task.error = task.error || "Max attempts reached";
      task.updated_at = new Date().toISOString();
      changed = true;
      continue;
    }
    const channel = channelMap[task.channel_id];
    if (!channel) continue;
    if (channel.enabled === false) continue;
    processingTasks.add(task.id);
    try {
      console.log(`[WORKER] Publishing community post ${task.id} to ${channel.id} (${task.archetype || "?"})`);
      const result = await publishToChannel(task, channel);
      task.status = "published";
      task.published_at = new Date().toISOString();
      task.message_id = result.message_id;
      task.attempts = (task.attempts || 0) + 1;
      task.updated_at = task.published_at;
      task.error = null;
      changed = true;
      console.log(`[WORKER] Community post ${task.id} published (msg ${result.message_id})`);
    } catch (e) {
      task.attempts = (task.attempts || 0) + 1;
      task.error = e.message;
      task.updated_at = new Date().toISOString();
      changed = true;
      console.error(`[WORKER] Community post ${task.id} failed (attempt ${task.attempts}): ${e.message}`);
    } finally {
      processingTasks.delete(task.id);
    }
  }
  if (changed) writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
}

// Run workers every 15 seconds
setInterval(() => {
  processScriptwriterTasks().catch(e => console.error("[WORKER] Scriptwriter error:", e.message));
  processResearchTasks().catch(e => console.error("[WORKER] Research error:", e.message));
  processSeoTasks().catch(e => console.error("[WORKER] SEO error:", e.message));
  processOpusclipTasks().catch(e => console.error("[WORKER] OpusClip error:", e.message));
  processDesignerTasks().catch(e => console.error("[WORKER] Designer error:", e.message));
  processCommunityTasks().catch(e => console.error("[WORKER] Community error:", e.message));
  processUgcTasks().catch(e => console.error("[WORKER] UGC error:", e.message));
}, 15_000);

// Poll Higgsfield status every 30 seconds
setInterval(pollUgcStatus, 30_000);
setInterval(pollAvatarCreator, 30_000);

// Run once on startup
setTimeout(() => {
  processScriptwriterTasks().catch(() => {});
  processResearchTasks().catch(() => {});
  processSeoTasks().catch(() => {});
  processOpusclipTasks().catch(() => {});
  processDesignerTasks().catch(() => {});
  processCommunityTasks().catch(() => {});
  processUgcTasks().catch(() => {});
  pollUgcStatus().catch(() => {});
  pollAvatarCreator().catch(() => {});
}, 3000);

// ── STRIPE REVENUE ───────────────────────────
let stripeCache = { data: null, ts: 0 };

// Paginate through all Stripe list results
async function stripeListAll(resource, params) {
  const items = [];
  let hasMore = true;
  let startingAfter;
  while (hasMore) {
    const opts = { ...params, limit: 100 };
    if (startingAfter) opts.starting_after = startingAfter;
    const page = await resource.list(opts);
    items.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
  }
  return items;
}

app.get("/stripe/revenue", async (_req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

  // Cache for 5 minutes
  if (stripeCache.data && Date.now() - stripeCache.ts < 5 * 60 * 1000) {
    return res.json(stripeCache.data);
  }

  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const tsMonth = Math.floor(startOfMonth / 1000);
    const tsPrevStart = Math.floor(startOfPrevMonth / 1000);
    const tsPrevEnd = Math.floor(endOfPrevMonth / 1000);

    // Parallel fetch all Stripe data
    const [balance, activeSubs, canceledSubs, txnsMTD, txnsPrev, invoicesMTD, invoicesPrev] = await Promise.all([
      stripe.balance.retrieve(),
      stripe.subscriptions.list({ status: "active", limit: 100 }),
      stripe.subscriptions.list({ status: "canceled", created: { gte: tsMonth }, limit: 100 }),
      // Balance transactions = source of truth for gross volume
      stripeListAll(stripe.balanceTransactions, { created: { gte: tsMonth } }),
      stripeListAll(stripe.balanceTransactions, { created: { gte: tsPrevStart, lte: tsPrevEnd } }),
      // Invoices = subscription revenue
      stripeListAll(stripe.invoices, { created: { gte: tsMonth } }),
      stripeListAll(stripe.invoices, { created: { gte: tsPrevStart, lte: tsPrevEnd } }),
    ]);

    // -- Gross volume from balance transactions (charge + payment types) --
    const revenueTypes = new Set(["charge", "payment"]);
    const grossMTD = txnsMTD.filter(t => revenueTypes.has(t.type)).reduce((s, t) => s + t.amount, 0);
    const feesMTD = txnsMTD.filter(t => revenueTypes.has(t.type)).reduce((s, t) => s + t.fee, 0);
    const grossPrev = txnsPrev.filter(t => revenueTypes.has(t.type)).reduce((s, t) => s + t.amount, 0);
    const feesPrev = txnsPrev.filter(t => revenueTypes.has(t.type)).reduce((s, t) => s + t.fee, 0);

    // -- Refunds --
    const refundsMTD = txnsMTD.filter(t => t.type === "payment_failure_refund" || t.type === "refund").reduce((s, t) => s + Math.abs(t.amount), 0);

    // -- MRR from active subscriptions --
    let mrr = 0;
    for (const sub of activeSubs.data) {
      for (const item of sub.items.data) {
        let amt = item.price.unit_amount || 0;
        if (item.price.recurring?.interval === "year") amt = Math.round(amt / 12);
        mrr += amt * (item.quantity || 1);
      }
    }

    // -- Subscription revenue (invoices) --
    const subRevenueMTD = invoicesMTD.filter(i => i.status === "paid").reduce((s, i) => s + i.amount_paid, 0);
    const subRevenuePrev = invoicesPrev.filter(i => i.status === "paid").reduce((s, i) => s + i.amount_paid, 0);

    // -- Other revenue = gross volume minus subs --
    const otherMTD = grossMTD - subRevenueMTD;
    const otherPrev = grossPrev - subRevenuePrev;

    // -- Subs --
    const activeSubCount = activeSubs.data.length;
    const churnCount = canceledSubs.data.length;
    const churnRate = activeSubCount + churnCount > 0
      ? ((churnCount / (activeSubCount + churnCount)) * 100).toFixed(1)
      : "0.0";

    // -- Balance --
    const balanceAvailable = balance.available.reduce((s, b) => s + b.amount, 0);
    const balancePending = balance.pending.reduce((s, b) => s + b.amount, 0);

    // MRR = subscription MRR + Plug&Pay monthly revenue (other revenue = Plug&Pay)
    const totalMRR = mrr + otherMTD;

    const result = {
      mrr: { value: totalMRR, subs_only: mrr, plugpay: otherMTD },
      subscriptions: { mtd: subRevenueMTD, prev: subRevenuePrev, subs: activeSubCount },
      other: { mtd: otherMTD, prev: otherPrev },
      gross: { mtd: grossMTD, prev: grossPrev, fees_mtd: feesMTD, fees_prev: feesPrev, refunds_mtd: refundsMTD },
      active_subs: { value: activeSubCount, churned: churnCount },
      churn_rate: { value: parseFloat(churnRate) },
      balance: { available: balanceAvailable, pending: balancePending },
      fetched_at: new Date().toISOString(),
    };

    stripeCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    console.error("[STRIPE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FINANCE: subscriptions, config, webhook ─────
const FINANCE_CONFIG_PATH = path.join(__dirname, "data", "finance-config.json");
const FINANCE_DEFAULTS = { notify_new: true, notify_canceled: true, notify_past_due: true, notify_recovered: true };

function loadFinanceConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(FINANCE_CONFIG_PATH, "utf8"));
    return { ...FINANCE_DEFAULTS, ...raw };
  } catch { return { ...FINANCE_DEFAULTS }; }
}
function saveFinanceConfig(cfg) {
  fs.writeFileSync(FINANCE_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function formatMoney(amountCents, currency) {
  const symbol = { usd: "$", eur: "€", gbp: "£" }[(currency || "usd").toLowerCase()] || ((currency || "usd").toUpperCase() + " ");
  return symbol + (amountCents / 100).toFixed(2);
}

// Normalize a Stripe Subscription into the shape the UI needs.
function normalizeSubscription(sub) {
  const items = sub.items?.data || [];
  let mrrCents = 0;
  const planLines = [];
  for (const item of items) {
    const price = item.price || {};
    const unit = price.unit_amount || 0;
    const qty = item.quantity || 1;
    const interval = price.recurring?.interval;
    let monthly = unit;
    if (interval === "year") monthly = Math.round(unit / 12);
    else if (interval === "week") monthly = unit * 4;
    else if (interval === "day") monthly = unit * 30;
    mrrCents += monthly * qty;
    const product = price.product && typeof price.product === "object" ? price.product : null;
    const productName = product?.name || price.nickname || "Plan";
    planLines.push(`${productName} — ${formatMoney(unit * qty, price.currency)}/${interval || "mo"}`);
  }
  const customer = sub.customer && typeof sub.customer === "object" ? sub.customer : null;
  return {
    id: sub.id,
    status: sub.status,
    customer_email: customer?.email || "",
    customer_name: customer?.name || "",
    plan: planLines.join(", ") || "—",
    currency: items[0]?.price?.currency || "usd",
    mrr_cents: mrrCents,
    amount_display: items.length ? formatMoney(mrrCents, items[0].price.currency) : "—",
    interval: items[0]?.price?.recurring?.interval || "month",
    start_date: sub.start_date ? new Date(sub.start_date * 1000).toISOString() : null,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
  };
}

app.get("/finance/subscriptions", async (_req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
  try {
    // Stripe caps expand depth at 4 levels, so we resolve product names in
    // a second pass and inline them onto each price before normalizing.
    const subs = await stripe.subscriptions.list({
      status: "all",
      limit: 100,
      expand: ["data.customer"],
    });
    const productIds = new Set();
    for (const sub of subs.data) {
      for (const item of (sub.items?.data || [])) {
        const pid = item.price?.product;
        if (typeof pid === "string") productIds.add(pid);
      }
    }
    const productMap = {};
    await Promise.all([...productIds].map(async pid => {
      try { productMap[pid] = await stripe.products.retrieve(pid); }
      catch { productMap[pid] = null; }
    }));
    for (const sub of subs.data) {
      for (const item of (sub.items?.data || [])) {
        const pid = item.price?.product;
        if (typeof pid === "string" && productMap[pid]) item.price.product = productMap[pid];
      }
    }
    const items = subs.data.map(normalizeSubscription);
    items.sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""));
    const active = items.filter(s => s.status === "active" || s.status === "trialing");
    const mrrCents = active.reduce((s, x) => s + x.mrr_cents, 0);
    const currency = active[0]?.currency || items[0]?.currency || "usd";
    res.json({
      subscriptions: items,
      kpi: {
        mrr_cents: mrrCents,
        mrr_display: formatMoney(mrrCents, currency),
        active_count: items.filter(s => s.status === "active").length,
        trialing_count: items.filter(s => s.status === "trialing").length,
        past_due_count: items.filter(s => s.status === "past_due").length,
        canceled_count: items.filter(s => s.status === "canceled").length,
      },
      currency,
    });
  } catch (err) {
    console.error("[FINANCE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/finance/config", (_req, res) => {
  const cfg = loadFinanceConfig();
  res.json({
    ...cfg,
    stripe_connected: !!stripe,
    webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
  });
});

app.post("/finance/config", (req, res) => {
  const cfg = loadFinanceConfig();
  const next = { ...cfg };
  if (typeof req.body.notify_new === "boolean") next.notify_new = req.body.notify_new;
  if (typeof req.body.notify_canceled === "boolean") next.notify_canceled = req.body.notify_canceled;
  if (typeof req.body.notify_past_due === "boolean") next.notify_past_due = req.body.notify_past_due;
  if (typeof req.body.notify_recovered === "boolean") next.notify_recovered = req.body.notify_recovered;
  saveFinanceConfig(next);
  res.json(next);
});

// Build a Telegram message for a subscription event.
function formatSubscriptionMessage(sub, eventType) {
  const norm = normalizeSubscription(sub);
  const who = norm.customer_name
    ? `${norm.customer_name} (${norm.customer_email || "no email"})`
    : (norm.customer_email || "Unknown customer");
  if (eventType === "customer.subscription.created") {
    return [
      `<b>New subscription</b>`,
      `Customer: ${who}`,
      `Plan: ${norm.plan}`,
      `MRR: ${norm.amount_display}/mo`,
      `Status: ${norm.status}`,
    ].join("\n");
  }
  if (eventType === "customer.subscription.deleted") {
    return [
      `<b>Subscription canceled</b>`,
      `Customer: ${who}`,
      `Plan: ${norm.plan}`,
      `Was MRR: ${norm.amount_display}/mo`,
      norm.canceled_at ? `Canceled: ${new Date(norm.canceled_at).toLocaleString()}` : "",
    ].filter(Boolean).join("\n");
  }
  if (eventType === "past_due") {
    return [
      `<b>Payment past due</b>`,
      `Customer: ${who}`,
      `Plan: ${norm.plan}`,
      `MRR at risk: ${norm.amount_display}/mo`,
      `Status: ${norm.status}`,
    ].join("\n");
  }
  if (eventType === "recovered") {
    return [
      `<b>Payment recovered</b>`,
      `Customer: ${who}`,
      `Plan: ${norm.plan}`,
      `MRR: ${norm.amount_display}/mo`,
      `Status: past_due → ${norm.status}`,
    ].join("\n");
  }
  return null;
}

// Retrieve a subscription with customer + product names expanded, for notification messages.
async function retrieveSubscriptionForMessage(id) {
  const sub = await stripe.subscriptions.retrieve(id, { expand: ["customer"] });
  // Inline product names (expand-depth workaround, see /finance/subscriptions).
  for (const item of (sub.items?.data || [])) {
    const pid = item.price?.product;
    if (typeof pid === "string") {
      try { item.price.product = await stripe.products.retrieve(pid); } catch {}
    }
  }
  return sub;
}

async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(503).send("Stripe not configured");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).send("Webhook secret not configured");

  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("[STRIPE-WH] Signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Invalidate the revenue cache so the UI shows fresh numbers.
  stripeCache = { data: null, ts: 0 };

  const cfg = loadFinanceConfig();
  try {
    if (event.type === "customer.subscription.created" && cfg.notify_new) {
      // Re-fetch with expansions so the message has customer + plan names.
      const sub = await retrieveSubscriptionForMessage(event.data.object.id);
      const msg = formatSubscriptionMessage(sub, event.type);
      if (msg) sendTelegram("New subscription", msg, "success");
    } else if (event.type === "customer.subscription.deleted" && cfg.notify_canceled) {
      const sub = await retrieveSubscriptionForMessage(event.data.object.id);
      const msg = formatSubscriptionMessage(sub, event.type);
      if (msg) sendTelegram("Subscription canceled", msg, "warning");
    } else if (event.type === "customer.subscription.updated") {
      // Status transitions: previous_attributes.status is only present when the status changed.
      const newStatus = event.data.object.status;
      const prevStatus = event.data.previous_attributes?.status;
      if (prevStatus && prevStatus !== newStatus) {
        if (newStatus === "past_due" && cfg.notify_past_due) {
          const sub = await retrieveSubscriptionForMessage(event.data.object.id);
          const msg = formatSubscriptionMessage(sub, "past_due");
          if (msg) sendTelegram("Payment past due", msg, "danger");
        } else if (prevStatus === "past_due" && (newStatus === "active" || newStatus === "trialing") && cfg.notify_recovered) {
          const sub = await retrieveSubscriptionForMessage(event.data.object.id);
          const msg = formatSubscriptionMessage(sub, "recovered");
          if (msg) sendTelegram("Payment recovered", msg, "success");
        }
      }
    }
  } catch (err) {
    console.error("[STRIPE-WH] handler error:", err.message);
  }

  res.json({ received: true });
}

// ── REMOTION VIDEO PROJECTS ──
const VIDEO_PROJECTS_DIR = path.join(__dirname, "data", "video-projects");
if (!fs.existsSync(VIDEO_PROJECTS_DIR)) fs.mkdirSync(VIDEO_PROJECTS_DIR, { recursive: true });
app.use("/video-projects-static", express.static(VIDEO_PROJECTS_DIR));

const STUDIO_PORT = REMOTION_STUDIO_PORT;
// Same-origin path proxied to the Studio subprocess. Customers can override
// with STUDIO_URL=https://… if they prefer their own reverse proxy / domain.
const STUDIO_URL = process.env.STUDIO_URL || "/remotion-studio/";
let currentStudio = null; // { projectId, process, startedAt }

function readProjectMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(VIDEO_PROJECTS_DIR, id, "meta.json"), "utf8")); }
  catch { return null; }
}
function writeProjectMeta(id, meta) {
  fs.writeFileSync(path.join(VIDEO_PROJECTS_DIR, id, "meta.json"), JSON.stringify(meta, null, 2));
}

function detectEntryPoint(projectDir) {
  const candidates = [
    "src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx",
    "src/Root.ts", "src/Root.tsx",
    "remotion/index.ts", "remotion/index.tsx",
    "index.ts", "index.tsx", "index.js", "index.jsx",
    "Root.tsx",
  ];
  // First check direct candidates
  for (const c of candidates) {
    const p = path.join(projectDir, c);
    if (fs.existsSync(p)) return p;
  }
  // Walk one level deep — sometimes zips have a wrapper dir
  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !["node_modules", ".git", "_bundle", "renders"].includes(e.name));
    for (const e of entries) {
      const sub = path.join(projectDir, e.name);
      for (const c of candidates) {
        const p = path.join(sub, c);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return null;
}

function linkNodeModules(projectDir) {
  const target = path.join(projectDir, "node_modules");
  if (fs.existsSync(target)) return;
  try { fs.symlinkSync(path.join(__dirname, "node_modules"), target, "dir"); }
  catch (e) { console.warn("[VIDEO-PROJECT] node_modules symlink failed:", e.message); }
}

// Walk a project dir, transcode any .mov/.mkv/.webm/.avi videos in-place to H.264+AAC
// so browsers (and Remotion's <OffthreadVideo>) can play them. Keeps the same filename
// so user code doesn't need to change references. Skips files already marked .transcoded.
function transcodeProjectVideos(projectDir) {
  const results = { transcoded: [], failed: [], skipped: [] };
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", ".git", "_bundle", "renders", "_incoming"].includes(e.name)) continue;
        walk(p, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (![".mov", ".mkv", ".webm", ".avi"].includes(ext)) continue;
        const marker = p + ".transcoded";
        if (fs.existsSync(marker)) { results.skipped.push(p); continue; }
        const tmpOut = p + ".tmp.mp4";
        try {
          console.log(`[VIDEO-PROJECT] Transcoding ${p}...`);
          // NOTE: stderr must be 'ignore' not 'pipe' — ffmpeg writes MBs of progress
          // to stderr on long renders and buffering would silently kill the process
          // via Node's default 1MB maxBuffer, leaving a truncated output file behind.
          const result = require("child_process").spawnSync("ffmpeg", [
            "-y", "-i", p,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "128k",
            "-max_muxing_queue_size", "1024",
            tmpOut,
          ], { stdio: "ignore", timeout: 60 * 60 * 1000 });
          if (result.error) throw result.error;
          if (result.status !== 0) throw new Error(`ffmpeg exited with code ${result.status}${result.signal ? " (signal " + result.signal + ")" : ""}`);
          if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 1024) throw new Error("ffmpeg produced empty output");
          // Replace original in place (keeping filename/extension)
          fs.renameSync(tmpOut, p);
          fs.writeFileSync(marker, new Date().toISOString());
          results.transcoded.push(p);
          console.log(`[VIDEO-PROJECT] Transcoded ${p} (${fs.statSync(p).size} bytes)`);
        } catch (err) {
          console.error(`[VIDEO-PROJECT] Transcode failed for ${p}:`, err.message);
          try { fs.unlinkSync(tmpOut); } catch {}
          results.failed.push({ path: p, error: err.message });
        }
      }
    }
  };
  walk(projectDir);
  return results;
}

app.get("/video-projects", (_req, res) => {
  try {
    const projects = fs.readdirSync(VIDEO_PROJECTS_DIR)
      .map(id => readProjectMeta(id))
      .filter(Boolean)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({
      projects,
      studio: currentStudio ? { projectId: currentStudio.projectId, url: STUDIO_URL, startedAt: currentStudio.startedAt } : null,
    });
  } catch (e) { res.json({ projects: [], studio: null }); }
});

app.get("/video-projects/:id", (req, res) => {
  const meta = readProjectMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: "Not found" });
  res.json(meta);
});

const videoProjectUpload = require("multer")({
  storage: require("multer").diskStorage({
    destination: (req, _file, cb) => {
      if (!req._projectId) req._projectId = genId();
      const dir = path.join(VIDEO_PROJECTS_DIR, req._projectId, "_incoming");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      // Use webkitRelativePath if browser provided it (folder upload), else original
      const rel = file.originalname;
      cb(null, rel.replace(/[^a-zA-Z0-9._/-]/g, "_"));
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.post("/video-projects", (req, res) => {
  videoProjectUpload.array("files", 500)(req, res, async (err) => {
    if (err) {
      console.error("[VIDEO-PROJECT] Upload error:", err.message);
      return res.status(400).json({ error: err.message });
    }
    try {
      const id = req._projectId || genId();
      const projectDir = path.join(VIDEO_PROJECTS_DIR, id);
      const incoming = path.join(projectDir, "_incoming");
      fs.mkdirSync(projectDir, { recursive: true });

      // Handle uploaded files. Supports: (a) one or more zip files, (b) loose files with paths
      // We support relative paths passed as form-data field `paths[]` in same order as files
      const paths = req.body && req.body.paths;
      const pathArr = Array.isArray(paths) ? paths : (paths ? [paths] : []);
      const uploadedNames = (req.files || []).map(f => f.originalname);
      let fileIdx = 0;
      for (const f of req.files || []) {
        const ext = path.extname(f.originalname).toLowerCase();
        if (ext === ".zip") {
          const unzipper = require("unzipper");
          await new Promise((resolve, reject) => {
            fs.createReadStream(f.path)
              .pipe(unzipper.Extract({ path: projectDir }))
              .on("close", resolve)
              .on("error", reject);
          });
          try { fs.unlinkSync(f.path); } catch {}
        } else {
          // Place file at its intended relative path if provided
          const rel = pathArr[fileIdx] || f.originalname;
          const safeRel = rel.replace(/\.\./g, "").replace(/^\/+/, "");
          const destPath = path.join(projectDir, safeRel);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.renameSync(f.path, destPath);
        }
        fileIdx++;
      }
      try { fs.rmSync(incoming, { recursive: true, force: true }); } catch {}

      // Symlink node_modules so Remotion deps resolve
      linkNodeModules(projectDir);

      const entry = detectEntryPoint(projectDir);
      const meta = {
        id,
        name: (req.body && req.body.name) || uploadedNames[0]?.replace(/\.zip$/i, "") || `Project ${id}`,
        created_at: new Date().toISOString(),
        entry: entry ? path.relative(projectDir, entry) : null,
        status: entry ? "ready" : "missing-entry",
        compositions: [],
        renders: [],
        transcode_status: "running",
        transcode_started_at: new Date().toISOString(),
      };
      writeProjectMeta(id, meta);
      console.log(`[VIDEO-PROJECT] Created ${id} (${meta.name}), entry=${meta.entry} — transcoding in background`);
      res.json(meta);

      // Run transcoding in background — does not block upload response
      setImmediate(() => {
        try {
          const results = transcodeProjectVideos(projectDir);
          const latest = readProjectMeta(id);
          if (latest) {
            latest.transcoded = results.transcoded.map(p => path.relative(projectDir, p));
            latest.transcode_failures = results.failed.map(f => ({ path: path.relative(projectDir, f.path), error: f.error }));
            latest.transcode_status = "done";
            latest.transcode_finished_at = new Date().toISOString();
            writeProjectMeta(id, latest);
          }
          console.log(`[VIDEO-PROJECT] Background transcode done for ${id}: ${results.transcoded.length} ok, ${results.failed.length} failed`);
        } catch (e) {
          console.error(`[VIDEO-PROJECT] Background transcode failed for ${id}:`, e);
          const latest = readProjectMeta(id);
          if (latest) {
            latest.transcode_status = "failed";
            latest.transcode_error = e.message;
            writeProjectMeta(id, latest);
          }
        }
      });
    } catch (e) {
      console.error("[VIDEO-PROJECT] Create failed:", e);
      res.status(500).json({ error: e.message });
    }
  });
});

app.delete("/video-projects/:id", (req, res) => {
  const id = req.params.id;
  if (currentStudio && currentStudio.projectId === id) {
    try { currentStudio.process.kill("SIGTERM"); } catch {}
    currentStudio = null;
  }
  try { fs.rmSync(path.join(VIDEO_PROJECTS_DIR, id), { recursive: true, force: true }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});

// Given a project dir and its relative entry path, return the "Remotion project root"
// (the nearest ancestor of the entry file that contains a package.json) plus the entry
// path relative to that root. Falls back to projectDir if no package.json is found.
function resolveRemotionRoot(projectDir, entryRel) {
  const entryAbs = path.join(projectDir, entryRel);
  let dir = path.dirname(entryAbs);
  while (dir.startsWith(projectDir) && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return { root: dir, entry: path.relative(dir, entryAbs) };
    }
    dir = path.dirname(dir);
  }
  return { root: projectDir, entry: entryRel };
}

// ── Remotion Studio subprocess (one at a time) ──
app.post("/video-projects/:id/studio", (req, res) => {
  const id = req.params.id;
  const meta = readProjectMeta(id);
  if (!meta) return res.status(404).json({ error: "Project not found" });
  if (!meta.entry) return res.status(400).json({ error: "No Remotion entry point detected in project" });
  const projectDir = path.join(VIDEO_PROJECTS_DIR, id);
  const entryAbs = path.join(projectDir, meta.entry);
  if (!fs.existsSync(entryAbs)) return res.status(400).json({ error: "Entry file missing: " + meta.entry });

  // Kill any existing studio
  if (currentStudio && currentStudio.process) {
    try { currentStudio.process.kill("SIGTERM"); } catch {}
    currentStudio = null;
  }

  linkNodeModules(projectDir);
  // Resolve to the nearest package.json so public/ and project root are correct
  const { root: remotionRoot, entry: entryRel } = resolveRemotionRoot(projectDir, meta.entry);
  // Also ensure node_modules is accessible from the inner project root
  linkNodeModules(remotionRoot);
  console.log(`[VIDEO-PROJECT] Starting Studio cwd=${remotionRoot} entry=${entryRel}`);
  const remotionBin = path.join(__dirname, "node_modules", ".bin", "remotion");
  const { spawn } = require("child_process");
  const child = spawn(remotionBin, ["studio", entryRel, `--port=${STUDIO_PORT}`, "--host=127.0.0.1", "--no-open"], {
    cwd: remotionRoot,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", d => process.stdout.write(`[STUDIO ${id}] ${d}`));
  child.stderr.on("data", d => process.stderr.write(`[STUDIO ${id} ERR] ${d}`));
  child.on("exit", (code) => {
    console.log(`[STUDIO ${id}] exited with code ${code}`);
    if (currentStudio && currentStudio.process === child) currentStudio = null;
  });

  currentStudio = { projectId: id, process: child, startedAt: new Date().toISOString() };
  console.log(`[VIDEO-PROJECT] Starting Studio for ${id}`);
  res.json({ ok: true, url: STUDIO_URL, projectId: id, startedAt: currentStudio.startedAt });
});

// Re-transcode video assets async — returns immediately, runs in background
app.post("/video-projects/:id/transcode", (req, res) => {
  const id = req.params.id;
  const meta = readProjectMeta(id);
  if (!meta) return res.status(404).json({ error: "Not found" });
  const projectDir = path.join(VIDEO_PROJECTS_DIR, id);

  if (meta.transcode_status === "running") return res.json({ ok: true, status: "already-running" });

  // Clear markers if force=true
  if (req.body && req.body.force) {
    const walk = (dir, depth = 0) => {
      if (depth > 6) return;
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory() && !["node_modules", ".git"].includes(e.name)) walk(path.join(dir, e.name), depth + 1);
          else if (e.isFile() && e.name.endsWith(".transcoded")) { try { fs.unlinkSync(path.join(dir, e.name)); } catch {} }
        }
      } catch {}
    };
    walk(projectDir);
  }

  meta.transcode_status = "running";
  meta.transcode_started_at = new Date().toISOString();
  writeProjectMeta(id, meta);

  res.json({ ok: true, status: "running" });

  setImmediate(() => {
    try {
      const results = transcodeProjectVideos(projectDir);
      const latest = readProjectMeta(id);
      if (latest) {
        latest.transcoded = [...new Set([...(latest.transcoded || []), ...results.transcoded.map(p => path.relative(projectDir, p))])];
        latest.transcode_failures = results.failed.map(f => ({ path: path.relative(projectDir, f.path), error: f.error }));
        latest.transcode_status = "done";
        latest.transcode_finished_at = new Date().toISOString();
        writeProjectMeta(id, latest);
      }
      console.log(`[VIDEO-PROJECT] Transcode done for ${id}: ${results.transcoded.length} ok, ${results.failed.length} failed`);
    } catch (e) {
      console.error(`[VIDEO-PROJECT] Background transcode failed:`, e);
      const latest = readProjectMeta(id);
      if (latest) {
        latest.transcode_status = "failed";
        latest.transcode_error = e.message;
        writeProjectMeta(id, latest);
      }
    }
  });
});

app.post("/video-projects/studio/stop", (_req, res) => {
  if (currentStudio && currentStudio.process) {
    try { currentStudio.process.kill("SIGTERM"); } catch {}
    currentStudio = null;
  }
  res.json({ ok: true });
});

app.get("/video-projects/studio/status", (_req, res) => {
  if (!currentStudio) return res.json({ running: false });
  res.json({ running: true, projectId: currentStudio.projectId, url: STUDIO_URL, startedAt: currentStudio.startedAt });
});

// ── Render to MP4 ──
app.post("/video-projects/:id/render", async (req, res) => {
  const id = req.params.id;
  const meta = readProjectMeta(id);
  if (!meta) return res.status(404).json({ error: "Not found" });
  if (!meta.entry) return res.status(400).json({ error: "No entry point" });
  const projectDir = path.join(VIDEO_PROJECTS_DIR, id);
  const bundleDir = path.join(projectDir, "_bundle");
  const rendersDir = path.join(projectDir, "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const renderId = genId();
  const outPath = path.join(rendersDir, `${renderId}.mp4`);

  // Respond immediately — render runs async
  res.json({ ok: true, render_id: renderId, status: "processing" });

  const renderRecord = {
    id: renderId,
    composition: req.body?.composition_id || null,
    status: "processing",
    started_at: new Date().toISOString(),
  };
  meta.renders = [renderRecord, ...(meta.renders || [])].slice(0, 20);
  writeProjectMeta(id, meta);

  try {
    linkNodeModules(projectDir);
    const { root: remotionRoot, entry: entryRel } = resolveRemotionRoot(projectDir, meta.entry);
    linkNodeModules(remotionRoot);
    const { bundle } = require("@remotion/bundler");
    const { selectComposition, renderMedia } = require("@remotion/renderer");
    console.log(`[VIDEO-PROJECT] Bundling ${id} (root=${remotionRoot})...`);
    const serveUrl = await bundle({
      entryPoint: path.join(remotionRoot, entryRel),
      outDir: bundleDir,
      publicDir: path.join(remotionRoot, "public"),
      webpackOverride: (c) => c,
    });
    let compositionId = req.body?.composition_id;
    if (!compositionId) {
      const { getCompositions } = require("@remotion/renderer");
      const comps = await getCompositions(serveUrl);
      if (!comps.length) throw new Error("No compositions found in project");
      compositionId = comps[0].id;
      meta.compositions = comps.map(c => ({ id: c.id, width: c.width, height: c.height, fps: c.fps, durationInFrames: c.durationInFrames }));
    }
    console.log(`[VIDEO-PROJECT] Rendering ${id} composition=${compositionId}`);
    const composition = await selectComposition({ serveUrl, id: compositionId });
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outPath,
      inputProps: req.body?.input_props || {},
    });
    const latest = readProjectMeta(id);
    const idx = (latest.renders || []).findIndex(r => r.id === renderId);
    if (idx >= 0) {
      latest.renders[idx] = {
        ...latest.renders[idx],
        status: "completed",
        composition: compositionId,
        path: `/video-projects-static/${id}/renders/${renderId}.mp4`,
        completed_at: new Date().toISOString(),
      };
      latest.compositions = meta.compositions;
      writeProjectMeta(id, latest);
    }
    console.log(`[VIDEO-PROJECT] Render complete ${id}/${renderId}`);
  } catch (e) {
    console.error(`[VIDEO-PROJECT] Render failed ${id}/${renderId}:`, e.message);
    const latest = readProjectMeta(id);
    const idx = (latest.renders || []).findIndex(r => r.id === renderId);
    if (idx >= 0) {
      latest.renders[idx] = { ...latest.renders[idx], status: "failed", error: e.message, completed_at: new Date().toISOString() };
      writeProjectMeta(id, latest);
    }
  }
});

// ── CRON JOBS ENDPOINT ──
const { execSync } = require("child_process");

// Restart the api-server: spawn a detached child that re-launches after a short delay, then exit
app.post("/system/restart", (_req, res) => {
  res.json({ ok: true, message: "Restarting api-server..." });
  console.log("[SYSTEM] Restart requested — spawning detached successor");
  try {
    const { spawn } = require("child_process");
    const scriptPath = path.resolve(__filename);
    spawn("sh", ["-c", `sleep 1 && exec node "${scriptPath}"`], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (e) {
    console.error("[SYSTEM] Failed to spawn successor:", e.message);
  }
  setTimeout(() => process.exit(0), 400);
});

// ── SYSTEM HEALTH: history buffer + sampler ─────────────
const SYS_HISTORY_MAX = 60;
const sysHistory = { cpu: [], mem: [], disk: [], net_rx: [], net_tx: [], ts: [] };
let _lastCpu = null;
let _lastNet = null;
let _lastNetTs = 0;

function readCpuTimes() {
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch { return null; }
}

function readNetTotals() {
  try {
    const lines = fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2);
    let rx = 0, tx = 0;
    for (const l of lines) {
      const m = l.trim().match(/^(\S+):\s+(\d+)(?:\s+\d+){7}\s+(\d+)/);
      if (!m) continue;
      if (m[1] === "lo") continue;
      rx += parseInt(m[2]); tx += parseInt(m[3]);
    }
    return { rx, tx };
  } catch { return null; }
}

function sampleSystem() {
  try {
    const cpuNow = readCpuTimes();
    let cpuPct = 0;
    if (_lastCpu && cpuNow) {
      const idleD = cpuNow.idle - _lastCpu.idle;
      const totalD = cpuNow.total - _lastCpu.total;
      cpuPct = totalD > 0 ? Math.max(0, Math.round((1 - idleD / totalD) * 100)) : 0;
    }
    _lastCpu = cpuNow;

    const mem = fs.readFileSync("/proc/meminfo", "utf8");
    const totalMem = parseInt(mem.match(/MemTotal:\s+(\d+)/)?.[1] || 0) / 1024;
    const availMem = parseInt(mem.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) / 1024;
    const memPct = totalMem > 0 ? Math.round((totalMem - availMem) / totalMem * 100) : 0;

    const diskRaw = execSync("df -BM / | tail -1", { encoding: "utf8", timeout: 3000 });
    const dp = diskRaw.trim().split(/\s+/);
    const diskPct = parseInt(dp[1]) > 0 ? Math.round(parseInt(dp[2]) / parseInt(dp[1]) * 100) : 0;

    const netNow = readNetTotals();
    let rxRate = 0, txRate = 0;
    const now = Date.now();
    if (_lastNet && netNow && _lastNetTs > 0) {
      const dtSec = Math.max(1, (now - _lastNetTs) / 1000);
      rxRate = Math.max(0, Math.round((netNow.rx - _lastNet.rx) / dtSec));
      txRate = Math.max(0, Math.round((netNow.tx - _lastNet.tx) / dtSec));
    }
    _lastNet = netNow; _lastNetTs = now;

    sysHistory.cpu.push(cpuPct);
    sysHistory.mem.push(memPct);
    sysHistory.disk.push(diskPct);
    sysHistory.net_rx.push(rxRate);
    sysHistory.net_tx.push(txRate);
    sysHistory.ts.push(now);
    for (const k of Object.keys(sysHistory)) {
      if (sysHistory[k].length > SYS_HISTORY_MAX) sysHistory[k].splice(0, sysHistory[k].length - SYS_HISTORY_MAX);
    }
  } catch (e) { /* ignore sampler errors */ }
}

sampleSystem();
setInterval(sampleSystem, 5000);

function getTopProcesses() {
  try {
    const raw = execSync("ps -eo pid,comm,%cpu,%mem --sort=-%mem --no-headers 2>/dev/null | head -6", { encoding: "utf8", timeout: 3000 });
    return raw.trim().split("\n").map(line => {
      const parts = line.trim().split(/\s+/);
      return { pid: parts[0], name: parts[1], cpu: parseFloat(parts[2]) || 0, mem: parseFloat(parts[3]) || 0 };
    });
  } catch { return []; }
}

app.get("/system/health", (_req, res) => {
  try {
    const uptime = parseFloat(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const mem = fs.readFileSync("/proc/meminfo", "utf8");
    const totalMem = parseInt(mem.match(/MemTotal:\s+(\d+)/)?.[1] || 0) / 1024;
    const availMem = parseInt(mem.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) / 1024;
    const usedMem = totalMem - availMem;
    const swapTotal = parseInt(mem.match(/SwapTotal:\s+(\d+)/)?.[1] || 0) / 1024;
    const swapFree = parseInt(mem.match(/SwapFree:\s+(\d+)/)?.[1] || 0) / 1024;
    const swapUsed = swapTotal - swapFree;
    const diskRaw = execSync("df -BM / | tail -1", { encoding: "utf8", timeout: 3000 });
    const diskParts = diskRaw.trim().split(/\s+/);
    const diskTotal = parseInt(diskParts[1]) || 0;
    const diskUsed = parseInt(diskParts[2]) || 0;
    const loadRaw = fs.readFileSync("/proc/loadavg", "utf8").split(" ");
    const cpuCores = os.cpus().length;
    const cpuModel = os.cpus()[0]?.model || "";
    const hostname = os.hostname();
    const osType = `${os.type()} ${os.release()}`;

    let procCount = 0;
    try { procCount = parseInt(execSync("ls -d /proc/[0-9]* 2>/dev/null | wc -l", { encoding: "utf8", timeout: 2000 }).trim()) || 0; } catch {}

    res.json({
      hostname,
      os: osType,
      node_version: process.version,
      uptime_seconds: Math.floor(uptime),
      uptime_human: uptime > 86400 ? Math.floor(uptime/86400) + 'd ' + Math.floor((uptime%86400)/3600) + 'h' : Math.floor(uptime/3600) + 'h ' + Math.floor((uptime%3600)/60) + 'm',
      cpu: {
        cores: cpuCores,
        model: cpuModel,
        pct: sysHistory.cpu.length ? sysHistory.cpu[sysHistory.cpu.length - 1] : 0,
        load1: parseFloat(loadRaw[0]) || 0,
        load5: parseFloat(loadRaw[1]) || 0,
        load15: parseFloat(loadRaw[2]) || 0,
      },
      memory: { total_mb: Math.round(totalMem), used_mb: Math.round(usedMem), pct: totalMem > 0 ? Math.round(usedMem/totalMem*100) : 0 },
      swap: { total_mb: Math.round(swapTotal), used_mb: Math.round(swapUsed), pct: swapTotal > 0 ? Math.round(swapUsed/swapTotal*100) : 0 },
      disk: { total_mb: diskTotal, used_mb: diskUsed, pct: diskTotal > 0 ? Math.round(diskUsed/diskTotal*100) : 0 },
      network: {
        rx_per_sec: sysHistory.net_rx.length ? sysHistory.net_rx[sysHistory.net_rx.length - 1] : 0,
        tx_per_sec: sysHistory.net_tx.length ? sysHistory.net_tx[sysHistory.net_tx.length - 1] : 0,
      },
      processes: procCount,
      top_processes: getTopProcesses(),
      history: {
        cpu: sysHistory.cpu.slice(),
        mem: sysHistory.mem.slice(),
        disk: sysHistory.disk.slice(),
        net_rx: sysHistory.net_rx.slice(),
        net_tx: sysHistory.net_tx.slice(),
      },
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/system/crons", (_req, res) => {
  try {
    const raw = execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
    const jobs = raw.split("\n").filter(l => l.trim() && !l.startsWith("#")).map(line => {
      // Find the comment on the line above
      const allLines = raw.split("\n");
      const idx = allLines.indexOf(line);
      const comment = idx > 0 && allLines[idx - 1].startsWith("#") ? allLines[idx - 1].replace(/^#\s*/, "") : "";

      const parts = line.trim().split(/\s+/);
      const schedule = parts.slice(0, 5).join(" ");
      const command = parts.slice(5).join(" ");

      // Parse schedule to human readable
      const [min, hour, dom, mon, dow] = parts;
      let human = "";
      if (min === "*" && hour === "*") human = "Every minute";
      else if (hour === "*") human = `Every hour at :${min.padStart(2, "0")}`;
      else if (dom === "*" && mon === "*" && dow === "*") human = `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
      else human = schedule;

      // Extract script name
      const scriptMatch = command.match(/([^\s/]+)\.(sh|py|js)/) ;
      const scriptName = scriptMatch ? scriptMatch[0] : command.substring(0, 50);

      return { schedule, human, command, script: scriptName, description: comment };
    });
    res.json(jobs);
  } catch (e) {
    res.json([]);
  }
});

// ══════════════════════════════════════════════════════════
// SCHEDULED TASKS SYSTEM
// ══════════════════════════════════════════════════════════

// ── CRUD ENDPOINTS ──
app.get("/scheduled-tasks", (_req, res) => res.json(readTaskFile("scheduled-tasks.json")));

app.post("/scheduled-tasks", (req, res) => {
  const schedules = readTaskFile("scheduled-tasks.json");
  const schedule = {
    id: genId(),
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: req.body.name || "Unnamed schedule",
    agent: req.body.agent || "designer",       // designer, researcher, scriptwriter
    hour: parseInt(req.body.hour) || 9,         // UTC hour
    minute: parseInt(req.body.minute) || 0,     // UTC minute
    days: req.body.days || ["mon","tue","wed","thu","fri","sat","sun"], // which days
    payload: req.body.payload || {},            // agent-specific task payload
    last_run: null,
    last_task_id: null,
  };
  schedules.push(schedule);
  writeTaskFile("scheduled-tasks.json", schedules);
  console.log(`[SCHEDULER] Created schedule: ${schedule.name} (${schedule.agent} at ${schedule.hour}:${String(schedule.minute).padStart(2,"0")} UTC)`);
  res.status(201).json(schedule);
});

app.patch("/scheduled-tasks/:id", (req, res) => {
  const schedules = readTaskFile("scheduled-tasks.json");
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  Object.assign(schedules[idx], req.body, { updated_at: new Date().toISOString() });
  writeTaskFile("scheduled-tasks.json", schedules);
  res.json(schedules[idx]);
});

app.delete("/scheduled-tasks/:id", (req, res) => {
  writeTaskFile("scheduled-tasks.json", readTaskFile("scheduled-tasks.json").filter(s => s.id !== req.params.id));
  res.json({ ok: true });
});

app.post("/scheduled-tasks/:id/run", (req, res) => {
  const schedules = readTaskFile("scheduled-tasks.json");
  const sched = schedules.find(s => s.id === req.params.id);
  if (!sched) return res.status(404).json({ error: "Not found" });
  executeSchedule(sched).catch(e => console.error(`[SCHEDULER] Manual run failed: ${e.message}`));
  res.json({ ok: true, triggered: sched.name, agent: sched.agent });
});

// ── SCHEDULE EXECUTOR ──
// Checks every minute if any schedule should fire
const DAY_MAP = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };

async function executeSchedule(schedule) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  console.log(`[SCHEDULER] Executing: ${schedule.name} (${schedule.agent})`);

  try {
    if (schedule.agent === "designer") {
      await executeDesignerSchedule(schedule, today);
    } else if (schedule.agent === "researcher") {
      await executeResearcherSchedule(schedule, today);
    } else if (schedule.agent === "scriptwriter") {
      await executeScriptwriterSchedule(schedule, today);
    } else if (schedule.agent === "marketeer") {
      await executeMarketeerSchedule(schedule, today);
    } else if (schedule.agent === "assistant") {
      await executeAssistantSchedule(schedule, today);
    } else if (schedule.agent === "ads_optimizer") {
      await executeAdsOptimizerSchedule(schedule, today);
    } else if (schedule.agent === "community_manager") {
      await executeCommunityManagerSchedule(schedule, today);
    } else if (schedule.agent === "seo") {
      await executeSeoSchedule(schedule, today);
    } else if (schedule.agent === "opusclip") {
      await executeOpusclipSchedule(schedule, today);
    }
  } catch (e) {
    console.error(`[SCHEDULER] Failed to execute ${schedule.name}:`, e.message);
  }
}

async function executeDesignerSchedule(schedule, today) {
  const p = schedule.payload;

  // If auto_from_research is enabled, use AI to pick the most interesting content
  let description = p.description || "";
  if (p.auto_from_research) {
    const reports = readTaskFile("research-reports.json");
    const lang = p.language || "NL";
    const report = reports.find(r => (r.language || "NL") === lang);
    if (report && report.sections?.length) {
      const allContent = report.sections.map(s => `## ${s.title}\n${s.content}`).join("\n\n");
      const designType = p.design_type || "instagram_post";
      const aiPrompt = `You are a social media content strategist for a crypto/trading brand.

Below is today's research report. Pick the SINGLE most engaging, visually interesting topic for a ${designType.replace(/_/g, " ")} design.

RESEARCH REPORT:
${allContent.substring(0, 4000)}

INSTRUCTIONS:
- Pick the topic with the most visual potential and audience engagement
- Write a concise, specific image generation prompt (max 300 chars) describing the visual design
- The prompt should describe the SCENE/VISUAL, not just text — think backgrounds, elements, mood, composition
- Include the key headline/text that should appear ON the image (max 15 words)
- Language: ${lang}
- Output ONLY a JSON object, nothing else:
{"headline": "short punchy headline for ON the image", "visual_prompt": "detailed scene description for image generation", "topic": "which topic you picked and why (1 sentence)"}`;

      try {
        const aiResult = await new Promise((resolve, reject) => {
          execFile("/root/.local/bin/claude", ["-p", aiPrompt, "--output-format", "json", "--max-turns", "1"], {
            timeout: 60000, maxBuffer: 1024 * 1024,
            env: { ...process.env, HOME: "/root" },
          }, (err, stdout) => {
            if (err) return reject(err);
            try {
              const parsed = JSON.parse(stdout);
              const text = parsed.result || parsed.content || stdout;
              const jsonMatch = text.match(/\{[\s\S]*"headline"[\s\S]*"visual_prompt"[\s\S]*\}/);
              if (jsonMatch) resolve(JSON.parse(jsonMatch[0]));
              else reject(new Error("No JSON in AI response"));
            } catch (e) {
              // Try extracting JSON directly from stdout
              const jsonMatch = stdout.match(/\{[\s\S]*"headline"[\s\S]*"visual_prompt"[\s\S]*\}/);
              if (jsonMatch) resolve(JSON.parse(jsonMatch[0]));
              else reject(e);
            }
          });
        });
        description = `${aiResult.visual_prompt}. Headline text on image: "${aiResult.headline}"`;
        console.log(`[SCHEDULER] AI picked topic: ${aiResult.topic}`);
        console.log(`[SCHEDULER] Design prompt: ${description}`);
      } catch (e) {
        console.error(`[SCHEDULER] AI content picker failed: ${e.message}, falling back to first section`);
        // Fallback: use first substantial section
        const fallback = report.sections.find(s => s.content.length > 200);
        if (fallback) description = fallback.content.substring(0, 2000);
      }
    }
    if (!description) {
      console.log(`[SCHEDULER] No research content found, skipping designer task`);
      return;
    }
  }

  // Trigger the designer task via the POST endpoint (creates task + processes it)
  try {
    const resp = await fetch(`http://localhost:3004/designer/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal": "scheduler" },
      body: JSON.stringify({
        description,
        design_type: p.design_type || "instagram_post",
        brand: p.brand || (loadBrand().company_name || "DEFAULT").toUpperCase(),
        engine: p.engine || "nanobanana",
        logo_position: p.logo_position || "SouthEast",
        template: p.template || "default",
      }),
    });
    const result = await resp.json().catch(() => ({}));
    const taskId = Array.isArray(result) ? result[0]?.id : result?.id;

    // Update schedule last_run
    const schedules = readTaskFile("scheduled-tasks.json");
    const idx = schedules.findIndex(s => s.id === schedule.id);
    if (idx >= 0) {
      schedules[idx].last_run = new Date().toISOString();
      schedules[idx].last_task_id = taskId || null;
      writeTaskFile("scheduled-tasks.json", schedules);
    }
    console.log(`[SCHEDULER] Designer task created: ${taskId}`);
  } catch (e) {
    console.error(`[SCHEDULER] Designer task failed:`, e.message);
  }
}

async function executeSeoSchedule(schedule, today) {
  const p = schedule.payload || {};
  if (!p.url) {
    console.log(`[SCHEDULER] SEO skipped: no url configured`);
    return;
  }
  const tasks = readTaskFile("seo-tasks.json");
  const taskId = genId();
  tasks.unshift({
    id: taskId,
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    url: p.url,
    max_pages: Math.min(Math.max(parseInt(p.max_pages, 10) || 25, 1), 100),
    language: p.language || process.env.LANGUAGE || "EN",
    error: null,
  });
  if (tasks.length > 50) tasks.length = 50;
  writeTaskFile("seo-tasks.json", tasks);

  const schedules = readTaskFile("scheduled-tasks.json");
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx].last_run = new Date().toISOString();
    schedules[idx].last_task_id = taskId;
    writeTaskFile("scheduled-tasks.json", schedules);
  }
  console.log(`[SCHEDULER] SEO task created: ${taskId} (${p.url})`);
}

// ── OpusClip: watch a YouTube channel, clip the newest unprocessed video ──
// Returns the YouTube channel configured in Settings (Social connections) as
// either a channel ID (UC...) or an @handle, so the clipper can run without an
// explicit channel_id in the schedule payload.
function getConnectedYoutubeChannel() {
  try {
    const conns = readTaskFile("social-connections.json");
    const yt = (Array.isArray(conns) ? conns : []).find(c => c.platform === "youtube");
    if (!yt) return "";
    return String(yt.channel_id || yt.handle || "").trim();
  } catch { return ""; }
}

// The browser frontend calls the YouTube API with a Referer matching the app's
// public origin, which is what HTTP-referrer-restricted API keys allow. Server
// side fetches send no referer and get blocked, so mirror that referer here.
// Derived from configured origins (never hardcoded) so it stays white-label.
function getApiReferer() {
  const explicit = (process.env.PUBLIC_ORIGIN || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "") + "/";
  for (const v of [process.env.META_REDIRECT_URI, process.env.CANVA_REDIRECT_URI]) {
    try { if (v) return new URL(v).origin + "/"; } catch {}
  }
  return "";
}

async function fetchLatestYoutubeUploads(channelRef, max = 5) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY not configured");
  const ref = String(channelRef || "").trim();
  // Accept either a channel ID (UC...) or a @handle; the YouTube API needs
  // different lookup params for each.
  const isChannelId = /^UC[\w-]{20,}$/.test(ref);
  const lookupParam = isChannelId
    ? `id=${encodeURIComponent(ref)}`
    : `forHandle=${encodeURIComponent(ref.replace(/^@/, ""))}`;
  const referer = getApiReferer();
  const ytHeaders = referer ? { Referer: referer } : {};
  const chRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&${lookupParam}&key=${apiKey}`, { headers: ytHeaders });
  const chData = await chRes.json();
  if (!chRes.ok) throw new Error(`YouTube channel lookup failed: ${chData?.error?.message || chRes.status}`);
  const uploadsId = chData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error(`No uploads playlist for channel ${ref}`);
  const plRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(uploadsId)}&maxResults=${max}&key=${apiKey}`, { headers: ytHeaders });
  const plData = await plRes.json();
  if (!plRes.ok) throw new Error(`YouTube uploads list failed: ${plData?.error?.message || plRes.status}`);
  return (plData.items || []).map(it => ({
    video_id: it.snippet?.resourceId?.videoId,
    title: it.snippet?.title,
    published_at: it.snippet?.publishedAt,
  })).filter(v => v.video_id);
}

async function executeOpusclipSchedule(schedule, today) {
  const p = schedule.payload || {};
  // Fall back to the YouTube channel connected in Settings when the schedule
  // has no explicit channel_id, so the clipper just picks up the configured channel.
  let channelId = (p.channel_id || "").trim();
  if (!channelId) {
    channelId = getConnectedYoutubeChannel();
    if (channelId) {
      console.log(`[SCHEDULER] OpusClip: no channel_id in schedule, using connected channel ${channelId}`);
    }
  }
  if (!channelId) {
    console.log(`[SCHEDULER] OpusClip skipped: no channel_id configured and no YouTube channel connected in Settings`);
    return;
  }
  if (!process.env.OPUSCLIP_API_KEY) {
    console.log(`[SCHEDULER] OpusClip skipped: OPUSCLIP_API_KEY not configured`);
    return;
  }
  if (!process.env.YOUTUBE_API_KEY) {
    console.log(`[SCHEDULER] OpusClip skipped: YOUTUBE_API_KEY not configured`);
    return;
  }

  let uploads;
  try {
    uploads = await fetchLatestYoutubeUploads(channelId, 5);
  } catch (e) {
    console.error(`[SCHEDULER] OpusClip YouTube fetch failed: ${e.message}`);
    return;
  }
  if (!uploads.length) {
    console.log(`[SCHEDULER] OpusClip: channel ${channelId} has no recent uploads`);
    return;
  }

  const tasks = readTaskFile("opusclip-tasks.json");
  const processedIds = new Set(tasks
    .map(t => {
      const m = String(t.video_url || "").match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{11})/);
      return m ? m[1] : null;
    })
    .filter(Boolean));

  const next = uploads.find(u => !processedIds.has(u.video_id));
  if (!next) {
    console.log(`[SCHEDULER] OpusClip: no new videos on channel ${channelId} (last ${uploads.length} all clipped)`);
    const schedules = readTaskFile("scheduled-tasks.json");
    const idx = schedules.findIndex(s => s.id === schedule.id);
    if (idx >= 0) {
      schedules[idx].last_run = new Date().toISOString();
      schedules[idx].last_skip_reason = "no new uploads";
      writeTaskFile("scheduled-tasks.json", schedules);
    }
    return;
  }

  const minD = parseInt(p.min_duration, 10);
  const maxD = parseInt(p.max_duration, 10);
  const task = {
    id: genId(),
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    video_url: `https://www.youtube.com/watch?v=${next.video_id}`,
    min_duration: Number.isFinite(minD) && minD > 0 ? minD : 30,
    max_duration: Number.isFinite(maxD) && maxD > 0 ? maxD : 90,
    source_lang: p.source_lang || "auto",
    topic_keywords: Array.isArray(p.topic_keywords) ? p.topic_keywords : [],
    description: (next.title || "").slice(0, 200),
    source: { type: "youtube_channel", channel_id: channelId, video_id: next.video_id, schedule_id: schedule.id },
    project_id: null, stage: null, clips: [], error: null,
  };
  tasks.unshift(task);
  if (tasks.length > 50) tasks.length = 50;
  writeTaskFile("opusclip-tasks.json", tasks);

  const schedules = readTaskFile("scheduled-tasks.json");
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx].last_run = new Date().toISOString();
    schedules[idx].last_task_id = task.id;
    schedules[idx].last_video_id = next.video_id;
    delete schedules[idx].last_skip_reason;
    writeTaskFile("scheduled-tasks.json", schedules);
  }
  console.log(`[SCHEDULER] OpusClip task created: ${task.id} (channel ${channelId} → ${next.video_id})`);
}

async function executeResearcherSchedule(schedule, today) {
  const p = schedule.payload;
  const lang = p.language || "NL";
  const isNL = lang === "NL";
  const tasks = readTaskFile("research-tasks.json");
  const taskId = genId();
  tasks.unshift({
    id: taskId, status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    type: p.type || "daily_full",
    query: p.query || (isNL
      ? `Daily crypto & trading research — ${today}. Onderzoek de belangrijkste crypto ontwikkelingen, marktbewegingen, trending topics op X/Reddit/TikTok, en genereer concrete content suggesties voor Instagram en Twitter.`
      : `Daily crypto & trading research — ${today}. Research the latest crypto developments, market movements, trending topics on X/Reddit/TikTok, and generate concrete content suggestions for Instagram and Twitter.`),
    platforms: p.platforms || ["x", "reddit", "tiktok"],
    niche: p.niche || "crypto trading",
    language: lang,
    error: null,
  });
  writeTaskFile("research-tasks.json", tasks);

  const schedules = readTaskFile("scheduled-tasks.json");
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx].last_run = new Date().toISOString();
    schedules[idx].last_task_id = taskId;
    writeTaskFile("scheduled-tasks.json", schedules);
  }
  console.log(`[SCHEDULER] Research task created: ${taskId} (${lang})`);
}

async function executeScriptwriterSchedule(schedule, today) {
  const p = schedule.payload;
  const tasks = readTaskFile("scriptwriter-tasks.json");
  const taskId = genId();
  tasks.unshift({
    id: taskId, status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    type: p.type || "script",
    prompt: p.prompt || "",
    language: p.language || "NL",
    error: null,
  });
  writeTaskFile("scriptwriter-tasks.json", tasks);

  const schedules = readTaskFile("scheduled-tasks.json");
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx].last_run = new Date().toISOString();
    schedules[idx].last_task_id = taskId;
    writeTaskFile("scheduled-tasks.json", schedules);
  }
  console.log(`[SCHEDULER] Scriptwriter task created: ${taskId}`);
}

async function executeMarketeerSchedule(schedule, today) {
  const p = schedule.payload;
  const query = p.query || "Geef marketing suggesties voor deze week";
  console.log(`[SCHEDULER] Marketeer query: ${query}`);

  try {
    const res = await fetch("http://localhost:3004/marketeer/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal": "telegram", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ message: query, sessionId: "scheduler_marketeer" }),
    });
    const data = await res.json();
    const reply = data.reply || "Geen antwoord.";

    if (p.notify !== "false") {
      sendTelegram(`📣 ${schedule.name}`, reply, "info");
    }
    console.log(`[SCHEDULER] Marketeer completed: ${schedule.name}`);
  } catch (e) {
    console.error(`[SCHEDULER] Marketeer failed:`, e.message);
    sendTelegram(`📣 ${schedule.name} — FOUT`, e.message, "danger");
  }

  const schedules = readTaskFile("scheduled-tasks.json");
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx].last_run = new Date().toISOString();
    writeTaskFile("scheduled-tasks.json", schedules);
  }
}

async function executeAssistantSchedule(schedule, today) {
  const p = schedule.payload;
  const query = p.query || "Geef een overzicht van mijn agenda vandaag";
  console.log(`[SCHEDULER] Assistant query: ${query}`);

  try {
    const res = await fetch("http://localhost:3004/calendar/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal": "telegram", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ message: query, sessionId: "scheduler_assistant" }),
    });
    const data = await res.json();
    const reply = data.reply || "Geen antwoord.";

    // Send result via Telegram if enabled
    if (p.notify !== "false") {
      sendTelegram(`📅 ${schedule.name}`, reply, "info");
    }

    console.log(`[SCHEDULER] Assistant completed: ${schedule.name}`);
  } catch (e) {
    console.error(`[SCHEDULER] Assistant failed:`, e.message);
    sendTelegram(`📅 ${schedule.name} — FOUT`, e.message, "danger");
  }

  const schedules = readTaskFile("scheduled-tasks.json");
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx].last_run = new Date().toISOString();
    writeTaskFile("scheduled-tasks.json", schedules);
  }
}

// Extract the first balanced top-level JSON array from a text blob.
// Robust against trailing prose, multiple arrays, or fenced code blocks.
function extractFirstJsonArray(text) {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── COMMUNITY MANAGER (weekly draft batch generator) ──
async function executeCommunityManagerSchedule(schedule, today) {
  const p = schedule.payload || {};
  const channelId = p.channel_id;
  const rawCount = parseInt(p.post_count);
  const autoCount = !Number.isFinite(rawCount) || rawCount <= 0;
  const postCount = autoCount ? null : Math.min(rawCount, 40);
  const language = (p.language || "NL").toUpperCase();

  // Create task-run record for the feed
  const runTaskId = genId();
  const runTasks = readTaskFile("community-manager-tasks.json");
  runTasks.unshift({
    id: runTaskId,
    status: "processing",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    schedule_id: schedule.id,
    schedule_name: schedule.name,
    channel_id: channelId || null,
    channel_name: null,
    archetype_set: null,
    language,
    post_count: autoCount ? "auto" : postCount,
    drafts_added: 0,
    description: `Weekly drafts for channel ${channelId || "?"} (${language})`,
    error: null,
  });
  writeTaskFile("community-manager-tasks.json", runTasks);

  const markRun = (patch) => {
    const all = readTaskFile("community-manager-tasks.json");
    const i = all.findIndex(t => t.id === runTaskId);
    if (i >= 0) {
      all[i] = { ...all[i], ...patch, updated_at: new Date().toISOString() };
      writeTaskFile("community-manager-tasks.json", all);
    }
  };

  const markScheduleRun = ({ last_task_id = runTaskId, last_error = null } = {}) => {
    const schedules = readTaskFile("scheduled-tasks.json");
    const idx = schedules.findIndex(s => s.id === schedule.id);
    if (idx >= 0) {
      schedules[idx].last_run = new Date().toISOString();
      schedules[idx].last_task_id = last_task_id;
      schedules[idx].last_error = last_error;
      writeTaskFile("scheduled-tasks.json", schedules);
    }
  };

  if (!channelId) {
    console.error(`[SCHEDULER] Community Manager: no channel_id in payload for "${schedule.name}"`);
    sendTelegram(`💬 ${schedule.name} — FOUT`, "No channel_id configured in payload.", "danger");
    markRun({ status: "failed", error: "No channel_id in payload" });
    markScheduleRun({ last_error: "No channel_id in payload" });
    return;
  }

  const channel = getChannel(channelId);
  if (!channel || !channel.enabled) {
    console.error(`[SCHEDULER] Community Manager: channel "${channelId}" not found or disabled`);
    sendTelegram(`💬 ${schedule.name} — FOUT`, `Channel ${channelId} not found or disabled.`, "danger");
    markRun({ status: "failed", error: `Channel ${channelId} not found or disabled` });
    markScheduleRun({ last_error: `Channel ${channelId} not found or disabled` });
    return;
  }

  markRun({ channel_name: channel.name, archetype_set: channel.archetype_set || null, description: `Weekly drafts for ${channel.name} (${language})` });

  if (!channel.archetype_set) {
    console.error(`[SCHEDULER] Community Manager: channel "${channelId}" has no archetype_set`);
    sendTelegram(`💬 ${schedule.name} — FOUT`, `Channel ${channel.name} has no archetype set assigned.`, "danger");
    markRun({ status: "failed", error: "No archetype set assigned" });
    markScheduleRun({ last_error: "No archetype set assigned" });
    return;
  }

  let archetypeMd;
  try {
    archetypeMd = readArchetypeSet(channel.archetype_set);
  } catch (e) {
    console.error(`[SCHEDULER] Community Manager: archetype set "${channel.archetype_set}" unreadable: ${e.message}`);
    sendTelegram(`💬 ${schedule.name} — FOUT`, `Archetype set ${channel.archetype_set} not found.`, "danger");
    markRun({ status: "failed", error: `Archetype set unreadable: ${e.message}` });
    markScheduleRun({ last_error: `Archetype set unreadable: ${e.message}` });
    return;
  }

  // Research context (fail-soft)
  let researchContext = "";
  try {
    const reports = readTaskFile("research-reports.json");
    const report = reports.find(r => (r.language || "NL") === language);
    if (report && Array.isArray(report.sections) && report.sections.length) {
      researchContext = report.sections.map(s => `## ${s.title}\n${s.content}`).join("\n\n").substring(0, 6000);
    }
  } catch {}

  // Build prompt
  const tz = process.env.TIMEZONE || "Europe/Amsterdam";
  const now = new Date();
  const startIso = now.toISOString();
  const endIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const platformRules = channel.platform === "twitter"
    ? `\n- PLATFORM = X (Twitter): every post MUST be 280 characters or less (URLs count as 23 chars). Plain text only, no markdown. Avoid links unless the archetype explicitly requires one. Ignore any footer-link instructions in the archetype doc.`
    : "";
  const aiPrompt = `You are a community content planner generating draft social posts for a ${channel.platform === "twitter" ? "X (Twitter) account" : `${channel.platform} channel`}.

CHANNEL: ${channel.name} (platform: ${channel.platform})
ARCHETYPE SET: ${channel.archetype_set}
LANGUAGE: ${language}
TIMEZONE FOR SCHEDULING: ${tz}
WINDOW: ${startIso} to ${endIso} (next 7 days)
POST COUNT: ${autoCount ? "AUTO (derive from the week schedule in the archetype doc)" : postCount}

ARCHETYPES & WEEK SCHEDULE (source of truth):
---
${archetypeMd}
---

${researchContext ? `LATEST RESEARCH CONTEXT (for hooks and angles):\n---\n${researchContext}\n---\n\n` : ""}RULES:${platformRules}
- ${autoCount
    ? "Generate exactly as many drafts as the week schedule in the archetype doc prescribes. Count every non-manual slot in the schedule table; one post per slot. Do not skip, add, or duplicate slots."
    : `Generate exactly ${postCount} draft posts, spread across the next 7 days using the week schedule in the archetype doc. If the schedule has more slots than ${postCount}, pick the highest-cadence archetypes first.`}
- SKIP any archetype explicitly marked as manual-only (look for markers like "NOT via", "handmatig", "⚠", "manually by"). Those are NOT generated here and do NOT count toward the total.
- Follow every STYLE RULE in the archetype doc (em-dash ban, no hollow superlatives, concrete numbers, short sentences, language setting)
- Each post must follow its archetype's structure and length guidelines
- scheduled_at: ISO 8601 with timezone offset matching ${tz}, aligned with the archetype's cadence slot (e.g. Monday 08:30 local for archetype A)
- trigger_word: only if the archetype specifies one (DELTA, CASCADE, PREMIUM, etc.), otherwise null
- text: full post body including footer links as shown in the examples

OUTPUT: ONLY a valid JSON array, no prose, no markdown fences. Schema per item:
{
  "archetype": "A — Market Intelligence Drop",
  "scheduled_at": "2026-04-21T08:30:00+02:00",
  "trigger_word": null,
  "text": "..."
}`;

  console.log(`[SCHEDULER] Community Manager: generating ${autoCount ? "auto-count" : postCount} drafts for channel "${channel.name}" (set: ${channel.archetype_set})`);

  let drafts;
  try {
    const raw = await new Promise((resolve, reject) => {
      const child = spawn("/root/.local/bin/claude", ["-p", aiPrompt, "--output-format", "json", "--max-turns", "5", "--disallowed-tools", "Bash Read Edit Write Grep Glob WebSearch WebFetch Task NotebookEdit"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: "/root" },
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claude CLI timeout after 600s")); }, 600000);
      child.stdout.on("data", d => { stdout += d.toString(); });
      child.stderr.on("data", d => { stderr += d.toString(); });
      child.on("error", err => { clearTimeout(timer); reject(err); });
      child.on("close", code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`Claude CLI exited ${code} | stderr: ${stderr.slice(0, 400) || "(empty)"} | stdout: ${stdout.slice(0, 400) || "(empty)"}`));
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed.result || parsed.content || stdout);
        } catch {
          resolve(stdout);
        }
      });
    });

    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    try { fs.writeFileSync(path.join(__dirname, "data", "community-last-raw.txt"), text); } catch {}
    const arrStr = extractFirstJsonArray(text);
    if (!arrStr) throw new Error(`No JSON array in Claude output. Text head: ${text.slice(0, 300)}`);
    drafts = JSON.parse(arrStr);
    if (!Array.isArray(drafts) || !drafts.length) throw new Error("Empty or invalid draft array");
  } catch (e) {
    console.error(`[SCHEDULER] Community Manager: generation failed: ${e.message}`);
    sendTelegram(`💬 ${schedule.name} — FOUT`, `Generation failed: ${e.message.slice(0, 300)}`, "danger");
    markRun({ status: "failed", error: e.message.slice(0, 500) });
    markScheduleRun({ last_error: e.message.slice(0, 500) });
    return;
  }

  // Persist drafts
  const tasks = readTaskFile(COMMUNITY_TASKS_FILE);
  let added = 0;
  for (const d of drafts) {
    if (!d || !d.text || !d.scheduled_at) continue;
    tasks.push({
      id: genId(),
      channel_id: channel.id,
      status: "draft",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      scheduled_at: d.scheduled_at,
      scheduled_local: null,
      archetype: d.archetype || null,
      trigger_word: d.trigger_word || null,
      media_path: null,
      text: String(d.text),
      published_at: null,
      message_id: null,
      attempts: 0,
      error: null,
      source: `scheduler:${schedule.id}`,
    });
    added++;
  }
  writeTaskFile(COMMUNITY_TASKS_FILE, tasks);
  console.log(`[SCHEDULER] Community Manager: added ${added} drafts to community-tasks.json`);

  if (p.notify !== "false" && p.notify !== false) {
    sendTelegram(`💬 ${schedule.name}`, `${added} drafts klaar voor <b>${channel.name}</b> (set: ${channel.archetype_set}).\nReview ze op de Community Manager pagina.`, "info");
  }

  markRun({ status: "completed", drafts_added: added, result: `${added} drafts generated for ${channel.name}` });
  markScheduleRun();
}

// ── ADS RULES ENGINE (checks every 5 minutes) ──
async function evaluateAdsRules() {
  let rules = [];
  try { rules = readTaskFile("ads-rules.json"); } catch { return; }
  const enabled = rules.filter(r => r.enabled);
  if (!enabled.length) return;

  for (const rule of enabled) {
    try {
      const conn = readSocial().find(c => c.platform === "meta_ads" && (c.account_id === rule.account_id || c.ad_account_id === rule.account_id));
      if (!conn) continue;
      const fields = "campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,actions,action_values,purchase_roas,website_purchase_roas";
      const url = `https://graph.facebook.com/v21.0/${conn.ad_account_id}/insights?fields=${fields}&date_preset=${rule.check_period}&level=campaign&limit=200&access_token=${conn.user_access_token}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.error || !d.data) continue;

      for (const row of d.data) {
        let metricVal = 0;
        if (rule.metric === "roas") {
          if (Array.isArray(row.purchase_roas) && row.purchase_roas[0]) metricVal = Number(row.purchase_roas[0].value) || 0;
          else if (Array.isArray(row.website_purchase_roas) && row.website_purchase_roas[0]) metricVal = Number(row.website_purchase_roas[0].value) || 0;
        } else if (rule.metric === "spend") {
          metricVal = Number(row.spend) || 0;
        } else if (rule.metric === "ctr") {
          metricVal = Number(row.ctr) || 0;
        } else if (rule.metric === "cpc") {
          metricVal = Number(row.cpc) || 0;
        } else if (rule.metric === "cpm") {
          metricVal = Number(row.cpm) || 0;
        }

        let triggered = false;
        if (rule.operator === "<" && metricVal < rule.threshold && Number(row.spend) > 0) triggered = true;
        if (rule.operator === ">" && metricVal > rule.threshold) triggered = true;
        if (rule.operator === "<=" && metricVal <= rule.threshold && Number(row.spend) > 0) triggered = true;
        if (rule.operator === ">=" && metricVal >= rule.threshold) triggered = true;

        if (!triggered) continue;

        const campName = row.campaign_name || row.campaign_id;
        let actionDesc = "";

        if (rule.action === "pause") {
          await fetch(`https://graph.facebook.com/v21.0/${row.campaign_id}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "PAUSED", access_token: conn.user_access_token }),
          });
          actionDesc = `Campaign *${campName}* paused`;
        } else if (rule.action === "activate") {
          await fetch(`https://graph.facebook.com/v21.0/${row.campaign_id}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "ACTIVE", access_token: conn.user_access_token }),
          });
          actionDesc = `Campaign *${campName}* activated`;
        } else if (rule.action === "adjust_budget" && rule.action_value) {
          const pct = Number(rule.action_value);
          const campRes = await fetch(`https://graph.facebook.com/v21.0/${row.campaign_id}?fields=daily_budget,lifetime_budget&access_token=${conn.user_access_token}`);
          const campData = await campRes.json();
          const budgetField = campData.daily_budget ? "daily_budget" : "lifetime_budget";
          const current = Number(campData[budgetField]) || 0;
          if (current > 0) {
            const newBudget = Math.round(current * (1 + pct / 100));
            await fetch(`https://graph.facebook.com/v21.0/${row.campaign_id}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ [budgetField]: newBudget, access_token: conn.user_access_token }),
            });
            actionDesc = `Campaign *${campName}* budget ${pct > 0 ? "+" : ""}${pct}% (${(current/100).toFixed(2)} → ${(newBudget/100).toFixed(2)})`;
          }
        } else if (rule.action === "alert") {
          actionDesc = `Alert: *${campName}* — ${rule.metric} = ${metricVal.toFixed(2)} (threshold: ${rule.operator} ${rule.threshold})`;
        }

        if (actionDesc) {
          // Create notification
          const notifs = readTaskFile("notifications.json");
          notifs.unshift({
            id: genId(), type: "system", agent: "ads_rules",
            title: `Ad Rule: ${rule.name}`, message: actionDesc,
            severity: rule.action === "alert" ? "info" : "success", read: false,
            created_at: new Date().toISOString(),
          });
          if (notifs.length > 100) notifs.length = 100;
          writeTaskFile("notifications.json", notifs);

          // Send Telegram notification
          if (TG_TOKEN && TG_CHAT) {
            sendTelegram(`📊 <b>Ad Rule: ${rule.name}</b>\n${actionDesc.replace(/\*/g, "")}`);
          }

          // Update rule trigger count
          rule.last_triggered = new Date().toISOString();
          rule.trigger_count = (rule.trigger_count || 0) + 1;
        }
      }
    } catch (e) {
      console.error(`[ADS-RULES] Error evaluating rule ${rule.name}:`, e.message);
    }
  }
  writeTaskFile("ads-rules.json", rules);
}

setInterval(() => evaluateAdsRules(), 5 * 60_000);

// ── ADS OPTIMIZER (AI-driven scheduled optimization) ──
async function executeAdsOptimizerSchedule(schedule, today) {
  const p = schedule.payload || {};
  const period = p.period || "last_7d";
  console.log(`[SCHEDULER] Ads Optimizer: ${schedule.name} (period: ${period})`);

  try {
    // Gather all campaign data
    const accounts = readSocial().filter(c => c.platform === "meta_ads");
    if (!accounts.length) { console.log("[ADS-OPT] No ad accounts connected"); return; }

    let allData = [];
    for (const acc of accounts) {
      try {
        const campUrl = `https://graph.facebook.com/v21.0/${acc.ad_account_id}/campaigns?fields=id,name,status,effective_status,daily_budget,lifetime_budget,objective&limit=100&access_token=${acc.user_access_token}`;
        const insUrl = `https://graph.facebook.com/v21.0/${acc.ad_account_id}/insights?fields=campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,actions,action_values,purchase_roas&date_preset=${period}&level=campaign&limit=200&access_token=${acc.user_access_token}`;
        const [campRes, insRes] = await Promise.all([fetch(campUrl), fetch(insUrl)]);
        const campaigns = (await campRes.json()).data || [];
        const insights = (await insRes.json()).data || [];
        const insMap = {};
        insights.forEach(i => insMap[i.campaign_id] = i);

        for (const c of campaigns) {
          const ins = insMap[c.id] || {};
          const spend = Number(ins.spend) || 0;
          let roas = 0;
          if (Array.isArray(ins.purchase_roas) && ins.purchase_roas[0]) roas = Number(ins.purchase_roas[0].value) || 0;
          let purchases = 0;
          if (Array.isArray(ins.actions)) {
            const pa = ins.actions.find(a => a.action_type === "purchase" || a.action_type === "omni_purchase");
            if (pa) purchases = Number(pa.value) || 0;
          }
          allData.push({
            account: acc.name, account_id: acc.account_id, currency: acc.currency,
            campaign_id: c.id, campaign_name: c.name, status: c.effective_status || c.status,
            objective: c.objective, daily_budget_cents: Number(c.daily_budget) || 0,
            lifetime_budget_cents: Number(c.lifetime_budget) || 0,
            spend, impressions: Number(ins.impressions) || 0, clicks: Number(ins.clicks) || 0,
            ctr: Number(ins.ctr) || 0, cpc: Number(ins.cpc) || 0, roas, purchases,
          });
        }
      } catch (e) { console.error(`[ADS-OPT] Error fetching ${acc.name}:`, e.message); }
    }

    if (!allData.length) { console.log("[ADS-OPT] No campaign data"); return; }

    // Send to Claude for analysis + optimization decisions
    const brand = loadBrand();
    const systemPrompt = `Je bent de Ads Optimizer van ${brand.company_name}. Je analyseert Meta Ads campaign performance en neemt optimalisatie-beslissingen.

REGELS:
- Pauzeer campaigns met ROAS < 0.8 en spend > €5 (ze verliezen geld)
- Scale campaigns met ROAS > 2.5 door budget +20% te verhogen (ze zijn winstgevend)
- Stuur een alert voor campaigns met hoge spend maar geen conversies
- Verander NOOIT budgets met meer dan 30% per keer
- Raak PAUSED campaigns niet aan tenzij ze eerder goede ROAS hadden
- Wees conservatief — liever een alert dan een verkeerde actie

BESCHIKBARE ACTIES (gebruik het tool):
- pause: pauzeer een campaign
- activate: activeer een campaign
- set_daily_budget: stel daily budget in (in euro's)
- alert: stuur alleen een melding, geen actie

Analyseer de data en voer acties uit. Geef een kort rapport.`;

    const userMsg = `Campaign performance data (${period}):\n\n${JSON.stringify(allData, null, 2)}\n\nAnalyseer elke campaign en neem de juiste acties. Geef een kort rapport van wat je hebt gedaan en waarom.`;

    const tools = [{
      type: "custom",
      name: "ads_optimize_action",
      description: "Voer een optimalisatie-actie uit op een campaign",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["pause", "activate", "set_daily_budget", "alert"], description: "De actie" },
          campaign_id: { type: "string", description: "Campaign ID" },
          account_id: { type: "string", description: "Account ID" },
          daily_budget_euros: { type: "number", description: "Nieuw daily budget in euro's (alleen voor set_daily_budget)" },
          reason: { type: "string", description: "Reden voor de actie (wordt opgenomen in notificatie)" },
        },
        required: ["action", "campaign_id", "account_id", "reason"],
      },
    }];

    let response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMsg }],
      tools,
    });

    const actions = [];
    let report = "";
    let loopCount = 0;

    while (response.stop_reason === "tool_use" && loopCount < 15) {
      loopCount++;
      const toolResults = [];

      for (const block of response.content) {
        if (block.type === "text") report += block.text;
        if (block.type !== "tool_use" || block.name !== "ads_optimize_action") continue;

        const input = block.input;
        const conn = accounts.find(a => a.account_id === input.account_id);
        let result = { success: false, error: "Unknown action" };

        try {
          if (input.action === "pause" && conn) {
            await fetch(`https://graph.facebook.com/v21.0/${input.campaign_id}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "PAUSED", access_token: conn.user_access_token }),
            });
            result = { success: true, action: "paused" };
          } else if (input.action === "activate" && conn) {
            await fetch(`https://graph.facebook.com/v21.0/${input.campaign_id}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "ACTIVE", access_token: conn.user_access_token }),
            });
            result = { success: true, action: "activated" };
          } else if (input.action === "set_daily_budget" && conn && input.daily_budget_euros) {
            const cents = Math.round(input.daily_budget_euros * 100);
            await fetch(`https://graph.facebook.com/v21.0/${input.campaign_id}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ daily_budget: cents, access_token: conn.user_access_token }),
            });
            result = { success: true, action: "budget_set", budget: input.daily_budget_euros };
          } else if (input.action === "alert") {
            result = { success: true, action: "alert" };
          }
        } catch (e) { result = { success: false, error: e.message }; }

        actions.push({ ...input, result });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      }

      response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: "user", content: userMsg },
          { role: "assistant", content: response.content },
          { role: "user", content: toolResults },
        ],
        tools,
      });
    }

    // Extract final report text
    for (const block of response.content) {
      if (block.type === "text") report += block.text;
    }

    const actionCount = actions.filter(a => a.result?.success && a.action !== "alert").length;
    const alertCount = actions.filter(a => a.action === "alert").length;

    // Create notification
    const notifs = readTaskFile("notifications.json");
    notifs.unshift({
      id: genId(), type: "system", agent: "ads_optimizer",
      title: `Ads Optimizer: ${actionCount} actions, ${alertCount} alerts`,
      message: report.substring(0, 500),
      severity: actionCount > 0 ? "success" : "info", read: false,
      created_at: new Date().toISOString(),
    });
    if (notifs.length > 100) notifs.length = 100;
    writeTaskFile("notifications.json", notifs);

    // Send Telegram report
    if (TG_TOKEN && TG_CHAT) {
      const tgReport = `📊 <b>Ads Optimizer — ${schedule.name}</b>\n\n${report.substring(0, 3500).replace(/[*_]/g, "")}`;
      sendTelegram(tgReport);
    }

    console.log(`[ADS-OPT] Done: ${actionCount} actions, ${alertCount} alerts`);
  } catch (e) {
    console.error(`[ADS-OPT] Failed:`, e.message);
    if (TG_TOKEN && TG_CHAT) sendTelegram(`⚠️ <b>Ads Optimizer fout</b>\n${e.message}`);
  }

  const schedules = readTaskFile("scheduled-tasks.json");
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx].last_run = new Date().toISOString();
    writeTaskFile("scheduled-tasks.json", schedules);
  }
}

// ── SCHEDULER LOOP (checks every 60s) ──
setInterval(() => {
  const now = new Date();
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();
  const dayKey = DAY_MAP[now.getUTCDay()];
  const today = now.toISOString().slice(0, 10);

  const schedules = readTaskFile("scheduled-tasks.json");
  for (const sched of schedules) {
    if (!sched.enabled) continue;
    if (sched.hour !== hour || sched.minute !== min) continue;
    if (sched.days && !sched.days.includes(dayKey)) continue;
    if (sched.last_run && sched.last_run.startsWith(today)) continue; // already ran today
    executeSchedule(sched);
  }
}, 60_000);

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`CTRL API running on port ${PORT}`);
  console.log(`[WORKER] Task workers active — polling every 15s, status check every 30s`);
  const schedules = readTaskFile("scheduled-tasks.json");
  const active = schedules.filter(s => s.enabled).length;
  console.log(`[SCHEDULER] ${active} active scheduled task(s) loaded`);
});

// Forward WebSocket upgrade requests for the Remotion Studio iframe (hot reload).
// Requires a valid cc_session cookie — Studio is bound to localhost so only
// proxied traffic can reach it.
httpServer.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  const ref = req.headers.referer || "";
  const isStudio = url.startsWith("/remotion-studio") || ref.includes("/remotion-studio");
  if (!isStudio) return;
  const cookieHeader = req.headers.cookie || "";
  const m = cookieHeader.match(/(?:^|;\s*)cc_session=([^;]+)/);
  if (!m || !isValidSession(decodeURIComponent(m[1]))) {
    socket.destroy();
    return;
  }
  remotionStudioProxy.upgrade(req, socket, head);
});
