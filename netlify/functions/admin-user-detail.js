// GET/POST /api/admin-user-detail?uid=...  (admin only)
// Drill-down for one streamer: who they referred + their payment history +
// who referred them. Used by the expand row in the admin users table.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin }        = require("./_lib/admin");

function ms(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_detail", 60, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  const params = event.queryStringParameters || {};
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const uid = String(params.uid || body.uid || "").trim();
  if (!uid) return res(400, { error: "Missing uid" });

  const ref  = db.collection("streamers").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Streamer not found" });
  const data = snap.data();

  // Who they invited.
  let referrals = [];
  try {
    const rs = await ref.collection("referrals").orderBy("joinedAt", "desc").limit(200).get();
    referrals = rs.docs.map((d) => {
      const r = d.data();
      return { kickChannel: r.kickChannel || null, plan: r.plan || "starter", status: r.status || "onboarded", joinedAt: ms(r.joinedAt) };
    });
  } catch { referrals = []; }

  // Payment history.
  let payments = [];
  try {
    const ps = await ref.collection("payments").orderBy("paidAt", "desc").limit(100).get();
    payments = ps.docs.map((d) => {
      const p = d.data();
      return { amount: p.amount || 0, currency: (p.currency || "usd").toUpperCase(), plan: p.plan || null, paidAt: ms(p.paidAt), hostedInvoiceUrl: p.hostedInvoiceUrl || null };
    });
  } catch { payments = []; }

  // Who referred them (resolve channel for display).
  let referredByChannel = null;
  if (data.referredBy) {
    try {
      const rb = await db.collection("streamers").doc(data.referredBy).get();
      referredByChannel = rb.exists ? (rb.data().kickChannel || data.referredBy) : data.referredBy;
    } catch { referredByChannel = data.referredBy; }
  }

  return res(200, {
    uid,
    kickChannel:       data.kickChannel || null,
    referredByChannel,
    referralCount:     data.referralCount || referrals.length,
    totalPaid:         data.totalPaid || 0,
    referrals,
    payments,
  });
};
