/* ─────────────────────────────────────────────────────────────
   Brand color loader.
   Reads the saved primary hue from /brand and overrides the
   `--primary` / `--accent` / `--primary-glow` / `--border-glow`
   CSS variables on <html>, so the entire UI tints to the brand
   color the user picked in Settings.

   Loaded near the top of every page. To avoid a color flash on
   reload we apply a localStorage-cached hue immediately, then
   refresh from /brand once the response comes back.
   ───────────────────────────────────────────────────────────── */
(function () {
  var CACHE_KEY = 'cc_primary_hue';
  var DEFAULT_HUE = 264;
  var SAT = 65;
  var LIT = 49;
  var GLOW_LIT = 65;

  function applyHue(hue) {
    var h = parseInt(hue, 10);
    if (isNaN(h) || h < 0 || h > 360) return;
    var root = document.documentElement;
    var s = SAT + '%';
    var l = LIT + '%';
    var gl = GLOW_LIT + '%';
    root.style.setProperty('--primary', 'hsl(' + h + ' ' + s + ' ' + l + ')');
    root.style.setProperty('--primary-glow', 'hsla(' + h + ' ' + s + ' ' + gl + ' / 0.4)');
    root.style.setProperty('--primary-dim', 'hsla(' + h + ' ' + s + ' ' + l + ' / 0.5)');
    root.style.setProperty('--accent', 'hsl(' + h + ' ' + s + ' ' + l + ')');
    root.style.setProperty('--accent-dim', 'hsla(' + h + ' ' + s + ' ' + l + ' / 0.5)');
    root.style.setProperty('--border-glow', 'hsla(' + h + ' ' + s + ' ' + l + ' / 0.3)');
    root.style.setProperty('--primary-hue', String(h));
  }

  // Expose for live preview (e.g. settings page hue slider) and post-save refresh.
  window.ccApplyHue = function (hue, persist) {
    applyHue(hue);
    if (persist) {
      try { localStorage.setItem(CACHE_KEY, String(parseInt(hue, 10))); } catch (e) {}
    }
  };

  // Paint immediately from cache so the page doesn't flash the default purple.
  try {
    var cached = localStorage.getItem(CACHE_KEY);
    if (cached) applyHue(cached);
  } catch (e) {}

  // Refresh from server (and update cache for next load).
  fetch('/brand', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (b) {
      if (!b) return;
      var hue = parseInt(b.primary_hue, 10);
      if (isNaN(hue)) return;
      applyHue(hue);
      try { localStorage.setItem(CACHE_KEY, String(hue)); } catch (e) {}
    })
    .catch(function () {});
})();
