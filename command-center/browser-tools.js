// NeuraLabs — Browser tools (Playwright-backed)
// Provides browser automation tools for the /ctrl/chat agent and a one-shot
// `browsePage` helper for the Researcher. Uses playwright directly; no MCP
// protocol bridging, since the Anthropic tool_use API already covers the
// surface we need.

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

// ─── Session management ─────────────────────────────────────────
const BROWSER_TTL_MS = 10 * 60 * 1000; // auto-close after 10 min idle
const browserSessions = new Map(); // sessionId -> { browser, context, page, lastUsed }

async function getOrCreateBrowserSession(sessionId) {
  const existing = browserSessions.get(sessionId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const session = { browser, context, page, lastUsed: Date.now() };
  browserSessions.set(sessionId, session);
  return session;
}

async function closeBrowserSession(sessionId) {
  const s = browserSessions.get(sessionId);
  if (!s) return false;
  try { await s.browser.close(); } catch {}
  browserSessions.delete(sessionId);
  return true;
}

async function closeAllBrowserSessions() {
  for (const id of Array.from(browserSessions.keys())) {
    await closeBrowserSession(id);
  }
}

// Idle cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of browserSessions) {
    if (now - s.lastUsed > BROWSER_TTL_MS) {
      closeBrowserSession(id).catch(() => {});
    }
  }
}, 60 * 1000).unref?.();

// ─── Page snapshot: text + interactive element refs ─────────────
async function getPageSnapshot(page) {
  const data = await page.evaluate(() => {
    // Clean up old refs so we don't accumulate them across snapshots
    document.querySelectorAll("[data-click-ref]").forEach((e) => e.removeAttribute("data-click-ref"));

    const pickVisible = (els) => els.filter((e) => {
      if (!e) return false;
      const rect = e.getBoundingClientRect?.();
      return rect && (rect.width > 0 && rect.height > 0);
    });

    const links = pickVisible(Array.from(document.querySelectorAll("a[href]"))).slice(0, 60);
    links.forEach((el, i) => el.setAttribute("data-click-ref", "L" + i));

    const buttons = pickVisible(
      Array.from(document.querySelectorAll("button, [role=\"button\"], input[type=\"submit\"], input[type=\"button\"]"))
    ).slice(0, 40);
    buttons.forEach((el, i) => el.setAttribute("data-click-ref", "B" + i));

    const inputs = pickVisible(
      Array.from(document.querySelectorAll("input:not([type=\"submit\"]):not([type=\"button\"]):not([type=\"hidden\"]), textarea, select"))
    ).slice(0, 30);
    inputs.forEach((el, i) => el.setAttribute("data-click-ref", "I" + i));

    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 100);

    const linkList = links.map((a, i) => ({
      ref: "L" + i,
      text: norm(a.innerText),
      href: a.href,
    })).filter((l) => l.text || l.href);

    const buttonList = buttons.map((b, i) => ({
      ref: "B" + i,
      text: norm(b.innerText || b.value || b.getAttribute("aria-label") || ""),
    })).filter((b) => b.text);

    const inputList = inputs.map((inp, i) => {
      let label = "";
      if (inp.id) {
        const lbl = document.querySelector('label[for="' + inp.id + '"]');
        if (lbl) label = norm(lbl.innerText);
      }
      return {
        ref: "I" + i,
        type: inp.type || inp.tagName.toLowerCase(),
        name: inp.name || "",
        placeholder: inp.placeholder || "",
        label,
        value: (inp.value || "").slice(0, 80),
      };
    });

    // Main visible text (trim scripts/styles first)
    const scrap = document.body.cloneNode(true);
    scrap.querySelectorAll("script,style,noscript,svg").forEach((e) => e.remove());
    let mainText = (scrap.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    if (mainText.length > 5000) mainText = mainText.slice(0, 5000) + "\n... [truncated]";

    return {
      title: document.title,
      text: mainText,
      links: linkList,
      buttons: buttonList,
      inputs: inputList,
    };
  });

  return {
    url: page.url(),
    title: data.title,
    text: data.text,
    links: data.links,
    buttons: data.buttons,
    inputs: data.inputs,
  };
}

