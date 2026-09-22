(function () {
  const NAV_ITEMS = [
    { href: 'index.html', label: 'Overview', icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { href: 'agents.html', label: 'Scheduler', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
    { href: 'editor.html', label: 'Video Editor', icon: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>' },
    { href: 'designer.html', label: 'Designer', icon: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>' },
    { href: 'content-creator.html', label: 'Content Creator', icon: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>' },
    { href: 'marketing.html', label: 'Marketing', icon: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>' },
    { href: 'community-manager.html', label: 'Social Media Manager', icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
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
    <div class="nav-item notif-bell" onclick="toggleNotifPanel()" style="margin-top:auto">
      ${svg(BELL_ICON)}
      <span class="tooltip">Notifications</span>
      <span class="notif-badge" id="notif-badge" style="display:none">0</span>
    </div>
    <a class="nav-item${currentPage === 'settings.html' ? ' active' : ''}" href="settings.html">
      ${svg(SETTINGS_ICON)}
      <span class="tooltip">Settings</span>
    </a>
  `;
})();
