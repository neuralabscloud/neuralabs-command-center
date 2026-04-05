(function () {
  // ── CSS ──
  const style = document.createElement('style');
  style.textContent = `
    .notif-bell { position: relative; cursor: pointer; }
    .notif-badge {
      position: absolute; top: 2px; right: 2px;
      min-width: 16px; height: 16px; padding: 0 4px;
      border-radius: 8px; background: hsl(0 72% 51%);
      color: #fff; font-size: 9px; font-weight: 700;
      font-family: var(--font-data); display: flex;
      align-items: center; justify-content: center;
      animation: pulse-glow 2s infinite;
    }
    .notif-panel {
      position: fixed; left: var(--sidebar-w, 62px); top: 0; bottom: 0;
      width: 340px; background: hsl(0 0% 3%);
      border-right: 1px solid hsl(217 32% 20%);
      z-index: 200; display: none; flex-direction: column;
      box-shadow: 8px 0 32px rgba(0,0,0,0.5);
    }
    .notif-panel.open { display: flex; }
    .notif-panel-header {
      padding: 16px 18px; border-bottom: 1px solid hsl(217 32% 20%);
      display: flex; align-items: center; justify-content: space-between;
    }
    .notif-panel-title {
      font-family: var(--font-display, 'Orbitron', sans-serif);
      font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;
      color: hsl(210 40% 98%);
    }
    .notif-mark-read {
      font-family: var(--font-data, 'Inter', sans-serif); font-size: 10px;
      color: hsl(215 20% 65%); background: none; border: 1px solid hsl(217 32% 20%);
      padding: 4px 10px; border-radius: 6px; cursor: pointer; transition: all 0.2s;
    }
    .notif-mark-read:hover { color: hsl(264 65% 49%); border-color: hsl(264 65% 49%); }
    .notif-list {
      flex: 1; overflow-y: auto; padding: 8px 0;
    }
    .notif-list::-webkit-scrollbar { width: 4px; }
    .notif-list::-webkit-scrollbar-thumb { background: hsl(217 32% 20%); border-radius: 2px; }
    .notif-item {
      display: flex; gap: 10px; padding: 12px 18px; cursor: pointer;
      transition: background 0.15s; border-left: 2px solid transparent;
    }
    .notif-item:hover { background: hsla(264 65% 49% / 0.03); }
    .notif-item.unread { border-left-color: hsl(264 65% 49%); background: hsla(264 65% 49% / 0.02); }
    .notif-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 4px;
    }
    .notif-dot.success { background: hsl(142 76% 36%); }
    .notif-dot.danger { background: hsl(0 72% 51%); }
    .notif-dot.warning { background: hsl(45 93% 55%); }
    .notif-dot.info { background: hsl(264 65% 49%); }
    .notif-content { flex: 1; min-width: 0; }
    .notif-title {
      font-family: var(--font-data, 'Inter', sans-serif); font-size: 12px;
      font-weight: 600; color: hsl(210 40% 98%); margin-bottom: 2px;
    }
    .notif-msg {
      font-family: var(--font-data, 'Inter', sans-serif); font-size: 11px;
      color: hsl(215 20% 65%); line-height: 1.5;
    }
    .notif-link {
      display: inline-block; margin-top: 4px; font-size: 10px; font-weight: 600;
      color: hsl(180 70% 45%); text-decoration: none; font-family: var(--font-data, 'Inter', sans-serif);
      padding: 3px 8px; border-radius: 4px; background: hsla(180 70% 45% / 0.08);
      border: 1px solid hsla(180 70% 45% / 0.2); transition: all 0.2s;
    }
    .notif-link:hover { background: hsla(180 70% 45% / 0.15); }
    .notif-time {
      font-family: var(--font-data, 'Inter', sans-serif); font-size: 9px;
      color: hsl(215 20% 45%); flex-shrink: 0; margin-top: 3px;
    }
    .notif-empty {
      padding: 40px 18px; text-align: center;
      font-family: var(--font-data, 'Inter', sans-serif);
      font-size: 12px; color: hsl(215 20% 45%);
    }
    .notif-overlay {
      position: fixed; inset: 0; z-index: 199; display: none;
    }
    .notif-overlay.open { display: block; }
    @media (max-width: 768px) {
      .notif-panel {
        left: 0; right: 0; bottom: 0; top: auto;
        width: 100%; max-height: 70vh;
        border-right: none; border-top: 1px solid hsl(217 32% 20%);
        border-radius: 16px 16px 0 0;
        box-shadow: 0 -8px 32px rgba(0,0,0,0.5);
      }
    }
  `;
  document.head.appendChild(style);

  // ── Panel HTML ──
  const overlay = document.createElement('div');
  overlay.className = 'notif-overlay';
  overlay.onclick = () => closePanel();
  document.body.appendChild(overlay);

  const panel = document.createElement('div');
  panel.className = 'notif-panel';
  panel.innerHTML = `
    <div class="notif-panel-header">
      <span class="notif-panel-title">Notifications</span>
      <button class="notif-mark-read" onclick="notifMarkAllRead()">Mark all read</button>
    </div>
    <div class="notif-list" id="notif-list"></div>
  `;
  document.body.appendChild(panel);

  let panelOpen = false;

  function timeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function renderNotifs(notifs) {
    const list = document.getElementById('notif-list');
    if (!notifs.length) {
      list.innerHTML = '<div class="notif-empty">Geen meldingen</div>';
      return;
    }
    list.innerHTML = notifs.map(n => {
      // Build message: strip URLs from text, show as buttons
      let msgText = (n.message || '').replace(/\n?(Video|Download): https?:\/\/\S+/g, '').trim();
      let links = '';
      if (n.heygen_url) links += `<a class="notif-link" href="${n.heygen_url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open in HeyGen</a> `;
      if (n.result_url) links += `<a class="notif-link" href="${n.result_url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Download video</a>`;

      return `<div class="notif-item ${n.read ? '' : 'unread'}" onclick="notifMarkRead('${n.id}', this)">
        <div class="notif-dot ${n.severity}"></div>
        <div class="notif-content">
          <div class="notif-title">${esc(n.title)}</div>
          <div class="notif-msg">${esc(msgText)}</div>
          ${links ? '<div style="margin-top:6px">' + links + '</div>' : ''}
        </div>
        <div class="notif-time">${timeAgo(n.created_at)}</div>
      </div>`;
    }).join('');
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  async function pollBadge() {
    try {
      const r = await fetch('/notifications/unread-count');
      const { count } = await r.json();
      const badge = document.getElementById('notif-badge');
      if (!badge) return;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    } catch {}
  }

  async function openPanel() {
    panelOpen = true;
    panel.classList.add('open');
    overlay.classList.add('open');
    try {
      const r = await fetch('/notifications?limit=50');
      const notifs = await r.json();
      renderNotifs(notifs);
    } catch { renderNotifs([]); }
  }

  function closePanel() {
    panelOpen = false;
    panel.classList.remove('open');
    overlay.classList.remove('open');
  }

  window.toggleNotifPanel = function () {
    panelOpen ? closePanel() : openPanel();
  };

  window.notifMarkRead = async function (id, el) {
    try { await fetch(`/notifications/${id}/read`, { method: 'PATCH' }); } catch {}
    if (el) el.classList.remove('unread');
    pollBadge();
  };

  window.notifMarkAllRead = async function () {
    try { await fetch('/notifications/read-all', { method: 'POST' }); } catch {}
    document.querySelectorAll('.notif-item.unread').forEach(el => el.classList.remove('unread'));
    pollBadge();
  };

  // Poll badge every 15s
  pollBadge();
  setInterval(pollBadge, 15_000);

  // Refresh panel if open
  setInterval(() => { if (panelOpen) openPanel(); }, 30_000);
})();
