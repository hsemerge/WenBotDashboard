// GET /api/leaderboard-live?channel=xxx&casino=xxx
// Proxies the casino's leaderboard API using the streamer's stored API key

const admin = require("firebase-admin");

const CASINO_NAMES = {
  gambulls: "Gambulls", stake: "Stake", rainbet: "Rainbet",
  thrill: "Thrill", winna: "Winna", shuffle: "Shuffle",
  duel: "Duel", roobet: "Roobet", bcgame: "BC.Game",
  "500casino": "500 Casino", gamdom: "Gamdom", duelbits: "Duelbits",
  rollbit: "Rollbit", chipsgg: "Chips.gg",
};

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

function res(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

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
    rankings: data.responseObject.rankings.map((e, i) => ({
      rank: i + 1,
      username: e.user?.isAnonymous ? "Anonymous" : (e.user?.name || "Unknown"),
      wagered: e.wagerAmount || 0,
      avatarUrl: e.user?.imageUrl || null,
    })),
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

      return res(200, { success: true, casino: provider, casinoName: CASINO_NAMES[provider], ...data });
    }

    // Honor-system casinos: return empty leaderboard (no API)
    return res(200, { success: true, casino: provider, casinoName: CASINO_NAMES[provider], totalWagered: 0, totalUsers: 0, rankings: [] });

  } catch (err) {
    return res(500, { error: err.message });
  }
};
