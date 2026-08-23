// POST /api/wenball-announce
//   { token: "<per-streamer wenball secret>", event: "lobby_open", map, players }
//
// Thin proxy to the always-on WenBot server (Railway), which holds the live Kick
// bot connections and actually posts the message. The game (a Godot web build at
// /wenball/) can read chat over the public Pusher socket but can't send, so this
// is how a lobby opening gets announced. Keeps the public URL on wenbot.gg and
// hides the server host; the token is validated server-side, and the message
// wording is built there from the event name — never taken from the client.
//
// Requires the Netlify env var WENBOT_SERVER_URL = the WenBot server base URL
// (e.g. https://wenbot-production.up.railway.app).

const { getDb }          = require("./_lib/firebase");
const { checkRateLimit } = require("./_lib/http");

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
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  // An announcement is decoration, not part of the race: if the relay isn't
  // configured, say so quietly rather than handing the game an error.
  const base = process.env.WENBOT_SERVER_URL;
  if (!base) return res(200, { ok: false, reason: "announcements unavailable" });

  // Throttle by IP so the per-streamer token can't be brute-forced through the
  // proxy (the server throttles per token as well).
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(getDb(), ip, "wenball_announce", 20, 60))) return res(429, { error: "Too many requests" });

  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/wenball-announce`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    event.body || "{}",
    });
    const data = await r.json().catch(() => ({}));
    return res(r.status, data);
  } catch (err) {
    // Deliberately message-only: the body carries the streamer's token.
    console.error("[wenball-announce] proxy error:", err.message);
    return res(502, { error: "Could not reach the WenBot server" });
  }
};
