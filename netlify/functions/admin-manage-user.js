// POST /api/admin-manage-user  (admin only)
// Lets an admin grant/revoke THEIR OWN delegation for a target streamer, so they
// can switch into and manage that account through the normal account-switcher
// (reusing the moderator `delegatedFor` mechanism — no special Firestore rules).
//
// Body: { uid: <targetUid>, action: "grant" | "revoke" }
// Every call is written to admin_audit_logs.

const { getDb, admin }                = require("./_lib/firebase");
const { res, checkRateLimit }         = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");
const { grantDelegation }             = require("./_lib/team");

// Remove a target from the admin's delegatedFor claim. Unlike the team revoke,
// we do NOT revoke the admin's refresh tokens (no need to force-logout the
// admin) — the client just refreshes its ID token to drop the claim.
async function adminRevoke(adminUid, targetUid) {
  const rec  = await admin.auth().getUser(adminUid);
  const cur  = Array.isArray(rec.customClaims?.delegatedFor) ? rec.customClaims.delegatedFor : [];
  const next = cur.filter((u) => u !== targetUid);
  await admin.auth().setCustomUserClaims(adminUid, {
    ...(rec.customClaims || {}),
    delegatedFor: next.length ? next : null,
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_manage_user", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const targetUid = String(body.uid || "").trim();
  const action    = body.action === "revoke" ? "revoke" : "grant";

  // Switch-in is OWNER-ONLY for now. Granting delegatedFor puts the admin inside
  // the streamer's dashboard, where the client reads that streamer's payments +
  // invoices straight from Firestore (the rules see any delegated uid as a mod) —
  // which would hand a staff admin exactly the billing surface the role model
  // hides. Until staff switch-in runs on a separate, billing-blind claim, only
  // the owner gets it. Revoke stays any-admin so a leftover grant can always be
  // cleaned up.
  if (action === "grant" && adminUser.role !== "owner") {
    return res(403, { error: "Switching into accounts is owner-only for now — it exposes the streamer's billing pages." });
  }
  if (!targetUid) return res(400, { error: "Missing uid" });
  if (targetUid === adminUser.uid) return res(400, { error: "That's your own account." });

  const tSnap = await db.collection("streamers").doc(targetUid).get();
  if (!tSnap.exists) return res(404, { error: "Streamer not found" });

  try {
    if (action === "grant") await grantDelegation(adminUser.uid, targetUid);
    else                    await adminRevoke(adminUser.uid, targetUid);
  } catch (e) {
    return res(500, { error: "Could not update access: " + e.message });
  }

  logAdminAudit(db, adminUser.uid, "admin_manage_" + action, {
    targetUid, channel: tSnap.data().kickChannel || null,
  });
  return res(200, { success: true, action, targetUid, channel: tSnap.data().kickChannel || null });
};
