// POST /api/verify-status
// Body: { channel, kickAccessToken }
//
// Lightweight pre-check the verify page hits AFTER Kick OAuth completes — lets
// us skip the casino-username form entirely when the viewer is already verified
// for the streamer's active casino. The full verify-affiliate.js flow does too
// much (rate limit, affiliate API call, writes) to repurpose for a passive
// status check, so this is its own minimal endpoint.

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, kickAccessToken } = body;
  if (!channel || !kickAccessToken) return res(400, { error: "Missing channel or kickAccessToken" });

  try {
    // Prove Kick identity — same path as verify-affiliate.js uses
    const kickApiResp = await fetch("https://api.kick.com/public/v1/users", {
      headers: { "Authorization": `Bearer ${kickAccessToken}` },
    });
    if (!kickApiResp.ok) return res(401, { error: "Kick identity check failed" });
    const kickData = await kickApiResp.json();
    const kickUser = kickData.data?.[0];
    if (!kickUser) return res(401, { error: "Kick identity check failed" });
    const kickUsername = kickUser.name;
    const kickKey      = kickUsername.toLowerCase();

    const db = getDb();
    const streamerSnap = await db.collection("streamers")
      .where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });
    const uid          = streamerSnap.docs[0].id;
    const streamerData = streamerSnap.docs[0].data();
    const activeProvider = streamerData.activeProvider || "gambulls";

    // Direct lookup by the known doc ID format — `${kickKey}_${provider}`
    const verifyRef = db.collection("streamers").doc(uid)
      .collection("verified_users").doc(`${kickKey}_${activeProvider}`);
    const verifySnap = await verifyRef.get();

    // Does this Kick user already have ANY Discord link on this streamer?
    const discordSnap = await db.collection("streamers").doc(uid)
      .collection("discord_links")
      .where("kickUsername", "==", kickUsername).limit(1).get();

    if (!verifySnap.exists) {
      return res(200, {
        kickUsername,
        verified:     false,
        provider:     activeProvider,
        discordLinkedAny: !discordSnap.empty,
      });
    }

    const v = verifySnap.data();
    return res(200, {
      kickUsername,
      verified:         true,
      provider:         activeProvider,
      providerUsername: v.providerUsername || null,
      underAffiliate:   !!v.underAffiliate,
      discordLinkedAny: !discordSnap.empty,
    });
  } catch (err) {
    console.error("[verify-status] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
