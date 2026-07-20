// GET /api/raffle-detail?uid=<streamer>&itemId=<id>[&fresh=1]
// Returns the aggregated point-raffle entrant breakdown for ONE raffle item —
// [{ username, tickets, lastTs }] + totals — computed server-side and cached, so
// the dashboard never downloads every ticket doc (a big channel has tens of
// thousands). This is what made the raffle page take ~a minute to open.
//
// 100% READ-ONLY. It never creates, edits, or deletes a ticket — the raffle_entry
// docs remain the single source of truth, and this aggregate can always be rebuilt
// from them. Auth mirrors the Firestore rules: the streamer (owner) or a delegated
// moderator (delegatedFor claim) may read their own raffle.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

const TTL_MS = 60 * 1000; // serve the cached aggregate for up to 60s

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const db = getDb(); // init the admin app before admin.auth()

  const idToken = (event.headers.authorization || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid token" }); }

  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid    = (event.queryStringParameters?.uid || "").trim() || decoded.uid;
  const itemId = (event.queryStringParameters?.itemId || "").trim();
  const fresh  = event.queryStringParameters?.fresh === "1";
  if (uid !== decoded.uid && !delegated.includes(uid)) return res(403, { error: "Not authorized for that account" });
  if (!itemId) return res(400, { error: "Missing itemId" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "raffle_detail", 90, 60))) return res(429, { error: "Too many requests" });

  const cacheRef = db.collection("_cache").doc(`raffle_detail_${uid}_${itemId}`);

  // Serve the cached aggregate unless a fresh rebuild was explicitly requested
  // (the dashboard passes fresh=1 right after a clear/remove so counts stay exact).
  if (!fresh) {
    try {
      const c = await cacheRef.get();
      if (c.exists && c.data().payload && (Date.now() - c.data().cachedAt) < TTL_MS) {
        return res(200, { ...c.data().payload, cached: true });
      }
    } catch { /* fall through to a fresh scan */ }
  }

  // Aggregate the tickets. itemId + status are both equality filters → Firestore
  // serves this from single-field indexes (zigzag merge), no composite index needed.
  try {
    const snap = await db.collection("streamers").doc(uid).collection("store_redemptions")
      .where("itemId", "==", itemId)
      .where("status", "==", "raffle_entry")
      .get();

    const map = {};
    snap.forEach((doc) => {
      const d   = doc.data();
      const key = (d.kickUsername || "").toLowerCase();
      if (!key) return;
      if (!map[key]) map[key] = { username: d.kickUsername, tickets: 0, lastTs: 0 };
      map[key].tickets++;
      const ts = d.redeemedAt && d.redeemedAt.toMillis ? d.redeemedAt.toMillis() : (Number(d.redeemedAt) || 0);
      if (ts > map[key].lastTs) map[key].lastTs = ts;
    });

    const entrants     = Object.values(map).sort((a, b) => b.tickets - a.tickets);
    const totalTickets = entrants.reduce((s, e) => s + e.tickets, 0);
    const payload      = { entrants, totalTickets, entrantCount: entrants.length };

    // Cache it. If the entrant list is huge (>1MB doc), the write throws and we
    // just skip caching — the data still returns correctly, uncached.
    try { await cacheRef.set({ cachedAt: Date.now(), payload }); } catch { /* too big to cache — fine */ }

    return res(200, { ...payload, cached: false });
  } catch (err) {
    console.error("[raffle-detail] error:", err.message);
    return res(500, { error: "Failed to load raffle entries" });
  }
};
