// Shared admin-panel auth + audit. Authority is ALWAYS verified server-side here;
// the admin page is just a view. An admin must (1) present a valid Firebase ID
// token, (2) have a verified email, and (3) be on the ADMIN_UIDS allowlist (env).
// Optionally (4) supply the ADMIN_PANEL_SECRET as a second factor if that env is
// set. With no ADMIN_UIDS configured, nobody is an admin (secure by default).

const { admin }        = require("./firebase");
const { timingSafeEq } = require("./http");

function adminUids() {
  return (process.env.ADMIN_UIDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Returns { uid, email } for an authorized admin, or null (caller → 403).
// Never throws — any failure is treated as "not an admin".
async function requireAdmin(event) {
  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return null;

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return null; }

  if (!decoded.email_verified) return null;

  const allow = adminUids();
  if (!allow.length || !allow.includes(decoded.uid)) return null;

  // Optional second factor: if ADMIN_PANEL_SECRET is set, require a matching
  // x-admin-secret header. (A pragmatic 2nd factor until Firebase MFA/TOTP is
  // enabled on the admin accounts via Identity Platform.)
  const secret = process.env.ADMIN_PANEL_SECRET;
  if (secret) {
    const provided = (event.headers["x-admin-secret"] || "").trim();
    if (!timingSafeEq(provided, secret)) return null;
  }

  return { uid: decoded.uid, email: decoded.email || null };
}

// Append an immutable admin audit entry. Best-effort (never blocks the action).
async function logAdminAudit(db, adminUid, action, details = {}) {
  try {
    await db.collection("admin_audit_logs").add({
      adminUid,
      action,
      details,
      at: admin.firestore.Timestamp.now(),
    });
  } catch (e) {
    console.error("[admin audit] failed:", e.message);
  }
}

module.exports = { requireAdmin, logAdminAudit, adminUids };