// ─── Tool handlers ──────────────────────────────────────────────
async function handleBrowserTool(sessionId, name, input) {
  try {
    if (name === "browser_close") {
      const closed = await closeBrowserSession(sessionId);
      return { ok: true, closed };
    }

    const s = await getOrCreateBrowserSession(sessionId);
    const page = s.page;

    switch (name) {
      case "browser_navigate": {
        if (!input.url) return { error: "Missing url" };
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        try { await page.waitForLoadState("networkidle", { timeout: 4000 }); } catch {}
        return await getPageSnapshot(page);
      }
      case "browser_snapshot": {
        return await getPageSnapshot(page);
      }
      case "browser_click": {
        if (input.ref) {
          await page.locator('[data-click-ref="' + input.ref + '"]').first().click({ timeout: 5000 });
        } else if (input.text) {
          await page.getByText(input.text, { exact: false }).first().click({ timeout: 5000 });
        } else {
          return { error: "Provide ref or text" };
        }
        try { await page.waitForLoadState("networkidle", { timeout: 3000 }); } catch {}
        return await getPageSnapshot(page);
      }
      case "browser_type": {
        if (!input.ref || input.text === undefined) return { error: "Provide ref and text" };
        const loc = page.locator('[data-click-ref="' + input.ref + '"]').first();
        await loc.fill(String(input.text), { timeout: 5000 });
        if (input.submit) {
          await loc.press("Enter");
          try { await page.waitForLoadState("networkidle", { timeout: 4000 }); } catch {}
        }
        return await getPageSnapshot(page);
      }
      case "browser_screenshot": {
        const imgDir = path.join(__dirname, "data", "generated-images");
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
        const fileName = "browser-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".png";
        const filePath = path.join(imgDir, fileName);
        await page.screenshot({ path: filePath, fullPage: !!input.full_page });
        return {
          url: "/generated-images/" + fileName,
          title: await page.title(),
          page_url: page.url(),
        };
      }
      default:
        return { error: "Unknown browser tool: " + name };
    }
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// ─── Tool schemas (Anthropic tool_use format) ───────────────────
const BROWSER_TOOLS = [
  {
    name: "browser_navigate",
    description:
      "Open a URL in a headless browser. Returns a page snapshot with title, URL, visible text, and interactive element refs you can use with browser_click / browser_type. Refs use prefix L (links), B (buttons), I (inputs). The same browser session persists across calls within a chat.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full http/https URL to navigate to" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Get a fresh snapshot of the current browser page. Use this after clicks or form interactions to see the new state and grab fresh element refs.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description:
      "Click an element on the current page. Provide either `ref` (an element ref from a previous snapshot such as 'L3' or 'B1') or `text` (click the first visible element whose text contains this). Returns a fresh snapshot.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from a previous snapshot, e.g. 'L0', 'B2'" },
        text: { type: "string", description: "Visible text to match (alternative to ref)" },
      },
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into an input/textarea on the current page. `ref` is the input ref from a snapshot (e.g. 'I0'). Set `submit: true` to press Enter afterwards (useful for search boxes). Returns a fresh snapshot.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Input ref from snapshot, e.g. 'I0'" },
        text: { type: "string", description: "Text to type into the field" },
        submit: { type: "boolean", description: "Press Enter after typing", default: false },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Take a screenshot of the current browser page, save it under /generated-images/, and return the URL path. Set full_page: true to capture the full scrollable height.",
    input_schema: {
      type: "object",
      properties: {
        full_page: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "browser_close",
    description:
      "Close the current browser session and free memory. Use when you are done browsing. A new session will be started automatically on the next browser_navigate call.",
    input_schema: { type: "object", properties: {} },
  },
];

// ─── One-shot page fetch (for Researcher agent) ─────────────────
// Simpler than the chat flow: open a URL, extract main text, close browser.
async function browsePage(url, { maxChars = 8000, waitMs = 1500 } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (waitMs) await page.waitForTimeout(waitMs);
    try { await page.waitForLoadState("networkidle", { timeout: 4000 }); } catch {}

    const data = await page.evaluate(() => {
      const scrap = document.body.cloneNode(true);
      scrap.querySelectorAll("script,style,noscript,svg,iframe").forEach((e) => e.remove());
      const main = scrap.querySelector("main, article, [role=\"main\"]") || scrap;
      const text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
      return {
        title: document.title,
        text,
        h1: Array.from(document.querySelectorAll("h1")).map((h) => (h.innerText || "").trim()).filter(Boolean).slice(0, 5),
      };
    });

    let text = data.text;
    if (text.length > maxChars) text = text.slice(0, maxChars) + "\n... [truncated, " + (data.text.length - maxChars) + " more chars]";

    return { url: page.url(), title: data.title, h1: data.h1, text };
  } finally {
    try { await browser.close(); } catch {}
  }
}

const BROWSE_PAGE_TOOL = {
  name: "browse_page",
  description:
    "Open a URL in a headless browser and return the main visible text content (title + article body). Use this to read news articles, blog posts, documentation, exchange dashboards and any JS-rendered site where a plain HTTP fetch would miss content. Each call launches a fresh browser — no interactive state. Complement to web_search: use web_search to find candidate URLs, then browse_page to actually read them.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full http/https URL to read" },
      max_chars: { type: "integer", description: "Max chars of extracted text to return (default 8000)", default: 8000 },
    },
    required: ["url"],
  },
};

module.exports = {
  BROWSER_TOOLS,
  BROWSE_PAGE_TOOL,
  handleBrowserTool,
  browsePage,
  closeBrowserSession,
  closeAllBrowserSessions,
};
