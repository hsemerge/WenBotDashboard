// GET /api/overlay-data?channel=xxx
// Returns giveaway snapshot + profile criteria for OBS overlays — no auth required

const admin = require("firebase-admin");

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
    const db = getDb();

    const snap = await db.collection("streamers")
      .where("kickChannel", "==", channel).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const uid     = snap.docs[0].id;
    const profile = snap.docs[0].data();

    const snapshotDoc = await db.collection("streamers").doc(uid)
      .collection("giveaway_state").doc("snapshot").get();

    const snapshot = snapshotDoc.exists ? snapshotDoc.data() : { active: false, count: 0, entries: [] };

    return res(200, {
      active:          !!snapshot.active,
      count:           snapshot.count  || 0,
      entries:         snapshot.entries || [],
      updatedAt:       snapshot.updatedAt || null,
      spinTrigger:     snapshot.spinTrigger   || null,
      raffleTrigger:   snapshot.raffleTrigger || null,
      keyword:         profile.giveawayKeyword  || "!join",
      type:            profile.giveawayType     || "code",
      minWager:        profile.giveawayMinWager || 0,
      subOnly:         !!profile.giveawaySubOnly,
      verifiedCasino:  !!profile.giveawayVerifiedCasino,
      verifiedDiscord: !!profile.giveawayVerifiedDiscord,
    });
  } catch (err) {
    return res(500, { error: err.message });
  }
};
