// GET /api/raffle-entries?channel=xxx[&kick=username]
// Per-raffle entry counts for the portal store. Returns the TOTAL entries for
// every raffle item, plus (when ?kick= is supplied) how many that viewer bought.
//
// Counts ONLY status=="raffle_entry" docs (a single raffle item accumulates docs
// with OTHER statuses too — e.g. "fulfilled" after a round is drawn — which must
// NOT be counted as live entries). We scan that status once and cache the
// aggregation per streamer, so all open portals share one scan per TTL instead
// of each re-scanning on every 60s poll.
//
// (Earlier a count() aggregation on itemId-only was tried for cost, but it
// over-counted because it ignored status — it summed fulfilled/old docs too.
// Doing it cheaply AND correctly needs a count() with an itemId+status COMPOSITE
// INDEX; until that's set up, this status-filtered cached scan is the correct
// source. `_cache` is admin-SDK only — clients can't read it.)
//
// Read-only: never writes/edits/deletes a ticket.

const { getDb }     = require("./_lib/firebase");
const { res: _res } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

const CACHE_TTL_MS = 5 * 60 * 1000;

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

    const cacheRef = db.collection("_cache").doc(`raffle_${uid}`);
    let agg = null;
    try {
      const c = await cacheRef.get();
      if (c.exists && c.data().agg && (Date.now() - c.data().cachedAt) < CACHE_TTL_MS) agg = c.data().agg;
    } catch { /* cache miss → recompute */ }

    if (!agg) {
      // Only live entries — status must be raffle_entry (NOT fulfilled/pending/etc.).
      const redemptionsSnap = await db.collection("streamers").doc(uid)
        .collection("store_redemptions").where("status", "==", "raffle_entry").get();
      agg = {}; // itemId -> { total, users: { kickKey: count } }
      redemptionsSnap.forEach((doc) => {
        const d = doc.data();
        const id = d.itemId;
        if (!id) return;
        if (!agg[id]) agg[id] = { total: 0, users: {} };
        agg[id].total += 1;
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
