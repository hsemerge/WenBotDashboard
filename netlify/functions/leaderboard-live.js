// GET /api/leaderboard-live?channel=xxx&casino=xxx
// Proxies the casino's leaderboard API using the streamer's stored API key

const { getDb }            = require("./_lib/firebase");
const { res: _res }        = require("./_lib/http");
const { CASINO_NAMES }     = require("./_lib/casinos");
const { normalizeGambulls, applyPeriod } = require("./_lib/leaderboard");
const res = (s, b) => _res(s, b, "*");

async function fetchGambulls(apiKey) {
  const resp = await fetch(
    "https://api.gambulls.com/api/public/streamer/leaderboard?type=monthly&limit=100",
    { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.success || !data.responseObject?.rankings) return null;
  return {
    totalWagered: data.responseObject.totalWagered || 0,
    totalUsers: data.responseObject.totalUsers || 0,
    rankings: normalizeGambulls(data.responseObject),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const { channel, casino } = event.queryStringParameters || {};
  if (!channel) return res(400, { error: "Missing channel" });

  const provider = (casino || "gambulls").toLowerCase();
  if (!CASINO_NAMES[provider]) return res(400, { error: "Unsupported casino" });

  try {
    const db = getDb();
    const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const streamerDoc = snap.docs[0];
    const streamerData = streamerDoc.data();

    // Period/countdown config for the public page (set from the dashboard).
    const period = streamerData.leaderboardPeriod || null;

    // For public viewers, check leaderboard is enabled; internal=1 bypasses (dashboard)
    const isInternal = event.queryStringParameters?.internal === "1";
    if (!isInternal && !streamerData.leaderboardEnabled) {
      return res(403, { error: "This streamer's leaderboard is not publicly enabled." });
    }

    // Only Gambulls has live API support right now
    if (provider === "gambulls") {
      const providerDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("gambulls").get();
      if (!providerDoc.exists) return res(400, { error: "Streamer hasn't configured their Gambulls API yet." });

      const { apiKey } = providerDoc.data();
      const data = await fetchGambulls(apiKey);
      if (!data) return res(502, { error: "Failed to fetch from Gambulls API." });

      // raw=1 returns the unbaselined monthly totals (used by the wager raffle,
      // which applies its own separate baselines).
      const raw = event.queryStringParameters?.raw === "1";
      const out = raw ? data : applyPeriod(data, period);
      return res(200, { success: true, casino: provider, casinoName: CASINO_NAMES[provider], period, ...out });
    }

    // Honor-system casinos: return empty leaderboard (no API)
    return res(200, { success: true, casino: provider, casinoName: CASINO_NAMES[provider], period, totalWagered: 0, totalUsers: 0, rankings: [] });

  } catch (err) {
    console.error("[leaderboard-live] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
