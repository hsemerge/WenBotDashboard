// Thrill affiliate leaderboard — every player referred under the streamer's code,
// with their wager for a date range.
//
//   GET https://api.thrill.com/referral/v1/referral-links/streamers
//       ?fromDate=YYYY-MM-DD   (inclusive)
//       &toDate=YYYY-MM-DD     (EXCLUSIVE — see below)
//   Header: Cookie: token=<session token>
//
// AUTH IS A SESSION COOKIE, not an API key. The streamer copies it out of their
// browser (DevTools → Application → Cookies → thrill.com → `token`). Thrill's own
// guide says to refresh it every 30 days. Treat a 403 as "the streamer needs to
// paste a new one", never as "this board is empty" — see thrillAuthFailed below.
//
// RATE LIMIT: Thrill asks for no more than one call every 2 MINUTES, and warns
// that exceeding it gets access revoked. Callers MUST cache. This module does not
// cache on its own because the callers already have per-board cache documents
// with the right keys.
//
// AMOUNTS ARE ATOMIC UNITS. `wager` is { value, currency, decimals } where value
// is a decimal STRING and decimals is usually 18 — so "123310000000000000000"
// with decimals 18 is $123.31. The values run past Number.MAX_SAFE_INTEGER, so
// they are converted with BigInt rather than parseFloat; going through a float
// first loses cents on large wagers.

const BASE = "https://api.thrill.com";

/**
 * Atomic-unit string → a normal number.
 *
 * Splits with BigInt so the integer part keeps full precision, then re-attaches
 * the fraction. Number("255673275000000000000") is already past the safe integer
 * range, so dividing after the cast is not accurate enough for money.
 */
function fromAtomic(value, decimals) {
  const d = Number.isFinite(Number(decimals)) ? Math.max(0, Math.trunc(Number(decimals))) : 0;
  const raw = String(value == null ? "0" : value).trim();
  if (!/^\d+$/.test(raw)) {
    // Not the documented shape (a plain digit string). Fall back rather than throw:
    // a board that renders a slightly wrong number is better than one that 500s,
    // and the caller has no way to repair this.
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (d === 0) return Number(raw);

  const big = BigInt(raw);
  const scale = 10n ** BigInt(d);
  const whole = big / scale;
  const frac = big % scale;
  if (frac === 0n) return Number(whole);
  // Only the leading digits of the fraction matter once this becomes a float.
  const fracStr = frac.toString().padStart(d, "0").slice(0, 6);
  return Number(`${whole}.${fracStr}`);
}

/** Thrill wants YYYY-MM-DD, in UTC. */
function ymd(ms) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * A 403 from Thrill means the session cookie is dead — expired, or the streamer
 * logged out. That is a CONFIGURATION problem the streamer has to fix, and it
 * must not be confused with "nobody wagered". Callers check this to show
 * "reconnect your Thrill account" instead of an empty board.
 */
class ThrillAuthError extends Error {
  constructor(message) { super(message || "Thrill session expired"); this.name = "ThrillAuthError"; this.authFailed = true; }
}

/**
 * Fetch the referred-player list for a window.
 *
 * @param {string} token     the `token` cookie value
 * @param {number} fromMs    window start (inclusive)
 * @param {number} toMs      window end — Thrill treats toDate as EXCLUSIVE, so a
 *                           race ending on the 12th must ask for the 13th or the
 *                           final day is silently dropped. Handled here.
 * @returns {Promise<{rankings, totalUsers, totalWagered}|null>} null = could not
 *          ask (network/5xx); throws ThrillAuthError when the cookie is rejected.
 */
async function fetchThrillBoard(token, fromMs, toMs) {
  if (!token || !fromMs || !toMs) return null;

  const from = ymd(fromMs);
  // toDate is EXCLUSIVE per Thrill's docs ("2025-09-01 to 2025-09-18 includes
  // 01 September but not 18 September"). Our windows are inclusive-end, so add a
  // day — without this every race loses its last day, which is the day that
  // decides the winner.
  const to = ymd(toMs + 24 * 60 * 60 * 1000);
  if (!from || !to) return null;

  const url = `${BASE}/referral/v1/referral-links/streamers`
    + `?fromDate=${encodeURIComponent(from)}&toDate=${encodeURIComponent(to)}`;

  let r;
  try {
    r = await fetch(url, { headers: { Cookie: `token=${token}`, Accept: "application/json" } });
  } catch (e) {
    return null;   // network — caller serves its cached copy
  }

  if (r.status === 401 || r.status === 403) {
    let msg = "";
    try { msg = (await r.json()).message || ""; } catch { /* body is optional */ }
    throw new ThrillAuthError(msg);
  }
  if (!r.ok) return null;

  let data;
  try { data = await r.json(); } catch { return null; }
  const items = Array.isArray(data && data.items) ? data.items : null;
  if (!items) return null;

  const rankings = items
    .map((e) => ({
      username: e.username || "Anonymous",
      wagered:  fromAtomic(e.wager && e.wager.value, e.wager && e.wager.decimals),
      avatarUrl: null,                       // Thrill returns no avatars
    }))
    .filter((e) => e.wagered > 0)
    .sort((a, b) => b.wagered - a.wagered)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  return {
    rankings,
    totalUsers: rankings.length,
    totalWagered: rankings.reduce((s, e) => s + e.wagered, 0),
    // Thrill pages its results. isLastBatch:false means there are more players
    // than one call returns — surfaced so a caller can warn rather than quietly
    // publishing a truncated race. (Not paged here: the 2-minute rate limit makes
    // follow-up calls expensive, and no streamer has hit a partial batch yet.)
    partial: data.isLastBatch === false,
    totalCount: Number(data.totalCount) || rankings.length,
  };
}

module.exports = { fetchThrillBoard, fromAtomic, ThrillAuthError };
