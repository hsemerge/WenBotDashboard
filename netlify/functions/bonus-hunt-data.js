// GET /api/bonus-hunt-data?channel=xxx
// Returns bonus hunt state for OBS overlay — no auth required

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

    const uid     = snap.docs[0].id;
    const huntDoc = await db.collection("streamers").doc(uid)
      .collection("bonus_hunt").doc("current").get();

    if (!huntDoc.exists || !huntDoc.data().active) {
      return res(200, { active: false });
    }

    return res(200, huntDoc.data());
  } catch (err) {
    console.error("[bonus-hunt-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
