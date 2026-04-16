(function () {
  const NAV_ITEMS = [
    { href: 'index.html', label: 'Overview', icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { href: 'research.html', label: 'Research', icon: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>' },
    { href: 'performance.html', label: 'Performance', icon: '<path d="M3 3v18h18"/><path d="M7 16l4-6 4 4 5-8"/>' },
    { href: 'ads.html', label: 'Ads Manager', icon: '<path d="M3 11l18-5v12L3 13v-2z"/><circle cx="7" cy="12" r="2"/>' },
    { href: 'agents.html', label: 'Agents', icon: '<circle cx="12" cy="8" r="4"/><path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/>' },
    { href: 'editor.html', label: 'Video Editor', icon: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>' },
    { href: 'designer.html', label: 'Designer', icon: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>' },
    { href: 'analyst.html', label: 'Analyst', icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h2"/><path d="M8 17h2"/><path d="M14 13h2"/><path d="M14 17h2"/>' },
    { href: 'content-creator.html', label: 'Content Creator', icon: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>' },
    { href: 'scriptwriter.html', label: 'Script Writer', icon: '<path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>' },
    { href: 'http://147.79.102.153:3000/', label: 'Trading Dashboard', icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>', external: true },
  ];

  const BELL_ICON = '<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>';
  const SETTINGS_ICON = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>';

  function svg(inner) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${inner}</svg>`;
  }

  const currentPage = location.pathname.split('/').pop() || 'index.html';

  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  sidebar.innerHTML = `
    <div class="sidebar-logo">NL</div>
    <nav class="sidebar-nav">
      ${NAV_ITEMS.map(item => {
        const active = item.href === currentPage ? ' active' : '';
        const target = item.external ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a class="nav-item${active}" href="${item.href}"${target}>${svg(item.icon)}<span class="tooltip">${item.label}</span></a>`;
      }).join('\n      ')}
    </nav>
    <a class="nav-item${currentPage === 'chat.html' ? ' active' : ''}" href="chat.html" style="margin-top:auto">
      ${svg('<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>')}
      <span class="tooltip" id="sidebar-assistant-tooltip">Assistant</span>
    </a>
    <div class="nav-item notif-bell" onclick="toggleNotifPanel()">
      ${svg(BELL_ICON)}
      <span class="tooltip">Notifications</span>
      <span class="notif-badge" id="notif-badge" style="display:none">0</span>
    </div>
    <a class="nav-item${currentPage === 'settings.html' ? ' active' : ''}" href="settings.html">
      ${svg(SETTINGS_ICON)}
      <span class="tooltip">Settings</span>
    </a>
  `;

  // Dynamically load assistant name from brand config
  fetch('/brand').then(r => r.json()).then(b => {
    const name = b && b.assistant_name;
    if (!name) return;
    const el = document.getElementById('sidebar-assistant-tooltip');
    if (el) el.textContent = name;
  }).catch(() => {});
})();
