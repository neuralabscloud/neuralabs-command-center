import { defineConfig } from "vite";
import path from "path";
import type { Connect } from "vite";

function authMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    // Allow static assets, vite internals, login page, and API proxy routes
    const url = req.url || "";
    const apiPrefixes = ["/auth/", "/api/", "/designer/", "/video/", "/avatar/", "/analyst/",
      "/research/", "/media/", "/scriptwriter/", "/notifications", "/ctrl/", "/video-agent/",
      "/heygen/", "/stripe/", "/system/", "/canva/", "/settings/", "/brands", "/brand-assets",
      "/generated-images", "/video-projects", "/video-projects-static",
      "/social/", "/ads/"];
    if (
      url.startsWith("/@") ||
      url.startsWith("/node_modules") ||
      url.startsWith("/src") ||
      url.includes(".") && !url.endsWith(".html") ||
      url === "/login.html" ||
      apiPrefixes.some(p => url.startsWith(p))
    ) {
      return next();
    }

    // Parse cc_session cookie
    const cookies = (req.headers.cookie || "").split(";").reduce((acc: Record<string, string>, c) => {
      const [k, ...v] = c.trim().split("=");
      if (k) acc[k] = v.join("=");
      return acc;
    }, {});

    const token = cookies["cc_session"];
    if (!token) {
      (res as any).writeHead(302, { Location: "/login.html" });
      (res as any).end();
      return;
    }

    // Verify session with API server
    try {
      const check = await fetch("http://localhost:3004/auth/check", {
        headers: { Cookie: `cc_session=${token}` },
      });
      const data = await check.json() as { authenticated: boolean };
      if (data.authenticated) return next();
    } catch {}

    (res as any).writeHead(302, { Location: "/login.html" });
    (res as any).end();
  };
}

export default defineConfig({
  server: {
    allowedHosts: true,
    proxy: {
      "/api/settings": "http://localhost:3004",
      "/api/setup-status": "http://localhost:3004",
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3004",
      "/designer/tasks": "http://localhost:3004",
      "/video/tasks": "http://localhost:3004",
      "/avatar/tasks": "http://localhost:3004",
      "/analyst/tasks": "http://localhost:3004",
      "/analyst/trades": "http://localhost:3004",
      "/analyst/daily-report": "http://localhost:3004",
      "/research/tasks": "http://localhost:3004",
      "/research/reports": "http://localhost:3004",
      "/research/daily": "http://localhost:3004",
      "/media/list": "http://localhost:3004",
      "/media/upload": "http://localhost:3004",
      "/scriptwriter/tasks": "http://localhost:3004",
      "/notifications": "http://localhost:3004",
      "/ctrl/chat": "http://localhost:3004",
      "/video-agent/tasks": "http://localhost:3004",
      "/heygen/avatars": "http://localhost:3004",
      "/stripe": "http://localhost:3004",
      "/system": "http://localhost:3004",
      "/canva": "http://localhost:3004",
      "/settings/integrations": "http://localhost:3004",
      "/settings/services": "http://localhost:3004",
      "/video/ai-generate": "http://localhost:3004",
      "/brands": "http://localhost:3004",
      "/brand-assets": "http://localhost:3004",
      "/brand": "http://localhost:3004",
      "/video-projects": "http://localhost:3004",
      "/video-projects-static": "http://localhost:3004",
      "/generated-images": "http://localhost:3004",
      "/scheduled-tasks": "http://localhost:3004",
      "/social": "http://localhost:3004",
      "/ads/": "http://localhost:3004",
    },
  },
  plugins: [
    {
      name: "auth-guard",
      configureServer(server) {
        server.middlewares.use(authMiddleware());
      },
    },
  ],
  resolve: {
    alias: {
      "@editor": path.resolve(__dirname, "src/editor"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        login: path.resolve(__dirname, "login.html"),
        research: path.resolve(__dirname, "research.html"),
        performance: path.resolve(__dirname, "performance.html"),
        ads: path.resolve(__dirname, "ads.html"),
        agents: path.resolve(__dirname, "agents.html"),
        editor: path.resolve(__dirname, "editor.html"),
        designer: path.resolve(__dirname, "designer.html"),
        analyst: path.resolve(__dirname, "analyst.html"),
        contentcreator: path.resolve(__dirname, "content-creator.html"),
        scriptwriter: path.resolve(__dirname, "scriptwriter.html"),
        chat: path.resolve(__dirname, "chat.html"),
        settings: path.resolve(__dirname, "settings.html"),
      },
    },
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});
