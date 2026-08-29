// Scheduled daily (see netlify.toml [functions."sync-billing"].schedule).
//
// Reconciles every Stripe subscription against Firestore. The webhook already
// records these changes the moment Stripe sends them, so this is a SAFETY NET,
// not the primary path: a webhook can be missed during a deploy, a delivery can
// fail, an event can arrive out of order. Without a reconcile, a missed
// cancellation stays invisible until someone happens to look in Stripe — which
// is exactly the failure this whole area already suffered once.
//
// Read-only against Stripe; the only writes are the billing fields on the
// streamer doc, and only where they actually differ. Idempotent, so running it
// by hand is harmless — the worst a manual hit does is agree with Stripe.
//
// Deliberately does NOT touch `plan`: comps and trials are admin decisions that
// live above Stripe. A plan that disagrees with Stripe is reported, not changed.

const { getDb } = require("./_lib/firebase");

function ms(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  return null;
}

// Same two API-version shifts the webhook handles: the price id moved into
// pricing.price_details, and current_period_end moved onto the item.
function periodEndOf(sub) {
  const it = sub && sub.items && sub.items.data && sub.items.data[0];
  const secs = (sub && sub.current_period_end) || (it && it.current_period_end) || null;
  return secs ? secs * 1000 : null;
}

function billingFieldsFrom(sub) {
  const it = (sub.items && sub.items.data && sub.items.data[0]) || {};
  const isActive = sub.status === "active" || sub.status === "trialing";
  const amount = (it.plan && it.plan.amount != null) ? it.plan.amount
               : (it.price && it.price.unit_amount != null) ? it.price.unit_amount : null;
  return {
    stripeSubscriptionActive: isActive,
    stripeStatus:     sub.status || null,
    stripePeriodEnd:  periodEndOf(sub),
    stripeAutoRenew:  isActive && !sub.cancel_at_period_end && !sub.cancel_at,
    stripeCancelAt:   sub.cancel_at ? sub.cancel_at * 1000 : null,
    stripeCanceledAt: sub.canceled_at ? sub.canceled_at * 1000 : null,
    stripeAmount:     amount != null ? amount / 100 : null,
    stripeInterval:   (it.plan && it.plan.interval) || (it.price && it.price.recurring && it.price.recurring.interval) || null,
    stripeStartedAt:  sub.start_date ? sub.start_date * 1000 : null,
  };
}

exports.handler = async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn("[sync-billing] no STRIPE_SECRET_KEY — skipped");
    return { statusCode: 200, body: JSON.stringify({ skipped: "no stripe key" }) };
  }
  const auth = Buffer.from(key + ":").toString("base64");
  const db = getDb();

  let checked = 0, updated = 0, failed = 0;
  const changes = [];
  let ghosts = [];        // declared out here because the response below reads it

  try {
    const snap = await db.collection("streamers").get();
    const subs = snap.docs.filter((d) => d.data().stripeSubscriptionId);

    // Accounts flagged as having an active subscription with no subscription ID
    // stored. This job reconciles against Stripe BY id, so these are exactly the
    // records it can never check — they'd stay "subscribed" forever. Reported,
    // not auto-cleared: the flag is money-adjacent, and an unattended job
    // rewriting billing state is how a wrong guess becomes permanent. The portal
    // shows the same thing on the account, where a human can act on it.
    ghosts = snap.docs
      .filter((d) => d.data().stripeSubscriptionActive === true && !d.data().stripeSubscriptionId)
      .map((d) => d.data().kickChannel || d.id);
    if (ghosts.length) {
      console.warn(`[sync-billing] ${ghosts.length} account(s) flagged subscribed with no subscription id — unverifiable: ${ghosts.join(", ")}`);
    }

    for (const d of subs) {
      const cur = d.data();
      checked++;
      let sub;
      try {
        const r = await fetch(`https://api.stripe.com/v1/subscriptions/${cur.stripeSubscriptionId}`,
          { headers: { Authorization: `Basic ${auth}` } });
        if (!r.ok) { failed++; continue; }
        sub = await r.json();
      } catch { failed++; continue; }

      const next = billingFieldsFrom(sub);
      const diff = {};
      for (const [k, v] of Object.entries(next)) {
        const before = k.endsWith("At") || k === "stripePeriodEnd" ? ms(cur[k]) : (cur[k] ?? null);
        if ((before ?? null) !== v) diff[k] = v;
      }
      if (Object.keys(diff).length) {
        await d.ref.set(diff, { merge: true });
        updated++;
        // Log the one that matters loudly — a cancellation nobody has seen yet.
        if (diff.stripeAutoRenew === false) {
          console.warn(`[sync-billing] ${cur.kickChannel || d.id} is no longer renewing (${sub.status}, ends ${new Date(next.stripeCancelAt || next.stripePeriodEnd || 0).toISOString().slice(0, 10)})`);
        }
        changes.push({ channel: cur.kickChannel || d.id, fields: Object.keys(diff) });
      }
    }
  } catch (e) {
    console.error("[sync-billing] failed:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  console.log(`[sync-billing] checked ${checked}, updated ${updated}, unreachable ${failed}`);
  return { statusCode: 200, body: JSON.stringify({ checked, updated, failed, changes, unverifiable: ghosts }) };
};
