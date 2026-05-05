// Sends a chat message to a Kick channel as WenBot
// WenBot must be modded in the target channel
// POST body: { broadcaster_user_id: int, message: string }

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return res(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return res(400, { error: "Invalid JSON body" });
  }

  const { broadcaster_user_id, message } = body;

  if (!broadcaster_user_id || !message) {
    return res(400, { error: "Missing broadcaster_user_id or message" });
  }

  if (String(message).length > 500) {
    return res(400, { error: "Message exceeds 500 character limit" });
  }

  // Load WenBot tokens from Netlify Blobs
  let tokens;
  try {
    const store = getStore("wenbot");
    tokens = await store.get("tokens", { type: "json" });
  } catch (err) {
    return res(503, { error: "Failed to load WenBot tokens: " + err.message });
  }

  if (!tokens?.access_token) {
    return res(503, { error: "WenBot not authenticated. Complete the WenBot auth flow at /admin/wenbot-auth.html" });
  }

  // Auto-refresh if expiring within 5 minutes
  if (tokens.expires_at && Date.now() > tokens.expires_at - 300_000) {
    tokens = await refreshWenBotToken(tokens);
    if (!tokens) {
      return res(503, { error: "WenBot token refresh failed — re-authenticate at /admin/wenbot-auth.html" });
    }
  }

  // Post message to Kick chat
  try {
    const resp = await fetch("https://api.kick.com/public/v1/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        type: "user",
        content: String(message),
        broadcaster_user_id: parseInt(broadcaster_user_id, 10),
      }),
    });

    const data = await resp.json();
    return res(resp.ok ? 200 : resp.status, data);
  } catch (err) {
    return res(500, { error: err.message });
  }
};

async function refreshWenBotToken(tokens) {
  const params = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id:     process.env.KICK_CLIENT_ID,
    client_secret: process.env.KICK_CLIENT_SECRET,
  });

  try {
    const resp = await fetch("https://id.kick.com/oauth/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    params,
    });

    if (!resp.ok) return null;

    const data  = await resp.json();
    const fresh = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
    };

    const store = getStore("wenbot");
    await store.setJSON("tokens", fresh);
    return fresh;
  } catch {
    return null;
  }
}

function res(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}
