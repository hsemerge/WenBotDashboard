// Backfill Stripe payments that never got recorded in Firestore.
//
// The webhook recorded a payment only from invoice.paid, matched to a streamer by
// stripeCustomerId. On a NEW subscription that event races with
// checkout.session.completed (which WRITES stripeCustomerId), so when invoice.paid
// won the race the payment was dropped — the charge succeeded on Stripe but the
// admin dash showed $0. The webhook is now fixed going forward; this repairs the
// ones already missed.
//
// It lists PAID invoices from Stripe, finds each one's streamer by
// stripeCustomerId, and writes any payment Firestore is missing — using the same
// idempotent shape + running totals the webhook uses (keyed by invoice id, totals
// increment only when the payment doc is new), so it is safe to run repeatedly and
// safe to run alongside the fixed webhook.
//
// USAGE (dry run lists what it WOULD record and writes nothing):
//   STRIPE_SECRET_KEY=sk_live_… FIREBASE_SERVICE_ACCOUNT_BASE64=… node scripts/backfill-stripe-payments.js
//   …                                                                      … --apply
//   optional: --since 2026-08-01   (only invoices paid on/after this date)

const admin = require("firebase-admin");

const argv   = process.argv.slice(2);
const flags  = new Set(argv.filter((a) => a.startsWith("--")));
const APPLY  = flags.has("--apply");
const sinceI = argv.indexOf("--since");
const SINCE  = sinceI >= 0 && argv[sinceI + 1] ? Date.parse(argv[sinceI + 1]) : null;

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) { console.error("Set STRIPE_SECRET_KEY (sk_live_… / sk_test_…)."); process.exit(1); }

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
  if (!r.ok) throw new Error(j.error?.message || `Stripe ${r.status}`);
  return j;
}

(async () => {
  const db = getDb();
  // Cache streamer lookups by customer id so we don't re-query per invoice.
  const streamerByCustomer = new Map();
  async function findStreamer(customerId) {
    if (!customerId) return null;
    if (streamerByCustomer.has(customerId)) return streamerByCustomer.get(customerId);
    const snap = await db.collection("streamers").where("stripeCustomerId", "==", customerId).limit(1).get();
    const doc = snap.empty ? null : snap.docs[0];
    streamerByCustomer.set(customerId, doc);
    return doc;
  }

  let starting_after = null, scanned = 0, wouldRecord = 0, already = 0, unmatched = 0, recorded = 0;
  const toRecord = [];

  // Page through paid invoices, newest first.
  for (;;) {
    const q = new URLSearchParams({ status: "paid", limit: "100" });
    if (starting_after) q.set("starting_after", starting_after);
    const page = await stripeGet(`/invoices?${q.toString()}`);
    for (const inv of page.data) {
      scanned++;
      const paidAtMs = (inv.status_transitions?.paid_at || inv.created) * 1000;
      if (SINCE && paidAtMs < SINCE) continue;
      const amount = (inv.amount_paid || 0) / 100;
      if (!(amount > 0)) continue;
      const doc = await findStreamer(inv.customer);
      if (!doc) { unmatched++; continue; }
      const payRef = doc.ref.collection("payments").doc(inv.id);
      if ((await payRef.get()).exists) { already++; continue; }
      const priceId = inv.lines?.data?.[0]?.price?.id;
      toRecord.push({
        uid: doc.id, ref: doc.ref, payRef,
        invoiceId: inv.id, amount, currency: inv.currency || "usd",
        plan: PRICE_PLAN[priceId] || null, paidAtMs,
        periodStart: inv.lines?.data?.[0]?.period?.start ? inv.lines.data[0].period.start * 1000 : null,
        periodEnd:   inv.lines?.data?.[0]?.period?.end   ? inv.lines.data[0].period.end   * 1000 : null,
        hostedInvoiceUrl: inv.hosted_invoice_url || null,
        customerEmail: inv.customer_email || null,
      });
      wouldRecord++;
    }
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }

  console.log(`Scanned ${scanned} paid invoices | already recorded ${already} | no matching streamer ${unmatched} | MISSING ${wouldRecord}\n`);
  for (const p of toRecord) {
    console.log(`  MISSING  ${p.customerEmail || "?"}  $${p.amount.toFixed(2)} ${p.currency.toUpperCase()}  ${new Date(p.paidAtMs).toISOString().slice(0,10)}  plan=${p.plan}  uid=${p.uid}  ${p.invoiceId}`);
  }
  if (unmatched) console.log(`\nNote: ${unmatched} paid invoice(s) had no streamer with that stripeCustomerId (older/deleted accounts or test data).`);

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply to record the MISSING payments."); process.exit(0); }

  for (const p of toRecord) {
    const d  = new Date(p.paidAtMs);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(p.payRef);
      tx.set(p.payRef, {
        invoiceId: p.invoiceId, amount: p.amount, currency: p.currency, plan: p.plan,
        paidAt: p.paidAtMs, month: ym, periodStart: p.periodStart, periodEnd: p.periodEnd,
        hostedInvoiceUrl: p.hostedInvoiceUrl, backfilled: true,
      }, { merge: true });
      if (!existing.exists) {
        tx.set(p.ref, {
          totalPaid:     admin.firestore.FieldValue.increment(p.amount),
          paymentCount:  admin.firestore.FieldValue.increment(1),
          lastPaymentAt: Date.now(),
        }, { merge: true });
      }
    });
    recorded++;
    console.log(`  ✅ recorded ${p.invoiceId} ($${p.amount.toFixed(2)}) for ${p.uid}`);
  }
  console.log(`\n✅ Backfilled ${recorded} payment(s).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
