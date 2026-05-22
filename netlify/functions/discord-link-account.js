// POST /api/discord-link-account
// Exchanges Discord OAuth code, verifies the user is a member of THIS streamer's
// Discord server, then saves the discord_links entry.
// Body: { code, state }  — state is base64 JSON { k: kickUsername, c: channel }

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();

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

  // Look up streamer by channel name first — we need their Discord guild ID
  // to verify membership.
  const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
  if (snap.empty) return res(404, { error: "Streamer channel not found" });

  const streamerUid = snap.docs[0].id;
  const guildId     = snap.docs[0].data()?.discordConfig?.guildId || null;
  if (!guildId) {
    return res(400, { error: "This streamer hasn't connected a Discord server yet." });
  }

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

  // Verify the user is actually a member of the streamer's Discord server.
  // The 'guilds' scope lets us read their guild list; we require the streamer's
  // guildId to be present. This stops "universal" links from accounts that
  // aren't in the server.
  try {
    const guildsResp = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { "Authorization": `Bearer ${access_token}` },
    });
    if (!guildsResp.ok) {
      return res(502, { error: "Couldn't read your Discord servers. Please try again." });
    }
    const guilds = await guildsResp.json();
    const isMember = Array.isArray(guilds) && guilds.some(g => g.id === guildId);
    if (!isMember) {
      return res(403, {
        error: "You're not in this streamer's Discord server yet. Join it first, then link your account.",
        notInGuild: true,
      });
    }
  } catch (err) {
    console.error("[discord-link-account] guild check failed:", err.message);
    return res(502, { error: "Couldn't verify your Discord membership. Please try again." });
  }

  // Save the discord_link (now guild-verified)
  await db.collection("streamers").doc(streamerUid)
    .collection("discord_links").doc(discordUserId).set({
      kickUsername,
      discordUsername,
      guildId,
      guildVerified: true,
      linkedAt: Date.now(),
    });

  return res(200, { success: true, discordUsername, kickUsername });
};
