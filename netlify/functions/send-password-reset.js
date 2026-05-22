// POST /api/send-password-reset
// Body: { email, continueUrl? }
//
// Public (no auth — the user has forgotten their password). Generates a
// Firebase password-reset link via the Admin SDK and sends it through Resend
// from support@wenbot.gg.
//
// Anti-enumeration: always returns { ok: true } whether or not the email is
// registered, so an attacker can't probe which emails have accounts. Rate
// limited by IP to prevent inbox-bombing a known address.

const { getDb, admin }              = require("./_lib/firebase");
const { res: _res, checkRateLimit } = require("./_lib/http");
const { sendEmail, wrap, button, SUPPORT_EMAIL } = require("./_lib/email");
const res = (s, b) => _res(s, b, "*");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_CONTINUE = "https://wenbot.gg/login.html";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb(); // lazy-init Admin SDK

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  // 3 reset requests per 15 min per IP — generous for legit retries, kills bombing
  if (!(await checkRateLimit(db, ip, "pwd_reset", 3, 900))) {
    return res(429, { error: "Too many requests. Please wait a few minutes." });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return res(400, { error: "Enter a valid email address." });
  }

  // Validate continue URL stays on our domain
  let continueUrl = DEFAULT_CONTINUE;
  try {
    if (body.continueUrl) {
      const u = new URL(String(body.continueUrl), "https://wenbot.gg");
      if (u.hostname === "wenbot.gg") continueUrl = u.toString();
    }
  } catch {}

  try {
    const link = await admin.auth().generatePasswordResetLink(email, { url: continueUrl });
    await sendEmail({
      to:      email,
      replyTo: SUPPORT_EMAIL,
      subject: "Reset your WenBot password",
      html: wrap("Reset your password",
        `<p>We got a request to reset the password for your WenBot account. Tap below to choose a new one.</p>
         ${button(link, "Reset my password")}
         <p style="font-size:13px;color:#8b949e;">If you didn't request this, ignore this email — your password won't change.</p>`),
    });
  } catch (err) {
    // user-not-found (auth/user-not-found) is expected for unknown emails —
    // swallow it so we don't reveal whether the account exists.
    if (err.code !== "auth/user-not-found") {
      console.error("[send-password-reset] error:", err.message);
    }
  }

  // Always report success regardless of whether the email was registered.
  return res(200, { ok: true });
};
