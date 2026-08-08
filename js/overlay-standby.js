/* WenBot overlay standby shell
 *
 * Every overlay has long stretches with nothing to draw. A wheel isn't
 * spinning, no giveaway is open, no hunt is running. The page renders nothing,
 * and in OBS that is indistinguishable from a broken source: the streamer adds
 * the browser source, sees an empty rectangle, and has no way to size or
 * position it — or concludes the overlay doesn't work and gives up.
 *
 * Which behaviour is right depends on how the overlay is used, and the two
 * cases are genuinely different:
 *
 * mode 'persistent' (default) — feature overlays a streamer turns on for a
 *   segment: bonus hunt, bonus battle, tournament, slot requests. They add the
 *   source when they want that feature and hide it when they're done, so an
 *   idle shell is not clutter — it's how they place the source before going
 *   live, and how they see the overlay is alive and waiting for the command.
 *   The shell simply shows whenever there's nothing to draw.
 *
 * mode 'setup' — overlays that stay enabled for the whole stream and appear
 *   only for a moment: the giveaway spinner, wheel, winner, request spinner and
 *   slot picker. A placeholder parked on screen for four hours is worse than a
 *   blank one, so here the shell keys off whether the streamer is broadcasting:
 *
 *     not broadcasting  →  show it. They're setting up; that's the point.
 *     broadcasting      →  hide it, EXCEPT for the first few seconds after the
 *                          page loads. A fresh load means they just added or
 *                          refreshed the source, which is the one moment they
 *                          need it mid-stream. It then clears itself, so it can
 *                          never linger on a live broadcast.
 *
 *   OBS exposes window.obsstudio to browser sources, which reports streaming
 *   and recording state and fires events on transitions. Outside OBS the object
 *   is absent — that's a streamer previewing the link in a normal browser,
 *   where "not broadcasting" is exactly right and the shell shows.
 *
 * ?standby=0 forces it off for good. ?standby=1 forces it on, for anyone who
 * wants it while live regardless.
 *
 * Usage:
 *   Standby.init({ icon: '🎡', label: 'Wheel overlay', mode: 'setup',
 *                  note: 'fills automatically when a spin starts' });
 *   Standby.show()            // nothing to draw right now
 *   Standby.show('custom')    // ...with a reason specific to the state
 *   Standby.hide()            // real content is on screen
 *   Standby.error('Channel not found')
 */
