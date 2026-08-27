// Winovo (winovo.io) creator-leaderboard provider.
//
//   GET https://winovo.io/api/creator/users
//       x-creator-auth: <creator api key>
//
//   → { status: "ok", creator: "<affiliate code>",
//       data: [ { name, pic, wagered }, … ] }   // already wager-desc
//
// Documented at github.com/winovo-io/Creator-Leaderboard-API.
//
// TWO THINGS SHAPE HOW THIS IS USED:
//
// 1. There is NO date range. The endpoint returns each referred player's
//    CUMULATIVE wager since the affiliate's counters were last reset, so a
//    "period" is not something the API can express. WenBot therefore treats it
//    like Gambulls: take a baseline at the period start and subtract it
//    (applyPeriod in _lib/leaderboard.js). That keeps a weekly/monthly race
//    honest without touching the casino's own numbers.
//
// 2. Winovo DO expose a reset — POST /api/creator/clear — and it is deliberately
//    NOT called from anywhere in WenBot. It zeroes every referred player's total
//    at once, irreversibly, for everyone reading that affiliate code. Baselines
//    achieve the same visible result and can be undone. If a reset button is
//    ever added it belongs behind an explicit, confirmed streamer action, never
//    on a schedule or a page load.
//
// Auth semantics, verified against the live API:
//   no header        → 401 { reason: "missing creator token" }
//   unknown key      → 403 { reason: "creator token invalid" }
//   valid key, but no affiliate attached to it yet
//                    → 404 { reason: "affiliate code not found" }
// That 404 is a Winovo-side provisioning state, not a bad key — worth keeping
// distinct so a streamer is told to finish setup rather than "check your key".

const WINOVO_URL = "https://winovo.io/api/creator/users";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * Fetch + normalise the creator leaderboard.
 * Returns null on any failure so callers serve their cached copy rather than
 * blanking a live board.
 *
 * @returns {{creator:string, rankings:Array, totalUsers:number, totalWagered:number}|null}
 */
async function fetchWinovoBoard(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return null;

  let body;
  try {
    const r = await fetch(WINOVO_URL, {
      headers: { "x-creator-auth": key, "Accept": "application/json" },
    });
    // Any non-200 (401/403/404 above, or a 5xx) means "no usable board right
    // now"; the reason is logged for support rather than shown to viewers.
    if (!r.ok) {
      let reason = "";
      try { reason = (await r.json()).reason || ""; } catch {}
      console.warn(`[winovo] ${r.status}${reason ? " " + reason : ""}`);
      return null;
    }
    body = await r.json();
  } catch (e) {
    console.warn("[winovo] fetch failed:", e.message);
    return null;
  }
  if (!body || body.status !== "ok" || !Array.isArray(body.data)) return null;

  // Documented as wager-descending already; sorted again so a change on their
  // side can never silently mis-rank a payout.
  const referred = body.data.map((p) => ({
    username:  String(p.name || "").trim() || "Anonymous",
    // Winovo expose no stable per-player id — the display name IS the key.
    uid:       null,
    wagered:   num(p.wagered),
    avatarUrl: p.pic ? String(p.pic) : null,
  }));

  // The BOARD drops anyone on zero — nobody wants a leaderboard padded with
  // $0.00 rows. Verification must not reuse that filtered list: `referred` keeps
  // every player the code has, wagered or not. See lookupWinovoAffiliate.
  const rankings = referred
    .filter((p) => p.wagered > 0)
    .sort((a, b) => b.wagered - a.wagered)
    .map((p, i) => ({ rank: i + 1, ...p }));

  return {
    creator:      String(body.creator || ""),
    rankings,
    // Everyone under the code, including zero-wager signups. Not used by the
    // board; verification reads this one.
    referred,
    totalUsers:   rankings.length,
    totalWagered: rankings.reduce((sum, p) => sum + p.wagered, 0),
  };
}

/**
 * Under-code lookup for verification: is this viewer referred by the code?
 *
 * Unlike Rainbet and Clash, absence here really is meaningful. Winovo list every
 * referred player INCLUDING those on zero wager, so a miss means "not under this
 * code" rather than "under it but has not played yet".
 *
 * That only holds by reading `referred`. Matching the board's `rankings` instead
 * silently required a viewer to have wagered before they could verify — on
 * SKSlots' code that was 4 of the first 6 signups being told, wrongly, that they
 * were not under it.
 *
 * Returns null when the API could not be reached, so callers can tell that apart
 * from a genuine miss.
 */
async function lookupWinovoAffiliate(apiKey, username) {
  const name = String(username || "").trim().toLowerCase();
  if (!name) return { found: false };

  const board = await fetchWinovoBoard(apiKey);
  if (!board) return null;

  const all = Array.isArray(board.referred) ? board.referred : board.rankings;
  const hit = all.find((r) => r.username.trim().toLowerCase() === name);
  if (!hit) return { found: false };

  // `place` comes from the board, so someone under the code with no wager yet
  // verifies with no place rather than a made-up one.
  const ranked = board.rankings.find((r) => r.username.trim().toLowerCase() === name);
  return { found: true, username: hit.username, wagered: hit.wagered, place: ranked ? ranked.rank : null };
}

module.exports = { fetchWinovoBoard, lookupWinovoAffiliate };
