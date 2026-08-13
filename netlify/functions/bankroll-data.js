// GET /api/bankroll-data?channel=xxx
// Returns the streamer's current session bankroll (manual deposits/withdrawals
// logged from the dashboard Overview) for the OBS bankroll overlays. Public,
// read-only, no sensitive data — just the running totals the streamer chooses
// to show on stream.

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
    const doc = await db.collection("streamers").doc(uid)
      .collection("bankroll").doc("current").get();

    const d = doc.exists ? doc.data() : {};
    const deposited = Number(d.deposited) || 0;
    const withdrawn = Number(d.withdrawn) || 0;
    const entries   = Array.isArray(d.entries) ? d.entries : [];

    return res(200, {
      deposited,
      withdrawn,
      net:             withdrawn - deposited,
      depositCount:    entries.filter((e) => e && e.type === "deposit").length,
      withdrawalCount: entries.filter((e) => e && e.type === "withdrawal").length,
      count:           entries.length,
      sessionStart:    d.sessionStart || null,
      updatedAt:       d.updatedAt || null,
    });
  } catch (err) {
    console.error("[bankroll-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
