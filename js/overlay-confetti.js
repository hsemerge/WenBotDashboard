/* ─────────────────────────────────────────────────────────────────────────────
   WenBot Overlay Confetti
   Lightweight CSS-driven celebration burst for winner-reveal moments. Auto-
   creates the host container on first call so overlays only need to call
   window.ovConfetti(opts?). Particles clean themselves up on animation end.

   opts (all optional):
     count   — number of particles (default 50)
     duration — ms each particle is visible (default 2200)
     colors  — array of hex colors (default rainbow + theme accent + winner)
     origin  — 'top' (default — falls from above) | 'center' (burst outward)
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Inject keyframes + container styles once per document.
  function ensureStyles() {
    if (document.getElementById('ov-confetti-styles')) return;
    const css = `
      .ov-confetti-host {
        position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 9999;
      }
      .ov-confetti-piece {
        position: absolute;
        width: 8px; height: 12px;
        opacity: 0;
        will-change: transform, opacity;
      }
      .ov-confetti-piece.fall    { animation: ovConfettiFall  var(--d,2.2s) ease-in forwards; }
      .ov-confetti-piece.burst   { animation: ovConfettiBurst var(--d,2.2s) cubic-bezier(0.18,0.7,0.3,1) forwards; }
      @keyframes ovConfettiFall {
        0%   { opacity: 1; transform: translate3d(0,-20px,0) rotate(0deg); }
        100% { opacity: 0; transform: translate3d(var(--dx,0),110vh,0) rotate(var(--rot,720deg)); }
      }
      @keyframes ovConfettiBurst {
        0%   { opacity: 1; transform: translate3d(-50%,-50%,0) rotate(0deg) scale(0.4); }
        60%  { opacity: 1; }
        100% { opacity: 0; transform: translate3d(calc(-50% + var(--dx,0px)), calc(-50% + var(--dy,0px)), 0) rotate(var(--rot,540deg)) scale(1); }
      }
    `;
    const style = document.createElement('style');
    style.id = 'ov-confetti-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function getHost() {
    let host = document.querySelector('.ov-confetti-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'ov-confetti-host';
      document.body.appendChild(host);
    }
    return host;
  }

  function themeColors() {
    const root = getComputedStyle(document.documentElement);
    const accent = (root.getPropertyValue('--ov-accent') || '#00e5ff').trim();
    const winner = (root.getPropertyValue('--ov-winner') || '#ffd700').trim();
    return [accent, winner, '#ffd700', '#00e5ff', '#a78bfa', '#ff6b9d', '#00ff88', '#ffb347'];
  }

  function rand(min, max) { return Math.random() * (max - min) + min; }

  window.ovConfetti = function (opts) {
    opts = opts || {};
    ensureStyles();
    const host     = getHost();
    const count    = opts.count    || 50;
    const duration = opts.duration || 2200;
    const colors   = opts.colors   || themeColors();
    const origin   = opts.origin   || 'top';

    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'ov-confetti-piece ' + (origin === 'center' ? 'burst' : 'fall');
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.width      = rand(5, 10).toFixed(1) + 'px';
      p.style.height     = rand(8, 14).toFixed(1) + 'px';
      p.style.borderRadius = Math.random() < 0.3 ? '50%' : '2px';
      p.style.setProperty('--d', (duration + rand(-400, 600)) + 'ms');
      p.style.setProperty('--rot', rand(360, 1080).toFixed(0) + 'deg');

      if (origin === 'center') {
        p.style.left = '50%';
        p.style.top  = '50%';
        p.style.setProperty('--dx', rand(-260, 260).toFixed(0) + 'px');
        p.style.setProperty('--dy', rand(-220, 60).toFixed(0)  + 'px');
      } else {
        p.style.left = rand(0, 100).toFixed(1) + 'vw';
        p.style.top  = '-12px';
        p.style.setProperty('--dx', rand(-80, 80).toFixed(0) + 'px');
        p.style.animationDelay = rand(0, 600).toFixed(0) + 'ms';
      }

      host.appendChild(p);
      p.addEventListener('animationend', () => p.remove(), { once: true });
    }
  };
})();
