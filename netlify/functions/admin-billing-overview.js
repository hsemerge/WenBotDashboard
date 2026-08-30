// GET /api/admin-billing-overview   (admin only)
// Per-streamer crypto-billing status derived from the ACTUAL invoices (source of
// truth), so the Billing tab shows anyone with invoices — not a maintained flag
// that can go stale. Reads each streamer's invoices subcollection directly (no
// collection-group index required, so it can't fail on a missing index).
// Returns { billing: { uid: { nextDue, hasUnpaid, ... } } }.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin }        = require("./_lib/admin");

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function summarize(docs) {
  let paidCount = 0, unpaidCount = 0, submittedCount = 0, latestPaidRecurringAt = 0, earliestUnpaidDueAt = 0, lastPaidAt = 0;
  // Money actually collected outside Stripe. The invoices ARE the record for
  // crypto/manual payers, so this is the honest figure — the dashboard used to
  // show Stripe revenue only, which quietly wrote invoice customers out of the
  // business.
  let paidTotal = 0;
  docs.forEach((doc) => {
    const v = doc.data();
    if (v.status === "paid") {
      paidCount++;
      paidTotal += Number(v.paidAmount != null ? v.paidAmount : v.amount) || 0;
      const pa = Number(v.paidAt) || 0;
      if (pa > lastPaidAt) lastPaidAt = pa;
      if (v.recurring && pa > latestPaidRecurringAt) latestPaidRecurringAt = pa;
    } else {
      unpaidCount++;
      if (v.paymentSubmitted) submittedCount++;
      const due = Number(v.dueAt) || Number(v.createdAt) || 0;
      if (due && (!earliestUnpaidDueAt || due < earliestUnpaidDueAt)) earliestUnpaidDueAt = due;
    }
  });
  // Next payment = a month after the last PAID recurring invoice; if none paid yet,
  // fall back to the earliest unpaid invoice's due date.
  const nextDue = latestPaidRecurringAt ? latestPaidRecurringAt + MONTH_MS : (earliestUnpaidDueAt || null);
  return { nextDue, paidCount, unpaidCount, submittedCount, hasUnpaid: unpaidCount > 0, paidTotal, lastPaidAt: lastPaidAt || null };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_billing_ov", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event, "owner"); // billing/destructive: owner only
  if (!adminUser) return res(403, { error: "Not authorized" });

  try {
    const streamers = await db.collection("streamers").get();
    const out = {};
    // Itemised money-collected, summed from the real records (never a running
    // counter), split three ways: Stripe charges (payments subcollection), crypto
    // subscriptions (paid invoices flagged recurring) and one-off work (paid
    // invoices not recurring). The Billing tab renders totals + these line items.
    const stripeItems = [], cryptoSubItems = [], workItems = [];
    const chanOf = {};
    streamers.docs.forEach((s) => { chanOf[s.id] = s.data().kickChannel || s.id; });
    // Read every streamer's invoices + payments subcollections in bounded batches.
    const docs = streamers.docs;
    const BATCH = 25;
    for (let i = 0; i < docs.length; i += BATCH) {
      const chunk = docs.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(async (s) => {
        try {
          const [inv, pay] = await Promise.all([
            s.ref.collection("invoices").get(),
            s.ref.collection("payments").get(),
          ]);
          return { uid: s.id, invDocs: inv.docs, payDocs: pay.docs };
        } catch (e) { console.warn("[admin-billing-overview] read failed", s.id, e.message); return null; }
      }));
      results.forEach((r) => {
        if (!r) return;
        const channel = chanOf[r.uid];
        if (r.invDocs.length) out[r.uid] = summarize(r.invDocs);
        r.invDocs.forEach((d) => {
          const v = d.data();
          if (v.status !== "paid") return;
          const amount = Number(v.paidAmount != null ? v.paidAmount : v.amount) || 0;
          const item = { uid: r.uid, channel, number: v.number || null, amount,
                         paidAt: Number(v.paidAt) || null, description: v.description || null };
          (v.recurring ? cryptoSubItems : workItems).push(item);
        });
        r.payDocs.forEach((d) => {
          const p = d.data();
          const amount = Number(p.amount) || 0;
          if (amount > 0) stripeItems.push({ uid: r.uid, channel, plan: p.plan || null, amount, paidAt: Number(p.paidAt) || null });
        });
      });
    }
    const sum = (arr) => arr.reduce((acc, x) => acc + (x.amount || 0), 0);
    const byDate = (a, b) => (b.paidAt || 0) - (a.paidAt || 0);
    const stripeSubs = sum(stripeItems), cryptoSubs = sum(cryptoSubItems), work = sum(workItems);
    const grandTotal = stripeSubs + cryptoSubs + work;
    const cryptoTotal = cryptoSubs + work;
    const collected = {
      stripeSubs: { total: stripeSubs, items: stripeItems.sort(byDate) },
      cryptoSubs: { total: cryptoSubs, items: cryptoSubItems.sort(byDate) },
      work:       { total: work,       items: workItems.sort(byDate) },
      grandTotal, cryptoTotal,
      cryptoShare: grandTotal > 0 ? cryptoTotal / grandTotal : 0,
    };
    return res(200, { billing: out, collected });
  } catch (e) {
    console.error("[admin-billing-overview]", e.message);
    return res(500, { error: "Internal server error" });
  }
};
