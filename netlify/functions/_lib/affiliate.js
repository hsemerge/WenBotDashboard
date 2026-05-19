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

async function lookupAffiliate(provider, apiKey, affiliateUsername) {
  if (provider === "gambulls") {
    const target = (affiliateUsername || "").toLowerCase();
    for (const type of LB_TYPES_BY_PROVIDER.gambulls) {
      try {
        const resp = await fetch(
          `https://api.gambulls.com/api/public/streamer/leaderboard?type=${encodeURIComponent(type)}&limit=${LIMIT_PER_LB}`,
          { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } }
        );
        if (!resp.ok) continue;
        const data = await resp.json();
        if (!data.success || !data.responseObject?.rankings) continue;
        const match = data.responseObject.rankings.find(
          e => (e.user?.name || "").toLowerCase() === target
        );
        if (match) {
          return {
            username:        match.user.name,
            wagerAmount:     match.wagerAmount || 0,
            leaderboardType: type,
          };
        }
      } catch {
        // Try next leaderboard type
      }
    }
    return null;
  }
  return null;
}

module.exports = { lookupAffiliate };
