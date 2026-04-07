require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const Stripe = require("stripe");

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const { renderSlide, renderCarousel } = require("./slide-renderer");
const { designSlides } = require("./slide-designer-ai");
const { execFile } = require("child_process");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use("/generated-images", express.static(path.join(__dirname, "data", "generated-images")));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cookie");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
});

// ── STATIC FILES ─────────────────────────────
app.use(express.static(__dirname));

// ── AUTH ──────────────────────────────────────
const CC_PASSWORD = process.env.CC_PASSWORD;
const SESSION_SECRET = process.env.CC_SESSION_SECRET;
if (!CC_PASSWORD || !SESSION_SECRET) {
  console.error("FATAL: CC_PASSWORD and CC_SESSION_SECRET must be set in .env");
  process.exit(1);
}
const activeSessions = new Set();

function createSessionToken() {
  const token = crypto.randomBytes(32).toString("hex");
  activeSessions.add(token);
  return token;
}

function isValidSession(token) {
  return token && activeSessions.has(token);
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
  const token = req.cookies?.cc_session;
  if (token) activeSessions.delete(token);
  res.clearCookie("cc_session");
  res.json({ ok: true });
});

app.get("/auth/check", (req, res) => {
  res.json({ authenticated: isValidSession(req.cookies?.cc_session) });
});

// Protect all other API routes
app.use((req, res, next) => {
  // Allow auth endpoints and setup status (needed before full config)
  if (req.path.startsWith("/auth/") || req.path === "/api/setup-status") return next();
  // Allow internal requests (from scheduler)
  if (req.headers["x-internal"] === "scheduler" || req.headers["x-internal"] === "telegram") return next();
  // Check session
  if (isValidSession(req.cookies?.cc_session)) return next();
  res.status(401).json({ error: "Unauthorized" });
});

// ── SETUP WIZARD & SETTINGS API ─────────────────────────
const ENV_PATH = path.join(__dirname, "..", ".env");

function readEnvFile() {
  try {
    const env = {};
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
    return env;
  } catch { return {}; }
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
}

function maskKey(val) {
  if (!val) return "";
  if (val.length <= 10) return "***";
  return val.slice(0, 6) + "..." + val.slice(-4);
}

app.get("/api/setup-status", (_req, res) => {
  const env = readEnvFile();
  const configured = !!(env.COMPANY_NAME && env.ANTHROPIC_API_KEY);
  res.json({ configured });
});

