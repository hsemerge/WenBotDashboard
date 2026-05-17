// POST /api/save-leaderboard-period
// Body: { idToken, casino, period, endDate, winners }
// Saves a finalized leaderboard month to Firestore (called from dashboard)

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
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://wenbot.gg" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Invalid JSON" }); }

  const { idToken, casino, period, endDate, winners } = body;
  if (!idToken || !casino || !period || !endDate || !Array.isArray(winners)) {
    return res(400, { error: "Missing required fields" });
  }

  const provider = casino.toLowerCase();
  if (!CASINO_NAMES[provider]) return res(400, { error: "Unsupported casino" });

  try {
    const db = getDb();

    // Verify Firebase auth token
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // Period ID: e.g. "gambulls_2025_04"
    const dateObj = new Date(endDate);
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const periodId = `${provider}_${year}_${month}`;

    await db.collection("streamers").doc(uid)
      .collection("leaderboard_periods").doc(periodId).set({
        casino: provider,
        casinoName: CASINO_NAMES[provider],
        period,
        endDate,
        savedAt: Date.now(),
        winners: winners.map((w, i) => ({
          rank: w.rank || i + 1,
          username: w.username || "Unknown",
          wagered: w.wagered || 0,
          prize: w.prize || 0,
          avatarUrl: w.avatarUrl || null,
        })),
      });

    return res(200, { success: true, periodId });

  } catch (err) {
    if (err.code === "auth/argument-error" || err.code === "auth/id-token-expired") {
      return res(401, { error: "Unauthorized" });
    }
    return res(500, { error: err.message });
  }
};
