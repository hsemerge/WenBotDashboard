// POST /api/stripe-webhook
// Handles Stripe webhook events — updates Firestore when subscription state changes.
// Must be called with raw body (no JSON parsing) for signature verification.

const { getDb, admin } = require("./_lib/firebase");
const crypto           = require("crypto");

// Map Stripe Price IDs → plan names (populated from env vars at runtime)
function getPricePlanMap() {
  return {
    [process.env.STRIPE_PRICE_PRO]:    "pro",
    [process.env.STRIPE_PRICE_ELITE]:  "elite",
    [process.env.STRIPE_PRICE_AGENCY]: "agency",
  };
}

function verifyStripeSignature(rawBody, signature, secret) {
  try {
    const parts     = Object.fromEntries(signature.split(",").map(p => p.split("=")));
    const timestamp = parts.t;
    const expected  = parts.v1;
    if (!timestamp || !expected) return false;
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
    const payload  = `${timestamp}.${rawBody}`;
    const computed = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const a = Buffer.from(computed);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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
      const ref  = db.collection("streamers").doc(uid);
      const cur  = await ref.get();
      const manual = cur.exists && cur.data().planManual === true;
      const update = {
        stripeSubscriptionActive: true,
        stripeCustomerId:         session.customer,
        stripeSubscriptionId:     session.subscription,
        stripeActivatedAt: Date.now(),
      };
      if (!manual) update.plan = plan; // admin comp overrides Stripe's plan
      await ref.set(update, { merge: true });
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
      const manual = snap.docs[0].data().planManual === true;
      const update = { stripeSubscriptionActive: isActive };
      if (!manual) {                       // don't touch a comped plan
        if (newPlan) update.plan = newPlan;
        if (!isActive) update.plan = "starter";
      }
      if (sub.current_period_end) update.stripePeriodEnd = sub.current_period_end * 1000;
      await snap.docs[0].ref.set(update, { merge: true });
    }
  }

  // ── Subscription cancelled → downgrade to starter ──────────────────────────
  if (stripeEvent.type === "customer.subscription.deleted") {
    const sub  = stripeEvent.data.object;
    const snap = await db.collection("streamers")
      .where("stripeSubscriptionId", "==", sub.id).limit(1).get();
    if (!snap.empty) {
      const manual = snap.docs[0].data().planManual === true;
      const update = { stripeSubscriptionActive: false };
      if (!manual) update.plan = "starter"; // keep a comped plan through cancellation
      await snap.docs[0].ref.set(update, { merge: true });
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
      const ref = snap.docs[0].ref;
      const periodEnd = invoice.lines?.data?.[0]?.period?.end;
      const update = { stripePaymentFailed: false };
      if (periodEnd) update.stripePeriodEnd = periodEnd * 1000;
      await ref.set(update, { merge: true });

      // Record the payment + maintain running totals (for the admin revenue view
      // and future referral rewards). Idempotent by invoice id: the payment doc is
      // keyed on it, and the running totals only increment when the doc is new — so
      // Stripe redelivering the same event can't double-count.
      const invoiceId = invoice.id;
      const amount    = (invoice.amount_paid || 0) / 100; // cents → currency units
      if (invoiceId && amount > 0) {
        const payRef  = ref.collection("payments").doc(invoiceId);
        const priceId = invoice.lines?.data?.[0]?.price?.id;
        const plan    = getPricePlanMap()[priceId] || null;
        const paidAtMs = (invoice.status_transitions?.paid_at || invoice.created || Math.floor(Date.now() / 1000)) * 1000;
        const d  = new Date(paidAtMs);
        const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        try {
          await db.runTransaction(async (tx) => {
            const existing = await tx.get(payRef);
            tx.set(payRef, {
              invoiceId,
              amount,
              currency:         invoice.currency || "usd",
              plan,
              paidAt:           paidAtMs,
              month:            ym,
              periodStart:      invoice.lines?.data?.[0]?.period?.start ? invoice.lines.data[0].period.start * 1000 : null,
              periodEnd:        periodEnd ? periodEnd * 1000 : null,
              hostedInvoiceUrl: invoice.hosted_invoice_url || null,
            }, { merge: true });
            if (!existing.exists) {
              tx.set(ref, {
                totalPaid:     admin.firestore.FieldValue.increment(amount),
                paymentCount:  admin.firestore.FieldValue.increment(1),
                lastPaymentAt: Date.now(),
              }, { merge: true });
            }
          });
        } catch (err) {
          console.error("[stripe-webhook] payment record failed:", err.message);
        }
      }
    }
  }

  return { statusCode: 200, body: "ok" };
};
