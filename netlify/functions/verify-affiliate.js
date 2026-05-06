// POST /api/verify-affiliate
// Body: { channel, kickUsername, affiliateUsername }
// Looks up streamer by channel, calls their affiliate API, saves verification

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
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

async function lookupAffiliate(provider, apiKey, affiliateUsername) {
  if (provider === "gambulls") {
    const resp = await fetch(
      "https://api.gambulls.com/api/public/streamer/leaderboard?type=monthly&limit=200",
      { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.success || !data.responseObject?.rankings) return null;
    const match = data.responseObject.rankings.find(
      e => (e.user?.name || "").toLowerCase() === affiliateUsername.toLowerCase()
    );
    return match ? { username: match.user.name, wagerAmount: match.wagerAmount || 0 } : null;
  }

  if (provider === "csbattle") {
    const resp = await fetch(
      `https://api.csbattle.com/leaderboards/affiliates/${apiKey}?from=2025-01-01%2000:00:00&to=2030-12-31%2023:59:59&limit=200`,
      { headers: { "Accept": "application/json" } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data)) return null;
    const match = data.find(
      e => (e.username || e.name || "").toLowerCase() === affiliateUsername.toLowerCase()
    );
    return match ? { username: match.username || match.name, wagerAmount: match.wagered || match.amount || 0 } : null;
  }

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, kickUsername, affiliateUsername } = body;
  if (!channel || !kickUsername || !affiliateUsername) {
    return res(400, { error: "Missing channel, kickUsername, or affiliateUsername" });
  }

  try {
    const db = getDb();

    // Find streamer by channel
    const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const streamerDoc = snap.docs[0];
    const streamerUid = streamerDoc.id;
    const streamerData = streamerDoc.data();
    const provider = streamerData.activeProvider || "gambulls";

    // Get API key
    const providerDoc = await db.collection("streamers").doc(streamerUid)
      .collection("providers").doc(provider).get();
    if (!providerDoc.exists) return res(400, { error: "Streamer has no affiliate provider configured" });
    const { apiKey } = providerDoc.data();

    // Check if affiliate username already claimed by different Kick user
    const kickKey      = kickUsername.toLowerCase();
    const affiliateKey = affiliateUsername.toLowerCase();

    const claimSnap = await db.collection("streamers").doc(streamerUid)
      .collection("verified_users").where("providerUsername_lower", "==", affiliateKey).limit(1).get();

    if (!claimSnap.empty && claimSnap.docs[0].id !== kickKey) {
      return res(409, { error: `"${affiliateUsername}" is already linked to another account. Contact a mod if this is an error.` });
    }

    // Validate against affiliate API
    const result = await lookupAffiliate(provider, apiKey, affiliateUsername);
    if (!result) {
      return res(404, { error: `"${affiliateUsername}" was not found on the ${provider} leaderboard for this channel. Make sure you're using your exact ${provider} username.` });
    }

    // Save verification — store identity only, NOT wager (wager is always read live)
    await db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(kickKey).set({
        kickName:              kickUsername,
        providerUsername:      result.username,
        providerUsername_lower: affiliateKey,
        provider,
        verifiedAt:            Date.now(),
      });

    return res(200, {
      success: true,
      kickUsername,
      affiliateUsername: result.username,
      provider,
    });

  } catch (err) {
    return res(500, { error: err.message });
  }
};
