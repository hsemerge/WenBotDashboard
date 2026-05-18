// POST /api/discord-link-account
// Exchanges Discord OAuth code for user ID and saves discord_links entry
// Body: { code, state }  — state is base64 JSON { k: kickUsername, c: channel }

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }

  const { code, state } = body;
  if (!code || !state) return res(400, { error: "Missing code or state" });

  // Decode state
  let kickUsername, channel;
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
    kickUsername  = decoded.k;
    channel       = decoded.c;
  } catch {
    return res(400, { error: "Invalid state" });
  }

  if (!kickUsername || !channel) return res(400, { error: "Incomplete state" });

  // Exchange OAuth code for Discord access token
  const tokenResp = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri:  process.env.DISCORD_VERIFY_REDIRECT_URI,
      client_id:     process.env.DISCORD_APPLICATION_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    return res(400, { error: "Discord token exchange failed: " + err });
  }

  const { access_token } = await tokenResp.json();

  // Get Discord user ID
  const userResp = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { "Authorization": `Bearer ${access_token}` },
  });

  if (!userResp.ok) return res(500, { error: "Failed to fetch Discord user" });
  const discordUser = await userResp.json();
  const discordUserId  = discordUser.id;
  const discordUsername = discordUser.username;

  // Look up streamer by channel name
  const db = getDb();
  const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
  if (snap.empty) return res(404, { error: "Streamer channel not found" });

  const streamerUid = snap.docs[0].id;

  // Save the discord_link
  await db.collection("streamers").doc(streamerUid)
    .collection("discord_links").doc(discordUserId).set({
      kickUsername,
      discordUsername,
      linkedAt: Date.now(),
    });

  return res(200, { success: true, discordUsername, kickUsername });
};
