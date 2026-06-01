// GET /api/discord-channels
// Returns text channels for the streamer's connected Discord guild
// Auth: Firebase ID token in Authorization header

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET") return res(405, { error: "Method not allowed" });

  const authHeader = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!authHeader) return res(401, { error: "Missing auth token" });

  const db = getDb();
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader);
    uid = decoded.uid;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  const profSnap = await db.collection("streamers").doc(uid).get();
  if (!profSnap.exists) return res(404, { error: "Streamer not found" });

  const guildId = profSnap.data()?.discordConfig?.guildId;
  if (!guildId) return res(200, { channels: [], guildId: null });

  try {
    const auth = { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}` };
    const [chanResp, roleResp] = await Promise.all([
      fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers: auth }),
      fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`,    { headers: auth }),
    ]);
    if (!chanResp.ok) {
      const err = await chanResp.text();
      throw new Error(`Discord API ${chanResp.status}: ${err}`);
    }
    const all = await chanResp.json();
    // type 0 = GUILD_TEXT, type 5 = GUILD_ANNOUNCEMENT
    const text = all
      .filter(c => c.type === 0 || c.type === 5)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map(c => ({ id: c.id, name: c.name, type: c.type }));

    // Roles WenBot can assign: exclude @everyone (id === guildId) and bot/
    // integration-managed roles. Highest position first for nicer ordering.
    let roles = [];
    if (roleResp.ok) {
      const allRoles = await roleResp.json();
      roles = (Array.isArray(allRoles) ? allRoles : [])
        .filter(r => r.id !== guildId && !r.managed)
        .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
        .map(r => ({ id: r.id, name: r.name }));
    }

    return res(200, { channels: text, roles, guildId });
  } catch (e) {
    console.error("[discord-channels] error:", e.message);
    return res(500, { error: "Internal server error" });
  }
};
