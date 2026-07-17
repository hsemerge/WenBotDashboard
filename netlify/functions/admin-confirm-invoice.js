// POST /api/admin-confirm-invoice   (admin only)
// Marks an invoice PAID (turns it into a receipt on the streamer's dashboard). For a
// recurring invoice it also stamps the streamer's next due date (+30d) so the admin's
// "due soon" view knows when to send the next one.
//
// Body: { uid, invoiceId, action?('confirm'|'unconfirm'|'delete') }

const { getDb }                       = require("./_lib/firebase");
const { res, checkRateLimit }         = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_inv_confirm", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
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
    if (action === "unconfirm") {
      await ref.update({ status: "unpaid", paidAt: null });
      logAdminAudit(db, adminUser.uid, "invoice_unconfirmed", { uid, number: inv.number });
      return res(200, { success: true });
    }
    // confirm → paid
    const now = Date.now();
    await ref.update({ status: "paid", paidAt: now, paidAmount: inv.amount || 0, confirmedBy: adminUser.uid });
    const supd = { cryptoBilling: true };
    if (inv.recurring) supd.cryptoBillingNextDue = now + MONTH_MS;
    await db.collection("streamers").doc(uid).set(supd, { merge: true });
    logAdminAudit(db, adminUser.uid, "invoice_confirmed", { uid, number: inv.number, amount: inv.amount });
    return res(200, { success: true });
  } catch (e) {
    console.error("[admin-confirm-invoice]", e.message);
    return res(500, { error: "Internal server error" });
  }
};
