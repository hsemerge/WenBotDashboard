// GET /api/leaderboard-winners?channel=xxx&casino=xxx
// Returns past leaderboard periods for a streamer + casino from Firestore

const { getDb }     = require("./_lib/firebase");
const { res: _res } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const { channel, casino } = event.queryStringParameters || {};
  if (!channel) return res(400, { error: "Missing channel" });

  const provider = (casino || "gambulls").toLowerCase();

  try {
    const db = getDb();
    const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const uid = snap.docs[0].id;

    const periodsSnap = await db.collection("streamers").doc(uid)
      .collection("leaderboard_periods")
      .where("casino", "==", provider)
      .orderBy("endDate", "desc")
      .limit(24)
      .get();

    const periods = periodsSnap.docs.map(d => d.data());
    return res(200, { success: true, periods });

  } catch (err) {
    console.error("[leaderboard-winners] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
