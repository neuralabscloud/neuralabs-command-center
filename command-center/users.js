// Team users: extra logins next to the owner (CC_PASSWORD), each limited to a
// set of tools. A user only ever sees the items they created themselves; the
// owner sees everything. Pure helpers + a small JSON store, no Express here so
// the access rules can be tested without a server (scripts/test-users.js).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Tools a user can be given. `page` is the only HTML page they may open.
const TOOLS = {
  designer: { label: "Designer", page: "/designer.html" },
  "content-creator": { label: "Content Creator", page: "/content-creator.html" },
};

// ── Passwords (scrypt) ─────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(pw, stored) {
  const m = /^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(String(stored || ""));
  if (!m) return false;
  const want = Buffer.from(m[2], "hex");
  const got = crypto.scryptSync(String(pw), Buffer.from(m[1], "hex"), want.length);
  return crypto.timingSafeEqual(got, want);
}

// ── Validation ──────────────────────────────────
function normUsername(u) { return String(u || "").trim().toLowerCase(); }
function validUsername(u) { return /^[a-z0-9._-]{3,32}$/.test(u); }
function validPassword(pw) { return typeof pw === "string" && pw.length >= 8 && pw.length <= 200; }
function cleanTools(tools) {
  return [...new Set((Array.isArray(tools) ? tools : []).filter(t => TOOLS[t]))];
}

// ── Store (data/users.json, mode 600) ──────────
function createStore(file) {
  function read() {
    try { const l = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(l) ? l : []; }
    catch { return []; }
  }
  function write(list) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  return {
    list: read,
    get: id => read().find(u => u.id === id) || null,
    byUsername: name => read().find(u => u.username === normUsername(name)) || null,
    create({ username, name, password, tools }) {
      const uname = normUsername(username);
      if (!validUsername(uname)) throw new Error("Username: 3-32 characters, letters, digits, dot, dash or underscore.");
      if (!validPassword(password)) throw new Error("Password must be at least 8 characters.");
      const list = read();
      if (list.some(u => u.username === uname)) throw new Error("That username is already taken.");
      const user = {
        id: "u_" + crypto.randomBytes(6).toString("hex"),
        username: uname,
        name: String(name || "").trim().slice(0, 60) || uname,
        pw_hash: hashPassword(password),
        tools: cleanTools(tools),
        disabled: false,
        created_at: new Date().toISOString(),
        sessions_after: 0,
      };
      list.push(user);
      write(list);
      return user;
    },
    update(id, patch) {
      const list = read();
      const u = list.find(x => x.id === id);
      if (!u) return null;
      let revoke = false;
      if (patch.name !== undefined) u.name = String(patch.name || "").trim().slice(0, 60) || u.username;
      if (patch.tools !== undefined) { u.tools = cleanTools(patch.tools); revoke = true; }
      if (patch.disabled !== undefined) { u.disabled = !!patch.disabled; revoke = revoke || u.disabled; }
      if (patch.password !== undefined) {
        if (!validPassword(patch.password)) throw new Error("Password must be at least 8 characters.");
        u.pw_hash = hashPassword(patch.password);
        revoke = true;
      }
      // Changing rights or the password logs the user out everywhere.
      if (revoke) u.sessions_after = Date.now();
      write(list);
      return u;
    },
    markLogin(id) {
      const list = read();
      const u = list.find(x => x.id === id);
      if (u) { u.last_login = new Date().toISOString(); write(list); }
    },
    remove(id) {
      const list = read();
      const next = list.filter(u => u.id !== id);
      if (next.length === list.length) return false;
      write(next);
      return true;
    },
  };
}

// What the browser and the settings page get to see (never the hash).
function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, tools: u.tools || [], disabled: !!u.disabled, created_at: u.created_at, last_login: u.last_login || null };
}

