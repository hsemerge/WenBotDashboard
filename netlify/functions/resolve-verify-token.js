// GET /api/resolve-verify-token?token=abc&channel=xyz
// Returns the kickUsername locked to a token so verify.html can display it.
// Does NOT consume the token — consumption happens in verify-affiliate.

const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    const raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
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

  const { token, channel } = event.queryStringParameters || {};
  if (!token || !channel) return res(400, { error: "Missing token or channel" });

  try {
    const db = getDb();

    const streamerSnap = await db.collection("streamers")
      .where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });

    const streamerUid = streamerSnap.docs[0].id;
    const tokenDoc    = await db.collection("streamers").doc(streamerUid)
      .collection("verify_tokens").doc(token).get();

    if (!tokenDoc.exists) return res(404, { error: "Invalid or expired verification link." });

    const { kickUsername, expiresAt, used } = tokenDoc.data();

    if (used)                    return res(410, { error: "This verification link has already been used." });
    if (Date.now() > expiresAt)  return res(410, { error: "This verification link has expired. Type !verify in chat to get a new one." });

    return res(200, { kickUsername });
  } catch (err) {
    return res(500, { error: err.message });
  }
};
