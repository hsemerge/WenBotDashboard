// GET /api/admin-users  (admin only)
// Returns every streamer with key ops fields + global rollups for the admin panel.
// Authority verified server-side via requireAdmin (Firebase token + allowlist).

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

function ms(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();            // Firestore Timestamp
  if (v._seconds != null) return v._seconds * 1000;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_users", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  const snap = await db.collection("streamers").get();
  const users = snap.docs.map((d) => {
    const s = d.data();
    return {
      uid:                d.id,
      kickChannel:        s.kickChannel || null,
      displayName:        s.displayName || s.kickChannel || null,
      email:              s.email || null,
      plan:               s.plan || "starter",
      planManual:         s.planManual === true,       // admin comp (survives Stripe)
      provider:           s.activeProvider || s.casino || null,
      subscriptionActive: !!s.stripeSubscriptionActive,
      paymentFailed:      !!s.stripePaymentFailed,
      onboarded:          !!s.onboarded,
      archived:           s.archived === true,
      referredBy:         s.referredBy || null,
      referralCount:      s.referralCount || 0,
      totalPaid:          s.totalPaid || 0,
      paymentCount:       s.paymentCount || 0,
      lastPaymentAt:      ms(s.lastPaymentAt),
      kickConnectedAt:    ms(s.kickConnectedAt),
      // Billing/renewals: next payment date. Stripe subs come from the webhook;
      // crypto subs advance on admin-confirm. Either drives the "Due Soon" view.
      stripeSubscribed:   !!s.stripeSubscriptionId,
      stripePeriodEnd:    ms(s.stripePeriodEnd),
      cryptoNextDue:      ms(s.cryptoBillingNextDue),
      cryptoBilling:      !!s.cryptoBilling,
    };
  });

  // Last login — pulled from Firebase Auth metadata (no per-login writes needed).
  // Batched getUsers (max 100/call). Non-fatal: on any failure, leave it null.
  try {
    for (let i = 0; i < users.length; i += 100) {
      const chunk = users.slice(i, i + 100).map((u) => ({ uid: u.uid }));
      const r = await admin.auth().getUsers(chunk);
      const m = {};
      r.users.forEach((rec) => {
        const t = rec.metadata && rec.metadata.lastSignInTime;
        if (t) m[rec.uid] = new Date(t).getTime();
      });
      for (const u of users.slice(i, i + 100)) u.lastLoginAt = m[u.uid] || null;
    }
  } catch (e) {
    console.warn("[admin-users] last-login lookup failed:", e.message);
  }

  users.sort((a, b) => (b.totalPaid - a.totalPaid) ||
    String(a.kickChannel || "").localeCompare(String(b.kickChannel || "")));

  const stats = {
    total:        users.length,
    onboarded:    users.filter((u) => u.onboarded).length,
    activeSubs:   users.filter((u) => u.subscriptionActive).length,
    totalRevenue: users.reduce((sum, u) => sum + (u.totalPaid || 0), 0),
    byPlan:       users.reduce((m, u) => { const k = u.plan; m[k] = (m[k] || 0) + 1; return m; }, {}),
  };

  logAdminAudit(db, adminUser.uid, "admin_users_view", { count: users.length });
  return res(200, { stats, users, admin: adminUser.email });
};
