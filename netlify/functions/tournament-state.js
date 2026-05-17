// GET /api/tournament-state?channel=xxx&kick=xxx
// Returns current tournament state + viewer entry/verification status.

const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '
'),
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET")     return res(405, { error: "Method not allowed" });

  const { channel, kick } = event.queryStringParameters || {};
  if (!channel) return res(400, { error: "Missing channel" });

  const channelKey = channel.toLowerCase().trim();
  const userKey    = kick ? kick.toLowerCase().trim() : null;

  try {
    const db = getDb();

    const streamerSnap = await db.collection("streamers").where("kickChannel", "==", channelKey).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });
    const uid = streamerSnap.docs[0].id;

    const tDoc = await db.collection("streamers").doc(uid).collection("tournaments").doc("current").get();
    const tournament = tDoc.exists ? tDoc.data() : null;

    let viewerPoints = null;
    let isVerified   = false;
    let isEntered    = false;

    if (userKey) {
      const [viewerDoc, vSnap] = await Promise.all([
        db.collection("streamers").doc(uid).collection("viewers").doc(userKey).get(),
        db.collection("streamers").doc(uid).collection("verified_users").where("kickName", "==", userKey).limit(1).get(),
      ]);
      viewerPoints = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;
      isVerified   = !vSnap.empty;

      if (tournament?.participants) {
        isEntered = tournament.participants.some(p => p && p.kickUsernameKey === userKey);
      }
    }

    return res(200, { tournament, viewerPoints, isVerified, isEntered });
  } catch (err) {
    return res(500, { error: err.message });
  }
};
