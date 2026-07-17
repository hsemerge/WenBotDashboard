// CSGOBig affiliate leaderboard — keyless public partner API (referral code in URL).
//   GET https://csgobig.com/api/partners/getRefDetails/{code}?from={ms}&to={ms}
//   → { success: true, results: [ { name, img, wagerTotal, depositTotal, ... } ] }
//
// STRICT rate limit (~15 min / IP). Callers MUST cache the result and serve their
// last good copy — on a rate-limit or any failure this returns null so the caller
// can fall back to cache instead of blanking the board.

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function fetchCsgobigRace(code, fromMs, toMs) {
  if (!code || !fromMs || !toMs) return null;
  const url = `https://csgobig.com/api/partners/getRefDetails/${encodeURIComponent(code)}?from=${fromMs}&to=${toMs}`;
  let data;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    data = await r.json();
  } catch (e) {
    return null;
  }
  // success:false is returned both for bad codes AND rate limits — treat as "no data,
  // keep the cache" rather than an empty board.
  if (!data || data.success !== true || !Array.isArray(data.results)) return null;

  const rankings = data.results
    .map((e) => ({
      username:  e.name || e.username || e.user || "Anonymous",
      // CSGOBig field naming has varied; accept the common spellings defensively.
      wagered:   num(e.wagerTotal ?? e.wagered ?? e.wager ?? e.totalWager ?? e.totalWagered),
      avatarUrl: e.img || e.avatar || e.imageUrl || e.avatarUrl || null,
    }))
    .filter((e) => e.wagered > 0)
    .sort((a, b) => b.wagered - a.wagered)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  return {
    rankings,
    totalWagered: rankings.reduce((s, e) => s + e.wagered, 0),
    totalUsers:   rankings.length,
  };
}

module.exports = { fetchCsgobigRace };
