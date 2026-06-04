// GET /api/giveall?token=XXXX&amount=500
// Thin proxy to the always-on WenBot server (Railway), which holds the active-
// chatter list in memory and actually performs the drop. Keeps the public URL on
// wenbot.gg (clean for Stream Deck) and hides the server host. Auth is the
// per-streamer token, validated server-side.
//
// Requires the Netlify env var WENBOT_SERVER_URL = the WenBot server base URL
// (e.g. https://wenbot-production.up.railway.app).

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

  const base = process.env.WENBOT_SERVER_URL;
  if (!base) return res(500, { error: "Webhook not configured (WENBOT_SERVER_URL missing)" });

  const token  = (event.queryStringParameters?.token  || "").trim();
  const amount = (event.queryStringParameters?.amount || "").trim();
  if (!token || !amount) return res(400, { error: "Usage: /api/giveall?token=...&amount=..." });

  try {
    const url = `${base.replace(/\/$/, "")}/giveall?token=${encodeURIComponent(token)}&amount=${encodeURIComponent(amount)}`;
    const r    = await fetch(url);
    const data = await r.json().catch(() => ({}));
    return res(r.status, data);
  } catch (err) {
    console.error("[giveall] proxy error:", err.message);
    return res(502, { error: "Could not reach the WenBot server" });
  }
};
