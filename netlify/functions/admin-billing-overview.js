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
  docs.forEach((doc) => {
    const v = doc.data();
    if (v.status === "paid") {
      paidCount++;
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
  return { nextDue, paidCount, unpaidCount, submittedCount, hasUnpaid: unpaidCount > 0 };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_billing_ov", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  try {
    const streamers = await db.collection("streamers").get();
    const out = {};
    // Read every streamer's invoices subcollection in bounded batches.
    const docs = streamers.docs;
    const BATCH = 25;
    for (let i = 0; i < docs.length; i += BATCH) {
      const chunk = docs.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(async (s) => {
        try {
          const inv = await s.ref.collection("invoices").get();
          return inv.empty ? null : { uid: s.id, summary: summarize(inv.docs) };
        } catch (e) { console.warn("[admin-billing-overview] invoices read failed", s.id, e.message); return null; }
      }));
      results.forEach((r) => { if (r) out[r.uid] = r.summary; });
    }
    return res(200, { billing: out });
  } catch (e) {
    console.error("[admin-billing-overview]", e.message);
    return res(500, { error: "Internal server error" });
  }
};
