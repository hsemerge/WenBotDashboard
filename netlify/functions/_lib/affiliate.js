// Shared casino affiliate lookup. Used by:
//   - verify-affiliate.js (initial verification time)
//   - recheck-verified.js (manual re-check from dashboard)
//
// Returns { username, wagerAmount, leaderboardType } when found, or null.
// Searches multiple leaderboard types (e.g. monthly + all_time) because a
// user under the affiliate code may not appear on the current month's top N
// list, but will typically appear on an all-time list. First match wins.

// Gambulls hard-caps the leaderboard limit at 100 (anything higher returns 400).
// Valid `type` values are only daily/weekly/monthly — no all_time/yearly.
// We pick `monthly` as the widest window the public API offers; users who haven't
// wagered this month won't appear regardless of limit. Gambulls is expected to
// provide a richer endpoint later that can answer "is X under affiliate Y" directly.
const LIMIT_PER_LB = 100;

const LB_TYPES_BY_PROVIDER = {
  gambulls: ["monthly"],
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
        // Gambulls also returns totalUsers (under affiliate code) and totalWagered
        // at the top of responseObject. Expose them as diagnostics so the dashboard
        // can show "X of Y users wagering this month" context.
        diag.totalUsers   = data.responseObject.totalUsers || null;
        diag.totalWagered = data.responseObject.totalWagered || null;
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
