// POST /api/verify-affiliate
// Body: { channel, kickUsername, affiliateUsername, casino }
// Verifies a viewer's casino account and saves it to verified_users

const admin = require("firebase-admin");

// Casinos with live API verification
const API_CASINOS = new Set(["gambulls", "csbattle"]);

// Display names for all supported casinos
const CASINO_NAMES = {
  gambulls:   "Gambulls",
  stake:      "Stake",
  rainbet:    "Rainbet",
  thrill:     "Thrill",
  winna:      "Winna",
  shuffle:    "Shuffle",
  duel:       "Duel",
  roobet:     "Roobet",
  bcgame:     "BC.Game",
  "500casino":"500 Casino",
  gamdom:     "Gamdom",
  duelbits:   "Duelbits",
  rollbit:    "Rollbit",
  chipsgg:    "Chips.gg",
};

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

// API-backed lookup — returns { username, wagerAmount } or null
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

  const { channel, kickUsername, affiliateUsername, casino } = body;
  if (!channel || !kickUsername || !affiliateUsername) {
    return res(400, { error: "Missing channel, kickUsername, or affiliateUsername" });
  }

  const provider = (casino || "gambulls").toLowerCase();
  if (!CASINO_NAMES[provider]) {
    return res(400, { error: "Unsupported casino." });
  }

  try {
    const db = getDb();

    const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const streamerDoc  = snap.docs[0];
    const streamerUid  = streamerDoc.id;
    const streamerData = streamerDoc.data();

    const kickKey      = kickUsername.toLowerCase();
    const affiliateKey = affiliateUsername.toLowerCase();

    // Check the active casino matches what the streamer is currently streaming at
    const activeProvider = streamerData.activeProvider || "gambulls";
    if (provider !== activeProvider) {
      const activeName = CASINO_NAMES[activeProvider] || activeProvider;
      return res(400, { error: `This streamer is currently streaming at ${activeName}. Please verify your ${activeName} username instead.` });
    }

    // Check if this casino username is already claimed by a different Kick account
    const claimSnap = await db.collection("streamers").doc(streamerUid)
      .collection("verified_users")
      .where("providerUsername_lower", "==", affiliateKey)
      .where("provider", "==", provider)
      .limit(1).get();

    if (!claimSnap.empty && claimSnap.docs[0].id !== kickKey) {
      return res(409, { error: `"${affiliateUsername}" is already linked to another Kick account. Contact a mod if this is an error.` });
    }

    let resultUsername = affiliateUsername;

    if (API_CASINOS.has(provider)) {
      // Full API verification
      const providerDoc = await db.collection("streamers").doc(streamerUid)
        .collection("providers").doc(provider).get();
      if (!providerDoc.exists) {
        return res(400, { error: `This streamer hasn't configured their ${CASINO_NAMES[provider]} API yet.` });
      }
      const { apiKey } = providerDoc.data();
      const result = await lookupAffiliate(provider, apiKey, affiliateUsername);
      if (!result) {
        return res(404, { error: `"${affiliateUsername}" was not found on the ${CASINO_NAMES[provider]} leaderboard for this channel. Make sure you're using your exact ${CASINO_NAMES[provider]} username.` });
      }
      resultUsername = result.username;
    }
    // For honor-system casinos: save without API check — username taken at face value

    await db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(kickKey).set({
        kickName:               kickUsername,
        providerUsername:       resultUsername,
        providerUsername_lower: affiliateKey,
        provider,
        apiVerified:            API_CASINOS.has(provider),
        verifiedAt:             Date.now(),
      });

    return res(200, {
      success:          true,
      kickUsername,
      affiliateUsername: resultUsername,
      provider,
      casinoName:       CASINO_NAMES[provider],
      apiVerified:      API_CASINOS.has(provider),
    });

  } catch (err) {
    return res(500, { error: err.message });
  }
};
