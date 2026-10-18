// Buffer (buffer.com) scheduling over its GraphQL API.
// Key: BUFFER_API_KEY in .env (publish.buffer.com/settings/api).
//
// Used by the weekly character video batch: every finished clip becomes one
// custom-scheduled post per selected channel, on the clip's own day at a fixed
// local time. Buffer fetches the video from a public URL, so the caller passes
// a signed link (see /share/video in api-server.js).
// Pure helpers are exported for tests; network goes through gql().

const ENDPOINT = "https://api.buffer.com";

function apiKey() {
  return (process.env.BUFFER_API_KEY || "").trim();
}

async function gql(query, variables = {}, { fetchImpl = fetch } = {}) {
  const key = apiKey();
  if (!key) throw new Error("BUFFER_API_KEY is not set");
  const r = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.errors?.length) {
    const msg = d.errors?.map(e => e.message).join("; ") || `HTTP ${r.status}`;
    throw new Error(`Buffer: ${msg}`.slice(0, 400));
  }
  return d.data;
}

async function account(opts) {
  const d = await gql(`{ account { id timezone organizations { id name } } }`, {}, opts);
  return d.account;
}

async function channels(opts) {
  const acc = await account(opts);
  const out = [];
  for (const org of acc.organizations || []) {
    const d = await gql(`query($o: OrganizationId!) { channels(input: { organizationId: $o }) { id name displayName service type isDisconnected isLocked } }`,
      { o: org.id }, opts);
    for (const c of d.channels || []) out.push({ ...c, organization_id: org.id, organization: org.name });
  }
  return { timezone: acc.timezone, channels: out };
}

// Offset of `tz` at instant `date`, in minutes (Amsterdam summer = +120).
function tzOffsetMin(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// "2026-10-19" + "18:00" in Europe/Amsterdam → Date (DST-proof: the offset is
// taken at the target moment, corrected once for days that switch).
function zonedTime(dateStr, hhmm, tz) {
  const [h, mi] = String(hhmm || "18:00").split(":").map(Number);
  const guess = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), h || 0, mi || 0);
  let t = guess - tzOffsetMin(new Date(guess), tz) * 60000;
  t = guess - tzOffsetMin(new Date(t), tz) * 60000;
  return new Date(t);
}

// Config from the batch payload: { enabled, channels: [ids], time: "HH:MM" }.
function configOf(payload = {}) {
  const b = payload.buffer || {};
  const ids = (Array.isArray(b.channels) ? b.channels : String(b.channels || "").split(","))
    .map(s => String(s).trim()).filter(Boolean);
  return {
    enabled: b.enabled === true || b.enabled === "true",
    channels: [...new Set(ids)],
    time: /^\d{1,2}:\d{2}$/.test(String(b.time || "")) ? String(b.time) : "18:00",
  };
}

// Instagram and TikTok both cap captions at 2200 characters.
function captionFor(slot, max = 2200) {
  const text = String(slot.caption || slot.caption_line || "").replace(/[—–]/g, ",").trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function metadataFor(service, slot) {
  if (service === "instagram") return { instagram: { type: "reel", shouldShareToFeed: true, isAiGenerated: true } };
  if (service === "tiktok") return { tiktok: { isAiGenerated: true } };
  if (service === "youtube") {
    const title = String(slot.caption_line || slot.onscreen_text || "").replace(/[—–]/g, ",").slice(0, 100);
    return { youtube: { ...(title ? { title } : {}), categoryId: "22", isAiGenerated: true } };
  }
  return undefined;
}

function postInput({ channelId, service, slot, videoUrl, thumbnailUrl, dueAt }) {
  const video = { url: videoUrl };
  if (thumbnailUrl) video.thumbnailUrl = thumbnailUrl;
  const input = {
    channelId,
    text: captionFor(slot),
    assets: [{ video }],
    mode: "customScheduled",
    dueAt: dueAt.toISOString(),
    schedulingType: "automatic",
    needsApproval: false,
  };
  const md = metadataFor(service, slot);
  if (md) input.metadata = md;
  return input;
}

const CREATE = `mutation($input: CreatePostInput!) { createPost(input: $input) {
  __typename
  ... on PostActionSuccess { post { id dueAt status } }
  ... on MutationError { message }
} }`;

async function createPost(input, opts) {
  const d = await gql(CREATE, { input }, opts);
  const res = d.createPost || {};
  if (res.__typename !== "PostActionSuccess") throw new Error(`Buffer: ${res.message || res.__typename || "createPost failed"}`);
  return res.post;
}

async function deletePost(id, opts) {
  const d = await gql(`mutation($input: DeletePostInput!) { deletePost(input: $input) { __typename ... on MutationError { message } } }`,
    { input: { id } }, opts);
  const t = d.deletePost?.__typename || "";
  if (/Error$/.test(t) && t !== "NotFoundError") throw new Error(`Buffer: ${d.deletePost.message || t}`);
  return true;
}

module.exports = { ENDPOINT, apiKey, gql, account, channels, tzOffsetMin, zonedTime, configOf, captionFor, metadataFor, postInput, createPost, deletePost };
