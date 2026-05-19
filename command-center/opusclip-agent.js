// ── OPUSCLIP AGENT ───────────────────────────────────────
// Thin wrapper around the OpusClip API:
//   POST /api/clip-projects                 → submit long-form video URL
//   GET  /api/clip-projects/{projectId}     → poll stage
//   GET  /api/exportable-clips?q=findByProjectId&projectId=…  → list clips

const BASE_URL = "https://api.opus.pro";
const TIMEOUT_MS = 30000;

function getKey() {
  const k = process.env.OPUSCLIP_API_KEY;
  if (!k) throw new Error("OPUSCLIP_API_KEY is not configured. Add it in Settings.");
  return k;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function apiRequest(method, path, body) {
  const res = await fetchWithTimeout(BASE_URL + path, {
    method,
    headers: {
      "Authorization": `Bearer ${getKey()}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text || `${res.status} ${res.statusText}`;
    throw new Error(`OpusClip ${method} ${path} failed: ${msg}`);
  }
  return data;
}

// ── Create a clipping project ────────────────────────────
async function createProject({ videoUrl, minDuration, maxDuration, sourceLang, topicKeywords }) {
  const body = { videoUrl };
  const curationPref = {};
  const min = Number(minDuration);
  const max = Number(maxDuration);
  if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min) {
    curationPref.clipDurations = [[min, max]];
  }
  if (Array.isArray(topicKeywords) && topicKeywords.length) {
    curationPref.topicKeywords = topicKeywords;
  }
  if (Object.keys(curationPref).length) body.curationPref = curationPref;
  if (sourceLang) body.importPref = { sourceLang };
  return apiRequest("POST", "/api/clip-projects", body);
}

// ── Poll project status ──────────────────────────────────
async function getProject(projectId) {
  return apiRequest("GET", `/api/clip-projects/${encodeURIComponent(projectId)}`);
}

// ── List finished clips for a project ────────────────────
async function listClips(projectId) {
  const path = `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}&pageSize=50`;
  const data = await apiRequest("GET", path);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

const TERMINAL_STAGES = new Set(["COMPLETE", "STALLED", "FAILED"]);
function isTerminal(stage) { return TERMINAL_STAGES.has(String(stage || "").toUpperCase()); }

module.exports = { createProject, getProject, listClips, isTerminal };
