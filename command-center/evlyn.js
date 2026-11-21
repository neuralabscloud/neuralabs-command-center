// Evlyn: één gesprek met twee ingangen (overview-pagina en Telegram).
// Pure helpers: het gedeelde gespreksverloop, controle van afbeeldingen en de lijst van
// toegestane VPS-acties. Bedrading (routes, Telegram, Whisper, systemctl) staat in api-server.js.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── VPS-acties ───────────────────────────────────────────────────────────────
// Alleen deze app-diensten mag Evlyn starten, stoppen of herstarten. Dezelfde lijst staat in
// de polkit-regel (/etc/polkit-1/rules.d/49-evlyn-ops.rules): die dwingt het af, dit is de voorcontrole.
// Bewust niet: nginx, redis, postgres, docker, ssh, firewall en de Command Center zelf.
const UNIT_RE = /^(nc-[a-z-]+|raydar-(api|markets|pipeline|publisher|src-[a-z]+)|neuralabs-[a-z0-9-]+|neuraintel|metavers3-(academy|call)|defitracker-[a-z]+|gh0stlayer|slabhaus|arc-scan|rh-scan|solana-scan|marktanalyse|cpuwacht|neuratrade-chart)\.service$/;
// Alleen-lezen status mag ook van de basisdiensten.
const CORE_RE = /^(nginx|redis-server|redis-raydar|postgresql@16-main|command-center|neuradeck|docker|fail2ban)\.service$/;
const ACTIONS = ["restart", "start", "stop"];

function normUnit(u) {
  const s = String(u || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".service") ? s : s + ".service";
}
const canControl = unit => UNIT_RE.test(normUnit(unit));
const canInspect = unit => { const n = normUnit(unit); return UNIT_RE.test(n) || CORE_RE.test(n); };
function opAllowed(action, unit) {
  return ACTIONS.includes(String(action)) && canControl(unit);
}

// Uitvoer van `systemctl list-units --plain --no-legend` → [{unit, active, sub}], alleen wat Evlyn mag zien.
function parseUnits(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4 || !canInspect(p[0])) continue;
    out.push({ unit: p[0], active: p[2], sub: p[3], controllable: canControl(p[0]) });
  }
  return out;
}

// Uitvoer van `systemctl show -p ...` → object.
function parseShow(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

// Acties die op bevestiging van de eigenaar wachten. Eenmalig te gebruiken, verlopen vanzelf.
function createPending(ttlMs = 10 * 60 * 1000) {
  const map = new Map();
  return {
    add(data, now = Date.now()) {
      for (const [k, v] of map) if (v.exp < now) map.delete(k);
      const id = crypto.randomBytes(6).toString("hex");
      map.set(id, { data, exp: now + ttlMs });
      return id;
    },
    take(id, now = Date.now()) {
      const v = map.get(String(id));
      if (!v) return null;
      map.delete(String(id));
      return v.exp < now ? null : v.data;
    },
    size: () => map.size,
  };
}

// ── Afbeeldingen ─────────────────────────────────────────────────────────────
// Type bepalen aan de eerste bytes, niet aan naam of opgegeven type. SVG en al het andere: null.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
const MEDIA_NAME_RE = /^[a-f0-9]{20}\.jpg$/;
const newMediaName = () => crypto.randomBytes(10).toString("hex") + ".jpg";
const validMediaName = n => MEDIA_NAME_RE.test(String(n || ""));

// ── Gespreksverloop ──────────────────────────────────────────────────────────
// Wat beide kanten zien. Staat los van de API-geschiedenis (die bevat ook tool-berichten).
function createStore(file, max = 400) {
  let state = null;
  function load() {
    if (state) return state;
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      state = { seq: Number(j.seq) || 0, messages: Array.isArray(j.messages) ? j.messages : [] };
    } catch { state = { seq: 0, messages: [] }; }
    return state;
  }
  function save() {
    const tmp = file + ".tmp";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }
  return {
    add(m) {
      const s = load();
      const msg = {
        id: ++s.seq, ts: Date.now(),
        role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
        source: m.source === "telegram" ? "telegram" : "web",
        text: String(m.text || "").slice(0, 20000),
      };
      const images = (m.images || []).filter(validMediaName).slice(0, 4);
      if (images.length) msg.images = images;
      if (m.voice) msg.voice = true;
      if (m.action) msg.action = m.action;
      s.messages.push(msg);
      if (s.messages.length > max) s.messages.splice(0, s.messages.length - max);
      save();
      return msg;
    },
    // Wijzigt een bestaand bericht (status van een actiekaart). `rev` laat de pagina de wijziging zien.
    patch(id, fn) {
      const s = load();
      const msg = s.messages.find(x => x.id === Number(id));
      if (!msg) return null;
      fn(msg);
      msg.rev = ++s.seq;
      save();
      return msg;
    },
    // Alles wat nieuwer is dan `after` (nieuw bericht of gewijzigde kaart).
    since(after = 0) {
      const a = Number(after) || 0;
      return load().messages.filter(m => m.id > a || (m.rev || 0) > a);
    },
    cursor: () => load().seq,
    clear() { const s = load(); s.messages = []; s.seq += 1; save(); },
  };
}

// Oudere afbeeldingen uit de API-geschiedenis halen: ze kosten bij elke beurt opnieuw tokens.
function pruneImages(history, keepLast = 6) {
  const end = Math.max(0, history.length - keepLast);
  for (let i = 0; i < end; i++) {
    const m = history[i];
    if (!Array.isArray(m.content)) continue;
    m.content = m.content.map(b => (b && b.type === "image" ? { type: "text", text: "[afbeelding eerder gedeeld]" } : b));
  }
  return history;
}

// Telegram: lange tekst in stukken van hooguit `size` tekens, bij voorkeur op een regeleinde.
function chunkText(text, size = 4000) {
  const out = [];
  let rest = String(text || "");
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// Eenvoudige rem: hooguit `max` beurten per venster.
function createLimiter(max = 20, windowMs = 60000) {
  let hits = [];
  return (now = Date.now()) => {
    hits = hits.filter(t => now - t < windowMs);
    if (hits.length >= max) return false;
    hits.push(now);
    return true;
  };
}

module.exports = {
  UNIT_RE, CORE_RE, ACTIONS, normUnit, canControl, canInspect, opAllowed, parseUnits, parseShow, createPending,
  sniffImage, newMediaName, validMediaName, createStore, pruneImages, chunkText, createLimiter,
};
