// POST /api/invoice-submit-payment
// A streamer signals they've SENT a (crypto) payment for one of their invoices.
// This does NOT mark the invoice paid — it only flags it so the admin can verify
// on-chain and Confirm (which is the step that turns it into a receipt).
//
// Body: { uid, invoiceId, txHash? }
// Auth: Firebase ID token (owner or a mod/admin delegatedFor the account).

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "invsubmit", 10, 60))) return res(429, { error: "Too many requests — wait a moment." });

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = (body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) return res(403, { error: "Not authorized for that account" });

  const invoiceId = String(body.invoiceId || "").trim();
  if (!invoiceId) return res(400, { error: "Missing invoiceId" });
  const txHash = String(body.txHash || "").trim().slice(0, 200);

  const ref = db.collection("streamers").doc(uid).collection("invoices").doc(invoiceId);
  try {
    const snap = await ref.get();
    if (!snap.exists) return res(404, { error: "Invoice not found" });
    if (snap.data().status === "paid") return res(400, { error: "This invoice is already paid." });

    await ref.update({
      paymentSubmitted:   true,
      paymentSubmittedAt: Date.now(),
      paymentSubmittedBy: decoded.uid,
      txHash:             txHash || null,
    });
    return res(200, { success: true });
  } catch (err) {
    console.error("[invoice-submit-payment] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
