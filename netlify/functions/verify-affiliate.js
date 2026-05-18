// POST /api/verify-affiliate
// Body: { channel, kickUsername, affiliateUsername, casino }
// Verifies a viewer's casino account.
// Kick-chat flow: saves a pending_confirmation and returns a confirm code — bot finalizes on !confirm.
// Discord flow: saves directly to verified_users (Discord OAuth already proves identity).

const admin  = require("firebase-admin");
const crypto = require("crypto");

// Casinos with live API verification
const API_CASINOS = new Set(["gambulls"]);

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
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

// Simple Firestore-backed rate limiter: maxReqs per windowSecs per IP
async function checkRateLimit(db, ip, bucket, maxReqs = 20, windowSecs = 60) {
  const key = `${bucket}_${(ip || 'unknown').replace(/[^a-z0-9]/gi, '_').slice(0, 64)}`;
  const ref  = db.collection('_rate_limits').doc(key);
  const now  = Date.now();
  try {
    const allowed = await db.runTransaction(async txn => {
      const doc   = await txn.get(ref);
      const d     = doc.exists ? doc.data() : {};
      const reset = d.resetAt || 0;
      const count = reset > now ? (d.count || 0) : 0;
      if (count >= maxReqs) return false;
      txn.set(ref, { count: count + 1, resetAt: reset > now ? reset : now + windowSecs * 1000 });
      return true;
    });
    return allowed;
  } catch {
    return true; // fail open on Firestore error
  }
}

function res(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://wenbot.gg" },
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

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "verify", 10, 60))) {
    return res(429, { error: "Too many requests. Please wait a moment and try again." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, token, dtoken, affiliateUsername, casino, kickUsername: bodyKickUsername, kickAccessToken } = body;
  if (!channel || (!token && !dtoken) || !affiliateUsername) {
    return res(400, { error: "Missing channel, token, or affiliateUsername" });
  }
  // dtoken path requires an explicit Kick username from the form
  if (dtoken && !bodyKickUsername) {
    return res(400, { error: "Missing kickUsername" });
  }

  const provider = (casino || "gambulls").toLowerCase();
  if (!CASINO_NAMES[provider]) {
    return res(400, { error: "Unsupported casino." });
  }

  try {
    const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const streamerDoc  = snap.docs[0];
    const streamerUid  = streamerDoc.id;
    const streamerData = streamerDoc.data();

    // Resolve and consume the one-time token
    let kickUsername;
    let discordUserId   = null;
    let discordUsername = null;

    if (token) {
      // Kick-chat initiated: token proves Kick identity, kickUsername is server-resolved
      const tokenRef = db.collection("streamers").doc(streamerUid)
        .collection("verify_tokens").doc(token);

      await db.runTransaction(async (txn) => {
        const tokenDoc = await txn.get(tokenRef);
        if (!tokenDoc.exists)          throw Object.assign(new Error("Invalid or expired verification link."), { status: 404 });
        const td = tokenDoc.data();
        if (td.used)                   throw Object.assign(new Error("This verification link has already been used."), { status: 410 });
        if (Date.now() > td.expiresAt) throw Object.assign(new Error("This verification link has expired. Type !verify in chat to get a new one."), { status: 410 });
        kickUsername = td.kickUsername;
        txn.update(tokenRef, { used: true });
      });

      // Require Kick OAuth — validate the provided access_token matches this token's kickUsername
      if (!kickAccessToken) {
        throw Object.assign(new Error("Kick identity verification required. Please use the 'Connect with Kick' button on the verification page."), { status: 401 });
      }
      const kickApiResp = await fetch("https://api.kick.com/public/v1/users", {
        headers: { "Authorization": `Bearer ${kickAccessToken}` },
      });
      if (!kickApiResp.ok) throw Object.assign(new Error("Could not verify your Kick identity. Please try again."), { status: 401 });
      const kickApiData = await kickApiResp.json();
      const kickApiUser = kickApiData.data?.[0];
      if (!kickApiUser) throw Object.assign(new Error("Could not verify your Kick identity."), { status: 401 });
      if (kickApiUser.name.toLowerCase() !== kickUsername.toLowerCase()) {
        throw Object.assign(new Error("This verification link belongs to a different Kick account. Please use your own link from chat."), { status: 403 });
      }

    } else {
      // Discord-initiated: dtoken proves Discord identity, kickUsername is self-reported
      const dtokenRef = db.collection("discord_verify_tokens").doc(dtoken);

      await db.runTransaction(async (txn) => {
        const dtokenDoc = await txn.get(dtokenRef);
        if (!dtokenDoc.exists)          throw Object.assign(new Error("Invalid or expired verification link."), { status: 404 });
        const td = dtokenDoc.data();
        if (td.used)                    throw Object.assign(new Error("This verification link has already been used."), { status: 410 });
        if (Date.now() > td.expiresAt)  throw Object.assign(new Error("This verification link has expired. Use /register in Discord to get a new one."), { status: 410 });
        discordUserId   = td.discordUserId;
        discordUsername = td.discordUsername;
        txn.update(dtokenRef, { used: true });
      });

      kickUsername = bodyKickUsername.trim();
    }

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

    let resultUsername  = affiliateUsername;
    let underAffiliate  = false;

    if (API_CASINOS.has(provider)) {
      // Full API verification against streamer's leaderboard
      const providerDoc = await db.collection("streamers").doc(streamerUid)
        .collection("providers").doc(provider).get();
      if (!providerDoc.exists) {
        return res(400, { error: `This streamer hasn't configured their ${CASINO_NAMES[provider]} API yet.` });
      }
      const { apiKey } = providerDoc.data();
      const result = await lookupAffiliate(provider, apiKey, affiliateUsername);
      if (result) {
        resultUsername = result.username;
        underAffiliate = true;
      }
      // Not found on leaderboard = not under affiliate code, but still save as verified
    } else {
      // Honor-system casino — no API check, username taken at face value
      underAffiliate = false;
    }

    const batch = db.batch();
    const newDocRef = db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(`${kickKey}_${provider}`);
    batch.set(newDocRef, {
      kickName:               kickUsername,
      providerUsername:       resultUsername,
      providerUsername_lower: affiliateKey,
      provider,
      apiVerified:            API_CASINOS.has(provider) && underAffiliate,
      underAffiliate,
      verifiedAt:             Date.now(),
    });
    // Clean up legacy docs that used just kickKey as doc ID (no _provider suffix)
    const legacyRef = db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(kickKey);
    const legacySnap = await legacyRef.get();
    if (legacySnap.exists) batch.delete(legacyRef);
    await batch.commit();

    // Discord-initiated flow: also save the discord_link
    if (discordUserId) {
      await db.collection("streamers").doc(streamerUid)
        .collection("discord_links").doc(discordUserId).set({
          kickUsername,
          discordUsername,
          linkedAt: Date.now(),
        });
    }

    return res(200, {
      success:          true,
      kickUsername,
      affiliateUsername: resultUsername,
      provider,
      casinoName:       CASINO_NAMES[provider],
      apiVerified:      API_CASINOS.has(provider) && underAffiliate,
      underAffiliate,
      discordLinked:    !!discordUserId,
      discordUsername:  discordUsername || null,
    });

  } catch (err) {
    return res(err.status || 500, { error: err.message });
  }
};
