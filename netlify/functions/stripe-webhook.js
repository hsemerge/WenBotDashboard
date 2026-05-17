// POST /api/stripe-webhook
// Handles Stripe webhook events — updates Firestore when payment is confirmed
// Must be called with raw body (no JSON parsing) for signature verification

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

function verifyStripeSignature(rawBody, signature, secret) {
  const parts     = Object.fromEntries(signature.split(",").map(p => p.split("=")));
  const timestamp = parts.t;
  const expected  = parts.v1;
  const payload   = `${timestamp}.${rawBody}`;
  const computed  = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // Allow 5 min clock skew
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const sig    = event.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !secret) return { statusCode: 400, body: "Missing signature config" };

  let stripeEvent;
  try {
    if (!verifyStripeSignature(event.body, sig, secret)) {
      return { statusCode: 400, body: "Invalid signature" };
    }
    stripeEvent = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: "Bad request: " + err.message };
  }

  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object;
    const uid     = session.metadata?.uid || session.client_reference_id;
    const plan    = session.metadata?.plan;

    if (uid) {
      const db = getDb();
      await db.collection("streamers").doc(uid).set({
        stripeSubscriptionActive: true,
        stripeCustomerId:         session.customer,
        stripeSubscriptionId:     session.subscription,
        plan:                     plan || "pro",
        stripeActivatedAt:        Date.now(),
      }, { merge: true });
    }
  }

  if (stripeEvent.type === "customer.subscription.deleted") {
    const sub = stripeEvent.data.object;
    // Find streamer by subscription ID and deactivate
    const db   = getDb();
    const snap = await db.collection("streamers")
      .where("stripeSubscriptionId", "==", sub.id).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.set({
        stripeSubscriptionActive: false,
        plan: "starter",
      }, { merge: true });
    }
  }

  return { statusCode: 200, body: "ok" };
};
