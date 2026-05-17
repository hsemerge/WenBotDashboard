// POST /api/tournament-enter
// Body: { channel, kickUsername, accessToken }
// Verifies viewer identity, deducts entry cost, adds to participants.

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
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, kickUsername, accessToken } = body;
  if (!channel || !kickUsername || !accessToken) {
    return res(400, { error: "Missing required fields" });
  }

  const channelKey = channel.toLowerCase().trim();
  const userKey    = kickUsername.toLowerCase().trim();

  try {
    // 1. Verify Kick identity
    const kickResp = await fetch("https://api.kick.com/public/v1/users", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!kickResp.ok) return res(401, { error: "Could not verify Kick identity — please log in again" });
    const kickData = await kickResp.json();
    const kickUser = kickData.data?.[0];
    if (!kickUser || kickUser.name.toLowerCase() !== userKey) {
      return res(401, { error: "Identity mismatch — please log in again" });
    }

    const db = getDb();

    // 2. Find streamer
    const streamerSnap = await db.collection("streamers").where("kickChannel", "==", channelKey).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });
    const uid = streamerSnap.docs[0].id;

    // 3. Check tournament
    const tRef  = db.collection("streamers").doc(uid).collection("tournaments").doc("current");
    const tDoc  = await tRef.get();
    if (!tDoc.exists || !tDoc.data().active || tDoc.data().status !== "registration") {
      return res(400, { error: "Tournament registration is not open" });
    }
    const t = tDoc.data();

    // 4. Check already entered
    const already = (t.participants || []).some(p => p && p.kickUsernameKey === userKey);
    if (already) return res(400, { error: "You are already entered in this tournament" });

    // 5. Check full
    if ((t.participants || []).length >= t.bracketSize) {
      return res(400, { error: "Tournament is full" });
    }

    // 6. Verified check
    const vSnap = await db.collection("streamers").doc(uid)
      .collection("verified_users").where("kickName", "==", userKey).limit(1).get();
    if (vSnap.empty) return res(403, { error: "You must be verified to enter. Please verify your account first." });

    // 7. Points check
    const entryCost = t.entryCost || 0;
    const viewerRef = db.collection("streamers").doc(uid).collection("viewers").doc(userKey);
    const viewerDoc = await viewerRef.get();
    const currentPoints = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;
    if (currentPoints < entryCost) {
      return res(400, { error: `Not enough points. You have ${currentPoints.toLocaleString()} pts, need ${entryCost.toLocaleString()} pts.` });
    }

    // 8. Batch: deduct points, add participant, update prize pool
    const newParticipant = { kickUsername, kickUsernameKey: userKey, enteredAt: Date.now(), eliminated: false, eliminatedRound: null, place: null };
    const batch = db.batch();
    if (entryCost > 0) {
      batch.update(viewerRef, { points: admin.firestore.FieldValue.increment(-entryCost) });
    }
    batch.update(tRef, {
      participants: admin.firestore.FieldValue.arrayUnion(newParticipant),
      prizePool: admin.firestore.FieldValue.increment(entryCost),
      updatedAt: Date.now(),
    });
    await batch.commit();

    const newBalance = currentPoints - entryCost;
    return res(200, {
      success: true,
      message: `You're in the tournament! Entry cost: ${entryCost.toLocaleString()} pts. Good luck!`,
      newBalance,
    });
  } catch (err) {
    return res(500, { error: err.message });
  }
};
