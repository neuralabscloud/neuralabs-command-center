// Het brein op de overview: api.neuralabs.cloud getekend als hersenen.
// Elke lichtflits is een echt verzoek aan de API (GET /api-brain, elke 4 s). Het signaal komt binnen
// via de hersenstam en loopt naar het gebied dat het verzoek afhandelt. Geen verkeer = rustig brein.
(function () {
  "use strict";
  const root = document.getElementById("api-brain");
  if (!root) return;

  const W = 1000, H = 700, POLL_MS = 4000;
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Zelfde gebieden als api-brain.js op de server; de server-versie wint zodra er data is.
  let regions = [
    { id: "regime", label: "Regime", lobe: "frontal", role: "Judges the market state", hue: 264 },
    { id: "derivatives", label: "Derivatives", lobe: "parietal", role: "Options, funding and volatility", hue: 218 },
    { id: "flow", label: "Order flow", lobe: "temporal", role: "Candles, CVD, order book, liquidations", hue: 188 },
    { id: "scanners", label: "Scanners", lobe: "occipital", role: "Watches Solana, Arc and Robinhood Chain", hue: 150 },
    { id: "market", label: "Market data", lobe: "cerebellum", role: "Relays prices and news from outside", hue: 38 },
    { id: "collectibles", label: "Collectibles", lobe: "limbic", role: "Card catalog, prices and deals", hue: 328 },
    { id: "core", label: "Core", lobe: "stem", role: "Health, keys and the Redis store", hue: 0 },
  ];

  // ── Anatomie (zijaanzicht, voorhoofd links) ──────────────────────────────
  const CEREBRUM = "M150,400 C120,300 170,170 330,120 C450,80 600,80 700,125 C800,165 860,250 860,340 C860,400 820,440 760,450 C700,455 650,440 610,450 C560,500 470,520 400,500 C340,485 320,450 290,440 C240,450 180,450 150,400 Z";
  const STEM = "M546,462 C560,520 568,582 574,636 C588,662 626,662 642,636 C638,580 630,520 618,470 Z";
  const SULCI = [
    "M300,438 C380,400 500,395 640,330",           // laterale groeve
    "M470,96 C455,170 500,230 520,292",            // centrale groeve
    "M330,128 C300,200 330,270 300,330",
    "M610,92 C640,160 610,220 650,280",
    "M735,150 C720,230 770,290 745,360",
    "M200,250 C250,280 250,340 215,380",
    "M400,455 C460,470 540,462 590,440",
    "M180,330 C230,300 270,310 300,270",
    "M380,150 C400,210 370,260 410,310",
    "M540,110 C530,170 570,200 560,260",
    "M690,200 C660,260 700,300 680,360",
    "M800,240 C780,300 820,340 800,400",
    "M330,400 C380,370 440,372 480,350",
    "M240,200 C290,220 320,200 360,230",
  ];
  const LIMBIC = { x: 515, y: 335, rx: 100, ry: 52 };
  const CEREBELLUM = { x: 722, y: 528, rx: 112, ry: 60, rot: -0.12 };
  const LOBES = {
    frontal: { seeds: [[240, 320], [350, 190]], at: [150, 170], align: "right", from: [140, 178], tip: [232, 262] },
    parietal: { seeds: [[540, 160], [650, 190]], at: [610, 60], align: "left", from: [620, 68], tip: [585, 138] },
    occipital: { seeds: [[790, 320], [770, 400]], at: [990, 170], align: "right", from: [960, 178], tip: [818, 292] },
    temporal: { seeds: [[420, 450], [540, 460]], at: [300, 590], align: "right", below: true, from: [295, 584], tip: [425, 478] },
    limbic: { seeds: [[LIMBIC.x, LIMBIC.y]], at: [345, 70], align: "right", from: [335, 78], tip: [498, 316] },
    cerebellum: { seeds: [[CEREBELLUM.x, CEREBELLUM.y]], at: [990, 610], align: "right", below: true, from: [950, 604], tip: [790, 548] },
    stem: { seeds: [[598, 560]], at: [500, 640], align: "right", below: true, from: [505, 650], tip: [588, 628] },
  };

  // ── DOM ──────────────────────────────────────────────────────────────────
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  root.textContent = "";
  const head = el("div", "nb-head");
  const titles = el("div");
  titles.append(el("div", "nb-title", "NeuraTrade brain"), el("div", "nb-sub", "api.neuralabs.cloud"));
  const pill = el("div", "nb-pill", "Connecting");
  head.append(titles, pill);

  const body = el("div", "nb-body");
  const stage = el("div", "nb-stage");
  const canvas = el("canvas", "nb-canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Side view of a brain. Each region is a part of the API and lights up when it handles a request.");
  const labelLayer = el("div", "nb-labels");
  stage.append(canvas, labelLayer);
  const stream = el("ol", "nb-stream");
  stream.setAttribute("aria-label", "Latest requests");
  const left = el("div", "nb-left");
  left.append(stage, stream);

  const side = el("div", "nb-side");
  const vitals = el("dl", "nb-vitals");
  const regionList = el("div", "nb-regions");
  const detail = el("div", "nb-detail");
  const senses = el("div", "nb-senses");
  side.append(vitals, regionList, detail, senses);
  body.append(left, side);
  root.append(head, body);

  // ── Neuronen ─────────────────────────────────────────────────────────────
  const ctx = canvas.getContext("2d");
  const cerePath = new Path2D(CEREBRUM), stemPath = new Path2D(STEM), cbPath = new Path2D();
  cbPath.ellipse(CEREBELLUM.x, CEREBELLUM.y, CEREBELLUM.rx, CEREBELLUM.ry, CEREBELLUM.rot, 0, Math.PI * 2);
  const sulciPaths = SULCI.map(d => new Path2D(d));

  function rng(seed) { // vaste seed: het brein ziet er bij elke pagina-load hetzelfde uit
    return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const inside = (path, x, y) => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); const r = ctx.isPointInPath(path, x, y); ctx.restore(); return r; };
  const inLimbic = (x, y) => ((x - LIMBIC.x) / LIMBIC.rx) ** 2 + ((y - LIMBIC.y) / LIMBIC.ry) ** 2 < 1;

  const nodes = []; // {x, y, lobe, e (energie 0..1), kind, nb:[index], parent}
  function scatter(box, minDist, tries, accept, lobeOf, rand) {
    const start = nodes.length;
    for (let i = 0; i < tries; i++) {
      const x = box[0] + rand() * (box[2] - box[0]), y = box[1] + rand() * (box[3] - box[1]);
      if (!accept(x, y)) continue;
      let ok = true;
      for (let j = start; j < nodes.length; j++) { const n = nodes[j]; if ((n.x - x) ** 2 + (n.y - y) ** 2 < minDist * minDist) { ok = false; break; } }
      if (ok) nodes.push({ x, y, lobe: lobeOf(x, y), e: 0, kind: null, nb: [], parent: -1 });
    }
  }
  const cortexLobes = ["frontal", "parietal", "occipital", "temporal"];
  function cortexLobe(x, y) {
    if (inLimbic(x, y)) return "limbic";
    let best = "frontal", bd = Infinity;
    for (const l of cortexLobes) for (const s of LOBES[l].seeds) { const d = (s[0] - x) ** 2 + (s[1] - y) ** 2; if (d < bd) { bd = d; best = l; } }
    return best;
  }
  (function buildNeurons() {
    const rand = rng(20261121);
    scatter([130, 80, 870, 525], 21, 9000, (x, y) => inside(cerePath, x, y), cortexLobe, rand);
    scatter([600, 460, 840, 595], 19, 2500, (x, y) => inside(cbPath, x, y) && !inside(cerePath, x, y), () => "cerebellum", rand);
    scatter([535, 465, 645, 655], 19, 1500, (x, y) => inside(stemPath, x, y) && !inside(cerePath, x, y) && !inside(cbPath, x, y), () => "stem", rand);
    // synapsen: de drie dichtstbijzijnde buren
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], near = [];
      for (let j = 0; j < nodes.length; j++) { if (j === i) continue; const d = (nodes[j].x - a.x) ** 2 + (nodes[j].y - a.y) ** 2; if (d < 52 * 52) near.push([d, j]); }
      near.sort((p, q) => p[0] - q[0]);
      for (const [, j] of near.slice(0, 3)) { if (!a.nb.includes(j)) a.nb.push(j); if (!nodes[j].nb.includes(i)) nodes[j].nb.push(i); }
    }
  })();
  // Route van elk neuron terug naar de ingang onderaan de hersenstam.
  let rootNode = 0;
  (function buildRoutes() {
    let maxY = -1;
    nodes.forEach((n, i) => { if (n.lobe === "stem" && n.y > maxY) { maxY = n.y; rootNode = i; } });
    const seen = new Uint8Array(nodes.length); seen[rootNode] = 1;
    const queue = [rootNode];
    while (queue.length) { const i = queue.shift(); for (const j of nodes[i].nb) if (!seen[j]) { seen[j] = 1; nodes[j].parent = i; queue.push(j); } }
    // losse eilandjes hangen we aan het dichtstbijzijnde bereikte neuron
    let again = true;
    while (again) {
      again = false;
      for (let i = 0; i < nodes.length; i++) {
        if (seen[i]) continue;
        let best = -1, bd = Infinity;
        for (let j = 0; j < nodes.length; j++) if (seen[j]) { const d = (nodes[j].x - nodes[i].x) ** 2 + (nodes[j].y - nodes[i].y) ** 2; if (d < bd) { bd = d; best = j; } }
        nodes[i].parent = best; seen[i] = 1; again = true;
        const q2 = [i];
        while (q2.length) { const k = q2.shift(); for (const j of nodes[k].nb) if (!seen[j]) { seen[j] = 1; nodes[j].parent = k; q2.push(j); } }
      }
    }
  })();
  const byLobe = {};
  nodes.forEach((n, i) => (byLobe[n.lobe] = byLobe[n.lobe] || []).push(i));
  const lobeCenter = {};
  for (const [l, idx] of Object.entries(byLobe)) lobeCenter[l] = [idx.reduce((s, i) => s + nodes[i].x, 0) / idx.length, idx.reduce((s, i) => s + nodes[i].y, 0) / idx.length];

  // ── Kleur ────────────────────────────────────────────────────────────────
  const hueOf = {};
  const regionOfLobe = {};
  function indexRegions() { for (const r of regions) { hueOf[r.lobe] = r.hue; regionOfLobe[r.lobe] = r; } }
  indexRegions();
  const lobeCol = (lobe, a, light = 72) => lobe === "stem" ? `hsla(230,14%,${light + 8}%,${a})` : `hsla(${hueOf[lobe]},70%,${light}%,${a})`;
  const kindCol = (kind, lobe, a) => kind === "err" ? `hsla(0,88%,62%,${a})` : kind === "warn" ? `hsla(225,10%,68%,${a})` : lobeCol(lobe, a, 76);

  // ── Tekenen ──────────────────────────────────────────────────────────────
  let scale = 1, dpr = 1, staticLayer = null;
  function resize() {
    const w = stage.clientWidth;
    if (!w) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    scale = w / W;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * (H / W) * dpr);
    staticLayer = document.createElement("canvas");
    staticLayer.width = canvas.width; staticLayer.height = canvas.height;
    const c = staticLayer.getContext("2d");
    c.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    c.lineCap = "round";
    // weefsel
    for (const p of [stemPath, cbPath, cerePath]) { c.fillStyle = "hsla(258,45%,62%,0.05)"; c.fill(p); }
    c.lineWidth = 1.5; c.strokeStyle = "hsla(258,65%,80%,0.5)";
    c.stroke(stemPath); c.stroke(cbPath);
    c.fillStyle = "hsl(258,30%,5.5%)"; c.fill(cerePath); c.fillStyle = "hsla(258,45%,62%,0.05)"; c.fill(cerePath);
    c.stroke(cerePath);
    // windingen
    c.save(); c.clip(cerePath); c.lineWidth = 1.3; c.strokeStyle = "hsla(258,50%,78%,0.2)";
    for (const p of sulciPaths) c.stroke(p);
    c.beginPath(); c.ellipse(LIMBIC.x, LIMBIC.y, LIMBIC.rx, LIMBIC.ry, 0, 0, Math.PI * 2); c.stroke();
    c.restore();
    c.save(); c.clip(cbPath); c.lineWidth = 1; c.strokeStyle = "hsla(258,50%,78%,0.18)";
    for (let k = -3; k <= 3; k++) { c.beginPath(); c.ellipse(CEREBELLUM.x, CEREBELLUM.y + k * 17, CEREBELLUM.rx * 1.1, 26, CEREBELLUM.rot, Math.PI * 0.05, Math.PI * 0.95); c.stroke(); }
    c.restore();
    // synapsen en neuronen in rust
    c.lineWidth = 0.7;
    nodes.forEach((a, i) => { for (const j of a.nb) if (j > i) { c.strokeStyle = lobeCol(a.lobe, 0.22); c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(nodes[j].x, nodes[j].y); c.stroke(); } });
    for (const n of nodes) { c.fillStyle = lobeCol(n.lobe, 0.7); c.beginPath(); c.arc(n.x, n.y, 1.8, 0, Math.PI * 2); c.fill(); }
    // aanwijslijnen van de labels
    c.lineWidth = 0.9;
    for (const [lobe, L] of Object.entries(LOBES)) {
      c.strokeStyle = lobeCol(lobe, 0.45); c.beginPath(); c.moveTo(L.from[0], L.from[1]); c.lineTo(L.tip[0], L.tip[1]); c.stroke();
      c.beginPath(); c.arc(L.tip[0], L.tip[1], 3.2, 0, Math.PI * 2); c.stroke();
    }
  }

  const pulses = [];  // {path:[i], len:[cumulatief], total, t0, dur, lobe, kind, at}
  const ripples = []; // {x, y, t0, lobe, kind}
  const level = {};   // activiteit per kwab 0..1 (uit verzoeken per minuut)
  let online = false, hoverLobe = null, lockLobe = null, lastFrame = 0, visible = true;

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden || !staticLayer) return;
    const busy = pulses.length || ripples.length || nodes.some(n => n.e > 0.01);
    if (now - lastFrame < (busy ? 30 : 90)) return; // in rust volstaat een traag ademritme
    const dt = Math.min(200, now - lastFrame); lastFrame = now;
    draw(now, dt);
  }
  function draw(now, dt) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = online ? 1 : 0.4;
    ctx.drawImage(staticLayer, 0, 0);
    ctx.globalAlpha = 1;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    const breath = !online ? 0 : reduceMotion ? 0.9 : 0.82 + 0.18 * Math.sin(now / 950);
    const focus = hoverLobe || lockLobe;
    // gloed per gebied: sterker naarmate het gebied drukker is
    if (online) for (const lobe of Object.keys(LOBES)) {
      const c0 = lobeCenter[lobe]; if (!c0) continue;
      const a = (0.05 + 0.2 * (level[lobe] || 0) + (focus === lobe ? 0.12 : 0)) * breath;
      const rad = lobe === "stem" ? 70 : lobe === "limbic" ? 95 : 150;
      const g = ctx.createRadialGradient(c0[0], c0[1], 0, c0[0], c0[1], rad);
      g.addColorStop(0, lobeCol(lobe, a, 62)); g.addColorStop(1, lobeCol(lobe, 0, 62));
      ctx.fillStyle = g; ctx.fillRect(c0[0] - rad, c0[1] - rad, rad * 2, rad * 2);
    }
    if (focus && byLobe[focus]) { ctx.fillStyle = lobeCol(focus, 0.55, 80); for (const i of byLobe[focus]) { const n = nodes[i]; ctx.beginPath(); ctx.arc(n.x, n.y, 2, 0, Math.PI * 2); ctx.fill(); } }
    // signalen onderweg
    for (let p = pulses.length - 1; p >= 0; p--) {
      const P = pulses[p], prog = (now - P.t0) / P.dur;
      if (prog < 0) continue;
      const dist = Math.min(1, prog) * P.total;
      let k = 0; while (k < P.len.length - 1 && P.len[k + 1] < dist) k++;
      for (; P.at <= k; P.at++) { const n = nodes[P.path[P.at]]; n.e = Math.max(n.e, 0.5); n.kind = P.kind; n.src = P.lobe; }
      const a = nodes[P.path[k]], b = nodes[P.path[Math.min(k + 1, P.path.length - 1)]];
      const seg = (P.len[k + 1] || P.len[k]) - P.len[k], f = seg ? (dist - P.len[k]) / seg : 1;
      const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      ctx.fillStyle = kindCol(P.kind, P.lobe, 0.28); ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = kindCol(P.kind, P.lobe, 1); ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
      if (prog >= 1) { pulses.splice(p, 1); arrive(P, now); }
    }
    // neuronen die vuren, doven langzaam uit
    const decay = Math.exp(-dt / 520);
    for (const n of nodes) {
      if (n.e <= 0.01) { n.e = 0; continue; }
      const lobe = n.src || n.lobe;
      ctx.fillStyle = kindCol(n.kind, lobe, 0.2 * n.e); ctx.beginPath(); ctx.arc(n.x, n.y, 3 + 8 * n.e, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = kindCol(n.kind, lobe, Math.min(1, n.e * 1.2)); ctx.beginPath(); ctx.arc(n.x, n.y, 1.6 + 2.6 * n.e, 0, Math.PI * 2); ctx.fill();
      n.e *= decay;
    }
    for (let r = ripples.length - 1; r >= 0; r--) {
      const R = ripples[r], q = (now - R.t0) / 900;
      if (q >= 1) { ripples.splice(r, 1); continue; }
      ctx.strokeStyle = kindCol(R.kind, R.lobe, 0.6 * (1 - q)); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(R.x, R.y, 6 + 44 * q, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }
  function arrive(P, now) {
    const t = P.path[P.path.length - 1], n = nodes[t];
    const light = (i, e) => { const m = nodes[i]; m.e = Math.max(m.e, e); m.kind = P.kind; m.src = P.lobe; };
    light(t, 1);
    if (!P.rejected) for (const j of n.nb) { light(j, 0.75); for (const k of nodes[j].nb) if (k !== t) light(k, 0.4); }
    ripples.push({ x: n.x, y: n.y, t0: now, lobe: P.lobe, kind: P.kind });
  }
  // Eén echt verzoek → één signaal van de hersenstam naar het gebied dat het afhandelt.
  function fire(ev) {
    const region = regions.find(r => r.id === ev.region);
    const kind = ev.status >= 500 ? "err" : ev.status >= 400 ? "warn" : "ok";
    let path, lobe, rejected = false;
    if (!region || !byLobe[region.lobe]) { // onbekend pad: komt niet verder dan de ingang
      lobe = "stem"; rejected = true;
      path = [rootNode, nodes[rootNode].nb[0] != null ? nodes[rootNode].nb[0] : rootNode];
    } else {
      lobe = region.lobe;
      const pool = byLobe[lobe];
      let i = pool[Math.floor(Math.random() * pool.length)];
      path = [i];
      while (nodes[i].parent >= 0 && path.length < 400) { i = nodes[i].parent; path.push(i); }
      path.reverse();
    }
    pushStream(ev, region, kind);
    const now = performance.now();
    if (reduceMotion || path.length < 2) { arrive({ path, lobe, kind: rejected ? "warn" : kind, rejected }, now); return; }
    const len = [0];
    for (let k = 1; k < path.length; k++) len.push(len[k - 1] + Math.hypot(nodes[path[k]].x - nodes[path[k - 1]].x, nodes[path[k]].y - nodes[path[k - 1]].y));
    const total = len[len.length - 1];
    pulses.push({ path, len, total, t0: now, dur: 260 + total * 1.5, lobe, kind: rejected ? "warn" : kind, rejected, at: 0 });
  }

  // ── Zijpaneel ────────────────────────────────────────────────────────────
  const labelEls = {};
  for (const [lobe, L] of Object.entries(LOBES)) {
    const box = el("div", "nb-label nb-" + L.align + (L.below ? " nb-below" : ""));
    box.style.left = (L.at[0] / W * 100) + "%"; box.style.top = (L.at[1] / H * 100) + "%";
    const name = el("div", "nb-label-name"), val = el("div", "nb-label-val", "");
    box.append(name, val); labelLayer.append(box);
    labelEls[lobe] = { box, name, val };
  }
  const fmtInt = n => Number(n || 0).toLocaleString("en-US");
  const fmtAge = s => s == null ? "unknown" : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;
  const fmtUp = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const fmtMs = v => v == null ? "none yet" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;

  function vital(label, value, warn) {
    const w = el("div", "nb-vital" + (warn ? " nb-warn" : ""));
    w.append(el("dt", null, label), el("dd", null, value));
    return w;
  }
  let lastData = null;
  function renderSide(d) {
    vitals.textContent = "";
    if (!d.ok) {
      vitals.append(vital("Status", d.error === "not_configured" ? "Brain feed key is missing in .env" : "No signal from api.neuralabs.cloud", true));
    } else {
      const stale = d.regime.age_seconds != null && d.regime.age_seconds > 3600;
      vitals.append(
        vital("Requests per minute", fmtInt(d.per_min)),
        vital("Median response", fmtMs(d.p50_ms)),
        vital("Awake for", fmtUp(d.uptime_seconds)),
        vital("Regime", d.regime.label ? `${d.regime.label}${stale ? `, ${fmtAge(d.regime.age_seconds)} old` : ""}` : "unknown", stale || !d.regime.label),
        vital("Redis keys", d.redis.connected ? fmtInt(d.redis.keys) : "disconnected", !d.redis.connected),
        vital("Server errors", fmtInt(d.errors_total), d.errors_total > 0),
      );
    }
    regionList.textContent = "";
    const max = Math.max(1, ...regions.map(r => r.per_min || 0));
    for (const r of regions) {
      const row = el("button", "nb-region" + ((hoverLobe || lockLobe) === r.lobe ? " nb-on" : ""));
      row.type = "button";
      row.style.setProperty("--h", r.lobe === "stem" ? "230 14% 80%" : `${r.hue} 70% 72%`);
      const bar = el("span", "nb-bar"); bar.style.width = (d.ok ? Math.round((r.per_min || 0) / max * 100) : 0) + "%";
      const track = el("span", "nb-track"); track.append(bar);
      row.append(el("span", "nb-dot"), el("span", "nb-region-name", r.label), track, el("span", "nb-region-val", d.ok ? `${fmtInt(r.per_min)}/min` : ""));
      row.setAttribute("aria-pressed", lockLobe === r.lobe ? "true" : "false");
      row.addEventListener("mouseenter", () => setHover(r.lobe));
      row.addEventListener("mouseleave", () => setHover(null));
      row.addEventListener("focus", () => setHover(r.lobe));
      row.addEventListener("blur", () => setHover(null));
      row.addEventListener("click", () => { lockLobe = lockLobe === r.lobe ? null : r.lobe; renderSide(lastData); });
      regionList.append(row);
      const L = labelEls[r.lobe];
      if (L) { L.name.textContent = r.label; L.val.textContent = !d.ok ? "" : r.per_min ? `${fmtInt(r.per_min)}/min` : "quiet"; L.box.style.setProperty("--h", r.lobe === "stem" ? "230 14% 80%" : `${r.hue} 70% 72%`); }
    }
    renderDetail(d);
    senses.textContent = "";
    if (d.ok) {
      senses.append(el("div", "nb-cap", "Senses"));
      for (const s of d.senses || []) {
        const line = el("div", "nb-sense" + (s.stale ? " nb-warn" : ""));
        line.append(el("span", null, `${s.label} scanner`), el("span", null, s.age_seconds == null ? "no data" : `${fmtAge(s.age_seconds)} ago${s.stale ? ", stale" : ""}`));
        senses.append(line);
      }
      if (d.unknown_total) {
        const line = el("div", "nb-sense");
        line.append(el("span", null, "Unknown paths stopped at the stem"), el("span", null, fmtInt(d.unknown_total)));
        senses.append(line);
      }
    }
  }
  function renderDetail(d) {
    detail.textContent = "";
    const lobe = hoverLobe || lockLobe;
    const r = lobe ? regions.find(x => x.lobe === lobe) : regions.slice().sort((a, b) => (b.per_min || 0) - (a.per_min || 0) || (b.count || 0) - (a.count || 0))[0];
    if (!r) return;
    detail.style.setProperty("--h", r.lobe === "stem" ? "230 14% 80%" : `${r.hue} 70% 72%`);
    detail.append(el("div", "nb-detail-name", r.label), el("div", "nb-detail-role", r.role));
    if (!d.ok) return;
    const top = r.top || [];
    if (!top.length) { detail.append(el("div", "nb-empty", "No requests since the API last started.")); return; }
    detail.append(el("div", "nb-cap", `${fmtInt(r.count)} requests since the API last started`));
    for (const t of top) {
      const line = el("div", "nb-route");
      line.append(el("span", "nb-route-path", t.endpoint), el("span", null, fmtInt(t.count)));
      detail.append(line);
    }
  }
  function setHover(lobe) {
    if (hoverLobe === lobe) return;
    hoverLobe = lobe;
    for (const row of regionList.children) row.classList.remove("nb-on");
    const i = regions.findIndex(r => r.lobe === (hoverLobe || lockLobe));
    if (i >= 0 && regionList.children[i]) regionList.children[i].classList.add("nb-on");
    if (lastData) renderDetail(lastData);
  }
  function pushStream(ev, region, kind) {
    const li = el("li", "nb-sig nb-" + kind);
    li.style.setProperty("--h", !region ? "225 10% 68%" : region.lobe === "stem" ? "230 14% 80%" : `${region.hue} 70% 72%`);
    const time = new Date(ev.t).toLocaleTimeString("en-GB", { hour12: false });
    li.append(el("span", "nb-sig-time", time), el("span", "nb-dot"), el("span", "nb-sig-path", `${ev.method} ${ev.path}`),
      el("span", "nb-sig-status", String(ev.status)), el("span", "nb-sig-ms", `${Math.round(ev.latency_ms)} ms`));
    stream.prepend(li);
    while (stream.children.length > 5) stream.lastChild.remove();
  }

  // muis boven het brein: dichtstbijzijnde neuron bepaalt het gebied
  canvas.addEventListener("mousemove", e => {
    const b = canvas.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * W, y = (e.clientY - b.top) / b.height * H;
    let best = null, bd = 34 * 34;
    for (const n of nodes) { const dd = (n.x - x) ** 2 + (n.y - y) ** 2; if (dd < bd) { bd = dd; best = n; } }
    setHover(best ? best.lobe : null);
  });
  canvas.addEventListener("mouseleave", () => setHover(null));
  canvas.addEventListener("click", () => { lockLobe = hoverLobe && lockLobe !== hoverLobe ? hoverLobe : null; if (lastData) renderSide(lastData); });

  // ── Data ─────────────────────────────────────────────────────────────────
  let lastT = 0, first = true, timer = null;
  const queue = []; // {at (performance.now), ev}
  function pump() {
    const now = performance.now();
    while (queue.length && queue[0].at <= now) { const q = queue.shift(); if (now - q.at < 8000) fire(q.ev); }
    setTimeout(pump, 60);
  }
  async function poll() {
    let d;
    try {
      const r = await fetch("/api-brain", { credentials: "include" });
      if (r.status === 403 || r.status === 404) { const sec = root.closest("section"); (sec || root).remove(); clearInterval(timer); return; } // team-gebruiker: geen toegang
      if (r.status === 401) return;
      d = await r.json();
    } catch { d = { ok: false, error: "unreachable", events: [] }; }
    if (Array.isArray(d.regions) && d.regions.length) { regions = d.regions; indexRegions(); }
    const wasOnline = online;
    online = !!d.ok; lastData = d;
    pill.textContent = d.ok ? `Live · v${d.version}` : d.error === "not_configured" ? "Not configured" : "No signal";
    pill.className = "nb-pill" + (d.ok ? " nb-live" : " nb-down");
    root.classList.toggle("nb-off", !d.ok);
    for (const r of regions) level[r.lobe] = d.ok ? Math.min(1, Math.log1p(r.per_min || 0) / Math.log1p(120)) : 0;
    renderSide(d);
    if (wasOnline !== online && staticLayer) draw(performance.now(), 16);
    if (!d.ok) return;
    let fresh = (d.events || []).filter(e => e.t > lastT);
    if (fresh.length) lastT = fresh[fresh.length - 1].t;
    if (first) { first = false; fresh = fresh.slice(-8); fresh.forEach((ev, i) => queue.push({ at: performance.now() + 400 + i * 220, ev })); return; }
    if (fresh.length > 70) { const step = fresh.length / 70; fresh = Array.from({ length: 70 }, (_, i) => fresh[Math.floor(i * step)]); }
    if (!fresh.length) return;
    // zelfde ritme als in het echt, één poll-ronde vertraagd
    const t0 = fresh[0].t, span = Math.max(1, fresh[fresh.length - 1].t - t0), fit = Math.min(1, (POLL_MS - 300) / span), base = performance.now();
    for (const ev of fresh) queue.push({ at: base + (ev.t - t0) * fit, ev });
    queue.sort((a, b) => a.at - b.at);
  }

  if ("IntersectionObserver" in window) new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(stage);
  if ("ResizeObserver" in window) new ResizeObserver(() => { resize(); if (staticLayer) draw(performance.now(), 16); }).observe(stage);
  else window.addEventListener("resize", resize);
  resize();
  renderSide({ ok: false, error: "connecting", events: [] });
  vitals.textContent = "";
  requestAnimationFrame(frame);
  pump();
  poll();
  timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
})();
