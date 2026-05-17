// POST /api/bb-vote
// Body: { channel, kickUsername, accessToken, matchId, choice (1|2), points }
// Verifies viewer identity via Kick API, then records vote and deducts points.

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
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, kickUsername, accessToken, matchId, choice, points } = body;
  if (!channel || !kickUsername || !accessToken || !matchId || !choice || !points) {
    return res(400, { error: "Missing required fields" });
  }

  const choiceNum = parseInt(choice);
  const pointsNum = parseInt(points);
  if (![1, 2].includes(choiceNum)) return res(400, { error: "choice must be 1 or 2" });
  if (!pointsNum || pointsNum < 1)  return res(400, { error: "Invalid points amount" });

  const channelKey = channel.toLowerCase().trim();
  const userKey    = kickUsername.toLowerCase().trim();

  try {
    // 1. Verify identity with Kick API
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

    // 3. Check battle
    const battleDoc = await db.collection("streamers").doc(uid).collection("bonus_battles").doc("current").get();
    if (!battleDoc.exists || !battleDoc.data().active) return res(400, { error: "No active bonus battle" });
    const battle = battleDoc.data();

    // 4. Check match
    const match = (battle.matches || []).find(m => m.id === matchId);
    if (!match)                      return res(404, { error: "Match not found" });
    if (match.status !== "voting")   return res(400, { error: "Voting is not open for this match" });

    // 5. Bet limits
    if (pointsNum < (battle.minBet || 1))    return res(400, { error: `Minimum bet is ${battle.minBet} pts` });
    if (pointsNum > (battle.maxBet || 99999)) return res(400, { error: `Maximum bet is ${battle.maxBet} pts` });

    // 6. Existing vote check
    const voteId      = `${matchId}_${userKey}`;
    const existingDoc = await db.collection("streamers").doc(uid).collection("bb_votes").doc(voteId).get();
    if (existingDoc.exists) return res(400, { error: "You already voted on this match" });

    // 7. Points check
    const viewerDoc    = await db.collection("streamers").doc(uid).collection("viewers").doc(userKey).get();
    const currentPoints = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;
    if (currentPoints < pointsNum) return res(400, { error: `Not enough points. You have ${currentPoints.toLocaleString()} pts` });

    // 8. Batch: deduct points + record vote + update match pools
    const batch = db.batch();

    batch.update(
      db.collection("streamers").doc(uid).collection("viewers").doc(userKey),
      { points: admin.firestore.FieldValue.increment(-pointsNum) }
    );

    batch.set(
      db.collection("streamers").doc(uid).collection("bb_votes").doc(voteId),
      {
        kickUsername, kickUsernameKey: userKey,
        matchId, choice: choiceNum, points: pointsNum,
        paid: false, payout: null, createdAt: Date.now(),
      }
    );

    const poolKey  = choiceNum === 1 ? "slot1Pool"  : "slot2Pool";
    const votesKey = choiceNum === 1 ? "slot1Votes" : "slot2Votes";
    const matches  = (battle.matches || []).map(m => m.id === matchId ? {
      ...m,
      [poolKey]:  (m[poolKey]  || 0) + pointsNum,
      [votesKey]: (m[votesKey] || 0) + 1,
    } : m);

    batch.update(
      db.collection("streamers").doc(uid).collection("bonus_battles").doc("current"),
      { matches, updatedAt: Date.now() }
    );

    await batch.commit();

    const slotName   = choiceNum === 1 ? match.slot1.name : match.slot2.name;
    const newBalance = currentPoints - pointsNum;
    return res(200, {
      success: true,
      message: `Voted ${pointsNum.toLocaleString()} pts on ${slotName}!`,
      newBalance,
    });

  } catch (err) {
    return res(500, { error: err.message });
  }
};
