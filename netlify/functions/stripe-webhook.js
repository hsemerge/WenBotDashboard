// POST /api/stripe-webhook
// Handles Stripe webhook events — updates Firestore when subscription state changes.
// Must be called with raw body (no JSON parsing) for signature verification.

const { getDb, admin } = require("./_lib/firebase");
const crypto           = require("crypto");

// Map Stripe Price IDs → plan names (populated from env vars at runtime)
function getPricePlanMap() {
  // Only map price ids that are actually configured. Spreading an unset env var
  // as a key produced a literal "undefined" entry, so ANY lookup that came back
  // undefined resolved to whichever plan sat last in the object — every payment
  // was being labelled "agency" because STRIPE_PRICE_AGENCY isn't set.
  const map = {};
  if (process.env.STRIPE_PRICE_PRO)    map[process.env.STRIPE_PRICE_PRO]    = "pro";
  if (process.env.STRIPE_PRICE_ELITE)  map[process.env.STRIPE_PRICE_ELITE]  = "elite";
  if (process.env.STRIPE_PRICE_AGENCY) map[process.env.STRIPE_PRICE_AGENCY] = "agency";
  return map;
}

// Where the price id lives depends on the API version: newer invoice lines carry
// it at pricing.price_details.price, older ones at price.id (and older still at
// plan.id). Reading only the old path returned undefined on current invoices.
function priceIdOf(lineOrItem) {
  if (!lineOrItem) return null;
  return (lineOrItem.pricing && lineOrItem.pricing.price_details && lineOrItem.pricing.price_details.price)
    || (lineOrItem.price && lineOrItem.price.id)
    || (lineOrItem.plan && lineOrItem.plan.id)
    || null;
}

// Record one payment + maintain running totals. Idempotent by invoice id: the
// payment doc is keyed on it and the running totals increment only when the doc
// is NEW — so the SAME payment arriving from both checkout.session.completed
// (which always resolves the streamer) and invoice.paid (renewals), or a Stripe
// redelivery, can never double-count.
async function recordPayment(db, ref, p) {
  if (!p.invoiceId || !(p.amount > 0)) return;
  const payRef = ref.collection("payments").doc(p.invoiceId);
  const d  = new Date(p.paidAtMs);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(payRef);
      tx.set(payRef, {
        invoiceId:        p.invoiceId,
        amount:           p.amount,
        currency:         p.currency || "usd",
        plan:             p.plan || null,
        paidAt:           p.paidAtMs,
        month:            ym,
        periodStart:      p.periodStart || null,
        periodEnd:        p.periodEnd || null,
        hostedInvoiceUrl: p.hostedInvoiceUrl || null,
      }, { merge: true });
      if (!existing.exists) {
        tx.set(ref, {
          totalPaid:     admin.firestore.FieldValue.increment(p.amount),
          paymentCount:  admin.firestore.FieldValue.increment(1),
          lastPaymentAt: Date.now(),
        }, { merge: true });
      }
    });
  } catch (err) {
    console.error("[stripe-webhook] payment record failed:", err.message);
  }
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
      const data = cur.exists ? cur.data() : {};
      // A trial is NOT a permanent comp: a trial user who pays converts to a real
      // Stripe customer — clear the trial + manual lock so their paid plan takes
      // over and the expire-trials sweep never downgrades them.
      const onTrial = data.planTrial === true;
      const manual  = data.planManual === true && !onTrial;
      const update = {
        stripeSubscriptionActive: true,
        stripeCustomerId:         session.customer,
        stripeSubscriptionId:     session.subscription,
        stripeActivatedAt: Date.now(),
      };
      // Store the renewal date at CREATION too. Only customer.subscription.updated
      // wrote stripePeriodEnd before, so a brand-new sub sat as "no confirmed
      // cycle" in the admin Billing tab until its first update event (often the
      // NEXT month). Best-effort — a miss here is healed by the next update event
      // or scripts/sync-stripe-cycles.js.
      try {
        if (session.subscription && process.env.STRIPE_SECRET_KEY) {
          const auth64 = Buffer.from(process.env.STRIPE_SECRET_KEY + ":").toString("base64");
          const sr = await fetch(`https://api.stripe.com/v1/subscriptions/${session.subscription}`,
            { headers: { "Authorization": `Basic ${auth64}` } });
          if (sr.ok) {
            const sub = await sr.json();
            if (sub.current_period_end) update.stripePeriodEnd = sub.current_period_end * 1000;
          }
        }
      } catch (e) { console.warn("[stripe-webhook] period fetch failed:", e.message); }
      if (onTrial) {
        update.plan = plan;
        update.planTrial = false;
        update.planManual = false;
        update.trialConvertedAt = Date.now();
      } else if (!manual) {
        update.plan = plan; // admin comp overrides Stripe's plan
      }
      await ref.set(update, { merge: true });

      // Record the first invoice payment HERE too. invoice.paid fires for this
      // same invoice, but on a NEW subscription it races with THIS event and
      // frequently arrives before stripeCustomerId is written just above — so its
      // customer-id lookup finds nobody and the payment is dropped (the "paid on
      // Stripe, $0 in the dash" bug). This event ALWAYS resolves the streamer (the
      // uid is in the session), so recording here guarantees the subscription-
      // creation payment lands. The shared invoice-id key + increment-once guard
      // mean invoice.paid recording the same payment can't double-count it.
      const firstAmount = (session.amount_total || 0) / 100;
      if (session.invoice && firstAmount > 0) {
        await recordPayment(db, ref, {
          invoiceId: session.invoice,
          amount:    firstAmount,
          currency:  session.currency || "usd",
          plan,
          paidAtMs:  Date.now(),
        });
      }
    }
  }

  // ── Subscription updated (upgrade/downgrade via portal) ────────────────────
  if (stripeEvent.type === "customer.subscription.updated") {
    const sub      = stripeEvent.data.object;
    const priceId  = priceIdOf(sub.items?.data?.[0]);
    const planMap  = getPricePlanMap();
    const newPlan  = planMap[priceId];
    const isActive = sub.status === "active" || sub.status === "trialing";

    const snap = await db.collection("streamers")
      .where("stripeSubscriptionId", "==", sub.id).limit(1).get();
    if (!snap.empty) {
      const d       = snap.docs[0].data();
      const onTrial = d.planTrial === true;
      const manual  = d.planManual === true && !onTrial;
      const update  = { stripeSubscriptionActive: isActive };
      if (onTrial && isActive) {           // trial converted to a paid sub
        update.planTrial = false;
        update.planManual = false;
        update.trialConvertedAt = Date.now();
      }
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
      const priceId  = priceIdOf(invoice.lines?.data?.[0]);
      const paidAtMs = (invoice.status_transitions?.paid_at || invoice.created || Math.floor(Date.now() / 1000)) * 1000;
      await recordPayment(db, ref, {
        invoiceId:        invoice.id,
        amount:           (invoice.amount_paid || 0) / 100, // cents → currency units
        currency:         invoice.currency || "usd",
        plan:             getPricePlanMap()[priceId] || null,
        paidAtMs,
        periodStart:      invoice.lines?.data?.[0]?.period?.start ? invoice.lines.data[0].period.start * 1000 : null,
        periodEnd:        periodEnd ? periodEnd * 1000 : null,
        hostedInvoiceUrl: invoice.hosted_invoice_url || null,
      });
    }
  }

  return { statusCode: 200, body: "ok" };
};
