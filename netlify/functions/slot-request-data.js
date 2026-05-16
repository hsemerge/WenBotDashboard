// GET /api/slot-request-data?channel=xxx
// Returns active slot request queue for OBS overlay — no auth required

const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    const raw  = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
    const cred = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(cred) });
  }
  return admin.firestore();
}

function res(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing ?channel=" });

  try {
    const db   = getDb();
    const snap = await db.collection("streamers").where("kickChannel", "==", channel).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const uid = snap.docs[0].id;

    const qSnap = await db.collection("streamers").doc(uid)
      .collection("slot_requests")
      .where("status", "==", "pending")
      .orderBy("requestedAt", "asc")
      .limit(50)
      .get();

    const requests = qSnap.docs.map(d => ({
      id:          d.id,
      kickUsername: d.data().kickUsername,
      slotName:    d.data().slotName,
      requestedAt: d.data().requestedAt,
    }));

    return res(200, { requests });
  } catch (err) {
    return res(500, { error: err.message });
  }
};
