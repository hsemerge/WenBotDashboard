// GET /api/discord-channels
// Returns text channels for the streamer's connected Discord guild
// Auth: Firebase ID token in Authorization header

const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '
'),
      }),
    });
  }
  return admin.firestore();
}

function res(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

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
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}` },
    });
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Discord API ${r.status}: ${err}`);
    }
    const all = await r.json();
    // type 0 = GUILD_TEXT, type 5 = GUILD_ANNOUNCEMENT
    const text = all
      .filter(c => c.type === 0 || c.type === 5)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map(c => ({ id: c.id, name: c.name, type: c.type }));

    return res(200, { channels: text, guildId });
  } catch (e) {
    return res(500, { error: e.message });
  }
};
