// POST /api/admin-create-invoice   (admin only)
// Issues an invoice to a streamer. Written server-side (rules block client writes),
// which fires the streamer's dashboard flag (live listener) automatically.
//
// Body: { uid, amount, description, method?('crypto'|'card'), dueAt?, billedTo?, recurring? }

const { getDb }                       = require("./_lib/firebase");
const { res, checkRateLimit }         = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_inv_create", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const uid         = String(body.uid || "").trim();
  const amount      = Number(body.amount);
  const description = String(body.description || "").trim().slice(0, 200);
  const method      = String(body.method || "crypto").toLowerCase() === "card" ? "card" : "crypto";
  const dueAt       = Number(body.dueAt) || null;
  const billedTo    = String(body.billedTo || "").trim().slice(0, 120) || null;
  const recurring   = !!body.recurring;
  const markPaid    = !!body.markPaid;                      // create it already paid (historical import)
  const paidAtIn    = Number(body.paidAt) || null;

  if (!uid)                 return res(400, { error: "Missing streamer uid" });
  if (!amount || amount <= 0) return res(400, { error: "Enter a valid amount" });
  if (!description)         return res(400, { error: "Enter a description" });

  const sSnap = await db.collection("streamers").doc(uid).get();
  if (!sSnap.exists) return res(404, { error: "Streamer not found" });

  // Auto invoice number (LPS-0001, 0002, …) via an atomic counter.
  const counterRef = db.collection("_cache").doc("invoice_counter");
  let number;
  try {
    await db.runTransaction(async (txn) => {
      const c = await txn.get(counterRef);
      const n = (c.exists ? (c.data().n || 0) : 0) + 1;
      number = "LPS-" + String(n).padStart(4, "0");
      txn.set(counterRef, { n }, { merge: true });
    });
  } catch (e) { return res(500, { error: "Could not allocate invoice number" }); }

  const now    = Date.now();
  const paidAt = markPaid ? (paidAtIn || now) : null;
  const invoice = {
    number, amount, description, method, dueAt, recurring,
    billedTo: billedTo || sSnap.data().displayName || sSnap.data().kickChannel || null,
    items:    [{ description, amount }],
    status:   markPaid ? "paid" : "unpaid",
    // For a historical paid receipt, date it to the paid date so the receipt reads right.
    createdAt: markPaid ? paidAt : now,
    createdBy: adminUser.uid,
  };
  if (markPaid) { invoice.paidAt = paidAt; invoice.paidAmount = amount; invoice.confirmedBy = adminUser.uid; }

  let ref;
  try { ref = await db.collection("streamers").doc(uid).collection("invoices").add(invoice); }
  catch (e) { console.error("[admin-create-invoice]", e.message); return res(500, { error: "Could not create invoice" }); }

  // Mark the streamer as a crypto-billing customer so they appear in the Billing tab
  // (even from just an unpaid invoice). Recurring + paid also advances their next-due.
  try {
    const sRef = db.collection("streamers").doc(uid);
    const upd = { cryptoBilling: true };
    if (markPaid && recurring) {
      const next = paidAt + 30 * 24 * 60 * 60 * 1000;
      const cur  = Number(sSnap.data().cryptoBillingNextDue) || 0;
      if (next > cur) upd.cryptoBillingNextDue = next;
    }
    await sRef.set(upd, { merge: true });
  } catch {}

  logAdminAudit(db, adminUser.uid, "invoice_created", { uid, number, amount, method, markPaid });
  return res(200, { success: true, id: ref.id, number });
};
