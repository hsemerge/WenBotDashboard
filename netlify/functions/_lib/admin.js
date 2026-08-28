// Shared admin-panel auth + audit. Authority is ALWAYS verified server-side here;
// the admin page is just a view. An admin must (1) present a valid Firebase ID
// token, (2) have a verified email, and (3) carry an adminRole custom claim
// ("owner" | "staff") — or, as a migration fallback, be on the ADMIN_UIDS env
// allowlist, which counts as owner. Optionally (4) supply ADMIN_PANEL_SECRET as
// a second factor if that env is set. With neither a claim nor an allowlist
// entry, nobody is an admin (secure by default).
//
// ROLES — two tiers, enforced per-request:
//   owner : everything, incl. billing/invoicing and destructive actions.
//   staff : day-to-day ops (accounts, plans/trials, slots, outreach, tickets).
//           Billing endpoints demand requireAdmin(event, "owner") and refuse.
// Claims are set by scripts/set-admin-role.js (merge-spread, so a mod's
// delegatedFor survives). The ADMIN_UIDS fallback keeps today's owner logins
// working until every account carries a claim — then the env can be emptied.

const { admin }        = require("./firebase");
const { timingSafeEq } = require("./http");

function adminUids() {
  return (process.env.ADMIN_UIDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Returns { uid, email, role } for an authorized admin, or null (caller → 403).
// Pass requiredRole "owner" to refuse staff. Never throws — any failure is
// treated as "not an admin".
async function requireAdmin(event, requiredRole = null) {
  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return null;

  let decoded;
  // checkRevoked:true so demoting/removing an admin takes effect the moment
  // set-admin-role.js revokes their refresh tokens — without it an already-
  // issued token kept the OLD role for up to an hour. Costs one account lookup
  // per request; fine for a 3-person panel.
  try { decoded = await admin.auth().verifyIdToken(idToken, true); }
  catch { return null; }

  if (!decoded.email_verified) return null;

  // Role: the adminRole claim, with ADMIN_UIDS winning UPWARD — the env list is
  // owner-curated, so a uid on it is an owner even if a claim says "staff"
  // (protects against a mixed-up set-admin-role run demoting the owner with no
  // in-band way back). The env is the migration fallback AND the break-glass.
  let role = (decoded.adminRole === "owner" || decoded.adminRole === "staff") ? decoded.adminRole : null;
  if (adminUids().includes(decoded.uid)) role = "owner";
  if (!role) return null;
  if (requiredRole === "owner" && role !== "owner") return null;

  // Second factor, two generations:
  //   NEW  — per-account TOTP MFA (Identity Platform). When the session was
  //          signed in with a second factor, the token says so; that session
  //          needs no shared secret. Set ADMIN_REQUIRE_MFA=1 to REQUIRE it for
  //          owners — then the shared secret is dead.
  //          ⚠ DEPLOY ORDER: flip ADMIN_REQUIRE_MFA only AFTER every owner has
  //          enrolled TOTP (check with `set-admin-role.js --list`, which prints
  //          MFA status). Flipped early it locks every owner out — including
  //          ADMIN_UIDS owners, and the shared secret does NOT substitute; the
  //          only recovery is unsetting the env var.
  //   OLD  — the shared ADMIN_PANEL_SECRET header, owners only, kept as the
  //          fallback for sessions without MFA until the switchover.
  // Staff sign in with just their account either way (the shared secret is
  // deliberately not handed to staff); their reduced surface is the trade-off.
  const mfaVerified = !!(decoded.firebase && decoded.firebase.sign_in_second_factor);
  if (process.env.ADMIN_REQUIRE_MFA === "1" && role === "owner" && !mfaVerified) return null;
  const secret = process.env.ADMIN_PANEL_SECRET;
  if (secret && role === "owner" && !mfaVerified) {
    const provided = (event.headers["x-admin-secret"] || "").trim();
    if (!timingSafeEq(provided, secret)) return null;
  }

  return { uid: decoded.uid, email: decoded.email || null, role, mfaVerified };
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
