// POST /api/send-agency-inquiry
// Saves agency contact submission to Firestore and optionally emails via Resend.
// Public endpoint (no auth) — protected by rate limit + input validation.

const { getDb, admin }        = require("./_lib/firebase");
const { res: _res, checkRateLimit } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

// Loose email format check — server's job is to filter obvious garbage,
// not to validate every RFC 5322 edge case (Resend will reject malformed too).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// HTML-escape user input before embedding in the outbound email body.
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  // 3 submissions per hour per IP — generous for legit users, kills bots
  if (!(await checkRateLimit(db, ip, "agency", 3, 3600))) {
    return res(429, { error: "Too many submissions. Please wait a bit before trying again." });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const name    = String(body.name || '').trim().slice(0, 200);
  const email   = String(body.email || '').trim().slice(0, 320);  // max RFC 5321 local+domain
  const details = String(body.details || '').trim().slice(0, 5000);

  if (!name || !email || !details) {
    return res(400, { error: "Name, email, and details are required." });
  }
  if (!EMAIL_RE.test(email)) {
    return res(400, { error: "Please enter a valid email address." });
  }

  // Always save to Firestore so submissions are never lost
  await db.collection("agency_inquiries").add({
    name,
    email,
    details,
    submittedAt: admin.firestore.Timestamp.now(),
    ip,
  });

  // Optionally send email via Resend if API key is configured
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          from:    "WenBot <support@wenbot.gg>",
          to:      "support@logicplaystudios.com",
          subject: `[WenBot] Agency Inquiry — ${escHtml(name)}`,
          html: `
            <h2>New Agency Inquiry</h2>
            <p><strong>Name:</strong> ${escHtml(name)}</p>
            <p><strong>Email:</strong> ${escHtml(email)}</p>
            <p><strong>Details:</strong></p>
            <p style="white-space:pre-wrap;">${escHtml(details)}</p>
          `,
          reply_to: email,
        }),
      });
    } catch (err) {
      console.error("[send-agency-inquiry] resend failed:", err.message);
      // Email failure is non-fatal — submission is already saved to Firestore
    }
  }

  return res(200, { ok: true });
};
