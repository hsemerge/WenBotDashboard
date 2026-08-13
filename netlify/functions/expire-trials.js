// Scheduled daily (see netlify.toml [functions."expire-trials"].schedule).
// Downgrades expired Elite trials to starter so the stored `plan` stays truthful
// for the bot + admin views. The web surfaces (dashboard, portal-data) ALSO guard
// against an expired trial live, so entitlements are correct even between runs.
//
// Idempotent + safe to call anytime: it only ever touches trials whose trialEndsAt
// has already passed (the correct action), so it needs no auth — the worst a manual
// hit can do is expire something that was due to expire anyway.

const { getDb } = require("./_lib/firebase");

// A due DATE is a day, not an instant, and this runs daily.
const GRACE_MS = 24 * 60 * 60 * 1000;

function ms(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  return null;
}

exports.handler = async () => {
  const db  = getDb();
  const now = Date.now();
  let expired = 0;

  try {
    const snap = await db.collection("streamers").where("planTrial", "==", true).get();
    const batch = db.batch();
    snap.forEach((doc) => {
      const end = ms(doc.data().trialEndsAt);
      if (end && end <= now) {
        batch.set(doc.ref, {
          plan:          "starter",
          planManual:    false,   // release to Stripe — they must subscribe to continue
          planTrial:     false,
          trialExpiredAt: now,
        }, { merge: true });
        expired++;
      }
    });
    if (expired) await batch.commit();
  } catch (e) {
    console.warn("[expire-trials] sweep failed:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  // ── Overdue invoices ────────────────────────────────────────────────────
  // Stripe cancels itself and tells us; an invoiced streamer does not. Nothing
  // watched cryptoBillingNextDue, so anyone billed by invoice who simply never
  // paid kept their plan indefinitely. Same rule as everyone else now: miss the
  // date, drop to starter until it is settled.
  //
  // A COMP is also planManual, so the due date is what separates them: comps
  // carry no cryptoBillingNextDue and are never touched here. Getting that wrong
  // would strip a comped agency account, which is the expensive mistake.
  //
  // One day of grace, because a due DATE is a day rather than an instant and the
  // sweep runs daily; without it a payment made on the due date can lose to a
  // timezone.
  let overdue = 0;
  try {
    const snap = await db.collection("streamers").where("planManual", "==", true).get();
    const batch = db.batch();
    snap.forEach((doc) => {
      const d = doc.data();
      if (d.planTrial === true) return;               // handled above
      if ((d.plan || "starter") === "starter") return; // nothing to take away
      const due = ms(d.cryptoBillingNextDue);
      if (!due) return;                                // a comp, not an invoice
      if (due + GRACE_MS > now) return;                // not overdue yet
      batch.set(doc.ref, {
        plan:              "starter",
        planManual:        false,
        billingLapsedAt:   now,
        billingLapsedFrom: d.plan,   // so it can be restored on payment
      }, { merge: true });
      overdue++;
    });
    if (overdue) await batch.commit();
  } catch (e) {
    console.warn("[expire-trials] overdue-invoice sweep failed:", e.message);
  }

  console.log(`[expire-trials] downgraded ${expired} expired trial(s), ${overdue} overdue invoice(s)`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, expired, overdue }) };
};
