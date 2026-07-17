// POST /api/admin-set-plan  (admin only)
// Manually set (comp) a streamer's plan, or release it back to Stripe control.
//
// Sets `plan` directly + `planManual: true`. The Stripe webhook checks planManual
// and will NOT overwrite `plan` while it's true — so a comped plan survives
// subscription changes/cancellations. Releasing (manual:false) lets Stripe drive
// the plan again. Using the existing `plan` field means every entitlement check in
// the app keeps working unchanged.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const VALID_PLANS = ["starter", "pro", "elite", "agency"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_set_plan", 20, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const targetUid = String(body.uid || "").trim();
  const reason    = String(body.reason || "").slice(0, 300);
  const manual    = body.manual !== false; // default true (setting a comp)
  if (!targetUid) return res(400, { error: "Missing uid" });

  const ref  = db.collection("streamers").doc(targetUid);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Streamer not found" });
  const cur = snap.data();

  const update = {};
  if (manual) {
    const plan = String(body.plan || "").trim();
    if (!VALID_PLANS.includes(plan)) return res(400, { error: `Invalid plan. One of: ${VALID_PLANS.join(", ")}` });
    update.plan       = plan;
    update.planManual = true;
  } else {
    // Release back to Stripe: clear the manual lock. Reflect the current real
    // subscription state (active sub keeps its plan; otherwise drop to starter).
    // Exception: a crypto-paying customer (has paid invoices) keeps their plan —
    // they aren't on Stripe, so "starter" would wrongly strip a plan they pay for.
    update.planManual = false;
    if (!cur.stripeSubscriptionActive) {
      const paidInv = await ref.collection("invoices").where("status", "==", "paid").limit(1).get();
      if (paidInv.empty) update.plan = "starter";
    }
  }

  await ref.set(update, { merge: true });

  logAdminAudit(db, adminUser.uid, "set_plan", {
    targetUid,
    targetChannel: cur.kickChannel || null,
    oldPlan: cur.plan || "starter",
    newPlan: update.plan != null ? update.plan : (cur.plan || "starter"),
    manual,
    reason,
  });

  return res(200, { ok: true, plan: update.plan != null ? update.plan : cur.plan, planManual: update.planManual });
};
