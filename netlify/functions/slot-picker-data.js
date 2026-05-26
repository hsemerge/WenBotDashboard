// GET /api/slot-picker-data?channel=xxx
// Public endpoint powering the slot-picker OBS overlay — no auth required.
// Returns the latest slot_picker trigger (reel + landing index) the dashboard
// wrote, so the overlay can replay the spin. Admin SDK, so it bypasses the
// Firestore rules that (correctly) block unauthenticated client reads.

const { getDb } = require("./_lib/firebase");

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
    const db = getDb();

    const snap = await db.collection("streamers")
      .where("kickChannel", "==", channel).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const uid = snap.docs[0].id;
    const doc = await db.collection("streamers").doc(uid)
      .collection("tools").doc("slot_picker").get();

    if (!doc.exists) return res(200, { picker: null });

    const d = doc.data() || {};
    return res(200, {
      picker: {
        trigger:     d.trigger     || null,
        picked:      d.picked      || null,
        reel:        d.reel        || null,
        pickedIndex: (typeof d.pickedIndex === "number") ? d.pickedIndex : null,
        pickedAt:    d.pickedAt     || null,
      },
    });
  } catch (err) {
    console.error("[slot-picker-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
