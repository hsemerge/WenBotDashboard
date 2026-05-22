// POST /api/send-verification-email
// Headers: Authorization: Bearer <Firebase ID token of the just-signed-up user>
// Body: { continueUrl }   — where to land after the user verifies (e.g. setup.html?plan=pro)
//
// Replaces Firebase's built-in sendEmailVerification(), which sends from
// noreply@<project>.firebaseapp.com (slow + spam-filtered). We generate the
// same verification link via the Admin SDK and deliver it through Resend from
// support@wenbot.gg.

const { getDb, admin }              = require("./_lib/firebase");
const { res: _res, checkRateLimit } = require("./_lib/http");
const { sendEmail, wrap, button, SUPPORT_EMAIL } = require("./_lib/email");
const res = (s, b) => _res(s, b, "*");

const DEFAULT_CONTINUE = "https://wenbot.gg/setup.html";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb(); // lazy-init Admin SDK before admin.auth()

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  // 5 verification sends per 10 min per IP — covers resends, kills loops
  if (!(await checkRateLimit(db, ip, "verify_email", 5, 600))) {
    return res(429, { error: "Too many requests. Please wait a moment." });
  }

  const auth = event.headers.authorization || event.headers.Authorization || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  let email;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken || "");
    email = decoded.email;
    if (decoded.email_verified) {
      // Already verified — nothing to do, report success so the UI moves on
      return res(200, { ok: true, alreadyVerified: true });
    }
  } catch {
    return res(401, { error: "Sign in to request a verification email." });
  }
  if (!email) return res(400, { error: "No email on account." });

  // Validate the continue URL stays on our domain (open-redirect guard)
  let continueUrl = DEFAULT_CONTINUE;
  try {
    const raw = String((JSON.parse(event.body || "{}")).continueUrl || "");
    if (raw) {
      const u = new URL(raw, "https://wenbot.gg");
      if (u.hostname === "wenbot.gg") continueUrl = u.toString();
    }
  } catch {}

  try {
    const link = await admin.auth().generateEmailVerificationLink(email, { url: continueUrl });
    const sent = await sendEmail({
      to:      email,
      replyTo: SUPPORT_EMAIL,
      subject: "Verify your WenBot email",
      html: wrap("Confirm your email",
        `<p>Welcome to WenBot! Tap the button below to verify your email and finish setting up your streamer dashboard.</p>
         ${button(link, "Verify my email")}
         <p style="font-size:13px;color:#8b949e;">This link expires after a while for security. If it stops working, request a new one from the verify screen.</p>`),
    });
    if (!sent) return res(502, { error: "Could not send the email. Try again in a moment." });
    return res(200, { ok: true });
  } catch (err) {
    console.error("[send-verification-email] error:", err.message);
    return res(500, { error: "Could not generate the verification link." });
  }
};
