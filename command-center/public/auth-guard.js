(async function() {
  if (window.location.pathname === '/login.html') return;
  if (window.location.pathname === '/setup.html') return;
  try {
    const res = await fetch('/auth/check', { credentials: 'include' });
    const data = await res.json();
    if (!data.authenticated) { window.location.href = '/login.html'; return; }
    // Redirect to setup wizard if not yet configured (first login)
    const sr = await fetch('/api/setup-status', { credentials: 'include' });
    const setup = await sr.json();
    if (!setup.setup_complete) { window.location.href = '/setup.html'; return; }
  } catch {
    window.location.href = '/login.html';
  }
})();
