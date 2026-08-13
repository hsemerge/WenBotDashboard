// GET /api/overlay-theme?channel=xxx
// Returns the streamer's SAVED overlay themes (the same map the dashboard's
// Overlay Studio writes to streamers/{uid}/overlay_theme/config). The overlay
// pages poll this so theme changes made in the dashboard propagate to OBS within
// seconds — no need to re-copy the URL. Public, read-only, appearance data only.

const { getDb } = require("./_lib/firebase");
const { findStreamerByChannel } = require("./_lib/streamer");

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
    const snapDoc = await findStreamerByChannel(db, channel);
    if (!snapDoc) return res(404, { error: "Channel not found" });

    const uid = snapDoc.id;
    const cfg = await db.collection("streamers").doc(uid)
      .collection("overlay_theme").doc("config").get();

    // Only the saved per-overlay appearance map — nothing sensitive.
    const overlays = (cfg.exists && cfg.data().overlays) || {};
    return res(200, { overlays });
  } catch (err) {
    console.error("[overlay-theme] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
