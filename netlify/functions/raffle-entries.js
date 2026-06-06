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

    const redemptionsSnap = await db.collection("streamers").doc(uid)
      .collection("store_redemptions").where("status", "==", "raffle_entry").get();

    const entries = {}; // itemId -> { total, mine }
    redemptionsSnap.forEach((doc) => {
      const d = doc.data();
      const id = d.itemId;
      if (!id) return;
      if (!entries[id]) entries[id] = { total: 0, mine: 0 };
      entries[id].total += 1;
      // Match the buyer by key, falling back to the raw username — chat (!buy) and
      // Discord (/buy) purchases historically stored only kickUsername, no key.
      const who = (d.kickUsernameKey || d.kickUsername || "").toLowerCase();
      if (kick && who === kick) entries[id].mine += 1;
    });

    return res(200, { success: true, entries, signedIn: !!kick });
  } catch (err) {
    console.error("[raffle-entries] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
