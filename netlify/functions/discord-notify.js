// POST /api/discord-notify (internal — called by other functions/dashboard actions)
// Sends embeds to a streamer's configured Discord channels
// Body: { uid, type, data }
// Types: giveaway_start | giveaway_winner | store_redemption

const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    const raw  = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
    const cred = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(cred) });
  }
  return admin.firestore();
}

function res(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function discordPost(path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method:  "POST",
    headers: {
      "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Discord API ${r.status}: ${err}`);
  }
  return r.json();
}

function buildGiveawayStartEmbed(data, profile) {
  const type      = data.type || "code";
  const keyword   = data.keyword || "!join";
  const typeLabel = type === "everyone" ? "Open to everyone" : "Verified users only";
  const platform  = profile?.activeProvider || "gambulls";

  return {
    color:       0x00e5ff,
    title:       "🎉 Giveaway is LIVE!",
    description: `A new giveaway has started on **${profile?.displayName || profile?.kickChannel || "stream"}**!`,
    fields: [
      { name: "Eligibility", value: typeLabel,            inline: true },
      { name: "Platform",    value: platform.toUpperCase(), inline: true },
      { name: "How to enter", value: `Click the **Join Giveaway** button below, or type \`${keyword}\` in Kick chat`, inline: false },
    ],
    footer:    { text: "WenBot • Giveaway" },
    timestamp: new Date().toISOString(),
  };
}

function buildGiveawayWinnerEmbed(data, profile) {
  return {
    color:       0xffd700,
    title:       "🏆 We have a winner!",
    description: `**${data.winner}** has won the giveaway on **${profile?.displayName || profile?.kickChannel || "stream"}**!`,
    fields:      [{ name: "Total entries", value: String(data.totalEntries || 0), inline: true }],
    footer:      { text: "WenBot • Giveaway" },
    timestamp:   new Date().toISOString(),
  };
}

function buildRedemptionEmbed(data) {
  return {
    color:       0x00ff88,
    description: `✅ **${data.itemName}** was redeemed by **${data.kickUsername}**`,
    footer:      { text: "WenBot • Store" },
    timestamp:   new Date().toISOString(),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  // Auth: Firebase ID token from dashboard (streamer must be signed in)
  const authHeader = event.headers["authorization"] || "";
  const idToken    = authHeader.replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }

  const { type, data } = body;
  if (!type) return res(400, { error: "Missing type" });

  // Verify Firebase ID token to get uid
  const db = getDb();
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  const profSnap = await db.collection("streamers").doc(uid).get();
  if (!profSnap.exists) return res(404, { error: "Streamer not found" });

  const profile = profSnap.data();
  const cfg     = profile.discordConfig || {};

  if (!cfg.guildId) return res(200, { skipped: "No Discord configured for this streamer" });

  try {
    if (type === "giveaway_start") {
      if (!cfg.giveawayChannelId) return res(200, { skipped: "No giveaway channel configured" });

      const payload = {
        embeds:     [buildGiveawayStartEmbed(data, profile)],
        components: [{
          type:       1,
          components: [{
            type:      2,
            style:     1,
            label:     "🎉 Join Giveaway",
            custom_id: "join_giveaway",
          }],
        }],
      };
      await discordPost(`/channels/${cfg.giveawayChannelId}/messages`, payload);
    }

    else if (type === "giveaway_winner") {
      if (!cfg.giveawayChannelId) return res(200, { skipped: "No giveaway channel configured" });
      await discordPost(`/channels/${cfg.giveawayChannelId}/messages`, {
        embeds: [buildGiveawayWinnerEmbed(data, profile)],
      });
    }

    else if (type === "store_redemption") {
      if (!cfg.announcementChannelId) return res(200, { skipped: "No announcement channel configured" });
      await discordPost(`/channels/${cfg.announcementChannelId}/messages`, {
        embeds: [buildRedemptionEmbed(data)],
      });
    }

    return res(200, { success: true });
  } catch (err) {
    return res(500, { error: err.message });
  }
};
