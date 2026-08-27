// ETHbet (ethbet.gg) streamer-leaderboard provider.
//
// ETHbet issues each streamer one API key tied to a single pre-configured board
// (its own window + prize ladder, set on ETHbet's side). One authenticated GET
// returns the current standings — there are NO date-range parameters, so, like
// Gamba/Degen, the board owns its window and WenBot passes it through live with
// no baselines, no finalize and no WenBot-set period.
//
//   GET https://ethbet.gg/api/v1/streamer-leaderboard
//   header: X-API-Key: <key>          (or ?key=<key>)
//
// Response (Aug 2026): { ok, leaderboard:{ id, streamer, status, starts_at,
// ends_at, prize_pool, prizes:{ "1":"500.00", … } }, standings:[{ position,
// username, wagered, prize }], updated_at }. Amounts are USD DOLLAR strings
// ("1981.75"), NOT cents — do not divide by 100. Timestamps are unix SECONDS.
//
// Matching is username-only: ETHbet exposes no stable per-user id and no per-user
// verification endpoint, so — exactly like Gamba — under-code verification checks
// whether the claimed username appears in the board's standings. The API returns
// only the TOP standings (~10), so a miss means "not among the board's ranked
// players", which for a small wagerer can happen even when they are under the
// code (a tighter version of the same caveat Gamba/Degen/CSGOBig carry).
//
// Returns null on any failure so callers serve their cached copy rather than
// blanking a live board.

const ETHBET_URL = "https://ethbet.gg/api/v1/streamer-leaderboard";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// The single origin-touching fetch. 8s timeout so a stalled ETHbet request can't
// hang the caller past the function's budget. Returns parsed JSON or null.
async function ethbetGet(apiKey) {
  if (!apiKey) return null;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(ETHBET_URL, {
      headers: { "X-API-Key": String(apiKey), "Accept": "application/json" },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;   // 401 bad key, 429 rate-limited, 5xx — serve cache
    return await resp.json();
  } catch { return null; }       // network error / abort / bad JSON
  finally { clearTimeout(timer); }
}

/**
 * Fetch + normalise the ETHbet board for this key. Returns the same shape as
 * fetchGambaRace (rankings[{rank,uid,username,wagered,avatarUrl,prize}] + window
 * + totals) so the leaderboard-live / portal-data dispatch can treat it exactly
 * like a Gamba race. Returns null on any failure.
 */
async function fetchEthbetBoard(apiKey) {
  const body = await ethbetGet(apiKey);
  if (!body || !body.ok || !Array.isArray(body.standings)) return null;
  const lb = body.leaderboard || {};

  // Rank-indexed prize ladder from the board's own distribution.
  const prizes = [];
  if (lb.prizes && typeof lb.prizes === "object") {
    Object.entries(lb.prizes).forEach(([pos, amt]) => {
      const p = Number(pos);
      if (p > 0) prizes[p - 1] = num(amt);
    });
  }

  const rankings = body.standings
    .map((s) => {
      const rank = Number(s.position) || 0;
      return {
        rank,
        uid:       null,                 // ETHbet exposes no stable per-user id
        username:  s.username || "Anonymous",
        wagered:   num(s.wagered),       // USD dollars, already, not cents
        avatarUrl: null,
        prize:     num(s.prize),
      };
    })
    .filter((r) => r.rank > 0 && r.username)
    .sort((a, b) => a.rank - b.rank);

  const startAt = lb.starts_at ? Number(lb.starts_at) * 1000 : null;  // unix seconds → ms
  const endAt   = lb.ends_at   ? Number(lb.ends_at)   * 1000 : null;
  const now     = Date.now();

  return {
    raceName:     null,
    rankings,
    prizes,
    prizePool:    num(lb.prize_pool),
    currency:     "USD",
    sponsor:      lb.streamer || null,
    startAt,
    endAt,
    active:       lb.status ? lb.status === "live"
                            : !!(startAt && endAt && now >= startAt && now <= endAt),
    totalWagered: rankings.reduce((s, r) => s + r.wagered, 0),
    totalUsers:   rankings.length,
    cacheUpdatedAt: null,
  };
}

// Under-code lookup for verification. ETHbet has no per-user endpoint, so — like
// Gamba — we match the claimed username against the board's standings.
// Returns { found, username, wagered, place }; found:false on a genuine miss;
// null when the board couldn't be fetched, so callers can tell "not on the board"
// apart from "couldn't check". A miss means "not among the board's ranked
// players", which can happen for a small wagerer even under the code.
async function lookupEthbet(apiKey, username) {
  const board = await fetchEthbetBoard(apiKey);
  if (!board) return null;
  const u = String(username || "").trim().toLowerCase();
  if (!u) return { found: false };
  const hit = board.rankings.find((r) => r.username && r.username.toLowerCase() === u);
  return hit
    ? { found: true, username: hit.username, wagered: hit.wagered || 0, place: hit.rank }
    : { found: false };
}

module.exports = { fetchEthbetBoard, lookupEthbet };
