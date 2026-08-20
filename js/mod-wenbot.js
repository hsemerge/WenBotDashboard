// "Mod WenBot in your chat" explainer — shared by the setup wizard and the
// dashboard so both show the same command and the same picture of where it goes.
// Loaded via <script src="/js/mod-wenbot.js">; defines modWenBotPanel() as a global.
//
// This is the one setup step nothing can verify for the streamer. Kick gives us
// no positive "is this account a moderator" signal — the bot only finds out when
// an action gets refused (moderationStatus.needsMod, written after the fact). So
// the job here is to make the instruction impossible to misread rather than to
// check it: the exact command, one click to copy it, and a mock of the Kick
// composer so it's obvious WHERE it gets typed.
//
// Colours are written with fallbacks because the two pages theme differently —
// setup.html uses --text-bright from css/styles.css, the dashboard uses --bright.

// The bot's Kick account. Same name the Automod "isn't a moderator" banner tells
// people to use; keep them in step.
const MOD_WENBOT_COMMAND = '/mod wenbot';

/**
 * @param {object} [opts]
 * @param {string} [opts.channel]  the streamer's Kick channel, for the mock header
 * @param {boolean} [opts.compact] drop the explanatory paragraph (tight spaces)
 * @returns {string} self-contained HTML
 */
function modWenBotPanel(opts) {
  const o       = opts || {};
  const bright  = 'var(--text-bright, var(--bright, #e8eef5))';
  const dim     = 'var(--text-dim, #8b949e)';
  const accent  = 'var(--accent, #00e5ff)';
  const border  = 'var(--border, rgba(255,255,255,0.1))';
  const card    = 'var(--bg-card, rgba(255,255,255,0.03))';
  const chan    = o.channel ? String(o.channel) : 'your channel';

  return `
    <div style="border:1px solid ${border};border-radius:10px;padding:14px;background:${card};">
      ${o.compact ? '' : `<div style="font-size:12px;color:${dim};line-height:1.6;margin-bottom:12px;">
        WenBot has to be a <strong style="color:${bright};">moderator</strong> in your Kick chat before it can
        post messages, run giveaways, or remove anything for you. It takes one command.
      </div>`}

      <!-- Mock of the Kick chat composer, so it's obvious where the command goes -->
      <div style="border:1px solid ${border};border-radius:9px;overflow:hidden;background:#0b0e13;">
        <div style="display:flex;align-items:center;gap:7px;padding:7px 11px;border-bottom:1px solid ${border};background:rgba(255,255,255,0.02);">
          <span style="width:7px;height:7px;border-radius:50%;background:#53e077;flex-shrink:0;"></span>
          <span style="font-size:11px;color:${dim};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">kick.com/${escapeForModPanel(chan)} — chat</span>
        </div>
        <div style="padding:11px;">
          <div style="display:flex;align-items:center;gap:8px;border:1px solid ${accent};border-radius:8px;padding:9px 11px;background:rgba(0,0,0,0.35);">
            <span style="font-family:'Courier New',monospace;font-size:13.5px;font-weight:700;color:${accent};white-space:nowrap;">${MOD_WENBOT_COMMAND}</span>
            <span style="width:1.5px;height:15px;background:${accent};animation:modCaretBlink 1.1s step-end infinite;"></span>
            <span style="margin-left:auto;font-size:13px;color:${dim};flex-shrink:0;">➤</span>
          </div>
          <div style="font-size:10.5px;color:${dim};margin-top:8px;line-height:1.5;">
            Type it in your own chat and send. Kick confirms in chat once WenBot is a moderator.
          </div>
        </div>
      </div>

      <button type="button" onclick="copyModWenBotCommand(this)"
        style="margin-top:11px;width:100%;background:rgba(0,229,255,0.1);border:1px solid rgba(0,229,255,0.35);border-radius:7px;color:${accent};font-size:12px;font-weight:800;padding:8px 12px;cursor:pointer;font-family:inherit;">
        📋 Copy <span style="font-family:'Courier New',monospace;">${MOD_WENBOT_COMMAND}</span>
      </button>
    </div>
    <style>@keyframes modCaretBlink { 0%,50% { opacity:1; } 51%,100% { opacity:0; } }</style>`;
}

// Local escape — this file loads on pages that don't all define escHtml.
function escapeForModPanel(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Copy, and say so on the button itself — a toast is easy to miss when the click
// target is what you were looking at.
function copyModWenBotCommand(btn) {
  const done = () => {
    if (!btn) return;
    const original = btn.innerHTML;
    btn.innerHTML = '✅ Copied — now paste it in your Kick chat';
    setTimeout(() => { btn.innerHTML = original; }, 2200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(MOD_WENBOT_COMMAND).then(done).catch(() => fallbackCopyModCommand(done));
  } else {
    fallbackCopyModCommand(done);
  }
}

// clipboard API needs a secure context; some streamers open the dashboard over a
// local/preview URL where it isn't available.
function fallbackCopyModCommand(done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = MOD_WENBOT_COMMAND;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  } catch (e) { /* leave the button alone — the command is on screen to type */ }
}
