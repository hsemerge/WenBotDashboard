// POST /api/admin-account-action  (admin only)
//
// The support actions that otherwise mean opening the Firebase console:
//   password-reset  → email the user a reset link
//   verify-email    → re-send their verification email
//   revoke-sessions → sign them out everywhere (stolen laptop, shared login)
//   clear-mfa       → remove their two-factor enrolment (lost phone)   [owner]
//   disable/enable  → block or restore sign-in                          [owner]
//
// Deliberate: the reset and verification links are NEVER returned to the admin,
// only emailed to the account holder. Handing an admin a working password-reset
// link is handing them the account — which would make "reset a streamer's
// password" a quiet account-takeover tool. Emailing it keeps the account holder
// in the loop and still solves the support case.
//
// clear-mfa and disable/enable are owner-only: one strips a security factor, the
// other locks somebody out of a product they pay for.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");
const { sendEmail, wrap, button, SUPPORT_EMAIL } = require("./_lib/email");

const OWNER_ONLY = new Set(["clear-mfa", "disable", "enable"]);

// Values interpolated into notification HTML are account data (channel names,
// admin notes), so they get escaped before they reach the email body.
const escHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_acct_action", 20, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const uid    = String(body.uid || "").trim();
  const action = String(body.action || "").trim();
  if (!uid)    return res(400, { error: "Missing uid" });
  if (OWNER_ONLY.has(action) && adminUser.role !== "owner") {
    return res(403, { error: `"${action}" is owner-only.` });
  }

  // Who looks after this streamer day to day. Handled before the Auth lookup
  // below because it's a property of the ACCOUNT, not of a login — an account
  // whose Firebase user was removed still belongs to someone's book.
  //
  // Any admin can set it: deciding who covers whom is ops, not billing.
  if (action === "set-manager") {
    const manager = String(body.manager || "").trim().slice(0, 120);
    if (manager && !manager.includes("@")) return res(400, { error: "Manager must be an admin email." });
    const sref = db.collection("streamers").doc(uid);
    const ssnap = await sref.get();
    if (!ssnap.exists) return res(404, { error: "No such streamer." });
    const s = ssnap.data();
    const changed = (s.accountManager || null) !== (manager || null);
    await sref.set({
      accountManager:   manager || null,
      accountManagerAt: manager ? Date.now() : null,
      accountManagerBy: manager ? (adminUser.email || adminUser.uid) : null,
    }, { merge: true });
    logAdminAudit(db, adminUser.uid, "account_manager_set", { uid, manager: manager || null });

    // Tell them they've been handed someone. The portal shows it on sign-in;
    // this reaches whoever isn't looking at the portal. Best-effort — an account
    // must still be assigned if Resend is down — and never mails you your own
    // action, since assigning yourself a streamer is not news.
    let emailed = false;
    if (changed && manager && manager !== (adminUser.email || "") && process.env.RESEND_API_KEY) {
      try {
        const chan = s.kickChannel || s.displayName || uid;
        const who  = String(adminUser.email || "someone").split("@")[0];
        const note = String(s.adminNotes || "").trim();
        emailed = await sendEmail({
          to: manager,
          subject: `[WenBot] ${chan} is now yours to look after`,
          html: wrap(`${escHtml(who)} assigned you a streamer`, `
            <p style="font-size:17px;color:#f0f6fc;margin:0 0 4px;"><b>${escHtml(chan)}</b></p>
            <p style="font-size:13px;color:#8b949e;margin:0 0 14px;">
              ${escHtml(s.plan || "starter")}${s.planTrial ? " · on a free trial" : ""}${s.email ? " &nbsp;·&nbsp; " + escHtml(s.email) : ""}
            </p>
            <p style="margin:0 0 6px;">You're their day-to-day contact now — they'll show up under <b>My streamers</b> on your dashboard.</p>
            ${note ? `<div style="background:#0d1117;border-left:3px solid #00e5ff;padding:10px 14px;margin:14px 0 0;white-space:pre-wrap;font-size:14px;">
              <b style="color:#f0f6fc;">Notes on this account</b><br>${escHtml(note).slice(0, 1200)}</div>` : ""}
            ${button(`https://wenbot.gg/admin/portal/#/customer/${encodeURIComponent(uid)}`, "Open their Customer 360")}
          `),
        });
      } catch (e) { console.warn("[admin-account-action] manager notify failed:", e.message); }
    }
    return res(200, { success: true, manager: manager || null, emailed });
  }

  // How this account pays, when the history can't tell the truth by itself —
  // e.g. someone who used to be comped and now pays by invoice. "auto" clears
  // the override and goes back to deriving it.
  if (action === "set-billing-method") {
    const m = String(body.method || "auto").trim();
    if (!["auto", "stripe", "crypto", "comp", "free"].includes(m)) return res(400, { error: "Unknown billing method." });
    const sref = db.collection("streamers").doc(uid);
    if (!(await sref.get()).exists) return res(404, { error: "No such streamer." });
    await sref.set({ billingMethod: m === "auto" ? null : m }, { merge: true });
    logAdminAudit(db, adminUser.uid, "billing_method_set", { uid, method: m });
    return res(200, { success: true, method: m });
  }

  // Free months already granted for referrals that converted. Owner-only: it's
  // the ledger behind giving away paid time.
  if (action === "set-referral-credits") {
    if (adminUser.role !== "owner") return res(403, { error: "Owner only." });
    const used = Math.max(0, Math.min(999, Math.floor(Number(body.used))));
    if (!Number.isFinite(used)) return res(400, { error: "Credits used must be a number." });
    const sref = db.collection("streamers").doc(uid);
    if (!(await sref.get()).exists) return res(404, { error: "No such streamer." });
    await sref.set({ referralCreditsUsed: used }, { merge: true });
    logAdminAudit(db, adminUser.uid, "referral_credits_set", { uid, used });
    return res(200, { success: true, used });
  }

  let user;
  try { user = await admin.auth().getUser(uid); }
  catch { return res(404, { error: "No login exists for that account." }); }
  const email = user.email;

  try {
    if (action === "password-reset") {
      if (!email) return res(400, { error: "That account has no email address." });
      const link = await admin.auth().generatePasswordResetLink(email, { url: "https://wenbot.gg/login.html" });
      await sendEmail({
        to: email, replyTo: SUPPORT_EMAIL,
        subject: "Reset your WenBot password",
        html: wrap("Reset your password",
          `<p>Someone at WenBot support started a password reset for your account.</p>
           <p>Click below to choose a new password. If you didn't ask for this, you can ignore this email — your password won't change.</p>
           ${button(link, "Choose a new password")}`),
      });
      logAdminAudit(db, adminUser.uid, "account_password_reset", { uid, email });
      return res(200, { ok: true, message: `Reset link emailed to ${email}.` });
    }

    if (action === "verify-email") {
      if (!email) return res(400, { error: "That account has no email address." });
      if (user.emailVerified) return res(200, { ok: true, message: "That email is already verified." });
      const link = await admin.auth().generateEmailVerificationLink(email, { url: "https://wenbot.gg/setup.html" });
      await sendEmail({
        to: email, replyTo: SUPPORT_EMAIL,
        subject: "Verify your WenBot email",
        html: wrap("Verify your email", `<p>Confirm this address to finish setting up your WenBot account.</p>${button(link, "Verify my email")}`),
      });
      logAdminAudit(db, adminUser.uid, "account_verify_resent", { uid, email });
      return res(200, { ok: true, message: `Verification email sent to ${email}.` });
    }

    if (action === "revoke-sessions") {
      await admin.auth().revokeRefreshTokens(uid);
      logAdminAudit(db, adminUser.uid, "account_sessions_revoked", { uid, email });
      return res(200, { ok: true, message: "Signed out of every device. They'll need to sign in again." });
    }

    if (action === "clear-mfa") {
      const factors = (user.multiFactor && user.multiFactor.enrolledFactors) || [];
      if (!factors.length) return res(200, { ok: true, message: "That account has no two-factor set up." });
      // Clearing the enrolment lets them sign in with just their password again,
      // so revoke live sessions at the same time — otherwise an attacker who
      // already had a session keeps it.
      await admin.auth().updateUser(uid, { multiFactor: { enrolledFactors: [] } });
      await admin.auth().revokeRefreshTokens(uid);
      logAdminAudit(db, adminUser.uid, "account_mfa_cleared", { uid, email, factors: factors.length });
      return res(200, { ok: true, message: "Two-factor removed and sessions revoked. Ask them to set it up again once they're back in." });
    }

    if (action === "disable" || action === "enable") {
      const disabled = action === "disable";
      if (uid === adminUser.uid) return res(400, { error: "You can't lock yourself out." });
      await admin.auth().updateUser(uid, { disabled });
      if (disabled) await admin.auth().revokeRefreshTokens(uid);
      logAdminAudit(db, adminUser.uid, disabled ? "account_disabled" : "account_enabled", { uid, email });
      return res(200, { ok: true, message: disabled ? "Sign-in blocked for this account." : "Sign-in restored." });
    }

    return res(400, { error: "Unknown action" });
  } catch (err) {
    console.error("[admin-account-action]", action, err.message);
    return res(500, { error: err.message || "Action failed" });
  }
};
