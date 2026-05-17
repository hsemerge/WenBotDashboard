// POST /api/stripe-webhook
// Handles Stripe webhook events — updates Firestore when subscription state changes.
// Must be called with raw body (no JSON parsing) for signature verification.

const admin = require("firebase-admin");
const crypto = require("crypto");

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '
'),
      }),
    });
  }
  return admin.firestore();
}

// Map Stripe Price IDs → plan names (populated from env vars at runtime)
function getPricePlanMap() {
  return {
    [process.env.STRIPE_PRICE_PRO]:    "pro",
    [process.env.STRIPE_PRICE_ELITE]:  "elite",
    [process.env.STRIPE_PRICE_AGENCY]: "agency",
  };
}

function verifyStripeSignature(rawBody, signature, secret) {
  const parts     = Object.fromEntries(signature.split(",").map(p => p.split("=")));
  const timestamp = parts.t;
  const expected  = parts.v1;
  const payload   = `${timestamp}.${rawBody}`;
  const computed  = crypto.createHmac("sha256", secret).update(payload).digest("hex");
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

  const db = getDb();

  // ── Checkout completed → activate subscription ──────────────────────────────
  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object;
    const uid     = session.metadata?.uid || session.client_reference_id;
    const plan    = session.metadata?.plan;
    if (uid && plan) {
      await db.collection("streamers").doc(uid).set({
        stripeSubscriptionActive: true,
        stripeCustomerId:         session.customer,
        stripeSubscriptionId:     session.subscription,
        plan,
        stripeActivatedAt: Date.now(),
      }, { merge: true });
    }
  }

  // ── Subscription updated (upgrade/downgrade via portal) ────────────────────
  if (stripeEvent.type === "customer.subscription.updated") {
    const sub      = stripeEvent.data.object;
    const priceId  = sub.items?.data?.[0]?.price?.id;
    const planMap  = getPricePlanMap();
    const newPlan  = planMap[priceId];
    const isActive = sub.status === "active" || sub.status === "trialing";

    const snap = await db.collection("streamers")
      .where("stripeSubscriptionId", "==", sub.id).limit(1).get();
    if (!snap.empty) {
      const update = { stripeSubscriptionActive: isActive };
      if (newPlan) update.plan = newPlan;
      if (!isActive) update.plan = "starter";
      await snap.docs[0].ref.set(update, { merge: true });
    }
  }

  // ── Subscription cancelled → downgrade to starter ──────────────────────────
  if (stripeEvent.type === "customer.subscription.deleted") {
    const sub  = stripeEvent.data.object;
    const snap = await db.collection("streamers")
      .where("stripeSubscriptionId", "==", sub.id).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.set({
        stripeSubscriptionActive: false,
        plan: "starter",
      }, { merge: true });
    }
  }

  // ── Invoice payment failed → flag it ───────────────────────────────────────
  if (stripeEvent.type === "invoice.payment_failed") {
    const invoice = stripeEvent.data.object;
    const snap    = await db.collection("streamers")
      .where("stripeCustomerId", "==", invoice.customer).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.set({ stripePaymentFailed: true }, { merge: true });
    }
  }

  if (stripeEvent.type === "invoice.paid") {
    const invoice = stripeEvent.data.object;
    const snap    = await db.collection("streamers")
      .where("stripeCustomerId", "==", invoice.customer).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.set({ stripePaymentFailed: false }, { merge: true });
    }
  }

  return { statusCode: 200, body: "ok" };
};