(function (global) {
  "use strict";

  // How long the shell stays up after a load that happens mid-broadcast. Long
  // enough to drag and scale the source, short enough that a scene switch which
  // reloads the source doesn't leave it sitting there.
  var LIVE_GRACE_MS = 25000;

  var force = new URLSearchParams(location.search).get("standby");
  var cfg = {
    icon: "📺", label: "WenBot overlay",
    note: "Waiting for data",
    hint: "This fills in automatically",
    // Persistent is the default because it's the safe one: the shell staying
    // visible is what a streamer placing a source expects. Only the overlays
    // that live on screen all stream opt into hiding themselves.
    mode: "persistent",
  };

  var el = null;
  var wanted = false;         // does the overlay currently have nothing to draw?
  var note = null;            // reason for this particular idle state
  var isError = false;
  var broadcasting = false;
  var loadedAt = Date.now();

  function inGrace() {
    return Date.now() - loadedAt < LIVE_GRACE_MS;
  }

  function allowed() {
    if (force === "0") return false;
    if (force === "1") return true;
    // Persistent overlays are turned on and off by the streamer as they need
    // the feature, so an idle shell is wanted whether or not they're live.
    if (cfg.mode !== "setup") return true;
    return !broadcasting || inGrace();
  }

  function build() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "ovStandbyShell";
    // Fixed and centred rather than in flow: the fourteen overlays have wildly
    // different body layouts and the shell must land predictably in all of them.
    el.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483000",
      "display:flex", "align-items:center", "justify-content:center",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(el);
    return el;
  }

  // Built to read as the overlay it stands in for, not as a debug label. A
  // streamer adding the source before their stream should see the panel's real
  // shape and styling, so they know what they're positioning and what it will
  // look like once it fills. It inherits the overlay's own theme variables, so
  // a custom accent colour carries through to the placeholder too.
  function paint() {
    var e = build();
    var accent = isError ? "255,120,120" : "var(--ov-accent-rgb,0,229,255)";
    var edge = isError ? "rgba(255,120,120,0.45)" : "rgba(" + accent + ",0.32)";
    var eyebrow = isError ? "#ff9d9d" : "rgba(" + accent + ",1)";

    var panel =
      '<div style="background:var(--ov-panel,rgba(13,17,23,0.93));border:1px solid ' + edge + ';' +
      "border-radius:14px;padding:18px 22px;text-align:center;max-width:82%;" +
      'box-shadow:0 8px 32px rgba(0,0,0,0.55);backdrop-filter:blur(12px);">' +
        '<div style="font-family:var(--ov-font-heading,\'Exo 2\',sans-serif);font-size:12px;font-weight:800;' +
        "letter-spacing:.12em;text-transform:uppercase;color:" + eyebrow + ';margin-bottom:8px;">' +
          esc(isError ? "⚠️" : cfg.icon) + " " + esc(cfg.label) + "</div>" +
        '<div style="font-family:var(--ov-font-heading,\'Exo 2\',sans-serif);font-size:17px;font-weight:900;' +
        'color:var(--ov-text,#fff);line-height:1.25;">' + esc(note || cfg.note) + "</div>" +
        '<div style="font-family:var(--ov-font,Inter,sans-serif);font-size:11.5px;font-weight:500;' +
        'color:rgba(255,255,255,0.5);margin-top:7px;">' + esc(cfg.hint || "This fills in automatically") + "</div>" +
      "</div>";

    // The dashed bounds only appear while they aren't broadcasting. It's a
    // sizing aid for setup, and it's the one part of this that would look like
    // a mistake if it ever reached a live stream.
    var bounds = broadcasting ? "" :
      '<div style="position:absolute;inset:4px;border:1px dashed rgba(' + accent + ',0.3);' +
      'border-radius:16px;"></div>';

    e.innerHTML = bounds + panel;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function sync() {
    var on = wanted && allowed();
    if (!on) { if (el) el.style.display = "none"; return; }
    paint();
    el.style.display = "";
  }

  // ── OBS state ────────────────────────────────────────────────────────────
  // Everything here is feature-detected. Older OBS builds lack getStatus, some
  // lack the events, and outside OBS the object doesn't exist at all — in every
  // one of those cases we fall through to "not broadcasting", which shows the
  // shell. Failing toward visible is the safe direction: a shell that shows
  // when it needn't is a cosmetic annoyance, one that hides when it's needed
  // recreates the blank-source problem this exists to solve.
  function readStatus() {
    var obs = global.obsstudio;
    if (!obs || typeof obs.getStatus !== "function") return;
    try {
      obs.getStatus(function (s) {
        var next = !!(s && (s.streaming || s.recording));
        if (next !== broadcasting) { broadcasting = next; sync(); }
      });
    } catch (_) { /* older OBS: leave broadcasting false */ }
  }

  function watchObs() {
    if (!global.obsstudio) return;
    ["obsStreamingStarted", "obsStreamingStopped",
      "obsRecordingStarted", "obsRecordingStopped"].forEach(function (evt) {
      global.addEventListener(evt, readStatus);
    });
    readStatus();
    // The events are the fast path; the poll covers OBS versions that don't
    // fire them. Once per 5s against an in-process call costs nothing.
    setInterval(readStatus, 5000);
  }

  // While in grace during a broadcast the shell has to take itself down when
  // the window expires, without waiting for the overlay to re-render.
  function watchGrace() {
    var t = setInterval(function () {
      if (inGrace()) return;
      clearInterval(t);
      sync();
    }, 1000);
  }

  var Standby = {
    init: function (opts) {
      Object.assign(cfg, opts || {});
      loadedAt = Date.now();
      if (document.body) watchObs();
      else global.addEventListener("DOMContentLoaded", watchObs);
      watchGrace();
      // An overlay's first render can run before init (tournament polls on the
      // way down the page and inits at the bottom), so repaint here or the
      // shell would sit there labelled with the placeholder defaults.
      sync();
      return Standby;
    },
    show: function (n) { wanted = true; isError = false; note = n || null; sync(); },
    error: function (msg) { wanted = true; isError = true; note = msg; sync(); },
    hide: function () { wanted = false; sync(); },

    // Bind the shell to whether an element is actually on screen.
    //
    // Most overlays already gate their whole widget behind one container that
    // gets shown for the event and hidden after. Watching that container is
    // both less invasive and more truthful than threading show/hide calls
    // through every branch that toggles it: there is no path that displays the
    // widget without the shell noticing, including ones added later.
    //
    // Computed style is the test rather than the class name, because these
    // containers are hidden by class in some branches and inline style in
    // others. The observer catches both; the interval covers a stylesheet or
    // ancestor change that mutates neither attribute on the element itself.
    //
    // Opacity matters as much as display: the winner overlay's machine is
    // always laid out and fades in with opacity, so a display-only test would
    // call it visible while it's completely transparent and suppress the shell
    // exactly where it's needed most.
    track: function (selector, n) {
      var check = function () {
        var node = document.querySelector(selector);
        var visible = false;
        if (node && node.offsetParent !== null) {
          var cs = getComputedStyle(node);
          visible = cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.05;
        }
        if (visible) Standby.hide(); else Standby.show(n);
      };
      var start = function () {
        var node = document.querySelector(selector);
        if (node) {
          new MutationObserver(check).observe(node, {
            attributes: true, attributeFilter: ["class", "style"],
          });
        }
        setInterval(check, 1000);
        check();
      };
      if (document.body) start();
      else global.addEventListener("DOMContentLoaded", start);
      return Standby;
    },
  };

  global.Standby = Standby;
})(window);