// ── Access rules for a logged-in user ──────────
// kind:
//   allow  – pass through
//   list   – pass through, filter the JSON array to the user's own items (file)
//   own    – :id must belong to the user (file), else 404
//   media  – GET of a file; must be referenced by one of the user's own items
//   stub   – answer with `body` instead of the real route
//   brand  – /brand without the owner's external links
//   agents – /agents/overview with only the agent cards of the user's tools
// Anything not matched is denied.
const ANY = Object.keys(TOOLS);
const CC = ["content-creator"];
const DS = ["designer"];
const RULES = [
  ["GET", /^\/brand$/, ANY, { kind: "brand" }],
  ["GET", /^\/notifications\/unread-count$/, ANY, { kind: "stub", body: { count: 0 } }],
  ["GET", /^\/notifications$/, ANY, { kind: "stub", body: [] }],
  ["PATCH", /^\/notifications\/[^/]+\/read$/, ANY, { kind: "stub", body: { ok: true } }],
  ["POST", /^\/notifications\/read-all$/, ANY, { kind: "stub", body: { ok: true } }],
  ["POST", /^\/costs\/estimate$/, ANY, { kind: "allow" }],
  // Overview page (the landing page): own agent cards + server stats
  ["GET", /^\/agents\/overview$/, ANY, { kind: "agents" }],
  ["GET", /^\/system\/health$/, ANY, { kind: "allow" }],
  ["GET", /^\/settings\/services$/, ANY, { kind: "allow" }],

  // Designer (the Content Creator's "From Designer" picker reads the list too)
  ["GET", /^\/designer\/tasks$/, ANY, { kind: "list", file: "designer-tasks.json" }],
  ["POST", /^\/designer\/tasks$/, DS, { kind: "allow" }],
  ["GET", /^\/designer\/image-models$/, DS, { kind: "allow" }],
  ["PATCH", /^\/designer\/tasks\/([^/]+)$/, DS, { kind: "own", file: "designer-tasks.json" }],
  ["DELETE", /^\/designer\/tasks\/([^/]+)$/, DS, { kind: "own", file: "designer-tasks.json" }],
  ["POST", /^\/designer\/tasks\/([^/]+)\/enhance$/, DS, { kind: "own", file: "designer-tasks.json" }],
  ["GET", /^\/designer\/ref-library$/, DS, { kind: "list", file: "ref-library.json" }],
  ["POST", /^\/designer\/ref-library$/, DS, { kind: "allow" }],
  ["PATCH", /^\/designer\/ref-library\/([^/]+)$/, DS, { kind: "own", file: "ref-library.json" }],
  ["DELETE", /^\/designer\/ref-library\/([^/]+)$/, DS, { kind: "own", file: "ref-library.json" }],
  ["GET", /^\/designer\/ref-library\/file\/[^/]+$/, DS, { kind: "media" }],
  ["GET", /^\/designer\/edu\/status$/, DS, { kind: "stub", body: { running: false, schedule: null } }],

  // Content Creator
  ["GET", /^\/brands$/, CC, { kind: "stub", body: {} }],
  ["GET", /^\/audio\/voiceovers$/, CC, { kind: "list", file: "voiceover-tasks.json" }],
  ["POST", /^\/audio\/voiceovers$/, CC, { kind: "allow" }],
  ["DELETE", /^\/audio\/voiceovers\/([^/]+)$/, CC, { kind: "own", file: "voiceover-tasks.json" }],
  ["GET", /^\/influencer\/genjutsu\/rates$/, CC, { kind: "allow" }],
  ["GET", /^\/influencer\/genjutsu\/restyle-presets$/, CC, { kind: "allow" }],
  ["GET", /^\/influencer\/genjutsu$/, CC, { kind: "list", file: "ai-video-tasks.json" }],
  ["POST", /^\/influencer\/genjutsu$/, CC, { kind: "allow" }],
  // Clipper (OpusClip) is owner-only: the page still asks for these, so answer empty.
  ["GET", /^\/opusclip\/brand-templates$/, CC, { kind: "stub", body: [] }],
  ["GET", /^\/opusclip\/social-accounts$/, CC, { kind: "stub", body: [] }],
  ["GET", /^\/opusclip\/tasks$/, CC, { kind: "stub", body: [] }],
  ["GET", /^\/ugc\/avatars$/, CC, { kind: "list", file: "ugc-avatars.json" }],
  ["POST", /^\/ugc\/avatars$/, CC, { kind: "allow" }],
  ["POST", /^\/ugc\/avatars\/upload$/, CC, { kind: "allow" }],
  ["PATCH", /^\/ugc\/avatars\/([^/]+)$/, CC, { kind: "own", file: "ugc-avatars.json" }],
  ["DELETE", /^\/ugc\/avatars\/([^/]+)$/, CC, { kind: "own", file: "ugc-avatars.json" }],
  ["GET", /^\/ugc\/(motions|voices|voice-providers|video-engines)$/, CC, { kind: "allow" }],
  ["GET", /^\/ugc\/tasks$/, CC, { kind: "list", file: "ugc-tasks.json" }],
  ["POST", /^\/ugc\/tasks$/, CC, { kind: "allow" }],
  ["PATCH", /^\/ugc\/tasks\/([^/]+)$/, CC, { kind: "own", file: "ugc-tasks.json" }],
  ["DELETE", /^\/ugc\/tasks\/([^/]+)$/, CC, { kind: "own", file: "ugc-tasks.json" }],
  ["POST", /^\/ugc\/upload$/, CC, { kind: "allow" }],
  ["GET", /^\/video\/ai-generate$/, CC, { kind: "list", file: "ai-video-tasks.json" }],
  ["POST", /^\/video\/ai-generate$/, CC, { kind: "allow" }],
  ["DELETE", /^\/video\/ai-generate\/([^/]+)$/, CC, { kind: "own", file: "ai-video-tasks.json" }],
  ["POST", /^\/video\/tools$/, CC, { kind: "allow" }],
  ["GET", /^\/video\/tools\/youtube-cookies$/, CC, { kind: "allow" }],

  // Generated files: only those that belong to the user's own items.
  ["GET", /^\/(media|video-outputs|brand-assets)\//, ANY, { kind: "media" }],
];

function routeRule(method, p, tools) {
  const m = method === "HEAD" ? "GET" : method;
  for (const [rm, re, need, rule] of RULES) {
    if (rm !== m) continue;
    const hit = re.exec(p);
    if (!hit) continue;
    if (!need.some(t => (tools || []).includes(t))) return { kind: "deny" };
    return { ...rule, id: rule.kind === "own" ? decodeURIComponent(hit[1]) : undefined };
  }
  return { kind: "deny" };
}

// HTML pages: the overview (landing page) plus the pages of the user's tools.
// Anything else goes to the overview.
const OVERVIEW_PAGES = ["/", "/index.html"];
function pageFor(p, tools) {
  if (OVERVIEW_PAGES.includes(p)) return { ok: true };
  const allowed = (tools || []).map(t => TOOLS[t] && TOOLS[t].page).filter(Boolean);
  if (allowed.includes(p)) return { ok: true };
  return { ok: false, redirect: "/index.html" };
}

function isOwnedBy(item, userId) { return !!item && item.owner_user === userId; }

// Every local path ("/media/…") mentioned anywhere inside an item.
function collectPaths(obj, out = new Set(), depth = 0) {
  if (depth > 6 || obj == null) return out;
  if (typeof obj === "string") {
    if (obj.startsWith("/")) out.add(obj.split(/[?#]/)[0]);
    return out;
  }
  if (Array.isArray(obj)) { for (const v of obj) collectPaths(v, out, depth + 1); return out; }
  if (typeof obj === "object") for (const v of Object.values(obj)) collectPaths(v, out, depth + 1);
  return out;
}

// Mark items a user just created. Only items that are not on disk yet, have
// no owner and were created recently (a stale copy of an item the owner just
// deleted must not come back as the user's).
function stampNew(items, onDisk, userId, now = Date.now()) {
  if (!Array.isArray(items) || !userId) return items;
  const known = new Set((Array.isArray(onDisk) ? onDisk : []).map(t => t && t.id).filter(Boolean));
  for (const t of items) {
    if (!t || typeof t !== "object" || !t.id || known.has(t.id) || t.owner_user) continue;
    const created = Date.parse(t.created_at || t.createdAt || "");
    if (Number.isFinite(created) && now - created > 60 * 60 * 1000) continue;
    t.owner_user = userId;
  }
  return items;
}

// ── Sessions ───────────────────────────────────
// Token payload: "<ts36>.<rand>" for the owner, "<ts36>.<rand>.<userId>" for a user.
function tokenUserId(payload) {
  const parts = String(payload || "").split(".");
  return parts.length >= 3 ? parts.slice(2).join(".") : null;
}
function tokenTime(payload) { return parseInt(String(payload || "").split(".")[0], 36) || 0; }

// Simple failed-login throttle per IP: 10 failures per 15 minutes.
function createLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    blocked(ip, now = Date.now()) {
      const h = hits.get(ip);
      if (!h || now - h.first > windowMs) return false;
      return h.count >= max;
    },
    fail(ip, now = Date.now()) {
      const h = hits.get(ip);
      if (!h || now - h.first > windowMs) hits.set(ip, { first: now, count: 1 });
      else h.count++;
      if (hits.size > 5000) for (const [k, v] of hits) if (now - v.first > windowMs) hits.delete(k);
    },
    reset(ip) { hits.delete(ip); },
  };
}

// The owner's lists hide what team members made (their own galleries stay clean).
function isListRoute(method, p) {
  return routeRule(method, p, ANY).kind === "list";
}
function ownerView(items) {
  return Array.isArray(items) ? items.filter(t => !(t && t.owner_user)) : items;
}

module.exports = {
  TOOLS, hashPassword, verifyPassword, normUsername, validUsername, validPassword, cleanTools,
  createStore, publicUser, routeRule, pageFor, isOwnedBy, collectPaths, stampNew,
  tokenUserId, tokenTime, createLoginLimiter, isListRoute, ownerView,
};
