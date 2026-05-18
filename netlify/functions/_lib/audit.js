// Audit logging for sensitive operations.
// Writes to streamers/{uid}/audit_logs/{auto} via admin SDK (bypasses client rules).
// Failures NEVER block the main operation — audit is best-effort.
//
// Usage:
//   const { logAudit } = require("./_lib/audit");
//   await logAudit(streamerUid, "verify", { kickUsername, providerUsername, underAffiliate });

const { getDb, admin } = require("./firebase");

async function logAudit(streamerUid, action, details = {}) {
  if (!streamerUid || !action) return;
  try {
    await getDb()
      .collection("streamers").doc(streamerUid)
      .collection("audit_logs").add({
        action,
        details,
        timestamp: admin.firestore.Timestamp.now(),
      });
  } catch (err) {
    console.error(`[Audit:${action}] log failed:`, err.message);
  }
}

module.exports = { logAudit };
