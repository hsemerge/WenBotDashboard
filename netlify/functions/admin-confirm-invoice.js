// POST /api/admin-confirm-invoice   (admin only)
// Marks an invoice PAID (turns it into a receipt on the streamer's dashboard). For a
// recurring invoice it also stamps the streamer's next due date (+30d) so the admin's
// "due soon" view knows when to send the next one.
//
// Body: { uid, invoiceId, action?('confirm'|'unconfirm'|'delete') }

const { getDb, admin }                = require("./_lib/firebase");
const { res, checkRateLimit }         = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_inv_confirm", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event, "owner"); // billing/destructive: owner only
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const uid       = String(body.uid || "").trim();
  const invoiceId = String(body.invoiceId || "").trim();
  const action    = String(body.action || "confirm");
  if (!uid || !invoiceId) return res(400, { error: "Missing uid or invoiceId" });

  const ref = db.collection("streamers").doc(uid).collection("invoices").doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Invoice not found" });
  const inv = snap.data();

  try {
    if (action === "delete") {
      await ref.delete();
      logAdminAudit(db, adminUser.uid, "invoice_deleted", { uid, number: inv.number });
      return res(200, { success: true, deleted: true });
    }
    // Crypto/manual invoices count toward lifetime revenue exactly like Stripe
    // payments do. They never used to: totalPaid was only ever incremented by
    // the Stripe webhook, so a crypto customer read as $0 no matter how much
    // they had paid, and both the admin revenue figure and every per-customer
    // total were understated. `countedInTotals` makes it idempotent — confirming
    // twice can't double-count, and unconfirming gives the money back.
    const streamerRef = db.collection("streamers").doc(uid);
    const amount = Number(inv.amount) || 0;

    if (action === "unconfirm") {
      const upd = { status: "unpaid", paidAt: null };
      if (inv.countedInTotals && amount > 0) {
        upd.countedInTotals = false;
        await streamerRef.set({
          totalPaid:    admin.firestore.FieldValue.increment(-amount),
          paymentCount: admin.firestore.FieldValue.increment(-1),
        }, { merge: true });
      }
      await ref.update(upd);
      logAdminAudit(db, adminUser.uid, "invoice_unconfirmed", { uid, number: inv.number });
      return res(200, { success: true });
    }
    // confirm → paid
    const now = Date.now();
    const invUpd = { status: "paid", paidAt: now, paidAmount: amount, confirmedBy: adminUser.uid };
    const supd = { cryptoBilling: true };
    if (inv.recurring) supd.cryptoBillingNextDue = now + MONTH_MS;
    if (!inv.countedInTotals && amount > 0) {
      invUpd.countedInTotals = true;
      supd.totalPaid     = admin.firestore.FieldValue.increment(amount);
      supd.paymentCount  = admin.firestore.FieldValue.increment(1);
      supd.lastPaymentAt = now;
    }
    await ref.update(invUpd);
    await streamerRef.set(supd, { merge: true });
    logAdminAudit(db, adminUser.uid, "invoice_confirmed", { uid, number: inv.number, amount: inv.amount });
    return res(200, { success: true });
  } catch (e) {
    console.error("[admin-confirm-invoice]", e.message);
    return res(500, { error: "Internal server error" });
  }
};
