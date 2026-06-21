// GET /api/raffle-entries?channel=xxx[&kick=username]
// Per-raffle entry counts for the portal store. Returns the TOTAL entries for
// every raffle item, plus (when ?kick= is supplied) how many that viewer bought.
//
// Counts come from store_redemptions (status "raffle_entry"). We fetch that
// single-field-indexed set once and aggregate in JS, so no composite index is
// needed. (Same "kick by username, no token re-verify" posture as bb-state's
// viewerPoints — an entry count isn't sensitive.)
//
// SCALING TODO: this scans all raffle_entry redemptions for the streamer. Fine at
// current scale; if a streamer accumulates very many over time, switch to a
// per-active-item count() aggregation (needs an itemId+status composite index).

const { getDb }     = require("./_lib/firebase");
const { res: _res } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  const kick    = (event.queryStringParameters?.kick || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing channel" });

  try {
    const db = getDb();
    const snap = await db.collection("streamers").where("kickChannel", "==", channel).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });
    const uid = snap.docs[0].id;

    // COST GUARD: scanning every raffle_entry redemption on every portal poll
    // (×60/hr ×every open portal) was a runaway as ticket docs piled up. Cache the
    // aggregation per streamer; all portals/viewers share one scan per TTL. The
    // per-user map is keyed by unique entrant (bounded by audience, NOT ticket
    // count), so it stays small. `_cache` is admin-SDK only — clients can't read it.
    const CACHE_TTL_MS = 5 * 60 * 1000;
    const cacheRef = db.collection("_cache").doc(`raffle_${uid}`);
    let agg = null;
    try {
      const c = await cacheRef.get();
      if (c.exists && c.data().agg && (Date.now() - c.data().cachedAt) < CACHE_TTL_MS) agg = c.data().agg;
    } catch { /* cache miss → recompute */ }

    if (!agg) {
      const redemptionsSnap = await db.collection("streamers").doc(uid)
        .collection("store_redemptions").where("status", "==", "raffle_entry").get();
      agg = {}; // itemId -> { total, users: { kickKey: count } }
      redemptionsSnap.forEach((doc) => {
        const d = doc.data();
        const id = d.itemId;
        if (!id) return;
        if (!agg[id]) agg[id] = { total: 0, users: {} };
        agg[id].total += 1;
        // chat/Discord/web all store kickUsernameKey now; fall back to raw name for legacy docs.
        const who = (d.kickUsernameKey || d.kickUsername || "").toLowerCase();
        if (who) agg[id].users[who] = (agg[id].users[who] || 0) + 1;
      });
      try { await cacheRef.set({ cachedAt: Date.now(), agg }); } catch { /* too big / write fail → skip cache */ }
    }

    const entries = {}; // itemId -> { total, mine }
    for (const id in agg) {
      entries[id] = { total: agg[id].total, mine: kick ? (agg[id].users[kick] || 0) : 0 };
    }

    return res(200, { success: true, entries, signedIn: !!kick });
  } catch (err) {
    console.error("[raffle-entries] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
