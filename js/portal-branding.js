// Applies the streamer's portal branding to STANDALONE pages (store.html,
// leaderboard.html) so customization done for the portal reflects everywhere
// their public links go: white-label palette, elite theme color, and logo.
// Reads the same cached /api/portal-data payload the portal itself renders
// from — no new backend surface, and a page with no portal config just keeps
// the default WenBot look.
async function applyPortalBranding(channel) {
  if (!channel) return null;
  try {
    const r = await fetch('/api/portal-data?channel=' + encodeURIComponent(channel));
    if (!r.ok) return null;
    const s = await r.json();
    const root = document.documentElement.style;
    const hexToGlow = (hex) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.2)`;
    };

    const theme = s && s.portal && s.portal.theme;
    if (theme) {
      // White-label: full brand palette over the CSS variables (same map as portal.html).
      const map = {
        accent: '--accent', accent2: '--accent-2', gold: '--gold',
        bg: '--bg', bgCard: '--bg-card', border: '--border',
        text: '--text', textDim: '--text-dim', bright: '--bright',
      };
      Object.keys(map).forEach(k => { if (theme[k]) root.setProperty(map[k], theme[k]); });
      root.setProperty('--accent-glow', theme.accentGlow || hexToGlow(theme.accent) || 'rgba(0,229,255,0.2)');
    } else if (s && s.streamer && s.streamer.themeColor) {
      // Standard streamers: the single elite theme color.
      root.setProperty('--accent', s.streamer.themeColor);
      const g = hexToGlow(s.streamer.themeColor);
      if (g) root.setProperty('--accent-glow', g);
    }

    // White-label logo replaces the WenBot wordmark in the nav when present.
    const logoUrl = (s && s.portal && s.portal.logoUrl) || null;
    const logoEl  = document.querySelector('.nav-logo');
    if (logoUrl && logoEl) {
      logoEl.innerHTML = `<img src="${String(logoUrl).replace(/"/g, '&quot;')}" alt="" style="height:30px;display:block;">`;
    }
    return s;
  } catch { return null; }
}
