// POST /api/discord-post-gate
// Posts (or refreshes) the verification "gate" message with a Verify link button
// into the streamer's configured channel. Auth: Firebase ID token.
//
// The button is a Discord LINK button to the verify page, so no interaction
// handling is needed — the existing verify flow (Kick + casino + Discord link +
// role assignment) does the rest.

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const authHeader = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!authHeader) return res(401, { error: "Missing auth token" });

  const db = getDb();
  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(authHeader)).uid;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  const profSnap = await db.collection("streamers").doc(uid).get();
  if (!profSnap.exists) return res(404, { error: "Streamer not found" });
  const data = profSnap.data() || {};

  const channelName = (data.kickChannel || "").toLowerCase();
  const casino      = (data.activeProvider || "").toLowerCase();
  const verify      = data.discordConfig?.verify || {};
  const channelId   = verify.gateChannelId;
  if (!channelId) return res(400, { error: "No verification channel set. Pick one and save first." });
  // Never post a gate that points at the wrong casino — require it to be set.
  if (!casino) return res(400, { error: "Set your casino in Settings before posting the verification gate." });

  // src=discord tells the verify page the user is already in the server, so it
  // skips the "join the server?" step and just links + assigns the role. The
  // casino param ensures the verify page reflects THIS streamer's casino.
  const verifyUrl = `https://wenbot.gg/verify.html?channel=${encodeURIComponent(channelName)}&casino=${encodeURIComponent(casino)}&src=discord`;
  const body = {
    content: verify.gateMessage ||
      "🛡️ **Verify to unlock the server**\n\nClick **Verify** below, connect your Kick + casino, and you'll be granted access.",
    components: [{
      type: 1,
      components: [{ type: 2, style: 5, label: "✅ Verify", url: verifyUrl }],
    }],
  };

  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method:  "POST",
      headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("[discord-post-gate] post failed:", r.status, t.slice(0, 200));
      return res(502, { error: `Couldn't post to that channel (Discord ${r.status}). Check WenBot can send messages there.` });
    }
    return res(200, { success: true });
  } catch (e) {
    console.error("[discord-post-gate] error:", e.message);
    return res(500, { error: "Internal server error" });
  }
};
