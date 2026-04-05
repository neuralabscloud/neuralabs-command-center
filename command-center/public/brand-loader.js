// brand-loader.js — Loads brand config from /brand API and applies it to the page
(function () {
  fetch("/brand")
    .then((r) => r.json())
    .then((b) => {
      // Update page title
      if (b.company_name) {
        document.title = document.title.replace(/NEURALABS|Trading Platform/gi, b.company_name);
      }

      // Update branded text elements
      document.querySelectorAll("[data-brand='company']").forEach((el) => {
        el.textContent = b.company_name || el.textContent;
      });
      document.querySelectorAll("[data-brand='assistant']").forEach((el) => {
        el.textContent = b.assistant_name || el.textContent;
      });
      document.querySelectorAll("[data-brand='tagline']").forEach((el) => {
        el.textContent = b.tagline || el.textContent;
      });

      // Override CSS custom properties for branding colors if provided
      if (b.primary_hue !== undefined) {
        const root = document.documentElement;
        const h = b.primary_hue, s = b.primary_sat || 65, l = b.primary_lit || 49;
        root.style.setProperty("--primary", `${h} ${s}% ${l}%`);
        root.style.setProperty("--primary-glow", `${h} ${s}% ${Math.min(l + 16, 100)}%`);
        root.style.setProperty("--accent", `${h} ${s}% ${l}%`);
        root.style.setProperty("--ring", `${h} ${s}% ${l}%`);
        root.style.setProperty("--premium", `${h} ${Math.min(s + 30, 100)}% ${Math.min(l + 16, 100)}%`);
      }

      // Hide navigation items for disabled features
      if (b.features) {
        if (!b.features.stripe) {
          document.querySelectorAll("[data-feature='stripe']").forEach((el) => el.style.display = "none");
        }
        if (!b.features.heygen) {
          document.querySelectorAll("[data-feature='heygen']").forEach((el) => el.style.display = "none");
        }
        if (!b.features.composio) {
          document.querySelectorAll("[data-feature='composio']").forEach((el) => el.style.display = "none");
        }
        if (!b.features.telegram) {
          document.querySelectorAll("[data-feature='telegram']").forEach((el) => el.style.display = "none");
        }
      }
    })
    .catch(() => {}); // Silently fail — defaults in HTML are fine
})();
