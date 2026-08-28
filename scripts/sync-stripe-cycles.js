// Sync every Stripe subscriber's billing cycle from Stripe into Firestore.
//
// The admin Billing tab reads streamers/{uid}.stripePeriodEnd for "Next
// payment". Only the customer.subscription.updated webhook ever wrote that
// field, so subs that never had an update event (most brand-new ones) show
// "no confirmed cycle", and canceled subs can show a stale overdue date. This
// pulls the live truth per subscription:
//   - stripePeriodEnd          <- subscription.current_period_end
//   - stripeSubscriptionActive <- status is active|trialing
// It reports plan mismatches (price → plan map) but does NOT touch plan — the
// webhook owns that.
//
// USAGE (dry run prints the plan and writes NOTHING):
//   STRIPE_SECRET_KEY=sk_live_… FIREBASE_SERVICE_ACCOUNT_BASE64=… node scripts/sync-stripe-cycles.js
//   …                                                              … --apply

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

const PRICE_PLAN = {
  [process.env.STRIPE_PRICE_PRO]:    "pro",
  [process.env.STRIPE_PRICE_ELITE]:  "elite",
  [process.env.STRIPE_PRICE_AGENCY]: "agency",
};

async function stripeGet(path) {
  const auth = Buffer.from(STRIPE_KEY + ":").toString("base64");
  const r = await fetch(`https://api.stripe.com/v1${path}`, { headers: { Authorization: `Basic ${auth}` } });
  const j = await r.json();
  return { ok: r.ok, status: r.status, body: j };
}

const d = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");

(async () => {
  const db = getDb();
  const snap = await db.collection("streamers").get();
  const subs = snap.docs
    .map((doc) => ({ uid: doc.id, ref: doc.ref, ...doc.data() }))
    .filter((s) => s.stripeSubscriptionId);

  console.log(`${subs.length} streamer(s) hold a stripeSubscriptionId.\n`);
  const updates = [];
  for (const s of subs) {
    const r = await stripeGet(`/subscriptions/${s.stripeSubscriptionId}`);
    const label = (s.kickChannel || s.uid).padEnd(20);
    if (!r.ok) {
      console.log(`  ${label} ⚠ Stripe ${r.status}: ${r.body.error?.message || "?"} — skipped`);
      continue;
    }
    const sub = r.body;
    const isActive  = sub.status === "active" || sub.status === "trialing";
    const periodEnd = sub.current_period_end ? sub.current_period_end * 1000 : null;
    const planNow   = PRICE_PLAN[sub.items?.data?.[0]?.price?.id] || null;
    const change = {};
    if (periodEnd && periodEnd !== (s.stripePeriodEnd || null)) change.stripePeriodEnd = periodEnd;
    if (isActive !== !!s.stripeSubscriptionActive) change.stripeSubscriptionActive = isActive;
    const planNote = planNow && planNow !== s.plan && !s.planManual ? `  [plan mismatch: stripe=${planNow} vs doc=${s.plan} — NOT changed]` : "";
    if (Object.keys(change).length) {
      updates.push({ ref: s.ref, change, label: s.kickChannel || s.uid });
      console.log(`  ${label} status=${sub.status.padEnd(9)} cycle ${d(s.stripePeriodEnd)} → ${d(periodEnd)}  active ${!!s.stripeSubscriptionActive} → ${isActive}${planNote}`);
    } else {
      console.log(`  ${label} status=${sub.status.padEnd(9)} in sync (renews ${d(periodEnd)})${planNote}`);
    }
  }

  console.log(`\n${updates.length} doc(s) need updating.`);
  if (!APPLY) { console.log("Dry run — nothing written. Re-run with --apply to save."); process.exit(0); }
  for (const u of updates) { await u.ref.set(u.change, { merge: true }); console.log(`  ✅ ${u.label}: ${JSON.stringify(u.change)}`); }
  console.log("\n✅ Cycles synced.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
