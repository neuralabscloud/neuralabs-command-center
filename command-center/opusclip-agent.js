// ── OPUSCLIP AGENT ───────────────────────────────────────
// Wrapper around the OpusClip API (https://api.opus.pro):
//   POST   /api/clip-projects                → submit long-form video URL
//   GET    /api/clip-projects/{projectId}    → poll stage
//   GET    /api/exportable-clips?q=findByProjectId&projectId=…  → list clips
//   GET    /api/brand-templates?q=mine       → list brand templates
//   GET    /api/social-accounts?q=mine       → connected social destinations
//   POST   /api/social-copy-jobs             → AI post copy for a clip
//   GET    /api/social-copy-jobs/{jobId}     → poll copy job
//   POST   /api/post-tasks                   → publish a clip instantly
//   POST   /api/publish-schedules            → schedule a clip post
//   DELETE /api/publish-schedules/{id}       → cancel a scheduled post

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
    const msg = (data && (data.message || data.error || data.errorMessage)) || text || `${res.status} ${res.statusText}`;
    throw new Error(`OpusClip ${method} ${path} failed: ${msg}`);
  }
  return data;
}

function unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

// Clip ids come back in composite form ("{projectId}.{clipId}") from some
// endpoints; the posting endpoints want only the bare part after the dot.
function bareClipId(id) {
  const s = String(id || "");
  return s.includes(".") ? s.split(".").pop() : s;
}

// ── Create a clipping project ────────────────────────────
// model: "ClipBasic" (talking-head) | "ClipAnything" (any genre, steerable
// with customPrompt). aspectRatio: "portrait" | "square" | "landscape".
// webhookUrl: registered as a WEBHOOK conclusionAction so OpusClip calls us
// back when processing finishes (polling stays as fallback).
async function createProject({
  videoUrl, minDuration, maxDuration, sourceLang, topicKeywords,
  model, customPrompt, brandTemplateId, aspectRatio, webhookUrl,
}) {
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
  if (model === "ClipBasic" || model === "ClipAnything") curationPref.model = model;
  if (customPrompt) curationPref.customPrompt = String(customPrompt);
  if (Object.keys(curationPref).length) body.curationPref = curationPref;
  if (sourceLang) body.importPref = { sourceLang };
  if (brandTemplateId) body.brandTemplateId = brandTemplateId;
  if (["portrait", "square", "landscape"].includes(aspectRatio)) {
    body.renderPref = { layoutAspectRatio: aspectRatio };
  }
  if (webhookUrl) {
    body.conclusionActions = [{ type: "WEBHOOK", url: webhookUrl, notifyFailure: true }];
  }
  return apiRequest("POST", "/api/clip-projects", body);
}

// ── Poll project status ──────────────────────────────────
async function getProject(projectId) {
  return apiRequest("GET", `/api/clip-projects/${encodeURIComponent(projectId)}`);
}

// ── List finished clips for a project ────────────────────
async function listClips(projectId) {
  const path = `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}&pageSize=50`;
  return unwrapList(await apiRequest("GET", path));
}

// ── Brand templates (reusable clip styling) ──────────────
async function listBrandTemplates() {
  return unwrapList(await apiRequest("GET", "/api/brand-templates?q=mine"));
}

// ── Connected social accounts ────────────────────────────
// Each entry: { postAccountId, subAccountId?, platform, extUserName, … }
// platform ∈ YOUTUBE | TIKTOK_BUSINESS | FACEBOOK_PAGE | INSTAGRAM_BUSINESS |
//            LINKEDIN | TWITTER
async function getSocialAccounts() {
  return unwrapList(await apiRequest("GET", "/api/social-accounts?q=mine"));
}

// ── AI social copy for a clip ────────────────────────────
async function createSocialCopyJob({ projectId, clipId, postAccountId, subAccountId, prompt, forceRegenerate }) {
  const body = {
    projectId,
    clipId: bareClipId(clipId),
    postAccountId,
  };
  if (subAccountId) body.subAccountId = subAccountId;
  if (prompt) body.prompt = String(prompt);
  if (forceRegenerate) body.forceRegenerate = true;
  const data = await apiRequest("POST", "/api/social-copy-jobs", body);
  return (data && data.data) || data; // { jobId }
}

async function getSocialCopyJob(jobId) {
  const data = await apiRequest("GET", `/api/social-copy-jobs/${encodeURIComponent(jobId)}`);
  return (data && data.data) || data; // { jobId, status: RUNNING|COMPLETED|FAILED, title, description, hashtags }
}

// ── Publish / schedule a clip to a connected account ─────
function buildPostBody({ projectId, clipId, postAccountId, subAccountId, title, description, privacy }) {
  const body = {
    projectId,
    clipId: bareClipId(clipId),
    postAccountId,
    postDetail: { title: String(title || "Clip").slice(0, 200) },
  };
  if (subAccountId) body.subAccountId = subAccountId;
  const custom = {};
  if (description) custom.description = String(description);
  if (["public", "private", "unlisted"].includes(privacy)) custom.privacy = privacy;
  if (Object.keys(custom).length) body.postDetail.custom = custom;
  return body;
}

async function publishPost(opts) {
  const data = await apiRequest("POST", "/api/post-tasks", buildPostBody(opts));
  return (data && data.data) || data; // { postId }
}

async function schedulePost(opts) {
  const body = buildPostBody(opts);
  body.publishAt = new Date(opts.publishAt).toISOString();
  const data = await apiRequest("POST", "/api/publish-schedules", body);
  return (data && data.data) || data; // { scheduleId }
}

async function cancelScheduledPost(scheduleId) {
  return apiRequest("DELETE", `/api/publish-schedules/${encodeURIComponent(scheduleId)}`);
}

const TERMINAL_STAGES = new Set(["COMPLETE", "STALLED", "FAILED"]);
function isTerminal(stage) { return TERMINAL_STAGES.has(String(stage || "").toUpperCase()); }

module.exports = {
  createProject, getProject, listClips, isTerminal, bareClipId,
  listBrandTemplates, getSocialAccounts,
  createSocialCopyJob, getSocialCopyJob,
  publishPost, schedulePost, cancelScheduledPost,
};
