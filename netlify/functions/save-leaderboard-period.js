// POST /api/save-leaderboard-period
// Body: { idToken, casino, period, endDate, winners }
// Saves a finalized leaderboard month to Firestore (called from dashboard)

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");
const { CASINO_NAMES } = require("./_lib/casinos");

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
    console.error("[save-leaderboard-period] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
