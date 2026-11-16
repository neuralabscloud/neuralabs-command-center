// Small fetch helpers for the news-card sources: timeout, size cap, fixed UA, host allowlist (SSRF).
const UA = "Mozilla/5.0 (compatible; gh0stlayer-newscards/1.0)";

async function get(url, { timeout = 15000, maxBytes = 3e6, allowHosts = null, headers = {}, method = "GET", body } = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`protocol ${u.protocol}`);
  if (allowHosts && !allowHosts.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))) throw new Error(`host niet toegestaan: ${u.hostname}`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(u, { method, body, headers: { "user-agent": UA, accept: "*/*", ...headers }, redirect: "follow", signal: ctl.signal });
    if (allowHosts) {
      const f = new URL(res.url);
      if (!allowHosts.some(h => f.hostname === h || f.hostname.endsWith(`.${h}`))) throw new Error(`redirect naar ${f.hostname}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { ctl.abort(); throw new Error(`te groot (> ${maxBytes} bytes)`); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { clearTimeout(timer); }
}
async function getJson(url, opts) { return JSON.parse(await get(url, opts)); }
async function postJson(url, payload, opts = {}) {
  return JSON.parse(await get(url, { ...opts, method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json", ...(opts.headers || {}) } }));
}

module.exports = { UA, get, getJson, postJson };
