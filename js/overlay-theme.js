/* ─────────────────────────────────────────────────────────────────────────────
   WenBot Overlay Theme Engine
   Shared by every /overlay-*.html page. Applies appearance settings as CSS custom
   properties on :root, loads the chosen Google Font, and (optionally) overrides
   header text.

   Two sources, applied in order (later wins):
     1. URL query params (legacy + override) — accent, bg, bgo, text, font, header.
     2. The streamer's SAVED theme from /api/overlay-theme (Overlay Studio) —
        polled, so changes made in the dashboard propagate to OBS within seconds
        WITHOUT re-copying the URL. Only applied when a saved theme exists for this
        overlay; otherwise the URL params stand (fully backwards-compatible).

   Overlays consume:
     --ov-accent / --ov-accent-rgb / --ov-panel / --ov-text / --ov-font / --ov-font-heading
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var OV_FONTS = {
    Inter:     { family: 'Inter',      weights: '400;500;600;700;800;900', fallback: 'sans-serif' },
    Poppins:   { family: 'Poppins',    weights: '400;500;600;700;800',     fallback: 'sans-serif' },
    Montserrat:{ family: 'Montserrat', weights: '400;500;600;700;800;900', fallback: 'sans-serif' },
    Roboto:    { family: 'Roboto',     weights: '400;500;700;900',         fallback: 'sans-serif' },
    OpenSans:  { family: 'Open Sans',  weights: '400;500;600;700;800',     fallback: 'sans-serif' },
    Lato:      { family: 'Lato',       weights: '400;700;900',             fallback: 'sans-serif' },
    WorkSans:  { family: 'Work Sans',  weights: '400;500;600;700;800',     fallback: 'sans-serif' },
    DMSans:    { family: 'DM Sans',    weights: '400;500;700',             fallback: 'sans-serif' },
    Rajdhani:  { family: 'Rajdhani',   weights: '500;600;700',             fallback: 'sans-serif' },
    Oswald:    { family: 'Oswald',     weights: '400;500;600;700',         fallback: 'sans-serif' },
    Exo2:      { family: 'Exo 2',      weights: '600;700;800;900',         fallback: 'sans-serif' },
    RussoOne:  { family: 'Russo One',  weights: '400',                     fallback: 'sans-serif' },
    BebasNeue: { family: 'Bebas Neue', weights: '400',                     fallback: 'sans-serif' },
    Teko:      { family: 'Teko',       weights: '500;600;700',             fallback: 'sans-serif' },
  };

  // Overlay page filename → Overlay Studio theme id (matches OS_OVERLAYS).
  var PATH_TO_ID = {
    'overlay-bonus-hunt':       'bonushunt',
    'overlay-slot-requests':    'slotreqs',
    'overlay-slot-picker':      'slotpicker',
    'overlay-request-spinner':  'reqspinner',
    'overlay-giveaway-spinner': 'gwspinner',
    'overlay-wheel':            'wheel',
    'overlay-winner':           'winner',
    'overlay-giveaway':         'entries',
    'overlay-bonus-battle':     'bonusbattle',
    'overlay-tournament':       'tournament',
    'overlay-bankroll':         'bankroll',
    'overlay-deposits':         'deposits',
    'overlay-withdrawals':      'withdrawals',
    'overlay-chat':             'chat',
  };

  function hexToRgb(hex) {
    hex = String(hex || '').replace('#', '').trim();
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    var n = parseInt(hex, 16);
    return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }

  function loadFont(key) {
    var def = OV_FONTS[key];
    if (!def) return null;
    var href = 'https://fonts.googleapis.com/css2?family=' +
      encodeURIComponent(def.family).replace(/%20/g, '+') +
      ':wght@' + def.weights + '&display=swap';
    if (!document.querySelector('link[data-ov-font="' + key + '"]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-ov-font', key);
      document.head.appendChild(link);
    }
    return "'" + def.family + "', " + def.fallback;
  }

  function setHeader(text) {
    var run = function () {
      var els = document.querySelectorAll('[data-ov-header]');
      for (var i = 0; i < els.length; i++) els[i].textContent = text;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }

  // Apply a normalized theme. Each field is optional — only provided fields change,
  // so this is safe to call repeatedly (polling) and to layer sources.
  //   { accent, bg ('transparent'|hex), bgo (0-100), text, font, header }
  function applyTheme(t) {
    if (!t) return;
    var root = document.documentElement;

    if (t.accent) {
      var rgb = hexToRgb(t.accent);
      if (rgb) {
        root.style.setProperty('--ov-accent', '#' + String(t.accent).replace('#', ''));
        root.style.setProperty('--ov-accent-rgb', rgb);
      }
    }

    if (t.bg === 'transparent') {
      root.style.setProperty('--ov-panel', 'transparent');
    } else if (t.bg) {
      var bgRgb = hexToRgb(t.bg);
      if (bgRgb) {
        var op = parseInt(t.bgo, 10);
        if (isNaN(op)) op = 100;
        root.style.setProperty('--ov-panel', 'rgba(' + bgRgb + ',' + (op / 100) + ')');
      }
    }

    if (t.text && hexToRgb(t.text)) {
      root.style.setProperty('--ov-text', '#' + String(t.text).replace('#', ''));
    }

    if (t.font) {
      var stack = loadFont(t.font);
      if (stack) {
        root.style.setProperty('--ov-font', stack);
        root.style.setProperty('--ov-font-heading', stack);
      }
    }

    if (t.header != null && t.header !== '') setHeader(t.header);
  }

  function themeFromParams() {
    var p = new URLSearchParams(window.location.search);
    return {
      accent: p.get('accent'),
      bg:     p.get('bg'),
      bgo:    p.get('bgo'),
      text:   p.get('text'),
      font:   p.get('font'),
      header: p.get('header'),
    };
  }

  // Convert the dashboard's saved theme object → the normalized shape above.
  function fromSaved(s) {
    if (!s) return null;
    return {
      accent: s.accent,
      bg:     (s.bgMode === 'transparent') ? 'transparent' : s.bgColor,
      bgo:    s.bgOpacity,
      text:   s.text,
      font:   s.font,
      header: s.header,
    };
  }

  function overlayId() {
    var m = window.location.pathname.match(/([^\/]+?)\.html$/i);
    return m ? (PATH_TO_ID[m[1]] || null) : null;
  }

  // Poll the streamer's saved theme so OBS picks up dashboard changes live.
  // Only overrides when a saved theme exists for THIS overlay (otherwise the URL
  // params stand). Failures are silent — the overlay keeps its current look.
  function pollServerTheme() {
    var channel = new URLSearchParams(window.location.search).get('channel');
    var id = overlayId();
    if (!channel || !id) return;
    fetch('/api/overlay-theme?channel=' + encodeURIComponent(channel))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var saved = d && d.overlays && d.overlays[id];
        if (saved) applyTheme(fromSaved(saved));
      })
      .catch(function () {});
  }

  // 1) URL params first (legacy + immediate paint).
  applyTheme(themeFromParams());
  // 2) Saved theme on top + poll for live updates — but ONLY when loaded
  //    standalone (OBS). Inside the dashboard's preview iframe the live-edited
  //    theme arrives via URL params, and polling the SAVED theme here would
  //    override the user's unsaved edits (the preview would never show changes).
  if (window.self === window.top) {
    pollServerTheme();
    setInterval(pollServerTheme, 20000);
  }

  window.OV_FONTS = OV_FONTS;
})();