app.get("/api/settings", (_req, res) => {
  const env = readEnvFile();
  res.json({
    branding: {
      company_name: env.COMPANY_NAME || "",
      assistant_name: env.ASSISTANT_NAME || "",
      tagline: env.TAGLINE || "",
      primary_hue: parseInt(env.PRIMARY_COLOR_HUE || "264"),
      primary_sat: parseInt(env.PRIMARY_COLOR_SAT || "65"),
      primary_lit: parseInt(env.PRIMARY_COLOR_LIT || "49"),
    },
    integrations: {
      anthropic: { has_key: !!env.ANTHROPIC_API_KEY, masked: maskKey(env.ANTHROPIC_API_KEY) },
      telegram: { has_key: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), token_masked: maskKey(env.TELEGRAM_BOT_TOKEN), chat_id: env.TELEGRAM_CHAT_ID || "" },
      heygen: { has_key: !!env.HEYGEN_API_KEY, masked: maskKey(env.HEYGEN_API_KEY) },
      stripe: { has_key: !!env.STRIPE_SECRET_KEY, masked: maskKey(env.STRIPE_SECRET_KEY) },
      composio: { has_key: !!env.COMPOSIO_API_KEY, masked: maskKey(env.COMPOSIO_API_KEY) },
      apify: { has_key: !!env.APIFY_API_KEY, masked: maskKey(env.APIFY_API_KEY) },
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
      heygen_key: "HEYGEN_API_KEY",
      stripe_key: "STRIPE_SECRET_KEY",
      composio_key: "COMPOSIO_API_KEY",
      apify_key: "APIFY_API_KEY",
    };
    for (const [field, envKey] of Object.entries(keyMap)) {
      if (integrations[field] !== undefined && integrations[field] !== "") {
        updates[envKey] = integrations[field].trim();
      }
    }
  }

  try {
    if (Object.keys(updates).length) {
      writeEnvFile(updates);
      // Regenerate brand.json if branding changed
      if (branding) {
        const configScript = path.join(__dirname, "..", "config", "generate-configs.sh");
        try { require("child_process").execSync(`bash ${configScript} 2>&1`, { timeout: 5000 }); } catch {}
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

// ── DESIGNER TASKS ────────────────────────────
app.get("/designer/tasks", (_req, res) => res.json(readTaskFile("designer-tasks.json")));

const designerUpload = require("multer")({
  storage: require("multer").diskStorage({
    destination: path.join(__dirname, "data", "ai-video-uploads"),
    filename: (_req, file, cb) => cb(null, "ref-" + Date.now() + path.extname(file.originalname || ".png")),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post("/designer/tasks", designerUpload.single("ref_image"), async (req, res) => {
  const tasks = readTaskFile("designer-tasks.json");
  const desc = req.body.description || "";
  const refImagePath = req.file ? req.file.path : null;
  const designType = req.body.design_type || "instagram_post";
  const brand = req.body.brand || (loadBrand().company_name || "DEFAULT").toUpperCase();
  const brandKitId = req.body.brand_kit_id || null;
  const engine = req.body.engine || "playwright"; // "playwright", "canva", or "claude"
  const logoPosition = req.body.logo_position || "SouthEast"; // ImageMagick gravity
  const templateName = req.body.template || "default"; // slide layout template
  const requestedSlideCount = req.body.slide_count || null;

  // Load brand assets (logos, colors, fonts) for this brand
  const brandConfigs = readBrandConfigs();
  const brandConfig = brandConfigs[brand.toUpperCase()] || { colors: [], fonts: [] };
  const brandAssetsDir = path.join(BRAND_ASSETS_DIR, brand.toUpperCase());
  const brandLogos = [];
  try {
    if (fs.existsSync(brandAssetsDir)) {
      for (const f of fs.readdirSync(brandAssetsDir)) {
        brandLogos.push({ name: f, url: `/brand-assets/${brand.toUpperCase()}/${f}` });
      }
    }
  } catch {}
  const brandContext = {
    name: brand,
    logos: brandLogos,
    colors: brandConfig.colors || [],
    fonts: brandConfig.fonts || [],
  };

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
      facebook_post: "1:1", infographic: "9:16", poster: "3:4",
      presentation: "16:9", logo: "1:1",
    };
    const aspect = aspectMap[designType] || "1:1";
    const numImages = slides.length > 1 ? slides.length
      : (designType === "instagram_carousel" && requestedSlideCount) ? requestedSlideCount : 1;

    const createdTasks = [];
    for (let i = 0; i < numImages; i++) {
      createdTasks.push({
        id: genId(), status: "processing",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        design_type: designType, brand, brand_kit_id: brandKitId, engine: "nanobanana",
        logo_position: logoPosition,
        carousel_parent: numImages > 1 ? genId() : null,
        carousel_slide: numImages > 1 ? i + 1 : null,
        carousel_total: numImages > 1 ? numImages : null,
        description: numImages > 1 && slides[i] ? `Slide ${i+1}/${numImages}: ${slides[i].title}` : desc,
        result_url: null, result_thumbnail: null, result_design_id: null, error: null,
      });
    }
    tasks.unshift(...createdTasks);
    writeTaskFile("designer-tasks.json", tasks);
    res.status(201).json(createdTasks);

    // Run infsh for each task
    for (const task of createdTasks) {
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
      const inputObj = { prompt, aspect_ratio: aspect, resolution: "2K", num_images: 1 };
      if (refImagePath && fs.existsSync(refImagePath)) inputObj.images = [refImagePath];
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
          if (refImagePath) try { fs.unlinkSync(refImagePath); } catch {}
          const allTasks = readTaskFile("designer-tasks.json");
          const idx = allTasks.findIndex(t => t.id === task.id);
          if (idx === -1) return;

          if (err) {
            const detail = stderr ? stderr.replace(/\x1b\[[0-9;]*m/g, '').trim() : err.message;
            console.error("[DESIGNER] Nano Banana failed after retries:", detail.slice(0, 300));
            allTasks[idx].status = "failed";
            allTasks[idx].error = detail.slice(0, 500);
            writeTaskFile("designer-tasks.json", allTasks);
            return;
          }

          if (parseError) {
            console.error("[DESIGNER] Nano Banana parse error:", parseError.message);
            allTasks[idx].status = "failed";
            allTasks[idx].error = "Failed to parse output: " + parseError.message.slice(0, 200);
            allTasks[idx].updated_at = new Date().toISOString();
            writeTaskFile("designer-tasks.json", allTasks);
            return;
          }

          if (images.length > 0) {
            const imgUrl = images[0];
            const imgDir = path.join(__dirname, "data", "generated-images");
            if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
            const outFile = path.join(imgDir, `nanobanana-${task.id}.png`);

            // Find the brand logo to overlay
            const logoFile = logoFiles.find(f => f.includes("logo"));
            const taskLogoPos = task.logo_position || "SouthEast";
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
                  return;
                }
                // Composite logo at chosen position (12% of image width, with padding)
                execFile("convert", [
                  outFile,
                  "(", logoFile, "-resize", "12%", ")",
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
        });
      };
      runInfsh(1);
    }
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
  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    template: req.body.template || "social-clip",
    aspect_ratio: req.body.aspect_ratio || "9:16",
    brand: req.body.brand || (loadBrand().company_name || "DEFAULT").toUpperCase(),
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
  const aspectRatio = req.body.aspect_ratio || "16:9";
  const duration = parseInt(req.body.duration) || 8;
  const refImagePath = req.file ? req.file.path : null;

  const task = {
    id: genId(), status: "processing",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    model, prompt, aspect_ratio: aspectRatio, duration,
    ref_image: refImagePath ? true : false,
    result_url: null, error: null,
  };
  tasks.unshift(task);
  writeTaskFile("ai-video-tasks.json", tasks);
  res.status(201).json(task);

  // Build infsh input
  const inputObj = { prompt, aspect_ratio: aspectRatio };
  if (duration) inputObj.duration = duration;
  if (refImagePath && fs.existsSync(refImagePath)) {
    // Resize to max 1024px and convert to JPEG to keep base64 payload small
    const resizedPath = refImagePath.replace(/\.\w+$/, "-resized.jpg");
    try {
      require("child_process").execSync(
        `convert "${refImagePath}" -resize "1024x1024>" -quality 85 "${resizedPath}"`,
        { timeout: 15000 }
      );
      const b64 = fs.readFileSync(resizedPath).toString("base64");
      inputObj.image = `data:image/jpeg;base64,${b64}`;
      try { fs.unlinkSync(resizedPath); } catch {}
    } catch (resizeErr) {
      console.error("[AI-VIDEO] Image resize failed, using original:", resizeErr.message);
      const ext = path.extname(refImagePath).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const b64 = fs.readFileSync(refImagePath).toString("base64");
      inputObj.image = `data:${mime};base64,${b64}`;
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

// ── AVATAR TASKS (HeyGen) ─────────────────────
app.get("/avatar/tasks", (_req, res) => res.json(readTaskFile("avatar-tasks.json")));

app.post("/avatar/tasks", (req, res) => {
  const tasks = readTaskFile("avatar-tasks.json");
  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    avatar_id: req.body.avatar_id || "703a2be1c9ae459e81be99b04636c5dc",
    voice_id: req.body.voice_id || "cae5f9ad5dec463b83565e8a38b74a09",
    voice_engine: req.body.voice_engine || "panda",
    motion_engine: req.body.motion_engine || "avatar_iii",
    script: req.body.script || "",
    description: req.body.description || "",
    result_url: null, result_video_id: null, error: null,
  };
  tasks.unshift(task);
  writeTaskFile("avatar-tasks.json", tasks);
  res.status(201).json(task);
});

app.patch("/avatar/tasks/:id", (req, res) => {
  const tasks = readTaskFile("avatar-tasks.json");
  const idx = tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  Object.assign(tasks[idx], req.body, { updated_at: new Date().toISOString() });
  writeTaskFile("avatar-tasks.json", tasks);
  res.json(tasks[idx]);
});

app.delete("/avatar/tasks/:id", (req, res) => {
  writeTaskFile("avatar-tasks.json", readTaskFile("avatar-tasks.json").filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

// ── VIDEO AGENT TASKS (HeyGen Video Agent) ───
app.get("/video-agent/tasks", (_req, res) => res.json(readTaskFile("video-agent-tasks.json")));

app.post("/video-agent/tasks", (req, res) => {
  const tasks = readTaskFile("video-agent-tasks.json");
  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    prompt: req.body.prompt || "",
    duration_sec: req.body.duration_sec || 30,
    orientation: req.body.orientation || "portrait",
    avatar_id: req.body.avatar_id || null,
    description: req.body.description || "",
    result_url: null, result_video_id: null, error: null,
  };
  tasks.unshift(task);
  writeTaskFile("video-agent-tasks.json", tasks);
  res.status(201).json(task);
});

app.patch("/video-agent/tasks/:id", (req, res) => {
  const tasks = readTaskFile("video-agent-tasks.json");
  const idx = tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  Object.assign(tasks[idx], req.body, { updated_at: new Date().toISOString() });
  writeTaskFile("video-agent-tasks.json", tasks);
  res.json(tasks[idx]);
});

app.delete("/video-agent/tasks/:id", (req, res) => {
  writeTaskFile("video-agent-tasks.json", readTaskFile("video-agent-tasks.json").filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

// ── HEYGEN AVATARS (cached proxy) ─────────────
let avatarCache = { data: null, ts: 0 };
const AVATAR_CACHE_TTL = 3600_000; // 1 hour

app.get("/heygen/avatars", async (req, res) => {
  try {
    if (!avatarCache.data || Date.now() - avatarCache.ts > AVATAR_CACHE_TTL) {
      const r = await fetch("https://api.heygen.com/v2/avatars", {
        headers: { "X-Api-Key": process.env.HEYGEN_API_KEY },
      });
      const json = await r.json();
      // Deduplicate by avatar_id
      const seen = new Set();
      const unique = [];
      for (const a of json.data.avatars) {
        if (!seen.has(a.avatar_id)) {
          seen.add(a.avatar_id);
          unique.push({
            id: a.avatar_id,
            name: a.avatar_name,
            gender: a.gender,
            preview: a.preview_image_url,
            custom: !a.avatar_id.includes("public") && !a.avatar_id.includes("_expressive_") && !a.avatar_id.includes("_standing_") && !a.avatar_id.includes("_sitting_"),
          });
        }
      }
      // Sort: custom first, then alphabetical
      unique.sort((a, b) => (b.custom - a.custom) || a.name.localeCompare(b.name));
      avatarCache = { data: unique, ts: Date.now() };
    }
    let results = avatarCache.data;
    const q = (req.query.q || "").toLowerCase();
    const gender = req.query.gender || "";
    if (q) results = results.filter(a => a.name.toLowerCase().includes(q));
    if (gender) results = results.filter(a => a.gender === gender);
    const limit = parseInt(req.query.limit) || 50;
    res.json({ total: results.length, avatars: results.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ANALYST TASKS ─────────────────────────────
app.get("/analyst/tasks", (_req, res) => res.json(readTaskFile("analyst-tasks.json")));

app.post("/analyst/tasks", (req, res) => {
  const tasks = readTaskFile("analyst-tasks.json");
  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    type: req.body.type || "daily_report",
    description: req.body.description || "",
    error: null,
  };
  tasks.unshift(task);
  writeTaskFile("analyst-tasks.json", tasks);
  res.status(201).json(task);
});

app.patch("/analyst/tasks/:id", (req, res) => {
  const tasks = readTaskFile("analyst-tasks.json");
  const idx = tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  Object.assign(tasks[idx], req.body, { updated_at: new Date().toISOString() });
  writeTaskFile("analyst-tasks.json", tasks);
  res.json(tasks[idx]);
});

app.delete("/analyst/tasks/:id", (req, res) => {
  writeTaskFile("analyst-tasks.json", readTaskFile("analyst-tasks.json").filter((t) => t.id !== req.params.id));
  res.json({ ok: true });
});

// ── SCRIPTWRITER TASKS ────────────────────────
app.get("/scriptwriter/tasks", (_req, res) => res.json(readTaskFile("scriptwriter-tasks.json")));

app.post("/scriptwriter/tasks", (req, res) => {
  const tasks = readTaskFile("scriptwriter-tasks.json");
  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    type: req.body.type || "video_script",
    topic: req.body.topic || "",
    format: req.body.format || "short-form",
    tone: req.body.tone || "educational",
    description: req.body.description || "",
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

// ── BOT TRADE HISTORY (reads from bot data files) ──
const INSTALL_DIR = process.env.INSTALL_DIR || path.join(__dirname, "..");
const TRADE_FILES = {
  funding: path.join(INSTALL_DIR, "funding-bot", "data", "trade_history.json"),
  trend: path.join(INSTALL_DIR, "trend-bot", "data", "trade_history.json"),
};

app.get("/analyst/trades/:botId", (req, res) => {
  const file = TRADE_FILES[req.params.botId];
  if (!file) return res.status(404).json({ error: "Unknown bot" });
  try {
    const trades = JSON.parse(fs.readFileSync(file, "utf8"));
    res.json(trades);
  } catch { res.json([]); }
});

app.get("/analyst/trades", (_req, res) => {
  const all = {};
  for (const [id, file] of Object.entries(TRADE_FILES)) {
    try { all[id] = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { all[id] = []; }
  }
  res.json(all);
});

// ── DAILY REPORTS (reads log files) ───────────
app.get("/analyst/daily-report", (_req, res) => {
  try {
    const log = fs.readFileSync("/root/daily_analysis.log", "utf8");
    const diag = fs.readFileSync("/root/diagnose_bots.log", "utf8");
    // Get last report from each
    const analysisBlocks = log.split("[ANALYSE] Start...");
    const diagBlocks = diag.split("[DIAGNOSE] Start...");
    const lastAnalysis = analysisBlocks[analysisBlocks.length - 1] || "";
    const lastDiag = diagBlocks[diagBlocks.length - 1] || "";
    const clean = s => s.replace(/<\/?[^>]+(>|$)/g, "")
      .replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
      .trim();
    res.json({
      analysis: clean(lastAnalysis),
      diagnosis: clean(lastDiag),
      analysis_raw: lastAnalysis.trim(),
      diagnosis_raw: lastDiag.trim(),
    });
  } catch { res.json({ analysis: "", diagnosis: "" }); }
});

// ── RESEARCH TASKS ────────────────────────────
app.get("/research/tasks", (_req, res) => res.json(readTaskFile("research-tasks.json")));

app.post("/research/tasks", (req, res) => {
  const tasks = readTaskFile("research-tasks.json");
  const task = {
    id: genId(), status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    type: req.body.type || "trending",
    query: req.body.query || "",
    platforms: req.body.platforms || ["tiktok", "x", "reddit"],
    niche: req.body.niche || "crypto trading",
    language: req.body.language || "NL",
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
      { label: "Model", value: "claude-sonnet-4-20250514" },
      { label: "Used by", value: "AI Chat, Research, Analyst, Designer (Claude engine)" },
    ],
  });

  // 2. HeyGen
  const heygenKey = process.env.HEYGEN_API_KEY || "";
  integrations.push({
    id: "heygen", status: heygenKey ? "connected" : "not-configured",
    details: [
      { label: "API Key", value: heygenKey, secret: true },
      { label: "Endpoints", value: "v1 Video Agent, v2 Avatar Video" },
      { label: "Used by", value: "Content Creator, Video Editor" },
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

  // 4. Canva
  let canvaStatus = "not-configured";
  let canvaDetails = [{ label: "OAuth", value: "Not configured" }];
  try {
    const canvaTokens = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "canva-oauth.json"), "utf8"));
    const expired = canvaTokens.expires_at && canvaTokens.expires_at < Date.now();
    canvaStatus = canvaTokens.access_token ? (expired ? "not-configured" : "connected") : "not-configured";
    canvaDetails = [
      { label: "Client ID", value: canvaTokens.client_id || "—" },
      { label: "Access Token", value: canvaTokens.access_token || "—", secret: true },
      { label: "Expires", value: canvaTokens.expires_at ? new Date(canvaTokens.expires_at).toLocaleString("nl-NL") : "—" },
      { label: "Used by", value: "Designer (Claude + Canva MCP engine)" },
    ];
  } catch {}
  integrations.push({ id: "canva", status: canvaStatus, details: canvaDetails });

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

  // 7. Apify
  const apifyToken = process.env.APIFY_API_KEY || "";
  integrations.push({
    id: "apify", status: apifyToken ? "connected" : "not-configured",
    details: apifyToken ? [
      { label: "API Token", value: apifyToken, secret: true },
      { label: "Actors", value: "TikTok Scraper, Instagram Scraper, Twitter/X Scraper" },
      { label: "Used by", value: "Performance page, Overview — social media analytics" },
    ] : [{ label: "Status", value: "Not configured — set APIFY_API_KEY in .env" }],
  });

  // 8. Composio
  const composioKey = process.env.COMPOSIO_API_KEY || "";
  integrations.push({
    id: "composio", status: composioKey ? "connected" : "not-configured",
    details: [
      { label: "API Key", value: composioKey, secret: true },
      { label: "Endpoint", value: "https://backend.composio.dev/api/v2" },
      { label: "Used by", value: "Tool integrations — GitHub, Slack, Gmail, Calendar & more" },
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
      const msg = await client.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 10, messages: [{ role: "user", content: "ping" }] });
      res.json({ ok: true, message: `Model responded (${msg.usage.input_tokens + msg.usage.output_tokens} tokens)` });
    } else if (id === "heygen") {
      const r = await fetch("https://api.heygen.com/v2/avatars", { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY } });
      const d = await r.json();
      res.json({ ok: r.ok, message: r.ok ? `${d.data?.avatars?.length || 0} avatars available` : d.message || "Auth failed" });
    } else if (id === "stripe") {
      const bal = await stripe.balance.retrieve();
      const amount = (bal.available?.[0]?.amount || 0) / 100;
      res.json({ ok: true, message: `Balance: €${amount.toFixed(2)}` });
    } else if (id === "canva") {
      const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "canva-oauth.json"), "utf8"));
      const expired = tokens.expires_at && tokens.expires_at < Date.now();
      res.json({ ok: !expired && !!tokens.access_token, message: expired ? "Token expired — re-authorize" : "OAuth token valid" });
    } else if (id === "telegram") {
      if (!TG_TOKEN) return res.json({ ok: false, message: "TELEGRAM_BOT_TOKEN not set in .env" });
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`);
      const d = await r.json();
      res.json({ ok: d.ok, message: d.ok ? `Bot: @${d.result.username}` : "Auth failed" });
    } else if (id === "apify") {
      const apifyKey = process.env.APIFY_API_KEY || "";
      if (!apifyKey) return res.json({ ok: false, message: "APIFY_API_KEY not set in .env" });
      const r = await fetch(`https://api.apify.com/v2/acts?token=${apifyKey}&limit=1`);
      const d = await r.json();
      res.json({ ok: r.ok, message: r.ok ? `API reachable — ${d.data?.total || "?"} actors available` : "Auth failed" });
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
    } else {
      res.json({ ok: false, message: "Unknown integration" });
    }
  } catch (e) {
    res.json({ ok: false, message: e.message.slice(0, 200) });
  }
});

app.get("/settings/services", async (_req, res) => {
  const services = [
    { label: "Command Center API", url: "http://localhost:3004", desc: "Main API server — tasks, brands, chat" },
    { label: "Trading Dashboard", url: process.env.DASHBOARD_URL || "http://localhost:3000", desc: "Live trading bot data & orderbook" },
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

// Upload via multipart (simple: read raw body and save)
const multer = require("multer") || null;
try {
  const upload = require("multer")({ dest: MEDIA_DIR, limits: { fileSize: 100 * 1024 * 1024 } });
  app.post("/media/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const ext = path.extname(req.file.originalname);
    const finalName = req.file.filename + ext;
    fs.renameSync(req.file.path, path.join(MEDIA_DIR, finalName));
    res.json({ name: finalName, path: "/media/" + finalName });
  });
} catch {
  // multer not installed, skip upload endpoint
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

  // Handle /start command
  if (text === "/start") {
    const brand = loadBrand();
    tgSend(chatId, `Hey! Ik ben *${brand.assistant_name}*, je ${brand.company_name} AI assistant.\n\nJe kunt me hier alles vragen wat je ook in het Command Center zou vragen:\n- Bot performance & status\n- Agents aansturen (designer, researcher, analyst, etc.)\n- Agenda beheren\n- Marktanalyse & nieuws\n\nStuur gewoon een bericht om te beginnen.`);
    return;
  }

  // Handle /clear command
  if (text === "/clear") {
    delete chatSessions["telegram"];
    tgSend(chatId, "Chat history gewist.");
    return;
  }

  // Handle /status command
  if (text === "/status") {
    try {
      const botData = await fetch("http://localhost:3000/api/status").then(r => r.json()).catch(() => null);
      if (botData) {
        const lines = ["*Bot Status:*"];
        for (const [id, label] of [["funding", "Funding"], ["trend", "Trend"]]) {
          const b = botData[id];
          if (!b) { lines.push(`${label}: offline`); continue; }
          const emoji = b.online ? "🟢" : "🔴";
          const upnl = (b.positions || []).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
          lines.push(`${emoji} *${label}* — $${(b.accountValue || 0).toFixed(0)} equity, uPnL: $${upnl >= 0 ? "+" : ""}${upnl.toFixed(2)}`);
        }
        tgSend(chatId, lines.join("\n"));
      } else {
        tgSend(chatId, "Kan geen verbinding maken met trading dashboard.");
      }
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
      headers: { "Content-Type": "application/json", "x-internal": "telegram" },
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

async function tgPoll() {
  if (tgPollingActive) return;
  tgPollingActive = true;
  console.log("[TG-BOT] Telegram bot polling started — assistant is now reachable via Telegram");

  while (tgPollingActive) {
    try {
      const r = await fetch(`${TG_API}/getUpdates?offset=${tgOffset}&timeout=30&allowed_updates=["message"]`, {
        signal: AbortSignal.timeout(35000),
      });
      const data = await r.json();

      if (data.ok && data.result?.length) {
        for (const update of data.result) {
          tgOffset = update.update_id + 1;
          if (update.message) {
            handleTgMessage(update.message).catch(e => console.error("[TG-BOT] Handler error:", e.message));
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
  "Content Creator": "avatar-tasks.json",
  "Video Agent": "video-agent-tasks.json",
  Analyst: "analyst-tasks.json",
  Researcher: "research-tasks.json",
  "Script Writer": "scriptwriter-tasks.json",
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
      const heygenLink = cur.result_video_id ? `https://app.heygen.com/videos/${cur.result_video_id}` : null;
      let message = cur.desc || "Taak afgerond";
      if (heygenLink) message += `\n\nVideo: ${heygenLink}`;
      if (cur.result_url) message += `\nDownload: ${cur.result_url}`;
      notifs.unshift({
        id: genId(), type: "task_completed", agent: cur.agent,
        title, message, severity: "success", read: false, created_at: new Date().toISOString(),
        result_url: cur.result_url || null,
        heygen_url: heygenLink || null,
      });
      const tgMsg = heygenLink ? `${cur.desc || "Taak afgerond"}\n\n🎬 ${heygenLink}` : (cur.desc || "Taak afgerond");
      sendTelegram(title, tgMsg, "success");
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

// ── BOT STATUS WATCHER ───────────────────────
let prevBotOnline = {};

setInterval(async () => {
  try {
    const res = await fetch("http://localhost:3000/api/status");
    const data = await res.json();
    const botNames = { funding: "Funding Bot", trend: "Trend Bot" };
    const notifs = readTaskFile("notifications.json");
    let changed = false;

    for (const [id, name] of Object.entries(botNames)) {
      const online = data[id]?.online ?? false;
      const prev = prevBotOnline[id];
      if (prev !== undefined && prev !== online) {
        const title = `${name} ${online ? "online" : "offline"}`;
        const message = online ? "Bot is weer actief" : "Bot is gestopt of log is staal";
        const severity = online ? "success" : "danger";
        notifs.unshift({
          id: genId(), type: "bot_status", agent: id,
          title, message, severity, read: false,
          created_at: new Date().toISOString(),
        });
        sendTelegram(title, message, severity);
        changed = true;
      }
      prevBotOnline[id] = online;
    }

    if (changed) {
      if (notifs.length > 100) notifs.length = 100;
      writeTaskFile("notifications.json", notifs);
    }
  } catch {}
}, 30_000);

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
    return { company_name: "Trading Platform", assistant_name: "Assistant", tagline: "Your Trading Platform" };
  }
}

app.get("/brand", (_req, res) => {
  const brand = loadBrand();
  brand.features = {
    telegram: !!TG_TOKEN,
    heygen: !!process.env.HEYGEN_API_KEY,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    composio: !!process.env.COMPOSIO_API_KEY,
  };
  res.json(brand);
});

function buildSystemPrompt() {
  const brand = loadBrand();
  return `Je bent ${brand.assistant_name}, de AI assistant van ${brand.company_name}, ingebouwd in het ${brand.company_name} Command Center.
Je helpt de gebruiker met het aansturen van agents, het monitoren van bots, en het beantwoorden van vragen over het systeem.

TRADING BOTS (Hyperliquid Perps):
- Funding Bot — Funding rate arbitrage
- Trend Bot — BB+RSI mean-reversion strategie

COMMAND CENTER:
- Agents: Designer (Canva), Video Editor (Remotion), Content Creator (HeyGen avatar + Video Agent), Analyst, Researcher, Script Writer
- Alle agents hebben een takenlijst (pending/processing/completed)

Je kunt:
1. Uitleggen wat bots/agents doen en hoe ze presteren
2. Adviseren over bot configuratie en strategie
3. Taken analyseren en suggesties doen
4. Vragen beantwoorden over trades, PnL, en performance
5. Content ideeën en scripts voorstellen
6. Het web doorzoeken voor actueel nieuws, marktdata, crypto events en andere real-time informatie
7. AGENTS AANSTUREN — je kunt taken aanmaken bij alle agents via tools:
   - create_avatar_video: Avatar video laten maken (Content Creator)
   - create_video_agent: AI-gegenereerde video laten maken (Video Agent)
   - create_script: Script laten schrijven (Script Writer)
   - create_design: Design laten maken (Designer) — BELANGRIJK: gebruik altijd de juiste parameters! Bij carousel: design_type="instagram_carousel" + slide_count. Engine: "nanobanana" (AI image), "playwright" (HTML), "claude" (Canva). Standaard engine is nanobanana.
   - create_video_edit: Video laten editen via Remotion (Video Editor)
   - create_research: Onderzoek laten doen (Researcher)
   - create_analysis: Analyse laten maken (Analyst)
   - calendar_query: Google Calendar beheren — events bekijken, aanmaken, verwijderen, vrije slots vinden
   - marketeer_query: Marketing strategie, content planning, copywriting, SEO, ads — vraag de Marketeer agent

BELANGRIJK bij het aansturen van agents:
- Gebruik de tools om taken daadwerkelijk aan te maken, niet alleen beschrijven wat je zou doen
- Als de gebruiker vraagt om een video te maken, maak dan direct de taak aan
- Bevestig altijd welke taken je hebt aangemaakt en bij welke agent

Je hebt toegang tot web search. Gebruik dit wanneer de gebruiker vraagt naar actueel nieuws, prijsbewegingen, of informatie recenter dan je training data.

Je spreekt Nederlands tenzij de gebruiker Engels praat.
Wees beknopt en direct. Gebruik geen emoji tenzij gevraagd.`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

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

  try {
    // Fetch live bot data
    let botContext = "";
    try {
      const botRes = await fetch("http://localhost:3000/api/status");
      const botData = await botRes.json();
      const botLines = [];
      for (const [id, b] of Object.entries(botData)) {
        if (!b.name) continue;
        botLines.push(`${b.name}: ${b.online ? "ONLINE" : "OFFLINE"} | Equity: $${(b.accountValue||0).toFixed(2)} | Day PnL: $${(b.stats?.dailyPnl||0).toFixed(2)} | Total PnL: $${(b.stats?.totalPnl||0).toFixed(2)} | Trades: ${b.stats?.totalTrades||0} | WR: ${b.stats?.winRate||0}% | Positions: ${b.positions?.length||0}`);
      }
      botContext = "\n\nLIVE BOT STATUS:\n" + botLines.join("\n");
    } catch {}

    const systemWithContext = SYSTEM_PROMPT + "\n\nAGENT & TAAK STATUS:\n" + gatherContext() + botContext;

    const agentTools = [
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      {
        type: "custom",
        name: "create_avatar_video",
        description: "Maak een avatar video task aan bij de Content Creator agent. De avatar spreekt het opgegeven script in.",
        input_schema: {
          type: "object",
          properties: {
            script: { type: "string", description: "Het volledige script dat de avatar moet spreken" },
            description: { type: "string", description: "Korte beschrijving van de video (bijv. 'Trading recap voor TikTok')" },
            avatar_id: { type: "string", description: "Avatar ID. Standaard: 703a2be1c9ae459e81be99b04636c5dc (Meta Vers3)" },
            voice_id: { type: "string", description: "Voice ID. Standaard: cae5f9ad5dec463b83565e8a38b74a09 (Meta Vers3 Clone). Andere opties: f3a93c83f9ec4294b41bd787ac93a247 (Tijs NL), f728541039564551bad369a6da2445b8 (Eric NL), f89d0301b13840ccb7a1814d77e336c6 (Jann NL), fae30d24656e441fad8864951da79b75 (Lucas NL), f38a635bee7a4d1f9b0a654a31d050d2 (Chill Brian EN), d92994ae0de34b2e8659b456a2f388b8 (John Doe EN)" },
            voice_engine: { type: "string", enum: ["panda", "coral"], description: "Voice engine. Standaard: panda" },
          },
          required: ["script", "description"],
        },
      },
      {
        type: "custom",
        name: "create_video_agent",
        description: "Maak een Video Agent task aan. AI genereert automatisch een complete video op basis van een prompt (script, avatar, visuals, voiceover).",
        input_schema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Beschrijving van de gewenste video" },
            duration_sec: { type: "integer", description: "Gewenste duur in seconden (5-300). Standaard: 30" },
            orientation: { type: "string", enum: ["portrait", "landscape"], description: "Orientatie. Standaard: portrait" },
            avatar_id: { type: "string", description: "Optioneel: specifiek avatar ID" },
          },
          required: ["prompt"],
        },
      },
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
            design_type: { type: "string", enum: ["instagram_post", "instagram_carousel", "instagram_story", "youtube_thumbnail", "youtube_banner", "twitter_post", "facebook_post", "infographic", "poster", "presentation", "logo"], description: "Type design. Standaard: instagram_post. Gebruik instagram_carousel voor meerdere slides." },
            brand: { type: "string", description: "Brand naam. Wordt geladen uit brand configuratie." },
            engine: { type: "string", enum: ["nanobanana", "playwright", "claude", "canva"], description: "Rendering engine. Standaard: nanobanana. Nano Banana = AI image generation (Gemini), Playwright = instant HTML-to-image, Claude = Canva MCP" },
            slide_count: { type: "integer", description: "Aantal slides voor carousels (2-10). Alleen nodig bij instagram_carousel." },
            logo_position: { type: "string", enum: ["SouthEast", "SouthWest", "NorthEast", "NorthWest", "Center", "none"], description: "Logo positie. Standaard: SouthEast" },
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
        name: "create_analysis",
        description: "Maak een analyse task aan bij de Analyst agent.",
        input_schema: {
          type: "object",
          properties: {
            description: { type: "string", description: "Beschrijving van de gewenste analyse" },
            type: { type: "string", enum: ["daily_report", "performance", "risk", "strategy"], description: "Type analyse. Standaard: daily_report" },
          },
          required: ["description"],
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
    ];

    // Map tool names to internal API endpoints and body builders
    const TOOL_ACTIONS = {
      create_avatar_video: (input) => ({
        url: "http://localhost:3004/avatar/tasks",
        body: {
          script: input.script,
          description: input.description,
          avatar_id: input.avatar_id || "703a2be1c9ae459e81be99b04636c5dc",
          voice_id: input.voice_id || "cae5f9ad5dec463b83565e8a38b74a09",
          voice_engine: input.voice_engine || "panda",
        },
      }),
      create_video_agent: (input) => ({
        url: "http://localhost:3004/video-agent/tasks",
        body: {
          prompt: input.prompt,
          duration_sec: input.duration_sec || 30,
          orientation: input.orientation || "portrait",
          avatar_id: input.avatar_id || null,
          description: (input.prompt || "").substring(0, 60),
        },
      }),
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
          logo_position: input.logo_position || "SouthEast",
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
      create_analysis: (input) => ({
        url: "http://localhost:3004/analyst/tasks",
        body: {
          description: input.description,
          type: input.type || "daily_report",
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
    };

    const apiParams = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemWithContext,
      messages: history,
      tools: agentTools,
    };

    let response = await anthropic.messages.create(apiParams);
    // Handle tool use loop (web search + agent actions)
    let loopCount = 0;
    while (response.stop_reason === "tool_use" && loopCount < 10) {
      loopCount++;
      history.push({ role: "assistant", content: response.content });

      const toolResults = [];

      for (const block of response.content) {
        // Server tools (web search) — handled by Anthropic
        if (block.type === "server_tool_use") {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: block.content || "" });
        }
        // Custom tools (agent actions) — execute locally
        if (block.type === "tool_use" && TOOL_ACTIONS[block.name]) {
          try {
            console.log(`[CHAT-TOOL] ${block.name}:`, JSON.stringify(block.input));
            const action = TOOL_ACTIONS[block.name](block.input);
            const authHeader = req.cookies?.cc_session
              ? { Cookie: `cc_session=${req.cookies.cc_session}` }
              : { "x-internal": "telegram" };
            console.log(`[CHAT-TOOL] → ${action.url}`, JSON.stringify(action.body));
            const taskRes = await fetch(action.url, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeader },
              body: JSON.stringify(action.body),
            });
            const task = await taskRes.json();
            const resultContent = action.isCalendar
              ? JSON.stringify({ success: true, calendar_response: task.reply || task.error || "Geen antwoord" })
              : JSON.stringify({ success: true, task_id: task.id, status: task.status, message: `Task aangemaakt: ${task.id}` });
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

      if (toolResults.length) {
        history.push({ role: "user", content: toolResults });
      }

      response = await anthropic.messages.create(apiParams);
    }

    // Extract final text reply
    const textBlocks = response.content.filter(b => b.type === "text");
    const reply = textBlocks.map(b => b.text).join("\n") || "Geen antwoord ontvangen.";

    // Add assistant message to history
    history.push({ role: "assistant", content: response.content });

    res.json({ reply, sessionId });
  } catch (err) {
    console.error("[CHAT] Error:", err.message);
    // Remove the user message on failure
    history.pop();
    res.status(500).json({ error: "AI request failed: " + err.message });
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
const COMPOSIO_ACCOUNT_ID = "30f9a8b5-8eae-4368-ad0f-da973486a34d";

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
      GOOGLECALENDAR_CREATE_EVENT: "Create a new calendar event. Params: summary (title), start_datetime (ISO), end_datetime (ISO), description, location, attendees (comma-separated emails), calendar_id.",
      GOOGLECALENDAR_DELETE_EVENT: "Delete an event. Params: event_id, calendar_id.",
      GOOGLECALENDAR_EVENTS_MOVE: "Move an event to a different calendar or time. Params: event_id, calendar_id, destination_calendar_id.",
      GOOGLECALENDAR_FIND_FREE_SLOTS: "Find free time slots. Params: calendar_id, time_min (ISO), time_max (ISO), duration_minutes (int).",
      GOOGLECALENDAR_GET_CURRENT_DATE_TIME: "Get the current date and time in the user's timezone.",
    }[name] || name,
    input_schema: { type: "object", properties: {}, additionalProperties: true },
  }));
}

const CALENDAR_SYSTEM = `Je bent de Calendar Assistant, ingebouwd in het Command Center.
Je beheert de Google Calendar van de gebruiker via Composio tools.

BESCHIKBARE TOOLS:
- GOOGLECALENDAR_GET_CURRENT_DATE_TIME: Haal huidige datum/tijd op. Gebruik dit ALTIJD als eerste bij relatieve tijdsaanduidingen ("morgen", "volgende week", etc.).
- GOOGLECALENDAR_LIST_CALENDARS: Toon alle calendars.
- GOOGLECALENDAR_EVENTS_LIST: Toon events. Gebruik calendar_id "primary" tenzij anders gevraagd. Stuur time_min en time_max als ISO 8601 strings.
- GOOGLECALENDAR_FIND_EVENT: Zoek events op tekst.
- GOOGLECALENDAR_CREATE_EVENT: Maak een event aan. Vereist: summary, start_datetime, end_datetime (ISO 8601 met timezone, bijv. "2026-04-03T14:00:00+02:00"). Optioneel: description, location, attendees.
- GOOGLECALENDAR_DELETE_EVENT: Verwijder een event (event_id nodig).
- GOOGLECALENDAR_FIND_FREE_SLOTS: Vind vrije slots (time_min, time_max, duration_minutes).

REGELS:
- Spreek Nederlands tenzij de gebruiker Engels praat.
- Wees beknopt en direct. Geen emoji tenzij gevraagd.
- Bij het tonen van events, formatteer ze overzichtelijk met tijd, titel, en locatie.
- Bij het aanmaken van events, bevestig altijd de details voordat je het aanmaakt, tenzij de gebruiker al specifiek genoeg is.
- Gebruik Europe/Amsterdam timezone (CET/CEST) als default.
- Bij "vandaag", "morgen", "deze week" etc.: gebruik eerst GET_CURRENT_DATE_TIME om de juiste datum te bepalen.
- Toon tijden in 24-uurs formaat (14:00 niet 2 PM).
- Als je een event aanmaakt, bevestig met de details (titel, datum, tijd, duur).`;

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
        model: "claude-sonnet-4-20250514",
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
  return `Je bent de Marketeer, de AI marketing strategist van ${brand.company_name}, ingebouwd in het Command Center.

Je hebt toegang tot 25 professionele marketing skill-bibliotheken die je kunt laden met de load_marketing_skill tool. Laad ALTIJD de relevante skill(s) voordat je advies geeft.

BESCHIKBARE SKILLS:
${skillList}

TOOLS:
- load_marketing_skill: Laad een specifieke marketing skill voor gedetailleerde frameworks en methodologieën. Laad ALTIJD 1-3 relevante skills voordat je advies geeft. Gebruik de skill slug als parameter.
- create_marketing_task: Maak een taak aan die door andere agents uitgevoerd kan worden (designer, scriptwriter, researcher, content_creator).

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
    description: "Create a task for another agent to execute: designer (visual assets), scriptwriter (scripts/copy), researcher (market research), content_creator (video content).",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["designer", "scriptwriter", "researcher", "content_creator"], description: "Which agent should execute this task" },
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
  content_creator: "/avatar/tasks",
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
        model: "claude-sonnet-4-20250514",
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
              headers: { "Content-Type": "application/json", "x-internal": "telegram" },
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

// ── CANVA OAUTH (Dynamic Client Registration + PKCE) ─────────
const CANVA_TOKENS_FILE = path.join(__dirname, "data", "canva-oauth.json");
const CANVA_MCP_BASE = "https://mcp.canva.com";

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

// Step 1: Register as OAuth client (Dynamic Client Registration)
async function canvaRegisterClient(callbackUrl) {
  const res = await fetch(`${CANVA_MCP_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: (loadBrand().company_name || "Trading") + " Command Center",
      redirect_uris: [callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  if (!res.ok) throw new Error(`Registration failed: ${await res.text()}`);
  return res.json();
}

// In-memory OAuth state for pending flows
let canvaOAuthState = null;

// Start OAuth flow
app.get("/canva/connect", async (req, res) => {
  try {
    // Canva MCP only allows localhost as redirect host
    // Use the real server origin for the exchange, but register localhost for Canva
    const serverOrigin = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.headers.host}`;
    const callbackUrl = "http://localhost:3003/canva/callback";

    // Register client
    const client = await canvaRegisterClient(callbackUrl);
    const pkce = generatePKCE();
    const state = crypto.randomBytes(16).toString("hex");

    canvaOAuthState = { client_id: client.client_id, client_secret: client.client_secret, verifier: pkce.verifier, state, callbackUrl, serverOrigin };

    const authUrl = `${CANVA_MCP_BASE}/authorize?` + new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: callbackUrl,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });

    console.log("[CANVA] authUrl:", authUrl);
    res.redirect(authUrl);
  } catch (e) {
    console.error("[CANVA] OAuth start failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// OAuth callback
// Exchange endpoint — called by the frontend callback page
app.get("/canva/exchange", async (req, res) => {
  try {
    if (!canvaOAuthState) throw new Error("No pending OAuth flow");
    if (req.query.state !== canvaOAuthState.state) throw new Error("State mismatch");
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);

    const tokenRes = await fetch(`${CANVA_MCP_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: canvaOAuthState.callbackUrl,
        client_id: canvaOAuthState.client_id,
        client_secret: canvaOAuthState.client_secret,
        code_verifier: canvaOAuthState.verifier,
      }),
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
    const tokens = await tokenRes.json();

    writeCanvaTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      client_id: canvaOAuthState.client_id,
      client_secret: canvaOAuthState.client_secret,
      expires_at: Date.now() + (tokens.expires_in || 14400) * 1000,
    });

    canvaOAuthState = null;
    console.log("[CANVA] OAuth connected successfully");
    res.json({ ok: true });
  } catch (e) {
    console.error("[CANVA] OAuth exchange failed:", e.message);
    canvaOAuthState = null;
    res.status(500).json({ error: e.message });
  }
});

// OAuth callback — handles both direct and redirected flows
app.get("/canva/callback", async (req, res) => {
  try {
    if (!canvaOAuthState) throw new Error("No pending OAuth flow");
    if (req.query.state !== canvaOAuthState.state) throw new Error("State mismatch");
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);

    const tokenRes = await fetch(`${CANVA_MCP_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: canvaOAuthState.callbackUrl,
        client_id: canvaOAuthState.client_id,
        client_secret: canvaOAuthState.client_secret,
        code_verifier: canvaOAuthState.verifier,
      }),
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
    const tokens = await tokenRes.json();

    writeCanvaTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      client_id: canvaOAuthState.client_id,
      client_secret: canvaOAuthState.client_secret,
      expires_at: Date.now() + (tokens.expires_in || 14400) * 1000,
    });

    canvaOAuthState = null;
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
  try {
    const res = await fetch(`${CANVA_MCP_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: data.refresh_token,
        client_id: data.client_id,
        client_secret: data.client_secret,
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

// Status endpoint
app.get("/canva/status", async (_req, res) => {
  const token = await getCanvaAccessToken();
  res.json({ connected: !!token });
});

app.post("/canva/disconnect", async (_req, res) => {
  try {
    if (fs.existsSync(CANVA_TOKENS_FILE)) fs.unlinkSync(CANVA_TOKENS_FILE);
    console.log("[CANVA] Disconnected");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TASK WORKERS (auto-execute pending tasks) ─────────
const HEYGEN_KEY = process.env.HEYGEN_API_KEY;
const HEYGEN_HEADERS = { "X-Api-Key": HEYGEN_KEY, "Content-Type": "application/json" };

// Track which tasks are already being processed to avoid duplicates
const processingTasks = new Set();

async function processAvatarTasks() {
  const tasks = readTaskFile("avatar-tasks.json");
  for (const task of tasks) {
    if (task.status !== "pending" || processingTasks.has(task.id)) continue;
    processingTasks.add(task.id);
    console.log(`[WORKER] Processing avatar task ${task.id}`);

    try {
      // Update to processing
      task.status = "processing";
      task.updated_at = new Date().toISOString();
      writeTaskFile("avatar-tasks.json", tasks);

      // Call HeyGen API
      const res = await fetch("https://api.heygen.com/v2/video/generate", {
        method: "POST",
        headers: HEYGEN_HEADERS,
        body: JSON.stringify({
          video_inputs: [{
            character: {
              type: "avatar",
              avatar_id: task.avatar_id || "703a2be1c9ae459e81be99b04636c5dc",
              avatar_style: "normal",
            },
            voice: {
              type: "text",
              input_text: task.script,
              voice_id: task.voice_id || "cae5f9ad5dec463b83565e8a38b74a09",
              voice_engine: task.voice_engine || "panda",
            },
          }],
          dimension: { width: 1080, height: 1920 },
        }),
      });
      const json = await res.json();

      if (json.error || !json.data?.video_id) {
        throw new Error(json.error?.message || json.error || "No video_id returned");
      }

      task.result_video_id = json.data.video_id;
      task.updated_at = new Date().toISOString();
      writeTaskFile("avatar-tasks.json", tasks);
      console.log(`[WORKER] Avatar task ${task.id} submitted to HeyGen: ${json.data.video_id}`);
    } catch (e) {
      console.error(`[WORKER] Avatar task ${task.id} failed:`, e.message);
      task.status = "failed";
      task.error = e.message;
      task.updated_at = new Date().toISOString();
      writeTaskFile("avatar-tasks.json", tasks);
      processingTasks.delete(task.id);
    }
  }
}

async function processVideoAgentTasks() {
  const tasks = readTaskFile("video-agent-tasks.json");
  for (const task of tasks) {
    if (task.status !== "pending" || processingTasks.has(task.id)) continue;
    processingTasks.add(task.id);
    console.log(`[WORKER] Processing video agent task ${task.id}`);

    try {
      task.status = "processing";
      task.updated_at = new Date().toISOString();
      writeTaskFile("video-agent-tasks.json", tasks);

      const body = { prompt: task.prompt };
      const config = {};
      if (task.duration_sec) config.duration_sec = task.duration_sec;
      if (task.orientation) config.orientation = task.orientation;
      if (task.avatar_id) config.avatar_id = task.avatar_id;
      if (Object.keys(config).length) body.config = config;

      const res = await fetch("https://api.heygen.com/v1/video_agent/generate", {
        method: "POST",
        headers: HEYGEN_HEADERS,
        body: JSON.stringify(body),
      });
      const json = await res.json();

      if (json.error || !json.data?.video_id) {
        throw new Error(json.error?.message || json.error || "No video_id returned");
      }

      task.result_video_id = json.data.video_id;
      task.updated_at = new Date().toISOString();
      writeTaskFile("video-agent-tasks.json", tasks);
      console.log(`[WORKER] Video agent task ${task.id} submitted to HeyGen: ${json.data.video_id}`);
    } catch (e) {
      console.error(`[WORKER] Video agent task ${task.id} failed:`, e.message);
      task.status = "failed";
      task.error = e.message;
      task.updated_at = new Date().toISOString();
      writeTaskFile("video-agent-tasks.json", tasks);
      processingTasks.delete(task.id);
    }
  }
}

// Poll HeyGen for video completion
async function pollVideoStatus() {
  const taskFiles = [
    { file: "avatar-tasks.json", label: "avatar" },
    { file: "video-agent-tasks.json", label: "video-agent" },
  ];

  for (const { file, label } of taskFiles) {
    const tasks = readTaskFile(file);
    let changed = false;

    for (const task of tasks) {
      if (task.status !== "processing" || !task.result_video_id) continue;

      try {
        const res = await fetch(`https://api.heygen.com/v2/videos/${task.result_video_id}`, {
          headers: { "X-Api-Key": HEYGEN_KEY },
        });
        const json = await res.json();
        const video = json.data;

        if (video.status === "completed") {
          task.status = "completed";
          task.result_url = video.video_url || null;
          task.updated_at = new Date().toISOString();
          changed = true;
          processingTasks.delete(task.id);
          console.log(`[WORKER] ${label} task ${task.id} completed: ${task.result_url}`);
        } else if (video.status === "failed") {
          task.status = "failed";
          task.error = video.failure_message || "Video generation failed";
          task.updated_at = new Date().toISOString();
          changed = true;
          processingTasks.delete(task.id);
          console.error(`[WORKER] ${label} task ${task.id} failed: ${task.error}`);
        }
      } catch (e) {
        console.error(`[WORKER] Poll error for ${label} task ${task.id}:`, e.message);
      }
    }

    if (changed) writeTaskFile(file, tasks);
  }
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

      const prompt = `Je bent een professionele scriptwriter voor een trading platform.

Schrijf een ${task.format || "short-form"} ${task.type || "video_script"} over: ${task.topic}

Extra context: ${task.description}

Toon: ${task.tone || "educational"}
Stijl: Professioneel maar toegankelijk. Geen hype. Data-driven.

${task.type === "video_script" ? "Formaat het als een spreekscript met duidelijke pauzes en secties. Voeg [SCENE] markers toe voor visuele overgangen." : ""}
${task.format === "short-form" ? "Houd het kort: max 60 seconden spreektijd (~150 woorden)." : ""}
${task.format === "hook" ? "Schrijf 5 verschillende hooks/openers die direct de aandacht pakken." : ""}`;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
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
      const prompt = `${isNL ? "Je bent een researcher en content strategist" : "You are a researcher and content strategist"} voor ${brand.company_name} — een trading platform.

${isNL ? "BELANGRIJK: Schrijf het VOLLEDIGE rapport in het Nederlands. Alle secties, analyses, suggesties, captions, tweets en beschrijvingen moeten in het Nederlands zijn. Alleen merknamen, platformnamen en technische termen (Bitcoin, Ethereum, DeFi, etc.) mogen in het Engels blijven." : "IMPORTANT: Write the FULL report in English."}

## ${isNL ? "Research opdracht" : "Research assignment"}
${isNL ? "Onderwerp" : "Topic"}: ${task.query}
${isNL ? "Type" : "Type"}: ${task.type || "trending"}
${isNL ? "Platformen" : "Platforms"}: ${(task.platforms || ["tiktok", "x", "reddit"]).join(", ")}
Niche: ${task.niche || "crypto trading"}

## ${isNL ? "Instructies" : "Instructions"}
${isNL ? "Gebruik web search om actuele informatie te vinden over dit onderwerp." : "Use web search to find current information about this topic."}

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

      const researchParams = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      };

      let response = await anthropic.messages.create(researchParams);

      // Handle tool use loop for web search
      let loops = 0;
      while (response.stop_reason === "tool_use" && loops < 8) {
        loops++;
        const msgs = [{ role: "user", content: prompt }, { role: "assistant", content: response.content }];
        const toolResults = response.content
          .filter(b => b.type === "server_tool_use")
          .map(b => ({ type: "tool_result", tool_use_id: b.id, content: b.content || "" }));
        if (toolResults.length) msgs.push({ role: "user", content: toolResults });
        response = await anthropic.messages.create({ ...researchParams, messages: msgs });
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

// ── ANALYST WORKER (Claude + Bot Data) ──
async function processAnalystTasks() {
  const tasks = readTaskFile("analyst-tasks.json");
  for (const task of tasks) {
    if (task.status !== "pending" || processingTasks.has(task.id)) continue;
    processingTasks.add(task.id);
    console.log(`[WORKER] Processing analyst task ${task.id}`);

    try {
      task.status = "processing";
      task.updated_at = new Date().toISOString();
      writeTaskFile("analyst-tasks.json", tasks);

      // Gather bot data
      let botData = {};
      try {
        const botRes = await fetch("http://localhost:3000/api/status");
        botData = await botRes.json();
      } catch {}

      let tradeData = {};
      for (const [id, file] of Object.entries(TRADE_FILES)) {
        try { tradeData[id] = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch { tradeData[id] = []; }
      }

      const botContext = Object.entries(botData).filter(([,b]) => b.name).map(([id, b]) =>
        `${b.name}: ${b.online ? "ONLINE" : "OFFLINE"} | Equity: $${(b.accountValue||0).toFixed(2)} | Day PnL: $${(b.stats?.dailyPnl||0).toFixed(2)} | Total PnL: $${(b.stats?.totalPnl||0).toFixed(2)} | Trades: ${b.stats?.totalTrades||0} | WR: ${b.stats?.winRate||0}% | Positions: ${b.positions?.length||0}`
      ).join("\n");

      const tradeContext = Object.entries(tradeData).map(([id, trades]) => {
        const recent = trades.slice(0, 10);
        return `${id} (laatste ${recent.length} trades):\n${recent.map(t => `  ${t.symbol || "?"} ${t.side || "?"} | PnL: $${(t.pnl||0).toFixed(2)} | ${t.timestamp || ""}`).join("\n")}`;
      }).join("\n\n");

      const prompt = `Je bent een trading analyst. Analyseer de volgende data en geef een rapport.

Opdracht: ${task.description}
Type: ${task.type || "daily_report"}

LIVE BOT STATUS:
${botContext || "Geen bot data beschikbaar"}

RECENTE TRADES:
${tradeContext || "Geen trade data beschikbaar"}

Geef een gestructureerd rapport met:
${task.type === "daily_report" ? "1. Dagelijkse samenvatting\n2. Bot performance per bot\n3. Opvallende trades\n4. Risico-indicatoren\n5. Aanbevelingen" : ""}
${task.type === "performance" ? "1. Performance metrics per bot\n2. Win rate analyse\n3. PnL breakdown\n4. Vergelijking tussen bots\n5. Verbeterpunten" : ""}
${task.type === "risk" ? "1. Huidige risico-exposure\n2. Drawdown analyse\n3. Positie-concentratie\n4. Volatiliteitsrisico\n5. Aanbevelingen voor risicovermindering" : ""}
${task.type === "strategy" ? "1. Strategie-evaluatie per bot\n2. Marktcondities analyse\n3. Parameter optimalisatie suggesties\n4. Nieuwe kansen\n5. Strategische aanbevelingen" : ""}

Schrijf in het Nederlands. Wees data-driven en direct.`;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });

      const result = response.content[0]?.text || "";

      // Store result in task
      task.status = "completed";
      task.result = result;
      task.updated_at = new Date().toISOString();
      writeTaskFile("analyst-tasks.json", tasks);
      processingTasks.delete(task.id);
      console.log(`[WORKER] Analyst task ${task.id} completed`);
    } catch (e) {
      console.error(`[WORKER] Analyst task ${task.id} failed:`, e.message);
      task.status = "failed";
      task.error = e.message;
      task.updated_at = new Date().toISOString();
      writeTaskFile("analyst-tasks.json", tasks);
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
        model: "claude-sonnet-4-20250514",
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

// Run workers every 15 seconds
setInterval(() => {
  processAvatarTasks().catch(e => console.error("[WORKER] Avatar error:", e.message));
  processVideoAgentTasks().catch(e => console.error("[WORKER] Video agent error:", e.message));
  processScriptwriterTasks().catch(e => console.error("[WORKER] Scriptwriter error:", e.message));
  processResearchTasks().catch(e => console.error("[WORKER] Research error:", e.message));
  processAnalystTasks().catch(e => console.error("[WORKER] Analyst error:", e.message));
  processDesignerTasks().catch(e => console.error("[WORKER] Designer error:", e.message));
}, 15_000);

// Poll video status every 30 seconds
setInterval(() => {
  pollVideoStatus().catch(e => console.error("[WORKER] Poll error:", e.message));
}, 30_000);

// Run once on startup
setTimeout(() => {
  processAvatarTasks().catch(() => {});
  processVideoAgentTasks().catch(() => {});
  processScriptwriterTasks().catch(() => {});
  processResearchTasks().catch(() => {});
  processAnalystTasks().catch(() => {});
  processDesignerTasks().catch(() => {});
  pollVideoStatus().catch(() => {});
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

    const result = {
      mrr: { value: mrr },
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

// ── CRON JOBS ENDPOINT ──
const { execSync } = require("child_process");
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
    agent: req.body.agent || "designer",       // designer, researcher, analyst, scriptwriter
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
    } else if (schedule.agent === "analyst") {
      await executeAnalystSchedule(schedule, today);
    } else if (schedule.agent === "scriptwriter") {
      await executeScriptwriterSchedule(schedule, today);
    } else if (schedule.agent === "marketeer") {
      await executeMarketeerSchedule(schedule, today);
    } else if (schedule.agent === "assistant") {
      await executeAssistantSchedule(schedule, today);
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

async function executeAnalystSchedule(schedule, today) {
  const p = schedule.payload;
  const tasks = readTaskFile("analyst-tasks.json");
  const taskId = genId();
  tasks.unshift({
    id: taskId, status: "pending",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    type: p.type || "daily_diagnose",
    description: p.description || "Dagelijkse bot diagnose en performance analyse",
    error: null,
  });
  writeTaskFile("analyst-tasks.json", tasks);

  const schedules = readTaskFile("scheduled-tasks.json");
  const idx = schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) {
    schedules[idx].last_run = new Date().toISOString();
    schedules[idx].last_task_id = taskId;
    writeTaskFile("scheduled-tasks.json", schedules);
  }
  console.log(`[SCHEDULER] Analyst task created: ${taskId}`);
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
      headers: { "Content-Type": "application/json", "x-internal": "telegram" },
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
      headers: { "Content-Type": "application/json", "x-internal": "telegram" },
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

const PORT = 3004;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`CTRL API running on port ${PORT}`);
  console.log(`[WORKER] Task workers active — polling every 15s, status check every 30s`);
  const schedules = readTaskFile("scheduled-tasks.json");
  const active = schedules.filter(s => s.enabled).length;
  console.log(`[SCHEDULER] ${active} active scheduled task(s) loaded`);
});
