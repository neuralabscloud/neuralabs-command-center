(async function() {
  const p = window.location.pathname;
  if (p === '/login.html' || p === '/setup.html') return;
  try {
    const res = await fetch('/auth/check', { credentials: 'include' });
    const data = await res.json();
    if (!data.authenticated) { window.location.href = '/login.html'; return; }
  } catch {
    window.location.href = '/login.html';
    return;
  }
  try {
    const r = await fetch('/api/setup-status', { credentials: 'include' });
    if (r.ok) {
      const d = await r.json();
      if (d.needs_setup) window.location.href = '/setup.html';
    }
  } catch {}
})();
