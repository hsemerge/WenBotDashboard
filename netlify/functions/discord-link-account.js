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

  // Decode state — just the Kick username + streamer channel. We link the
  // account but never auto-add anyone to the server.
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

  const streamerUid  = snap.docs[0].id;
  const streamerData = snap.docs[0].data() || {};
  const guildId      = streamerData.discordConfig?.guildId || null;
  const verifyCfg    = streamerData.discordConfig?.verify || {};
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

  // Account-age gate (gatekeeper anti-bot). A Discord snowflake encodes the
  // account's creation time; reject accounts newer than the streamer's minimum.
  if (verifyCfg.gatekeeper && verifyCfg.minAccountAgeDays > 0) {
    try {
      const createdMs = Number((BigInt(discordUserId) >> 22n) + 1420070400000n);
      const ageDays   = (Date.now() - createdMs) / 86400000;
      if (ageDays < verifyCfg.minAccountAgeDays) {
        return res(403, { error: `Your Discord account is too new to verify here — it must be at least ${verifyCfg.minAccountAgeDays} days old.` });
      }
    } catch { /* if parsing fails, don't block */ }
  }

  // Check whether the user is already in the streamer's Discord server.
  // The 'guilds' scope lets us read their guild list.
  let alreadyMember = false;
  try {
    const guildsResp = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { "Authorization": `Bearer ${access_token}` },
    });
    if (guildsResp.ok) {
      const guilds = await guildsResp.json();
      alreadyMember = Array.isArray(guilds) && guilds.some(g => g.id === guildId);
    }
  } catch (err) {
    console.warn("[discord-link-account] guild list read failed:", err.message);
  }

  // Add them to the server (they consented via the guilds.join scope) and then
  // assign the verified role — both in this single request, so the role lands the
  // instant they join. No detection/polling needed. The verify page already
  // showed them which server they're joining (name + icon).
  let joined = false;
  if (!alreadyMember) {
    try {
      const joinResp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`, {
        method:  "PUT",
        headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ access_token }),
      });
      // 201 = added, 204 = already a member. Both are success.
      if (joinResp.ok) joined = true;
      else console.warn("[discord-link-account] guild join failed:", joinResp.status, (await joinResp.text().catch(() => "")).slice(0, 200));
    } catch (err) {
      console.warn("[discord-link-account] guild join error:", err.message);
    }
  }
  const isMember = alreadyMember || joined;

  // Fallback invite, only if we somehow couldn't add them (e.g. bot missing the
  // Create Instant Invite permission) — so the result page still has a way in.
  let inviteUrl = null;
  if (!isMember) {
    inviteUrl = streamerData.socials?.discord || null;
    const dc = streamerData.discordConfig || {};
    let inviteChannelId = verifyCfg.gateChannelId || dc.giveawayChannelId || dc.announcementChannelId || null;
    if (!inviteChannelId) {
      try { const cr = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}` } }); if (cr.ok) { const chans = await cr.json(); inviteChannelId = (Array.isArray(chans) ? chans.find(c => c.type === 0) : null)?.id || null; } } catch {}
    }
    if (inviteChannelId) {
      try { const irr = await fetch(`https://discord.com/api/v10/channels/${inviteChannelId}/invites`, { method: "POST", headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ max_age: 0, max_uses: 0, unique: false }) }); if (irr.ok) { const inv = await irr.json(); if (inv.code) inviteUrl = `https://discord.gg/${inv.code}`; } } catch {}
    }
  }

  // Save the discord_link.
  await db.collection("streamers").doc(streamerUid)
    .collection("discord_links").doc(discordUserId).set({
      kickUsername,
      discordUsername,
      guildId,
      guildVerified: isMember,
      linkedAt: Date.now(),
    });

  // Assign the verified role now that they're a member (idempotent). Needs the
  // bot to have Manage Roles + a higher role than the target; non-fatal on fail.
  let roleAssigned = false;
  if (verifyCfg.assignRole && verifyCfg.roleId && isMember) {
    try {
      const roleResp = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}/roles/${verifyCfg.roleId}`,
        { method: "PUT", headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
      );
      roleAssigned = roleResp.ok;
      if (!roleResp.ok) console.warn("[discord-link-account] role assign failed:", roleResp.status, (await roleResp.text().catch(() => "")).slice(0, 200));
    } catch (err) {
      console.warn("[discord-link-account] role assign error:", err.message);
    }
  }

  // alreadyMember (= now a member) drives the "Open Discord" button; inviteUrl is
  // only set on the rare failure path.
  return res(200, { success: true, discordUsername, kickUsername, alreadyMember: isMember, joined, roleAssigned, inviteUrl, guildId });
};
