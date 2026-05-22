// Shared transactional email sender (Resend).
//
// wenbot.gg is a verified Resend sending domain (SPF + DKIM), so any
// address @wenbot.gg works. We send auth emails (verification, password
// reset) from support@wenbot.gg instead of Firebase's default
// noreply@<project>.firebaseapp.com sender — which is slow and frequently
// spam-filtered because its domain doesn't align with wenbot.gg.

const FROM = "WenBot <support@wenbot.gg>";
// Where human replies should land — a monitored inbox. support@wenbot.gg
// forwards here too, but setting reply-to explicitly guarantees replies reach
// us even if forwarding isn't configured.
const SUPPORT_EMAIL = "support@logicplaystudios.com";

// Wraps body HTML in a consistent branded shell. `bodyHtml` is trusted
// (built by us, never raw user input) — callers must escape any dynamic
// values before passing them in.
function wrap(title, bodyHtml) {
  return `
  <div style="background:#0d1117;padding:32px 0;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;">
      <div style="padding:24px 32px;border-bottom:1px solid #30363d;">
        <img src="https://wenbot.gg/img/logo.png" alt="WenBot" height="36" style="height:36px;object-fit:contain;display:inline-block;">
      </div>
      <div style="padding:28px 32px;color:#c9d1d9;font-size:15px;line-height:1.6;">
        <h1 style="font-size:18px;color:#f0f6fc;margin:0 0 16px;">${title}</h1>
        ${bodyHtml}
      </div>
      <div style="padding:18px 32px;border-top:1px solid #30363d;color:#8b949e;font-size:12px;line-height:1.5;">
        Streamer tools for Kick · <a href="https://wenbot.gg" style="color:#00e5ff;text-decoration:none;">wenbot.gg</a><br>
        If you didn't request this email, you can safely ignore it.
      </div>
    </div>
  </div>`;
}

// Big primary call-to-action button.
function button(href, label) {
  return `<div style="text-align:center;margin:24px 0;">
    <a href="${href}" style="display:inline-block;background:#00e5ff;color:#0d1117;font-weight:700;font-size:15px;text-decoration:none;padding:12px 28px;border-radius:8px;">${label}</a>
  </div>
  <p style="font-size:12px;color:#8b949e;word-break:break-all;">Or paste this link into your browser:<br>${href}</p>`;
}

// Send an email via Resend. Returns true on success, false on failure
// (callers decide whether failure is fatal). Throws only on missing config
// so misconfiguration is loud during development.
async function sendEmail({ to, subject, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not configured");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from:    FROM,
      to,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("[email] Resend send failed:", resp.status, detail.slice(0, 300));
    return false;
  }
  return true;
}

module.exports = { sendEmail, wrap, button, FROM, SUPPORT_EMAIL };
