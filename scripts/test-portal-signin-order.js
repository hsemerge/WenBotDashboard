// Guards the sign-in ordering in every white-label portal.
//
// On a custom domain the Kick callback cannot run on the portal's own origin,
// so OAuth finishes on wenbot.gg and hands the session back as a one-time ?s=
// code. initViewer() exchanges that code. Until it has, there IS no session.
//
// load() starts its own loadViewerWager(), and renderProgress() reads the
// session directly — so if load() runs first, the viewer's own lookup fires
// with no session, resolves to null, and the panel paints "Sign in with Kick"
// over somebody who just signed in. Two lookups then race to write the same
// variable and the last to land wins rather than the newest.
//
// It is invisible locally (wenbot.gg is the auth origin, so no handoff happens
// and no ?s= is involved) and only shows up on a real custom domain. That is
// exactly the kind of bug worth pinning down in a test.
const fs = require("fs");
const path = require("path");

const PORTALS = path.join(__dirname, "..", "portals");
let fails = 0;
const ok = (l, c, x) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${l}${c ? "" : "   <-- " + x}`); if (!c) fails++; };

const dirs = fs.readdirSync(PORTALS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

console.log("\n== the ?s= handoff must be claimed before anything loads ==");
let checked = 0;
for (const name of dirs) {
  const file = path.join(PORTALS, name, "index.html");
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, "utf8");

  // Only portals that actually implement the cross-domain handoff.
  if (!/initViewer\s*\(/.test(src)) continue;
  checked++;

  const iv = src.indexOf("await initViewer()");
  ok(`${name}: awaits initViewer()`, iv !== -1, "not awaited — the ?s= code is never exchanged");
  if (iv === -1) continue;

  // The board load inside the startup sequence. Matches `load();` on its own
  // line, ignoring load(cached) and the unrelated inline refresh calls.
  const loads = [...src.matchAll(/^\s*load\(\);\s*$/gm)].map((m) => m.index);
  const after = loads.filter((i) => i > iv);
  const before = loads.filter((i) => i < iv);

  ok(`${name}: no bare load() before the handoff is claimed`,
     before.length === 0,
     `${before.length} load() call(s) run before initViewer — a session-dependent render would run blind`);
  ok(`${name}: the startup load() runs after it`, after.length > 0,
     "no load() found after initViewer");

  // The cached repaint only matters when load() ITSELF performs a
  // session-dependent lookup. TiltBros' load() calls loadViewerWager(); the
  // other portals resolve the viewer inside initViewer and repaint from there,
  // so painting a cached BOARD first is correct for them and keeps the page from
  // sitting empty during the session call. Asserting it unconditionally reports
  // those portals as broken when they are not.
  if (/load[\s\S]{0,4000}?loadViewerWager\s*\(/.test(src)) {
    const cached = [...src.matchAll(/load\(\s*__?cached\s*\)/g)].map((m) => m.index);
    ok(`${name}: cached repaint waits too (its load() does a wager lookup)`,
       cached.every((i) => i > iv),
       "a cached paint runs first and fires its own session-less wager lookup");
  }
}

ok("found portals implementing the handoff", checked > 0, "none scanned — did the portals move?");

console.log("\n== signing in must return to the page it was started from ==");
// This is enforced in ONE place for every portal: kick-auth sends the viewer's
// full page URL as returnOrigin, and the callback only appends ?s= to it — so
// the path and hash survive the round trip through wenbot.gg and the portal's
// own routing puts them back. Sending a bare origin instead drops everyone on
// the portal root, which is what made signing in from Bonuses land on the
// leaderboard. A per-portal localStorage stash is a nice fallback but cannot be
// the mechanism: private windows and blocked storage silently lose it.
const auth = fs.readFileSync(path.join(__dirname, "..", "js", "kick-auth.js"), "utf8");
const m = auth.match(/setParams?\(|searchParams\.set\(\s*["']returnOrigin["']\s*,\s*([^)]+)\)/);
ok("kick-auth sends returnOrigin at all", !!m, "returnOrigin is no longer set — the handoff cannot return");
if (m) {
  const expr = (m[1] || "").trim();
  ok("returnOrigin carries the path, not just the origin",
     /pathname/.test(expr),
     `sends \`${expr}\` — the viewer lands on the portal root instead of the page they signed in from`);
  ok("returnOrigin carries the hash, so the view is restored",
     /hash/.test(expr),
     `sends \`${expr}\` — the portal cannot tell which view to show`);
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : "\nportal sign-in ordering correct\n");
process.exit(fails ? 1 : 0);
