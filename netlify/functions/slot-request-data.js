// GET /api/slot-request-data?channel=xxx
// Returns active slot request queue for OBS overlay — no auth required

const { getDb } = require("./_lib/firebase");
const { findStreamerByChannel } = require("./_lib/streamer");
const { memo } = require("./_lib/overlay-cache");

// Reads up to 50 docs per poll, so this is the biggest per-poll saving.
const CACHE_TTL_MS = 2500;

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
    const { code, body } = await memo(`slotreq:${channel}`, CACHE_TTL_MS, async () => {
    const db   = getDb();
    const snapDoc = await findStreamerByChannel(db, channel);
    if (!snapDoc) return { code: 404, body: { error: "Channel not found" } };

    const uid = snapDoc.id;

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

      return { code: 200, body: { requests } };
    });
    return res(code, body);
  } catch (err) {
    console.error("[slot-request-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
