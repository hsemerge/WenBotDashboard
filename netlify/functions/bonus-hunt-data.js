// GET /api/bonus-hunt-data?channel=xxx
// Returns bonus hunt state for OBS overlay — no auth required

const { getDb } = require("./_lib/firebase");
const { findStreamerByChannel } = require("./_lib/streamer");
const { memo } = require("./_lib/overlay-cache");

// A bonus-hunt figure a couple of seconds behind looks identical on stream.
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
    const { code, body } = await memo(`bonushunt:${channel}`, CACHE_TTL_MS, async () => {
      const db   = getDb();
      const snapDoc = await findStreamerByChannel(db, channel);
      if (!snapDoc) return { code: 404, body: { error: "Channel not found" } };

      const uid     = snapDoc.id;
      const huntDoc = await db.collection("streamers").doc(uid)
        .collection("bonus_hunt").doc("current").get();

      if (!huntDoc.exists || !huntDoc.data().active) return { code: 200, body: { active: false } };
      return { code: 200, body: huntDoc.data() };
    });
    return res(code, body);
  } catch (err) {
    console.error("[bonus-hunt-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
