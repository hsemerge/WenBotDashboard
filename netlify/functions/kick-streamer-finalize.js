// POST /api/kick-streamer-finalize
// Server-side Kick OAuth finalize for the streamer connect flow.
// Replaces client-side token writes (now blocked by Firestore rules).
//
// Body: { code, code_verifier, idToken }
//   code, code_verifier — from Kick OAuth callback (PKCE)
//   idToken             — Firebase Auth ID token of the logged-in streamer
//
// Flow: verify Firebase identity → exchange Kick code for tokens →
//       fetch Kick user profile → write everything to streamer doc via admin SDK.
//
// Returns: { success: true, kickUsername, kickAvatar } — tokens never returned to client.

const admin = require("firebase-admin");

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

function res(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { code, code_verifier, idToken } = body;
  if (!code || !code_verifier || !idToken) {
    return res(400, { error: "Missing code, code_verifier, or idToken" });
  }

  // 1. Verify Firebase identity — proves this request is from an authenticated streamer
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return res(401, { error: "Invalid Firebase auth token" });
  }

  // 2. Exchange Kick OAuth code for access + refresh tokens
  const tokenParams = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    client_id:     process.env.KICK_CLIENT_ID,
    client_secret: process.env.KICK_CLIENT_SECRET,
    redirect_uri:  "https://wenbot.netlify.app/auth/kick/callback.html",
    code_verifier,
  });

  let tokens;
  try {
    const tokenResp = await fetch("https://id.kick.com/oauth/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    tokenParams,
    });
    tokens = await tokenResp.json();
    if (!tokenResp.ok) {
      return res(400, { error: "Kick token exchange failed", details: tokens });
    }
  } catch (err) {
    return res(500, { error: "Token exchange error: " + err.message });
  }

  // 3. Fetch Kick user profile (proves Kick identity)
  let kickUser;
  try {
    const userResp = await fetch("https://api.kick.com/public/v1/users", {
      headers: { "Authorization": `Bearer ${tokens.access_token}` },
    });
    const userData = await userResp.json();
    if (!userResp.ok)            return res(400, { error: "Failed to fetch Kick profile" });
    kickUser = userData.data?.[0];
    if (!kickUser)               return res(400, { error: "No Kick user data returned" });
  } catch (err) {
    return res(500, { error: "Kick profile error: " + err.message });
  }

  // 4. Store via admin SDK (bypasses client-side write rules on protected fields)
  try {
    await getDb().collection("streamers").doc(uid).set({
      kickUserId:         String(kickUser.user_id),
      kickUsername:       kickUser.name,
      kickEmail:          kickUser.email || null,
      kickAvatar:         kickUser.profile_picture || null,
      kickAccessToken:    tokens.access_token,
      kickRefreshToken:   tokens.refresh_token,
      kickTokenExpiresAt: Date.now() + (tokens.expires_in * 1000),
      kickChannel:        (kickUser.name || "").toLowerCase(),
      kickConnectedAt:    Date.now(),
    }, { merge: true });
  } catch (err) {
    return res(500, { error: "Failed to save connection: " + err.message });
  }

  // Return only non-sensitive identity info — tokens never leave the server
  return res(200, {
    success:      true,
    kickUsername: kickUser.name,
    kickAvatar:   kickUser.profile_picture || null,
  });
};
