/* ─────────────────────────────────────────────────────────────────────────────
   WenBot Overlay Theme Engine
   Shared by every /overlay-*.html page. Reads appearance settings from the URL
   query string and applies them as CSS custom properties on :root, loads the
   chosen Google Font, and (optionally) overrides header text.

   URL params (all optional):
     accent  — accent color hex, with or without # (e.g. 00e5ff)
     bg      — "transparent" | panel background color hex (e.g. 0d1117)
     bgo     — panel background opacity 0–100 (only used when bg is a color)
     text    — main text color hex
     font    — font key (see OV_FONTS below; e.g. Poppins, Montserrat)
     header  — custom header text (URL-encoded). Replaces any element marked
               with [data-ov-header].

   Overlays consume these variables:
     --ov-accent        accent color           (default #00e5ff)
     --ov-accent-rgb    accent as "r,g,b"      (default 0,229,255)
     --ov-panel         panel/card background  (default rgba(13,17,23,0.92))
     --ov-text          primary text color     (default #ffffff)
     --ov-font          body font stack        (default 'Inter', sans-serif)
     --ov-font-heading  heading font stack     (default 'Exo 2', sans-serif)
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Google Font key → { family, weights, fallback }
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
    // Avoid duplicate <link>s
    if (!document.querySelector('link[data-ov-font="' + key + '"]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-ov-font', key);
      document.head.appendChild(link);
    }
    return "'" + def.family + "', " + def.fallback;
  }

  function apply() {
    var params = new URLSearchParams(window.location.search);
    var root = document.documentElement;

    // Accent
    var accent = params.get('accent');
    if (accent) {
      var rgb = hexToRgb(accent);
      if (rgb) {
        root.style.setProperty('--ov-accent', '#' + accent.replace('#', ''));
        root.style.setProperty('--ov-accent-rgb', rgb);
      }
    }

    // Background (panel)
    var bg = params.get('bg');
    if (bg === 'transparent') {
      root.style.setProperty('--ov-panel', 'transparent');
    } else if (bg) {
      var bgRgb = hexToRgb(bg);
      if (bgRgb) {
        var op = parseInt(params.get('bgo'), 10);
        if (isNaN(op)) op = 100;
        root.style.setProperty('--ov-panel', 'rgba(' + bgRgb + ',' + (op / 100) + ')');
      }
    }

    // Text color
    var text = params.get('text');
    if (text && hexToRgb(text)) {
      root.style.setProperty('--ov-text', '#' + text.replace('#', ''));
    }

    // Font (applies to both body + headings)
    var font = params.get('font');
    if (font) {
      var stack = loadFont(font);
      if (stack) {
        root.style.setProperty('--ov-font', stack);
        root.style.setProperty('--ov-font-heading', stack);
      }
    }

    // Custom header text
    var header = params.get('header');
    if (header) {
      var run = function () {
        var els = document.querySelectorAll('[data-ov-header]');
        for (var i = 0; i < els.length; i++) els[i].textContent = header;
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
      } else {
        run();
      }
    }
  }

  apply();

  // Expose for the dashboard preview, which may want the font list.
  window.OV_FONTS = OV_FONTS;
})();
