// News card account profiles: accounts/<name>.yaml. One code path, one profile per account.
// YAML subset (no library on this server): nested maps by indentation, "- item" lists of scalars,
// inline JSON for [..] / {..} / "..", and "key: |" block text. Comments start with #.
const fs = require("fs");
const path = require("path");

const DIR = __dirname;

function scalar(v) {
  const s = String(v).trim();
  if (s === "") return "";
  if (/^["[{]/.test(s)) {
    try { return JSON.parse(s); } catch (e) { throw new Error(`YAML: ongeldige JSON-waarde: ${s.slice(0, 60)}`); }
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  if (s === "null" || s === "~") return null;
  return s.replace(/^'(.*)'$/, "$1");
}

function parse(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  let i = 0;
  const indentOf = l => l.match(/^ */)[0].length;
  const skip = () => { while (i < lines.length && (!lines[i].trim() || /^\s*#/.test(lines[i]))) i++; };

  function block(indent) {
    skip();
    if (i >= lines.length) return null;
    const isList = /^\s*-(\s|$)/.test(lines[i]);
    const out = isList ? [] : {};
    while (true) {
      skip();
      if (i >= lines.length) break;
      const raw = lines[i];
      const ind = indentOf(raw);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`YAML: onverwachte inspringing op regel ${i + 1}: ${raw.trim().slice(0, 50)}`);
      const t = raw.trim();
      if (isList) {
        if (!t.startsWith("-")) break;
        out.push(scalar(t.replace(/^-\s*/, "")));
        i++;
        continue;
      }
      const m = t.match(/^([A-Za-z0-9_][\w-]*|"[^"]+"):(?:\s+(.*))?$/);
      if (!m) throw new Error(`YAML: onleesbare regel ${i + 1}: ${t.slice(0, 60)}`);
      const key = m[1].replace(/^"|"$/g, "");
      const val = (m[2] || "").replace(/\s+#.*$/, "");
      i++;
      if (val === "|" || val === ">") {
        const buf = [];
        let bi = null;
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() && indentOf(l) <= indent) break;
          if (l.trim() && bi == null) bi = indentOf(l);
          buf.push(l.trim() ? l.slice(bi) : "");
          i++;
        }
        while (buf.length && !buf[buf.length - 1]) buf.pop();
        out[key] = val === ">" ? buf.join(" ").replace(/\s+/g, " ").trim() : buf.join("\n");
      } else if (val === "") {
        skip();
        out[key] = i < lines.length && indentOf(lines[i]) > indent ? block(indentOf(lines[i])) : null;
      } else {
        out[key] = scalar(val);
      }
    }
    return out;
  }
  return block(0) || {};
}

const cache = new Map();
function load(name) {
  const id = String(name || "").toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`ongeldig account: ${name}`);
  const file = path.join(DIR, `${id}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`geen profiel accounts/${id}.yaml`);
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(id);
  if (hit && hit.mtime === mtime) return hit.profile;
  const p = parse(fs.readFileSync(file, "utf8"));
  p.id = id;
  cache.set(id, { mtime, profile: p });
  return p;
}
function list() {
  return fs.readdirSync(DIR).filter(f => f.endsWith(".yaml")).map(f => f.slice(0, -5)).sort();
}

module.exports = { DIR, parse, load, list };
