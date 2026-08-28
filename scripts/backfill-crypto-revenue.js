// Count already-paid crypto/manual invoices toward lifetime revenue.
//
// totalPaid was only ever incremented by the Stripe webhook, so a customer who
// pays by crypto read as $0 no matter how much they had actually paid — both the
// admin's total-revenue figure and every per-customer total were understated.
// admin-confirm-invoice now increments on confirm; this catches up the invoices
// confirmed before that existed.
//
// Idempotent: each invoice is stamped `countedInTotals` when its money is added,
// and invoices already carrying that stamp are skipped — so running this twice
// cannot double-count, and a later unconfirm knows to give the money back.
//
// USAGE (dry run prints the plan and writes NOTHING):
//   FIREBASE_SERVICE_ACCOUNT_BASE64=… node scripts/backfill-crypto-revenue.js
//   …                                                                  … --apply

const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");

function getDb() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) { console.error("Set FIREBASE_SERVICE_ACCOUNT_BASE64."); process.exit(1); }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) });
  return admin.firestore();
}

(async () => {
  const db = getDb();
  const snap = await db.collection("streamers").get();

  const work = [];
  for (const d of snap.docs) {
    const x = d.data();
    const paid = await d.ref.collection("invoices").where("status", "==", "paid").get().catch(() => ({ docs: [] }));
    const uncounted = paid.docs.filter((i) => !i.data().countedInTotals && (Number(i.data().amount) || 0) > 0);
    if (!uncounted.length) continue;
    const amount = uncounted.reduce((a, i) => a + Number(i.data().amount), 0);
    work.push({ ref: d.ref, channel: x.kickChannel || d.id, was: x.totalPaid || 0, amount, invoices: uncounted });
  }

  let total = 0;
  console.log(`Uncounted crypto/manual revenue on ${work.length} account(s):\n`);
  work.forEach((w) => {
    total += w.amount;
    console.log(`  ${String(w.channel).padEnd(16)} +$${String(w.amount).padEnd(7)} (${w.invoices.length} invoice${w.invoices.length === 1 ? "" : "s"})  totalPaid ${w.was} → ${w.was + w.amount}`);
  });
  console.log(`\nTotal to add: $${total}`);

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply to save."); process.exit(0); }

  for (const w of work) {
    // Stamp each invoice first: if the run dies midway, the money already added
    // stays matched to the invoices marked as counted.
    for (const inv of w.invoices) await inv.ref.set({ countedInTotals: true }, { merge: true });
    await w.ref.set({
      totalPaid:    admin.firestore.FieldValue.increment(w.amount),
      paymentCount: admin.firestore.FieldValue.increment(w.invoices.length),
    }, { merge: true });
    console.log(`  ✅ ${w.channel}: +$${w.amount}`);
  }
  console.log(`\n✅ Added $${total} of crypto revenue to lifetime totals.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
