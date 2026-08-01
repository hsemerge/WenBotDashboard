// POST /api/discord-save-guild
// Called by discord-callback.html after Discord OAuth redirect
// Body: { guildId, uid? }  — auth via Firebase ID token in Authorization header.
// uid lets a moderator / agency admin (delegatedFor claim) connect the server
// to the MANAGED account instead of their own.
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
    const requested = body.uid || decoded.uid;
    const delegated = Array.isArray(decoded.delegatedFor) && decoded.delegatedFor.includes(requested);
    if (requested !== decoded.uid && !delegated) {
      return res(403, { error: "You don't have access to that account." });
    }
    uid = requested;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  try {
    const profSnap = await db.collection("streamers").doc(uid).get();
    const existing = profSnap.exists ? (profSnap.data()?.discordConfig || {}) : {};
    const discordConfig = { ...existing, guildId, connectedAt: Date.now() };

    await db.collection("streamers").doc(uid).set({ discordConfig }, { merge: true });

    // APPEND, never overwrite. This used to `set({ uid })`, so when a second
    // streamer linked the same server the first was silently replaced — their
    // Discord integration would stop resolving with no error anywhere. That
    // matters now that several streamers share one server.
    //
    // `uids` is the real list; `uid` is kept in sync as uids[0] so the many
    // existing single-streamer readers keep working untouched.
    const gRef = db.collection("discord_guilds").doc(guildId);
    const linked = await db.runTransaction(async (tx) => {
      const snap = await tx.get(gRef);
      const cur  = snap.exists ? snap.data() : {};
      // Legacy docs only have `uid`; treat that as a one-element list.
      const uids = Array.isArray(cur.uids) ? [...cur.uids] : (cur.uid ? [cur.uid] : []);
      if (!uids.includes(uid)) uids.push(uid);
      tx.set(gRef, { uid: uids[0], uids, connectedAt: Date.now() }, { merge: true });
      return uids;
    });

    return res(200, {
      success: true,
      guildId,
      // Lets the dashboard tell the streamer they're sharing a server, which is
      // when channel-level setup starts to matter.
      streamersInGuild: linked.length,
      sharedGuild: linked.length > 1,
    });
  } catch (e) {
    console.error("[discord-save-guild] error:", e.message);
    return res(500, { error: "Internal server error" });
  }
};
