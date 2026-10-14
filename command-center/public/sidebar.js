(function () {
  const NAV_ITEMS = [
    { href: 'index.html', label: 'Overview', icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { href: 'agents.html', label: 'Scheduler', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
    { href: 'designer.html', label: 'Designer', icon: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>' },
    { href: 'content-creator.html', label: 'Content Creator', icon: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>' },
    { href: 'marketing.html', label: 'Marketing', icon: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>' },
    { href: 'community-manager.html', label: 'Social Media Manager', icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
  ];

  const BELL_ICON = '<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>';
  const SETTINGS_ICON = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>';

  const LOGOUT_ICON = '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>';

  function bindLogout() {
    sidebar.querySelectorAll('.cc-logout').forEach(a => a.addEventListener('click', async e => {
      e.preventDefault();
      try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
      location.href = '/login.html';
    }));
  }

  function svg(inner) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${inner}</svg>`;
  }

  // Wide sidebar with visible labels on desktop. Every page sizes .main via --sidebar-w,
  // so overriding it here is enough. Below 1025px the pages' own icon/mobile layout applies.
  if (!document.getElementById('sidebar-wide-style')) {
    const st = document.createElement('style');
    st.id = 'sidebar-wide-style';
    st.textContent = `
      @media (min-width: 1025px) {
        html:root { --sidebar-w: 214px; }
        html .sidebar { align-items: stretch; padding: 16px 12px; overflow-y: auto; }
        html .sidebar-logo { text-align: center; font-size: 13px; letter-spacing: 0.16em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        html .sidebar-logo .logo-short { display: none; }
        html .sidebar-logo .logo-full { display: inline; }
        html .sidebar .nav-item { width: auto; height: 38px; justify-content: flex-start; gap: 11px; padding: 0 11px; flex-shrink: 0; }
        html .sidebar .nav-item svg { flex-shrink: 0; }
        html .sidebar .nav-item .tooltip { position: static; transform: none; opacity: 1; background: none; border: 0; padding: 0; font-size: 13px; font-weight: 500; color: inherit; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
        html .sidebar .nav-external .tooltip::after { content: ' \\2197'; opacity: 0.5; }
        html .sidebar .notif-badge { left: auto; right: 10px; top: 50%; transform: translateY(-50%); }
      }
      .sidebar-logo .logo-full { display: none; }`;
    document.head.appendChild(st);
  }

  // Logo = company name from /brand (full on the wide sidebar, initials on the icon bar).
  let brandName = '';
  const LOGO = '<div class="sidebar-logo"><span class="logo-short"></span><span class="logo-full"></span></div>';
  function paintLogo() {
    if (!brandName) return;
    const words = brandName.split(/[\s_-]+/).filter(Boolean);
    let short = words.length > 1 ? words.map(w => w[0]).join('') : (brandName.match(/[A-Z]/g) || []).join('');
    if (short.length < 2 || short.length > 3) short = brandName.slice(0, 2);
    sidebar.querySelectorAll('.sidebar-logo').forEach(el => {
      el.title = brandName;
      el.querySelector('.logo-short').textContent = short.toUpperCase();
      el.querySelector('.logo-full').textContent = brandName.toUpperCase();
    });
  }

  const currentPage = location.pathname.split('/').pop() || 'index.html';

  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  sidebar.innerHTML = `
    ${LOGO}
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
    <a class="nav-item cc-logout" href="#">${svg(LOGOUT_ICON)}<span class="tooltip">Log out</span></a>
  `;
  bindLogout();

  // Optional external tools, only when configured in .env (PHOTO_EDITOR_URL, VIDEO_EDITOR_URL)
  const EXTERNAL_TOOLS = [
    { key: 'photo_editor', label: 'Photo Editor', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>' },
    { key: 'video_editor', label: 'Video Editor', icon: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>' },
  ];
  // Team users (Settings → Users & access) only see their own tools and a log out button.
  sidebar.style.visibility = 'hidden';
  const reveal = setTimeout(() => { sidebar.style.visibility = ''; }, 1500);
  fetch('/auth/check', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      const u = d && d.user;
      if (!u || u.role !== 'user') return;
      document.documentElement.classList.add('cc-team-user');
      const pages = (u.tools || []).map(t => String(t.page || '').replace(/^\//, ''))
      pages.unshift('index.html');
      const items = NAV_ITEMS.filter(i => pages.includes(i.href));
      sidebar.innerHTML = `
        ${LOGO}
        <nav class="sidebar-nav">
          ${items.map(item => `<a class="nav-item${item.href === currentPage ? ' active' : ''}" href="${item.href}">${svg(item.icon)}<span class="tooltip">${item.label}</span></a>`).join('')}
        </nav>
        <a class="nav-item cc-logout" href="#" style="margin-top:auto">${svg(LOGOUT_ICON)}<span class="tooltip">Log out</span></a>`;
      bindLogout();
      paintLogo();
    })
    .catch(() => {})
    .finally(() => { clearTimeout(reveal); sidebar.style.visibility = ''; });

  if (!document.getElementById('cc-team-style')) {
    const st = document.createElement('style');
    st.id = 'cc-team-style';
    st.textContent = 'html.cc-team-user [data-owner-only] { display: none !important; }';
    document.head.appendChild(st);
  }

  // Explain mode switch + guides under the page title (explain-mode.js)
  if (!document.getElementById('cc-explain-js')) {
    const xs = document.createElement('script');
    xs.id = 'cc-explain-js';
    xs.src = '/explain-mode.js';
    document.head.appendChild(xs);
  }

  fetch('/brand', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(brand => {
      brandName = String((brand && (brand.company_name || brand.name)) || '').trim();
      paintLogo();
      const links = (brand && brand.links) || {};
      const nav = sidebar.querySelector('.sidebar-nav');
      EXTERNAL_TOOLS.forEach(tool => {
        const url = links[tool.key];
        if (!url || !/^https?:\/\//.test(url)) return;
        const a = document.createElement('a');
        a.className = 'nav-item nav-external';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.innerHTML = `${svg(tool.icon)}<span class="tooltip">${tool.label}</span>`;
        nav.appendChild(a);
      });
    })
    .catch(() => {});
})();
