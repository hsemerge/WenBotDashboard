// GET /api/billing-history
// Returns the authenticated streamer's own Stripe payment history + totals,
// recorded by the stripe-webhook (streamers/{uid}/payments). Read via the admin
// SDK so it works regardless of client-read rules, and only ever exposes the
// caller's own records. Requires a Firebase ID token in the Authorization header.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "billing_history", 30, 60))) {
    return res(429, { error: "Too many requests. Please wait a moment." });
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch { return res(401, { error: "Invalid token" }); }

  const ref  = db.collection("streamers").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Streamer profile not found" });
  const data = snap.data();

  let payments = [];
  try {
    const ps = await ref.collection("payments").orderBy("paidAt", "desc").limit(100).get();
    payments = ps.docs.map((d) => {
      const p = d.data();
      return {
        amount:           p.amount || 0,
        currency:         (p.currency || "usd").toUpperCase(),
        plan:             p.plan || null,
        paidAt:           p.paidAt || null,
        hostedInvoiceUrl: p.hostedInvoiceUrl || null,
      };
    });
  } catch {
    payments = [];
  }

  return res(200, {
    totalPaid:     data.totalPaid || 0,
    paymentCount:  data.paymentCount || payments.length || 0,
    lastPaymentAt: data.lastPaymentAt || null,
    currency:      payments[0]?.currency || "USD",
    payments,
  });
};
