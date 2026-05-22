// POST /api/kick-login
// Body: { code, code_verifier }
//
// "Sign in with Kick" — exchanges a Kick OAuth code, identifies the Kick user,
// finds the WenBot streamer account already linked to that Kick channel, and
// mints a Firebase custom token so the client can sign in via
// signInWithCustomToken().
//
// Only works for accounts that have ALREADY connected Kick (i.e. completed
// setup). If no streamer doc is linked to the Kick identity, returns 404 so
// the UI can nudge them to email login / signup.
//
// Custom tokens are signed locally with the service-account private key
// (FIREBASE_PRIVATE_KEY) — no extra IAM role needed.

const { getDb, admin }              = require("./_lib/firebase");
const { res: _res, checkRateLimit } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb(); // init Admin SDK before any admin.* call

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "kick_login", 10, 600))) {
    return res(429, { error: "Too many attempts. Please wait a moment." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { code, code_verifier } = body;
  if (!code || !code_verifier) {
    return res(400, { error: "Missing code or code_verifier" });
  }

  // 1. Exchange the Kick OAuth code for tokens (PKCE)
  let tokens;
  try {
    const tokenResp = await fetch("https://id.kick.com/oauth/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        code,
        client_id:     process.env.KICK_CLIENT_ID,
        client_secret: process.env.KICK_CLIENT_SECRET,
        redirect_uri:  "https://wenbot.gg/auth/kick/callback.html",
        code_verifier,
      }),
    });
    tokens = await tokenResp.json();
    if (!tokenResp.ok) return res(400, { error: "Kick sign-in failed. Please try again." });
  } catch (err) {
    console.error("[kick-login] token exchange error:", err.message);
    return res(500, { error: "Kick sign-in failed. Please try again." });
  }

  // 2. Fetch the Kick profile (proves identity)
  let kickUser;
  try {
    const userResp = await fetch("https://api.kick.com/public/v1/users", {
      headers: { "Authorization": `Bearer ${tokens.access_token}` },
    });
    const userData = await userResp.json();
    if (!userResp.ok) return res(400, { error: "Could not read your Kick profile." });
    kickUser = userData.data?.[0];
    if (!kickUser) return res(400, { error: "No Kick profile returned." });
  } catch (err) {
    console.error("[kick-login] profile fetch error:", err.message);
    return res(500, { error: "Could not read your Kick profile." });
  }

  // 3. Find the streamer account linked to this Kick identity. Check both
  //    kickUserId and kickChannel (the latter is the reliable lowercase key).
  try {
    const channelLower = (kickUser.name || "").toLowerCase();
    const [byUserId, byChannel] = await Promise.all([
      db.collection("streamers").where("kickUserId", "==", String(kickUser.user_id)).get(),
      channelLower
        ? db.collection("streamers").where("kickChannel", "==", channelLower).get()
        : Promise.resolve({ docs: [] }),
    ]);
    const match = (byUserId.docs || [])[0] || (byChannel.docs || [])[0];
    if (!match) {
      return res(404, {
        error: "No WenBot account is linked to this Kick channel yet. Sign in with your email, or sign up to get started.",
      });
    }

    // 4. Mint a Firebase custom token for that account's UID
    const customToken = await admin.auth().createCustomToken(match.id);
    return res(200, { customToken });

  } catch (err) {
    console.error("[kick-login] error:", err.message);
    return res(500, { error: "Sign-in failed. Please try again." });
  }
};
