// POST /api/kick-session-mint
// Body: { session, returnOrigin }
// Cross-domain viewer-session handoff (step 1 of 2). The Kick OAuth callback
// always runs on wenbot.gg (single registered redirect URI), but white-label
// portals live on their own domains (e.g. skslots.co.uk) which can't read
// wenbot.gg's localStorage. So after a viewer logs in on wenbot.gg, the callback
// calls this to stash the finished session under a random, single-use, 60s code,
// then redirects the viewer back to their custom domain with ?s=<code>. The
// custom-domain page claims it via /api/kick-session-claim.
//
// Security: returnOrigin MUST be a known white-label host (allowlist) so a
// tampered redirect can't exfiltrate a session to an attacker domain.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { getKickUser }         = require("./_lib/kick");
const crypto = require("crypto");

// White-label hosts allowed to receive a handed-off session. Mirrors
// HOST_TO_SLUG in netlify/edge-functions/custom-domain.js — keep in sync.
const ALLOWED_RETURN_HOSTS = new Set([
  "skslots.co.uk",
  "www.skslots.co.uk",
  "irishqueenoftheslots.com",
  "www.irishqueenoftheslots.com",
]);

const CODE_TTL_MS = 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "kick_session_mint", 20, 600))) {
    return res(429, { error: "Too many attempts. Please wait a moment." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { session, returnOrigin } = body;
  if (!session || !session.accessToken || !session.kickUsername || !returnOrigin) {
    return res(400, { error: "Missing session or returnOrigin" });
  }

  // Validate the return origin against the allowlist.
  let host;
  try { host = new URL(returnOrigin).host.toLowerCase(); }
  catch { return res(400, { error: "Invalid returnOrigin" }); }
  if (!ALLOWED_RETURN_HOSTS.has(host)) {
    return res(403, { error: "returnOrigin not allowed" });
  }

  // Verify the token is a genuine Kick token that belongs to the claimed user
  // BEFORE storing it in a handoff code. This stops forged/garbage tokens from
  // ever entering the codes collection and confirms the session is real.
  const kickLookup = await getKickUser(session.accessToken);
  if (kickLookup.error) return res(kickLookup.status, { error: kickLookup.error });
  if (kickLookup.user.name.toLowerCase() !== String(session.kickUsername).toLowerCase()) {
    return res(401, { error: "Token does not match the claimed user" });
  }

  const code = crypto.randomBytes(24).toString("hex");
  await db.collection("kick_session_codes").doc(code).set({
    session: {
      kickUsername: session.kickUsername,
      kickUserId:   session.kickUserId || null,
      accessToken:  session.accessToken,
      expiresAt:    session.expiresAt || (Date.now() + 3600 * 1000),
    },
    used:      false,
    expiresAt: Date.now() + CODE_TTL_MS,
    host,
  });

  return res(200, { code });
};
