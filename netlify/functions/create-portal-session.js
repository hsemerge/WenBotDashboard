// POST /api/create-portal-session
// Creates a Stripe Customer Portal session so users can manage/cancel their subscription.
// Requires Firebase ID token in Authorization header.

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
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const authHeader = event.headers["authorization"] || "";
  const idToken    = authHeader.replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let uid, stripeCustomerId;
  try {
    const db      = getDb();
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid           = decoded.uid;
    const snap    = await db.collection("streamers").doc(uid).get();
    stripeCustomerId = snap.exists ? snap.data().stripeCustomerId : null;
  } catch {
    return res(401, { error: "Invalid token" });
  }

  if (!stripeCustomerId) {
    return res(400, { error: "No active subscription found. Please subscribe first." });
  }

  const siteUrl = process.env.URL || "https://wenbot.gg";

  try {
    const stripeRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(process.env.STRIPE_SECRET_KEY + ":").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "customer":    stripeCustomerId,
        "return_url":  `${siteUrl}/dashboard.html`,
      }).toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) return res(500, { error: session.error?.message || "Stripe error" });
    return res(200, { url: session.url });
  } catch (err) {
    return res(500, { error: err.message });
  }
};
