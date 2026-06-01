// GET /api/discord-guild-info?channel=xxx
// Returns the streamer's Discord server name + icon so the verify page can show
// the user which server they're about to join. Public, read-only.

const { getDb }     = require("./_lib/firebase");
const { res: _res } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing channel" });

  try {
    const db   = getDb();
    const snap = await db.collection("streamers").where("kickChannel", "==", channel).limit(1).get();
    if (snap.empty) return res(200, { guildId: null });

    const guildId = snap.docs[0].data()?.discordConfig?.guildId || null;
    if (!guildId) return res(200, { guildId: null });

    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}` },
    });
    if (!r.ok) return res(200, { guildId, name: null, iconUrl: null });

    const g = await r.json();
    const iconUrl = g.icon ? `https://cdn.discordapp.com/icons/${guildId}/${g.icon}.png?size=128` : null;
    return res(200, { guildId, name: g.name || null, iconUrl });
  } catch (e) {
    console.error("[discord-guild-info] error:", e.message);
    return res(500, { error: "Internal server error" });
  }
};
