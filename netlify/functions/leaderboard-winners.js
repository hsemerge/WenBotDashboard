// GET /api/leaderboard-winners?channel=xxx&casino=xxx
// Returns past leaderboard periods for a streamer + casino from Firestore

const { getDb }     = require("./_lib/firebase");
const { res: _res } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const { channel, casino } = event.queryStringParameters || {};
  if (!channel) return res(400, { error: "Missing channel" });

  try {
    const db = getDb();
    const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const uid = snap.docs[0].id;
    // Never assume Gambulls — param first, else the streamer's actual casino.
    // An unset casino means an empty query (no past winners), not Gambulls data.
    const provider = (casino || snap.docs[0].data().activeProvider || "").toLowerCase();

    // Past winners change only when a period finalizes (rare), but every open
    // leaderboard polls this every 5 min — so cache per channel+casino to avoid
    // re-scanning leaderboard_periods for every viewer.
    const cacheRef = db.collection("_cache").doc(`lbwinners_${uid}_${provider || "none"}`);
    try {
      const c = await cacheRef.get();
      if (c.exists && c.data().payload && (Date.now() - c.data().cachedAt) < 5 * 60 * 1000) {
        return res(200, c.data().payload);
      }
    } catch { /* recompute */ }

    // Filter by casino only (single-field, auto-indexed) and sort/slice in JS.
    // `where(casino==).orderBy(endDate)` needs a composite index that isn't
    // deployed — without it the query throws and Past Winners silently empties.
    const periodsSnap = await db.collection("streamers").doc(uid)
      .collection("leaderboard_periods")
      .where("casino", "==", provider)
      .get();

    const periods = periodsSnap.docs
      .map(d => d.data())
      .sort((a, b) => (b.endDate || 0) - (a.endDate || 0))
      .slice(0, 24);
    const payload = { success: true, periods };
    try { await cacheRef.set({ cachedAt: Date.now(), payload }); } catch { /* skip cache */ }
    return res(200, payload);

  } catch (err) {
    console.error("[leaderboard-winners] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
