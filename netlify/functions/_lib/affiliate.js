// Shared casino affiliate lookup. Used by:
//   - verify-affiliate.js (initial verification time)
//   - recheck-verified.js (manual re-check from dashboard)
//
// Returns { username, wagerAmount, leaderboardType } when found, or null.
// Searches multiple leaderboard types (e.g. monthly + all_time) because a
// user under the affiliate code may not appear on the current month's top N
// list, but will typically appear on an all-time list. First match wins.

const LIMIT_PER_LB = 500;

// Casinos with API-backed verification.
// Each entry is a list of leaderboard types to search in order.
const LB_TYPES_BY_PROVIDER = {
  gambulls: ["all_time", "monthly"],
};

// Optional 4th arg `diagnostics` (array) — if passed, lookupAffiliate pushes
// per-leaderboard search summaries into it for debugging. Doesn't change the
// return contract.
async function lookupAffiliate(provider, apiKey, affiliateUsername, diagnostics = null) {
  if (provider === "gambulls") {
    const target = (affiliateUsername || "").toLowerCase();
    for (const type of LB_TYPES_BY_PROVIDER.gambulls) {
      const diag = { type, target, limit: LIMIT_PER_LB };
      try {
        const resp = await fetch(
          `https://api.gambulls.com/api/public/streamer/leaderboard?type=${encodeURIComponent(type)}&limit=${LIMIT_PER_LB}`,
          { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } }
        );
        diag.httpStatus = resp.status;
        if (!resp.ok) {
          diag.error = `non-200 status`;
          if (diagnostics) diagnostics.push(diag);
          continue;
        }
        const data = await resp.json();
        diag.apiSuccess = !!data.success;
        diag.hasRankings = !!data.responseObject?.rankings;
        if (!data.success || !data.responseObject?.rankings) {
          diag.error = `unexpected response shape`;
          diag.responseKeys = Object.keys(data || {});
          if (diagnostics) diagnostics.push(diag);
          continue;
        }
        diag.totalEntries = data.responseObject.rankings.length;
        // Capture a sample of the first 5 usernames for sanity-checking match logic
        diag.sample = data.responseObject.rankings.slice(0, 5).map(e => e.user?.name).filter(Boolean);
        const match = data.responseObject.rankings.find(
          e => (e.user?.name || "").toLowerCase() === target
        );
        if (match) {
          diag.matched = true;
          if (diagnostics) diagnostics.push(diag);
          return {
            username:        match.user.name,
            wagerAmount:     match.wagerAmount || 0,
            leaderboardType: type,
          };
        }
        diag.matched = false;
        if (diagnostics) diagnostics.push(diag);
      } catch (err) {
        diag.error = err.message;
        if (diagnostics) diagnostics.push(diag);
      }
    }
    return null;
  }
  return null;
}

module.exports = { lookupAffiliate };
