// GET /api/slot-request-data?channel=xxx
// Returns active slot request queue for OBS overlay — no auth required

const { getDb } = require("./_lib/firebase");

// Local res() — includes Cache-Control: no-store for overlay freshness
function res(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing ?channel=" });

  try {
    const db   = getDb();
    const snap = await db.collection("streamers").where("kickChannel", "==", channel).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const uid = snap.docs[0].id;

    // Filter by status only (single-field, auto-indexed) and sort in JS — same
    // pattern the dashboard uses. Adding `.orderBy("requestedAt")` on top of the
    // `where(status==)` needs a composite index that isn't deployed, which made
    // this throw → 500 → the overlay rendered empty even when requests existed.
    const qSnap = await db.collection("streamers").doc(uid)
      .collection("slot_requests")
      .where("status", "==", "pending")
      .limit(50)
      .get();

    const requests = qSnap.docs.map(d => ({
      id:          d.id,
      kickUsername: d.data().kickUsername,
      slotName:    d.data().slotName,
      requestedAt: d.data().requestedAt,
    })).sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));

    return res(200, { requests });
  } catch (err) {
    console.error("[slot-request-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
