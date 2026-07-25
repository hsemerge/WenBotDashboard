// GET /api/tournament-state?channel=xxx&kick=xxx
// Returns current tournament state + viewer entry/verification status.

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

    const streamerSnap = await db.collection("streamers").where("kickChannel", "==", channelKey).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });
    const uid = streamerSnap.docs[0].id;

    const tRef = db.collection("streamers").doc(uid).collection("tournaments").doc("current");
    const tDoc = await tRef.get();
    const tournament = tDoc.exists ? tDoc.data() : null;

    // Self-heal: raffle tournaments created before entrantsCount existed show
    // "N tickets · 0 entrants". Derive it ONCE from the entries pool (bounded)
    // and persist — the field existing afterwards keeps this from re-running.
    if (tournament && tournament.mode === "raffle" && tournament.status === "registration"
        && (tournament.entriesCount || 0) > 0 && tournament.entrantsCount === undefined) {
      try {
        const snap = await db.collection("streamers").doc(uid)
          .collection("tournament_entries").limit(500).get();
        const uniq = new Set();
        let last = null, lastAt = 0;
        snap.forEach((d) => {
          const e = d.data();
          if (e.kickUsernameKey) uniq.add(e.kickUsernameKey);
          if ((e.enteredAt || 0) > lastAt) { lastAt = e.enteredAt || 0; last = e.kickUsername || null; }
        });
        tournament.entrantsCount = uniq.size;
        if (last && !tournament.lastEntrant) tournament.lastEntrant = last;
        tRef.set({ entrantsCount: uniq.size, ...(last ? { lastEntrant: last } : {}) }, { merge: true }).catch(() => {});
      } catch { /* cosmetic — skip */ }
    }

    let viewerPoints = null;
    let isVerified   = false;
    let isEntered    = false;
    let ticketsUsed  = 0;

    if (userKey) {
      const verifiedUsersRef = db.collection("streamers").doc(uid).collection("verified_users");
      // Look up the new lowercased field first (added Apr 2026 to verify-affiliate.js).
      // For older docs that don't have kickName_lower yet, fall back to a doc-ID prefix
      // range query — verified_users doc IDs are `${kickKey}_${provider}` so any doc
      // starting with `${userKey}_` belongs to this user. Either branch confirms
      // verification; the kickName field itself stores original case, which is
      // why a direct `kickName == userKey` query missed users like TriitonGM.
      const FieldPath = admin.firestore.FieldPath;
      const [viewerDoc, vSnapNew, vSnapLegacy] = await Promise.all([
        db.collection("streamers").doc(uid).collection("viewers").doc(userKey).get(),
        verifiedUsersRef.where("kickName_lower", "==", userKey).limit(1).get(),
        verifiedUsersRef
          .where(FieldPath.documentId(), ">=", `${userKey}_`)
          .where(FieldPath.documentId(), "<",  `${userKey}_`)
          .limit(1).get(),
      ]);
      viewerPoints = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;
      isVerified   = !vSnapNew.empty || !vSnapLegacy.empty;

      if (tournament?.participants) {
        isEntered = tournament.participants.some(p => p && p.kickUsernameKey === userKey);
      }
      // Raffle: "entered" = holds at least one ticket in the pool.
      if (tournament?.mode === "raffle") {
        const tk = await db.collection("streamers").doc(uid).collection("tournament_entries")
          .where("kickUsernameKey", "==", userKey).get();
        ticketsUsed = tk.size;
        if (ticketsUsed > 0) isEntered = true;
      }
    }

    return res(200, { tournament, viewerPoints, isVerified, isEntered, ticketsUsed });
  } catch (err) {
    console.error("[tournament-state] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
