// GET /api/bb-state?channel=xxx&kick=xxx
// Returns current battle state, viewer's point balance, votes, and verification status.

const { getDb, admin } = require("./_lib/firebase");
const { res: _res }    = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET")     return res(405, { error: "Method not allowed" });

  const { channel, kick } = event.queryStringParameters || {};
  if (!channel) return res(400, { error: "Missing channel" });

  const channelKey = channel.toLowerCase().trim();
  const userKey    = kick ? kick.toLowerCase().trim() : null;

  try {
    const db = getDb();

    // Find streamer
    const streamerSnap = await db.collection("streamers").where("kickChannel", "==", channelKey).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });
    const uid = streamerSnap.docs[0].id;

    // Get battle
    const battleDoc = await db.collection("streamers").doc(uid).collection("bonus_battles").doc("current").get();
    const battle    = battleDoc.exists ? battleDoc.data() : null;

    let viewerPoints = null;
    let isVerified   = false;
    const votes      = {};

    if (userKey) {
      // Points balance
      const viewerDoc = await db.collection("streamers").doc(uid).collection("viewers").doc(userKey).get();
      viewerPoints    = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;

      // Verification status
      const vSnap = await db.collection("streamers").doc(uid)
        .collection("verified_users").where("kickName", "==", userKey).limit(1).get();
      isVerified = !vSnap.empty;

      // Fetch viewer's votes on active battle matches
      if (battle?.matches?.length) {
        const voteIds = battle.matches.map(m => `${m.id}_${userKey}`);
        // Firestore doesn't support "in" on doc IDs easily, so fetch individually (matches are typically ≤20)
        await Promise.all(voteIds.map(async (voteId, idx) => {
          const voteDoc = await db.collection("streamers").doc(uid).collection("bb_votes").doc(voteId).get();
          if (voteDoc.exists) votes[battle.matches[idx].id] = voteDoc.data();
        }));
      }
    }

    return res(200, { battle, viewerPoints, isVerified, votes });

  } catch (err) {
    console.error("[bb-state] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
