// GET /api/admin-activity  (admin only)
// The team activity feed for the admin portal dashboard: recent admin_audit_logs
// entries (who comped what, who archived whom, ticket/outreach moves…), newest
// first. Read-only.
//
// Staff see the feed too — it's how a 3-person team keeps up with each other —
// but BILLING entries are filtered out server-side for them: invoice_* details
// carry dollar amounts (admin-create-invoice logs { amount, … }), and billing is
// owner-only surface. The filter is by action prefix so a future invoice action
// can't slip through by being new.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin }        = require("./_lib/admin");

const OWNER_ONLY_ACTIONS = /^(invoice_|admin_billing)/;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET")     return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_activity", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  const limit = Math.min(100, Math.max(1, parseInt(event.queryStringParameters?.limit, 10) || 40));
  // Over-fetch so the staff filter can drop billing rows and still fill the page.
  const snap = await db.collection("admin_audit_logs").orderBy("at", "desc").limit(limit * 2).get();

  // Resolve admin uids → emails once per response (3-person team; tiny map).
  const uids = [...new Set(snap.docs.map((d) => d.data().adminUid).filter(Boolean))];
  const who = {};
  try {
    const { admin } = require("./_lib/firebase");
    const r = await admin.auth().getUsers(uids.slice(0, 100).map((uid) => ({ uid })));
    r.users.forEach((u) => { who[u.uid] = u.email || u.uid; });
  } catch { /* fall back to raw uids */ }

  let events = snap.docs.map((d) => {
    const e = d.data();
    return {
      id:      d.id,
      action:  e.action || "unknown",
      by:      who[e.adminUid] || e.adminUid || "?",
      at:      e.at && e.at.toMillis ? e.at.toMillis() : null,
      details: e.details || {},
    };
  });

  if (adminUser.role !== "owner") {
    events = events.filter((e) => !OWNER_ONLY_ACTIONS.test(e.action));
  }
  events = events.slice(0, limit);

  return res(200, { events, role: adminUser.role });
};
