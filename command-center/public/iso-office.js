// Isometric Office widget (shared)
// Renders an isometric office with AI agent stations, connections and live status.
// Usage: add a container with `data-iso-office` attribute, then load this script.
(function () {
  let BRAND_NAME = "HQ";
  const OFFICE = [
    { key:'researcher',   name:'RESEARCHER', role:'TREND RESEARCH',    emoji:'\u{1F50D}', hsl:'264 65% 49%', pos:[0,0], href:'research.html',        taskApi:'/research/tasks' },
    { key:'content',      name:'CONTENT',    role:'HEYGEN AVATARS',    emoji:'\u{1F3AC}', hsl:'180 70% 45%', pos:[1,0], href:'content-creator.html', taskApis:['/avatar/tasks','/video-agent/tasks'] },
    { key:'scriptwriter', name:'WRITER',     role:'VIDEO SCRIPTS',     emoji:'\u270D\uFE0F', hsl:'30 90% 55%',  pos:[2,0], href:'scriptwriter.html',    taskApi:'/scriptwriter/tasks' },
    { key:'video',        name:'VIDEO ED',   role:'REMOTION + AI',     emoji:'\u2702\uFE0F', hsl:'0 72% 51%',   pos:[0,1], href:'editor.html',          taskApis:['/video/tasks','/video/ai-generate'] },
    { key:'marketeer',    name:'MARKETEER',  role:'GROWTH',            emoji:'\u{1F4E3}', hsl:'340 80% 55%', pos:[1,1], href:'ads.html' },
    { key:'designer',     name:'DESIGNER',   role:'CANVA ASSETS',      emoji:'\u{1F3A8}', hsl:'45 93% 55%',  pos:[2,1], href:'designer.html',        taskApi:'/designer/tasks' },
    { key:'assistant',    name:'ASSISTANT',  role:'CALENDAR',          emoji:'\u{1F4C5}', hsl:'210 90% 55%', pos:[0,2], href:'chat.html' },
    { key:'community',    name:'COMMUNITY',  role:'TELEGRAM / DISCORD', emoji:'\u{1F4AC}', hsl:'200 90% 55%', pos:[1,2], href:'community-manager.html', taskApi:'/community/tasks', isCommunity:true },
    { key:'seo',          name:'SEO',        role:'SITE AUDIT',         emoji:'\u{1F50E}', hsl:'160 70% 45%', pos:[2,2], href:'seo.html',             taskApi:'/seo/tasks' },
  ];

  const CONNECTIONS = [
    ['researcher', 'scriptwriter',4.2],
    ['scriptwriter','content',    3.8],
    ['scriptwriter','video',      4.6],
    ['content',    'video',       3.2],
    ['video',      'designer',    3.6],
    ['designer',   'marketeer',   3.4],
    ['marketeer',  'assistant',   3.0],
    ['scriptwriter','community',  4.4],
    ['designer',   'community',   3.8],
    ['assistant',  'community',   3.2],
    ['researcher', 'seo',         4.0],
    ['seo',        'marketeer',   3.6],
  ];

  const ISO_TW = 310, ISO_TH = 155, ISO_OX = 600, ISO_OY = 258;

  // Chief AI Officer / orchestrator (lives above the floor). Name & title are
  // overridden from /brand at runtime — these are neutral fallbacks only.
  const CHIEF = {
    key: "chief",
    name: "ASSISTANT",
    title: "CHIEF AI OFFICER",
    href: "chat.html",
    cx: 600,
    cy: 70,
  };

  function agentByKey(k) { return OFFICE.find(a => a.key === k); }
  function isoGridPos(gx, gy) {
    return { x: (gx - gy) * ISO_TW / 2 + ISO_OX, y: (gx + gy) * ISO_TH / 2 + ISO_OY };
  }
  function stationHub(agent) {
    const p = isoGridPos(agent.pos[0], agent.pos[1]);
    return { x: p.x, y: p.y - 38 };
  }
  function curvePath(x1, y1, x2, y2, curvature = 0.18) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const px = -dy / len * curvature * len;
    const py =  dx / len * curvature * len;
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${(mx + px).toFixed(1)} ${(my + py).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  function renderConnections() {
    const paths = [], lines = [], glows = [], particles = [], flashes = [], gradientDefs = [];
    CONNECTIONS.forEach(([fromKey, toKey, dur], i) => {
      const from = agentByKey(fromKey), to = agentByKey(toKey);
      if (!from || !to) return;
      const a = stationHub(from), b = stationHub(to);
      const id = `conn-${i}`;
      const d = curvePath(a.x, a.y, b.x, b.y);
      const fromCol = `hsl(${from.hsl})`, toCol = `hsl(${to.hsl})`;
      gradientDefs.push(`<linearGradient id="${id}-grad" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="${fromCol}" stop-opacity="0.85"/><stop offset="100%" stop-color="${toCol}" stop-opacity="0.85"/></linearGradient>`);
      paths.push(`<path id="${id}" d="${d}" fill="none"/>`);
      glows.push(`<path class="conn-glow" d="${d}" stroke="url(#${id}-grad)"/>`);
      lines.push(`<path class="conn-line" d="${d}" stroke="url(#${id}-grad)" style="animation-duration:${(dur*5).toFixed(1)}s"/>`);
      for (let k = 0; k < 2; k++) {
        const delay = -(dur * k / 2).toFixed(2);
        const mixCol = k === 0 ? fromCol : toCol;
        particles.push(`<g class="particle" color="${mixCol}"><circle class="particle-halo" r="4" fill="${mixCol}"><animateMotion dur="${dur}s" repeatCount="indefinite" begin="${delay}s" rotate="auto"><mpath href="#${id}"/></animateMotion></circle><circle class="particle-core" r="1.8" fill="#fff"><animateMotion dur="${dur}s" repeatCount="indefinite" begin="${delay}s" rotate="auto"><mpath href="#${id}"/></animateMotion></circle></g>`);
      }
      const flashDur = dur.toFixed(1);
      flashes.push(`<circle class="screen-flash" cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="3" fill="${fromCol}" opacity="0"><animate attributeName="opacity" dur="${flashDur}s" repeatCount="indefinite" values="0;0;0.22;0;0;0.22;0" keyTimes="0;0.47;0.50;0.55;0.97;1;1"/><animate attributeName="r" dur="${flashDur}s" repeatCount="indefinite" values="3;3;7;11;3;7;11" keyTimes="0;0.47;0.50;0.55;0.97;1;1"/></circle>`);
    });
    return { defs: gradientDefs.join('') + paths.join(''), lines: glows.join('') + lines.join(''), particles: particles.join(''), flashes: flashes.join('') };
  }

  function renderChief() {
    const cx = CHIEF.cx, cy = CHIEF.cy;
    // Hexagonal base (larger, iso-flat)
    const r = 40;
    const baseCy = cy + 26;
    const hexPts = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 3) * i + Math.PI / 6;
      const x = cx + Math.cos(ang) * r;
      const y = baseCy + Math.sin(ang) * (r * 0.38);
      hexPts.push(x.toFixed(1) + "," + y.toFixed(1));
    }
    const hexStr = hexPts.join(" ");
    const hexGlow = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 3) * i + Math.PI / 6;
      const x = cx + Math.cos(ang) * (r + 5);
      const y = baseCy + Math.sin(ang) * ((r + 5) * 0.38);
      hexGlow.push(x.toFixed(1) + "," + y.toFixed(1));
    }
    const orbCy = cy - 4;
    return `
      <a href="${CHIEF.href}" class="chief" data-key="${CHIEF.key}">
        <polygon class="chief-base-glow" points="${hexGlow.join(' ')}"/>
        <polygon class="chief-base" points="${hexStr}"/>
        <line class="chief-stem" x1="${cx}" y1="${(baseCy - 3).toFixed(1)}" x2="${cx}" y2="${(orbCy + 16).toFixed(1)}"/>
        <circle class="chief-ring" cx="${cx}" cy="${orbCy.toFixed(1)}" r="28"/>
        <circle class="chief-orb-outer" cx="${cx}" cy="${orbCy.toFixed(1)}" r="18"/>
        <circle class="chief-orb-core"  cx="${cx}" cy="${orbCy.toFixed(1)}" r="6.5"/>
        <text class="chief-name"  x="${cx}" y="${(cy - 42).toFixed(1)}">${CHIEF.name}</text>
        <line class="chief-title-rule" x1="${(cx - 74).toFixed(1)}" y1="${(baseCy + 32).toFixed(1)}" x2="${(cx - 52).toFixed(1)}" y2="${(baseCy + 32).toFixed(1)}"/>
        <line class="chief-title-rule" x1="${(cx + 52).toFixed(1)}" y1="${(baseCy + 32).toFixed(1)}" x2="${(cx + 74).toFixed(1)}" y2="${(baseCy + 32).toFixed(1)}"/>
        <text class="chief-title" x="${cx}" y="${(baseCy + 35).toFixed(1)}">${CHIEF.title}</text>
      </a>
    `;
  }

  function renderFloor() {
    const halfW = ISO_TW / 2, halfH = ISO_TH / 2;
    let tiles = '';
    const c00 = isoGridPos(0, 0), c30 = isoGridPos(3, 0), c02 = isoGridPos(0, 2), c32 = isoGridPos(3, 2);
    const outer = [
      { x: c00.x, y: c00.y - halfH },
      { x: c30.x + halfW, y: c30.y },
      { x: c32.x, y: c32.y + halfH },
      { x: c02.x - halfW, y: c02.y },
    ];
    tiles += `<polygon class="floor-accent" points="${outer.map(p=>p.x+','+p.y).join(' ')}"/>`;
    for (let gy = 0; gy <= 2; gy++) {
      for (let gx = 0; gx <= 3; gx++) {
        const p = isoGridPos(gx, gy);
        const cls = (gx === 1 && gy === 1) ? 'floor-tile hero' : 'floor-tile';
        tiles += `<polygon class="${cls}" points="${p.x-halfW},${p.y} ${p.x},${p.y-halfH} ${p.x+halfW},${p.y} ${p.x},${p.y+halfH}"/>`;
      }
    }
    return tiles;
  }

  function renderStation(agent) {
    const p = isoGridPos(agent.pos[0], agent.pos[1]);
    const cx = p.x, cy = p.y;
    const col = `hsl(${agent.hsl})`;
    const scale = agent.hero ? 1.18 : 1.0;
    const iso = (wx, wy, wz) => ({ x: cx + (wx - wy) * 0.866, y: cy + (wx + wy) * 0.5 - wz });

    const W = 72 * scale, D = 32 * scale, H = 18 * scale;
    const hw = W / 2, hd = D / 2;
    const dyOff = -8 * scale;

    const b_NW = iso(-hw, -hd + dyOff, 0), b_NE = iso(hw, -hd + dyOff, 0);
    const b_SE = iso(hw,  hd + dyOff, 0),  b_SW = iso(-hw, hd + dyOff, 0);
    const t_NW = iso(-hw, -hd + dyOff, H), t_NE = iso(hw, -hd + dyOff, H);
    const t_SE = iso(hw,  hd + dyOff, H),  t_SW = iso(-hw, hd + dyOff, H);
    const ptsStr = (arr) => arr.map(pt => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');

    const deskFront = ptsStr([t_SW, t_SE, b_SE, b_SW]);
    const deskRight = ptsStr([t_NE, t_SE, b_SE, b_NE]);
    const deskTop   = ptsStr([t_NW, t_NE, t_SE, t_SW]);

    const monW = 26 * scale, monD = 5 * scale, monH = 17 * scale;
    const mhw = monW / 2, mhd = monD / 2;
    const mcx = 0, mcy = -hd + dyOff + mhd + 3, mz = H;
    const m_bNW = iso(mcx - mhw, mcy - mhd, mz),        m_bNE = iso(mcx + mhw, mcy - mhd, mz);
    const m_bSE = iso(mcx + mhw, mcy + mhd, mz),        m_bSW = iso(mcx - mhw, mcy + mhd, mz);
    const m_tNW = iso(mcx - mhw, mcy - mhd, mz + monH), m_tNE = iso(mcx + mhw, mcy - mhd, mz + monH);
    const m_tSE = iso(mcx + mhw, mcy + mhd, mz + monH), m_tSW = iso(mcx - mhw, mcy + mhd, mz + monH);
    const monFront = ptsStr([m_tSW, m_tSE, m_bSE, m_bSW]);
    const monRight = ptsStr([m_tNE, m_tSE, m_bSE, m_bNE]);
    const monTop   = ptsStr([m_tNW, m_tNE, m_tSE, m_tSW]);

    const inset = 1.8;
    const s_tl = iso(mcx - mhw + inset, mcy + mhd, mz + monH - inset);
    const s_tr = iso(mcx + mhw - inset, mcy + mhd, mz + monH - inset);
    const s_br = iso(mcx + mhw - inset, mcy + mhd, mz + inset);
    const s_bl = iso(mcx - mhw + inset, mcy + mhd, mz + inset);
    const screenPts = ptsStr([s_tl, s_tr, s_br, s_bl]);
    const screenCenter = iso(mcx, mcy + mhd, mz + monH / 2);

    const chair = iso(0, hd + dyOff + 14, 0);
    const chairR = 9 * scale;
    const glowCenter = iso(0, dyOff, 0);

    let monitorSvg;
    if (agent.hero) {
      const mw = 12, md = 4, mhH = 14;
      const positions = [-17, 0, 17];
      let parts = '';
      for (let i = 0; i < 3; i++) {
        const ox = positions[i] * scale;
        const h = (i === 1 ? 1.1 : 1.0) * mhH * scale;
        const mbNW = iso(ox - mw*scale/2, mcy - md*scale/2, mz);
        const mbNE = iso(ox + mw*scale/2, mcy - md*scale/2, mz);
        const mbSE = iso(ox + mw*scale/2, mcy + md*scale/2, mz);
        const mbSW = iso(ox - mw*scale/2, mcy + md*scale/2, mz);
        const mtNW = iso(ox - mw*scale/2, mcy - md*scale/2, mz + h);
        const mtNE = iso(ox + mw*scale/2, mcy - md*scale/2, mz + h);
        const mtSE = iso(ox + mw*scale/2, mcy + md*scale/2, mz + h);
        const mtSW = iso(ox - mw*scale/2, mcy + md*scale/2, mz + h);
        const fr = ptsStr([mtSW, mtSE, mbSE, mbSW]);
        const rt = ptsStr([mtNE, mtSE, mbSE, mbNE]);
        const tp = ptsStr([mtNW, mtNE, mtSE, mtSW]);
        const sIn = 1.2;
        const sTl = iso(ox - mw*scale/2 + sIn, mcy + md*scale/2, mz + h - sIn);
        const sTr = iso(ox + mw*scale/2 - sIn, mcy + md*scale/2, mz + h - sIn);
        const sBr = iso(ox + mw*scale/2 - sIn, mcy + md*scale/2, mz + sIn);
        const sBl = iso(ox - mw*scale/2 + sIn, mcy + md*scale/2, mz + sIn);
        parts += `<polygon class="monitor-back" points="${fr}" stroke="${col}"/><polygon class="monitor-side" points="${rt}" stroke="${col}" stroke-opacity="0.4"/><polygon class="monitor-top" points="${tp}"/><polygon class="screen-fill" points="${ptsStr([sTl,sTr,sBr,sBl])}" fill="url(#screen-${agent.key})"/>`;
      }
      monitorSvg = parts;
    } else {
      monitorSvg = `<polygon class="monitor-back" points="${monFront}" stroke="${col}"/><polygon class="monitor-side" points="${monRight}" stroke="${col}" stroke-opacity="0.4"/><polygon class="monitor-top" points="${monTop}"/><polygon class="screen-fill" points="${screenPts}" fill="url(#screen-${agent.key})"/>`;
    }

    return `<a href="${agent.href}" class="station${agent.hero ? ' hero' : ''}" data-key="${agent.key}" style="--station-color: ${col}"><ellipse class="station-glow" cx="${glowCenter.x.toFixed(1)}" cy="${(glowCenter.y+2).toFixed(1)}" rx="${(W*0.95).toFixed(1)}" ry="${(D*0.75).toFixed(1)}" fill="${col}"/><polygon class="desk-front" points="${deskFront}"/><polygon class="desk-side" points="${deskRight}"/><polygon class="desk-top" points="${deskTop}" stroke="${col}" stroke-opacity="0.28"/>${monitorSvg}<ellipse class="chair" cx="${chair.x.toFixed(1)}" cy="${chair.y.toFixed(1)}" rx="${chairR.toFixed(1)}" ry="${(chairR*0.55).toFixed(1)}"/><line class="chair" x1="${chair.x.toFixed(1)}" y1="${(chair.y - chairR*0.55).toFixed(1)}" x2="${chair.x.toFixed(1)}" y2="${(chair.y - chairR*1.4).toFixed(1)}" stroke="#202020" stroke-width="2"/></a>`;
  }

  function renderNameplate(agent) {
    const p = isoGridPos(agent.pos[0], agent.pos[1]);
    const cx = p.x, cy = p.y;
    const col = `hsl(${agent.hsl})`;
    const npCy = cy - 78;
    const W = 104, H = 18, halfW = W/2, halfH = H/2;
    const leaderTop = { x: cx, y: npCy + halfH };
    const leaderBot = { x: cx, y: cy - 54 };
    return `<a href="${agent.href}" class="nameplate" data-key="${agent.key}" style="--np-color: ${col}"><line class="np-leader" x1="${leaderTop.x}" y1="${leaderTop.y.toFixed(1)}" x2="${leaderBot.x}" y2="${leaderBot.y.toFixed(1)}"/><rect class="np-bg" x="${cx - halfW}" y="${(npCy - halfH).toFixed(1)}" width="${W}" height="${H}" rx="3"/><rect class="np-accent" x="${cx - halfW}" y="${(npCy - halfH).toFixed(1)}" width="3" height="${H}" rx="1"/><circle class="status-dot status-${agent.key} idle" cx="${cx - halfW + 14}" cy="${npCy.toFixed(1)}" r="3.5"/><text class="np-name" x="${cx - halfW + 22}" y="${(npCy - 2).toFixed(1)}">${agent.name}</text><text class="np-role" x="${cx - halfW + 22}" y="${(npCy + 5.5).toFixed(1)}">${agent.role}</text></a>`;
  }

  function renderOffice(svg) {
    const conn = renderConnections();
    const defs = `<defs>${OFFICE.map(a => `<radialGradient id="screen-${a.key}" cx="35%" cy="30%" r="90%"><stop offset="0%" stop-color="hsl(${a.hsl})" stop-opacity="0.95"/><stop offset="60%" stop-color="hsl(${a.hsl})" stop-opacity="0.35"/><stop offset="100%" stop-color="hsl(${a.hsl})" stop-opacity="0.05"/></radialGradient>`).join('')}${conn.defs}</defs>`;
    const floor = `<g class="floor">${renderFloor()}</g>`;
    const connLines = `<g class="connections">${conn.lines}</g>`;
    const sorted = OFFICE.slice().sort((a, b) => isoGridPos(a.pos[0],a.pos[1]).y - isoGridPos(b.pos[0],b.pos[1]).y);
    const stations = sorted.map(renderStation).join('');
    const flashes = `<g class="flashes">${conn.flashes}</g>`;
    const particles = `<g class="particles">${conn.particles}</g>`;
    const nameplates = `<g class="nameplates">${sorted.map(renderNameplate).join('')}</g>`;
    const chief = `<g class="chief-wrap">${renderChief()}</g>`;
    svg.innerHTML = defs + floor + connLines + stations + flashes + particles + nameplates + chief;
  }

  async function updateOfficeStatus(svg) {
    for (const agent of OFFICE) {
      const dot = svg.querySelector(`.status-${agent.key}`);
      if (!dot) continue;
      let state = 'idle';
      if (agent.alwaysOn) {
        state = 'online';
      } else if (agent.isCommunity) {
        try {
          const tasks = await (await fetch(agent.taskApi)).json();
          const nowMs = Date.now();
          const hourAgo = nowMs - 3600000;
          const firingSoon = tasks.some(t => {
            if (t.status !== 'scheduled') return false;
            const when = Date.parse(t.scheduled_at || '');
            return isFinite(when) && when - nowMs <= 15*60*1000 && when - nowMs > -60*1000;
          });
          const queued = tasks.some(t => ['scheduled','draft','manual'].includes(t.status));
          const recent = tasks.some(t => {
            if (t.status !== 'published') return false;
            const ts = t.published_at || t.updated_at || t.completed_at;
            if (!ts) return false;
            const when = new Date(ts).getTime();
            return isFinite(when) && when >= hourAgo;
          });
          state = firingSoon ? 'online' : queued ? 'queued' : recent ? 'recent' : 'idle';
        } catch {}
      } else {
        let tasks = [];
        if (agent.taskApis) {
          for (const api of agent.taskApis) { try { tasks = tasks.concat(await (await fetch(api)).json()); } catch {} }
        } else if (agent.taskApi) {
          try { tasks = await (await fetch(agent.taskApi)).json(); } catch {}
        }
        const processing = tasks.filter(t => t.status === 'processing').length;
        const pending = tasks.filter(t => t.status === 'pending').length;
        const hourAgo = Date.now() - 3600000;
        const recent = tasks.some(t => {
          if (t.status !== 'completed') return false;
          const ts = t.updated_at || t.completed_at || t.updatedAt || t.completedAt || t.created_at || t.createdAt;
          if (!ts) return false;
          const when = new Date(ts).getTime();
          return isFinite(when) && when >= hourAgo;
        });
        state = processing > 0 ? 'online' : pending > 0 ? 'queued' : recent ? 'recent' : 'idle';
      }
      dot.classList.remove('online', 'queued', 'recent', 'idle');
      dot.classList.add(state);
    }
  }

  function tickClock(el) {
    if (el) el.textContent = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  function initContainer(container) {
    container.innerHTML = `
      <div class="iso-wrap">
        <div class="iso-topbar">
          <div class="iso-topbar-left">${BRAND_NAME} · <b>Floor 01</b> · Live</div>
          <div class="iso-topbar-right"><span class="live-dot"></span><span class="iso-clock">--:--</span></div>
        </div>
        <svg class="iso-scene" viewBox="115 10 1115 720" preserveAspectRatio="xMidYMid meet"></svg>
      </div>
    `;
    const svg = container.querySelector('svg.iso-scene');
    const clock = container.querySelector('.iso-clock');
    renderOffice(svg);
    tickClock(clock);
    updateOfficeStatus(svg);
    setInterval(() => updateOfficeStatus(svg), 8000);
    setInterval(() => tickClock(clock), 30000);
  }

  async function init() {
    // Load brand config (company + assistant name) before rendering
    try {
      const res = await fetch('/brand');
      if (res.ok) {
        const b = await res.json();
        if (b && b.assistant_name) CHIEF.name = String(b.assistant_name).toUpperCase();
        if (b && b.company_name) BRAND_NAME = `${String(b.company_name).toUpperCase()} HQ`;
      }
    } catch {}
    const containers = document.querySelectorAll('[data-iso-office]');
    containers.forEach(initContainer);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
