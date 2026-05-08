// GET /api/leaderboard-winners?channel=xxx&casino=xxx
// Returns past leaderboard periods for a streamer + casino from Firestore

const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
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
    return res(500, { error: err.message });
  }
};
