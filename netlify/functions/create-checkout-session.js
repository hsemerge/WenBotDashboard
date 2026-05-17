// POST /api/create-checkout-session
// Creates a Stripe Checkout session for a paid plan
// Requires Firebase ID token in Authorization header

const admin = require("firebase-admin");
const crypto = require("crypto");

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

const PLAN_PRICES = {
  pro:    process.env.STRIPE_PRICE_PRO,
  elite:  process.env.STRIPE_PRICE_ELITE,
  agency: process.env.STRIPE_PRICE_AGENCY,
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const authHeader = event.headers["authorization"] || "";
  const idToken = authHeader.replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const targetPlan = body.targetPlan;
  if (!targetPlan || !PLAN_PRICES[targetPlan]) {
    return res(400, { error: `Invalid or missing targetPlan. Must be one of: ${Object.keys(PLAN_PRICES).join(", ")}` });
  }

  let uid, existingCustomerId;
  try {
    const db       = getDb();
    const decoded  = await admin.auth().verifyIdToken(idToken);
    uid            = decoded.uid;
    // Reuse existing Stripe customer if present (avoids duplicate customers)
    const profSnap = await db.collection("streamers").doc(uid).get();
    existingCustomerId = profSnap.exists ? profSnap.data().stripeCustomerId : null;
  } catch {
    return res(401, { error: "Invalid token" });
  }

  const priceId = PLAN_PRICES[targetPlan];
  if (!priceId) return res(400, { error: `No Stripe price configured for plan: ${targetPlan}` });

  const siteUrl  = process.env.URL || "https://wenbot.gg";
  const fromDash = body.fromDashboard === true;
  const successUrl = fromDash
    ? `${siteUrl}/dashboard.html?stripe=success&plan=${targetPlan}`
    : `${siteUrl}/setup.html?stripe=success`;
  const cancelUrl  = fromDash ? `${siteUrl}/dashboard.html` : `${siteUrl}/setup.html`;

  const authHeader64 = Buffer.from(process.env.STRIPE_SECRET_KEY + ":").toString("base64");

  try {
    const params = new URLSearchParams({
      "mode":                    "subscription",
      "payment_method_types[]":  "card",
      "line_items[0][price]":    priceId,
      "line_items[0][quantity]": "1",
      "success_url":             successUrl,
      "cancel_url":              cancelUrl,
      "client_reference_id":     uid,
      "metadata[uid]":           uid,
      "metadata[plan]":          targetPlan,
    });
    if (existingCustomerId) params.set("customer", existingCustomerId);

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "Authorization": `Basic ${authHeader64}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) return res(500, { error: session.error?.message || "Stripe error" });
    return res(200, { url: session.url });
  } catch (err) {
    return res(500, { error: err.message });
  }
};
