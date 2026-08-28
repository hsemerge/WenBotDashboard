// Sync every Stripe subscriber's real billing state from Stripe into Firestore.
//
// The admin Billing tab could only say "renews on <date>" or "no confirmed
// cycle", which hides the thing that matters most: whether the subscription is
// actually going to renew. A customer who cancelled still shows as active until
// the day their period ends, so the one window where you could save them passes
// unnoticed.
//
// Pulled per subscription and stored on the streamer doc:
//   stripeStatus            active | trialing | past_due | canceled | unpaid…
//   stripePeriodEnd         when the current period ends (renewal or expiry)
//   stripeAutoRenew         false when cancel_at_period_end or cancel_at is set
//   stripeCancelAt          the date cover actually stops, when cancelling
//   stripeCanceledAt        when they pressed cancel — the support signal
//   stripeAmount/Interval   what they pay, and how often
//   stripeSubscriptionActive  active|trialing (unchanged meaning)
//
// API-version note: current_period_end used to sit on the subscription and now
// lives on the subscription ITEM. Reading only the old path returned undefined,
// which is why every cycle showed as unconfirmed. Both paths are tried.
//
// Plan is reported on mismatch but never changed — the webhook owns that.
//
// USAGE (dry run prints the plan and writes NOTHING):
//   STRIPE_SECRET_KEY=… FIREBASE_SERVICE_ACCOUNT_BASE64=… node scripts/sync-stripe-cycles.js
//   …                                                     … --apply

const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) { console.error("Set STRIPE_SECRET_KEY."); process.exit(1); }

function getDb() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) { console.error("Set FIREBASE_SERVICE_ACCOUNT_BASE64."); process.exit(1); }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) });
  return admin.firestore();
}

const PRICE_PLAN = {};
if (process.env.STRIPE_PRICE_PRO)    PRICE_PLAN[process.env.STRIPE_PRICE_PRO]    = "pro";
if (process.env.STRIPE_PRICE_ELITE)  PRICE_PLAN[process.env.STRIPE_PRICE_ELITE]  = "elite";
if (process.env.STRIPE_PRICE_AGENCY) PRICE_PLAN[process.env.STRIPE_PRICE_AGENCY] = "agency";

function priceIdOf(item) {
  if (!item) return null;
  return (item.pricing && item.pricing.price_details && item.pricing.price_details.price)
    || (item.price && item.price.id) || (item.plan && item.plan.id) || null;
}
// current_period_end moved from the subscription onto its item.
function periodEndOf(sub) {
  const it = sub.items && sub.items.data && sub.items.data[0];
  const secs = sub.current_period_end || (it && it.current_period_end) || null;
  return secs ? secs * 1000 : null;
}

async function stripeGet(path) {
  const auth = Buffer.from(STRIPE_KEY + ":").toString("base64");
  const r = await fetch(`https://api.stripe.com/v1${path}`, { headers: { Authorization: `Basic ${auth}` } });
  return { ok: r.ok, status: r.status, body: await r.json() };
}

const d = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");

(async () => {
  const db = getDb();
  const snap = await db.collection("streamers").get();
  const subs = snap.docs.map((doc) => ({ uid: doc.id, ref: doc.ref, ...doc.data() })).filter((s) => s.stripeSubscriptionId);

  console.log(`${subs.length} streamer(s) hold a stripeSubscriptionId.\n`);
  const updates = [];
  for (const s of subs) {
    const r = await stripeGet(`/subscriptions/${s.stripeSubscriptionId}`);
    const label = (s.kickChannel || s.uid).padEnd(18);
    if (!r.ok) { console.log(`  ${label} ⚠ Stripe ${r.status}: ${r.body.error?.message || "?"} — skipped`); continue; }

    const sub = r.body;
    const it  = sub.items?.data?.[0] || {};
    const isActive  = sub.status === "active" || sub.status === "trialing";
    const periodEnd = periodEndOf(sub);
    // A subscription is only really renewing if nothing is scheduled to stop it.
    const autoRenew = isActive && !sub.cancel_at_period_end && !sub.cancel_at;
    const amount    = (it.plan?.amount ?? it.price?.unit_amount ?? null);
    const planNow   = PRICE_PLAN[priceIdOf(it)] || null;

    const next = {
      stripeStatus:             sub.status || null,
      stripeSubscriptionActive: isActive,
      stripePeriodEnd:          periodEnd,
      stripeAutoRenew:          autoRenew,
      stripeCancelAt:           sub.cancel_at ? sub.cancel_at * 1000 : null,
      stripeCanceledAt:         sub.canceled_at ? sub.canceled_at * 1000 : null,
      stripeAmount:             amount != null ? amount / 100 : null,
      stripeInterval:           it.plan?.interval || it.price?.recurring?.interval || null,
      stripeStartedAt:          sub.start_date ? sub.start_date * 1000 : null,
    };

    const change = {};
    for (const [k, v] of Object.entries(next)) if ((s[k] ?? null) !== v) change[k] = v;

    const flag = !autoRenew && isActive ? "  ⚠ WILL NOT RENEW" : "";
    const planNote = planNow && planNow !== s.plan && !s.planManual ? `  [stripe=${planNow} vs doc=${s.plan}, not changed]` : "";
    console.log(`  ${label} ${String(sub.status).padEnd(9)} ${autoRenew ? "auto-renews" : "no renewal "} ${d(periodEnd)}  $${next.stripeAmount}/${next.stripeInterval || "?"}${flag}${planNote}`);
    if (sub.canceled_at) console.log(`  ${" ".repeat(18)} cancelled ${d(next.stripeCanceledAt)}${sub.cancel_at ? `, cover ends ${d(next.stripeCancelAt)}` : ""}`);
    if (Object.keys(change).length) updates.push({ ref: s.ref, change, label: s.kickChannel || s.uid });
  }

  console.log(`\n${updates.length} doc(s) need updating.`);
  if (!APPLY) { console.log("Dry run — nothing written. Re-run with --apply to save."); process.exit(0); }
  for (const u of updates) { await u.ref.set(u.change, { merge: true }); console.log(`  ✅ ${u.label}`); }
  console.log("\n✅ Billing state synced.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
