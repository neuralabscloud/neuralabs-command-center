(async function() {
  if (window.location.pathname === '/login.html') return;
  try {
    const res = await fetch('/auth/check', { credentials: 'include' });
    const data = await res.json();
    if (!data.authenticated) window.location.href = '/login.html';
  } catch {
    window.location.href = '/login.html';
  }
})();
