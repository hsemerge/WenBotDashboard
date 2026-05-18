// POST /api/send-agency-inquiry
// Saves agency contact submission to Firestore and optionally emails via Resend

const { getDb, admin } = require("./_lib/firebase");
const { res: _res }    = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const { name, email, details } = body;
  if (!name || !email || !details) {
    return res(400, { error: "Name, email, and details are required." });
  }

  const db = getDb();

  // Always save to Firestore so submissions are never lost
  await db.collection("agency_inquiries").add({
    name,
    email,
    details,
    submittedAt: admin.firestore.Timestamp.now(),
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
          from:    "WenBot <noreply@wenbot.gg>",
          to:      "sales@logicplaystudios.com",
          subject: `[WenBot] Agency Inquiry — ${name}`,
          html: `
            <h2>New Agency Inquiry</h2>
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Details:</strong></p>
            <p style="white-space:pre-wrap;">${details}</p>
          `,
          reply_to: email,
        }),
      });
    } catch {
      // Email failure is non-fatal — submission is already saved to Firestore
    }
  }

  return res(200, { ok: true });
};
