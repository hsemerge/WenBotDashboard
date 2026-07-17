// POST /api/bb-vote
// Body: { channel, kickUsername, accessToken, matchId, choice (1|2), points }
// Verifies viewer identity via Kick API, then records vote and deducts points.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { logAudit }            = require("./_lib/audit");
const { getKickUser }         = require("./_lib/kick");

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
    const kickLookup = await getKickUser(accessToken);
    if (kickLookup.error) return res(kickLookup.status, { error: kickLookup.error });
    const kickUser = kickLookup.user;
    if (kickUser.name.toLowerCase() !== userKey) {
      return res(401, { error: "Identity mismatch — please log in again" });
    }

    const db = getDb();

    // Per-user rate limit (verified Kick identity, not IP). Anti-spam.
    if (!(await checkRateLimit(db, userKey, "bb_vote", 30, 60))) {
      return res(429, { error: "Too many requests — please slow down a moment." });
    }

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

    // 6-8. Do the existing-vote check, balance check, point deduction, vote
    // record, and pool update ATOMICALLY in one transaction. A plain read-then-
    // batch let two concurrent votes both pass a stale balance check and both
    // deduct (double-spend → negative balance); the transaction re-reads inside
    // and only one can win.
    const voteId    = `${matchId}_${userKey}`;
    const viewerRef = db.collection("streamers").doc(uid).collection("viewers").doc(userKey);
    const voteRef   = db.collection("streamers").doc(uid).collection("bb_votes").doc(voteId);
    const battleRef = db.collection("streamers").doc(uid).collection("bonus_battles").doc("current");
    const poolKey   = choiceNum === 1 ? "slot1Pool"  : "slot2Pool";
    const votesKey  = choiceNum === 1 ? "slot1Votes" : "slot2Votes";

    let newBalance;
    try {
      newBalance = await db.runTransaction(async (txn) => {
        const [voteSnap, viewerSnap, bSnap] = await Promise.all([
          txn.get(voteRef), txn.get(viewerRef), txn.get(battleRef),
        ]);
        if (voteSnap.exists) throw new Error("ALREADY_VOTED");
        const cur = viewerSnap.exists ? (viewerSnap.data().points || 0) : 0;
        if (cur < pointsNum) throw new Error("INSUFFICIENT");
        const b  = bSnap.exists ? bSnap.data() : battle;
        const mt = (b.matches || []).find(m => m.id === matchId);
        if (!mt || mt.status !== "voting") throw new Error("MATCH_CLOSED");
        const matches = (b.matches || []).map(m => m.id === matchId ? {
          ...m,
          [poolKey]:  (m[poolKey]  || 0) + pointsNum,
          [votesKey]: (m[votesKey] || 0) + 1,
        } : m);
        txn.update(viewerRef, { points: admin.firestore.FieldValue.increment(-pointsNum) });
        txn.set(voteRef, {
          kickUsername, kickUsernameKey: userKey,
          matchId, choice: choiceNum, points: pointsNum,
          paid: false, payout: null, createdAt: Date.now(),
        });
        txn.update(battleRef, { matches, updatedAt: Date.now() });
        return cur - pointsNum;
      });
    } catch (e) {
      if (e.message === "ALREADY_VOTED") return res(400, { error: "You already voted on this match" });
      if (e.message === "INSUFFICIENT")  return res(400, { error: "Not enough points" });
      if (e.message === "MATCH_CLOSED")  return res(400, { error: "Voting is not open for this match" });
      throw e;
    }

    const slotName = choiceNum === 1 ? match.slot1.name : match.slot2.name;

    logAudit(uid, "bb_vote", {
      kickUsername, matchId, choice: choiceNum, points: pointsNum, slotName,
    });

    return res(200, {
      success: true,
      message: `Voted ${pointsNum.toLocaleString()} pts on ${slotName}!`,
      newBalance,
    });

  } catch (err) {
    console.error("[bb-vote] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
