// Evergreen pool loader. Minimal YAML subset: list of flat maps, JSON for [..] / {..} values.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "evergreen.yaml");

function scalar(v) {
  const s = v.trim();
  if (s === "") return "";
  if (/^["[{]/.test(s)) {
    try { return JSON.parse(s); } catch {}
    if (s.startsWith("[")) return s.slice(1, -1).split(",").map(x => x.trim()).filter(Boolean).map(scalar);
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  if (s === "null") return null;
  return s;
}

function parse(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = raw.match(/^(\s*)(-\s+)?([A-Za-z_][\w]*):\s?(.*)$/);
    if (!m) throw new Error(`evergreen.yaml: onleesbare regel: ${raw.slice(0, 60)}`);
    if (m[2]) { cur = {}; out.push(cur); }
    if (!cur) throw new Error("evergreen.yaml: sleutel buiten item");
    cur[m[3]] = scalar(m[4]);
  }
  return out;
}

function load(file = FILE) {
  return parse(fs.readFileSync(file, "utf8")).map(e => ({
    kind: "evergreen", id: e.id, source: e.source, url: e.url, title: e.title, summary: e.summary,
    published_at: e.date ? new Date(`${e.date}T00:00:00Z`).toISOString() : null,
    numbers: (e.numbers || []).map(n => ({ raw: String(n), value: n })),
    entities: e.entities || [], layouts: e.layouts || ["signal"],
    series: e.series || null, versus: e.versus || null, topic: e.topic || null,
  }));
}

module.exports = { FILE, parse, load };
