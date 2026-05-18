// POST /api/discord-save-guild
// Called by discord-callback.html after Discord OAuth redirect
// Body: { guildId }  — auth via Firebase ID token in Authorization header
// Writes discordConfig.guildId to streamers/{uid} and discord_guilds/{guildId}

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const authHeader = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!authHeader) return res(401, { error: "Missing auth token" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }

  const { guildId } = body;
  if (!guildId) return res(400, { error: "Missing guildId" });

  const db = getDb();
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader);
    uid = decoded.uid;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  try {
    const profSnap = await db.collection("streamers").doc(uid).get();
    const existing = profSnap.exists ? (profSnap.data()?.discordConfig || {}) : {};
    const discordConfig = { ...existing, guildId, connectedAt: Date.now() };

    await db.collection("streamers").doc(uid).set({ discordConfig }, { merge: true });
    await db.collection("discord_guilds").doc(guildId).set({ uid, connectedAt: Date.now() }, { merge: true });

    return res(200, { success: true, guildId });
  } catch (e) {
    console.error("[discord-save-guild] error:", e.message);
    return res(500, { error: "Internal server error" });
  }
};
