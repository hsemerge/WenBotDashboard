// POST /api/tournament-enter
// Body: { channel, kickUsername, accessToken }
// Verifies viewer identity, deducts entry cost, adds to participants.

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");
const { logAudit }     = require("./_lib/audit");

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

    // 6. Verified check — case-insensitive. New docs use kickName_lower (added
    // Apr 2026); older docs are caught by a doc-ID prefix scan since IDs are
    // `${kickKey}_${provider}` and kickKey is already lowercased. The original
    // `kickName == userKey` query missed mixed-case usernames like TriitonGM
    // because kickName stores Kick's original case.
    const verifiedUsersRef = db.collection("streamers").doc(uid).collection("verified_users");
    const FieldPath = admin.firestore.FieldPath;
    const [vSnapNew, vSnapLegacy] = await Promise.all([
      verifiedUsersRef.where("kickName_lower", "==", userKey).limit(1).get(),
      verifiedUsersRef
        .where(FieldPath.documentId(), ">=", `${userKey}_`)
        .where(FieldPath.documentId(), "<",  `${userKey}_`)
        .limit(1).get(),
    ]);
    if (vSnapNew.empty && vSnapLegacy.empty) {
      return res(403, { error: "You must be verified to enter. Please verify your account first." });
    }

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

    logAudit(uid, "tournament_enter", { kickUsername, entryCost });

    return res(200, {
      success: true,
      message: `You're in the tournament! Entry cost: ${entryCost.toLocaleString()} pts. Good luck!`,
      newBalance,
    });
  } catch (err) {
    console.error("[tournament-enter] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
