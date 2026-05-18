// Stores WenBot's OAuth tokens in Firestore at system/wenbot (admin-only)
// Requires x-admin-key header matching WENBOT_ADMIN_KEY env var
// POST body: { access_token, refresh_token, expires_in }

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

exports.handler = async (event) => {
  const adminKey    = event.headers["x-admin-key"];
  const expectedKey = process.env.WENBOT_ADMIN_KEY;

  if (!adminKey || !expectedKey || adminKey !== expectedKey) {
    return res(401, { error: "Unauthorized" });
  }

  // GET — return whether tokens exist (used by /admin/wenbot-auth.html status probe)
  if (event.httpMethod === "GET") {
    try {
      const doc = await getDb().collection("system").doc("wenbot").get();
      const authenticated = doc.exists && !!doc.data().access_token;
      return res(200, { authenticated, expiresAt: doc.data()?.expires_at || null });
    } catch (err) {
      return res(500, { error: "Failed to check status: " + err.message });
    }
  }

  if (event.httpMethod !== "POST") {
    return res(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return res(400, { error: "Invalid JSON body" });
  }

  const { access_token, refresh_token, expires_in } = body;

  if (!access_token || !refresh_token) {
    return res(400, { error: "Missing access_token or refresh_token" });
  }

  const tokens = {
    access_token,
    refresh_token,
    expires_at: Date.now() + (parseInt(expires_in, 10) || 3600) * 1000,
    stored_at:  Date.now(),
  };

  try {
    const db = getDb();
    await db.collection("system").doc("wenbot").set(tokens);
    return res(200, { success: true, expires_at: tokens.expires_at });
  } catch (err) {
    return res(500, { error: "Failed to store tokens: " + err.message });
  }
};

function res(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
