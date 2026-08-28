// Grant a streamer's "verified" Discord role to a member.
//
// This lived inside discord-link-account, the OAuth callback, and nowhere else.
// That was fine while every viewer reached Discord linking by pressing "Connect
// Discord & Join" on the success screen, because that button IS the OAuth flow.
//
// Then verification started attaching Discord automatically whenever a viewer
// arrived with a dtoken (they ran /verify inside Discord, so the token already
// proves which account is theirs, and asking them to confirm it was a step
// people skipped). That change was right, but it removed the only path that
// granted the role: anyone verifying from inside Discord got linked and stayed
// role-less, while the dashboard's role check reported everything healthy,
// because hierarchy and permissions genuinely were fine. Nothing was ever
// asking Discord for the role.
//
// One implementation, called from every path that links a Discord account.
//
// Best effort by design: the verification has already been written by the time
// this runs, and a viewer who is verified must not be told they are not because
// Discord refused a role.

// One role PUT/DELETE, with retries on transient Discord failures. Discord
// occasionally answers with a 5xx (a brief server-side blip) or the request
// stalls; a single attempt then left a verified viewer without their role, and
// the log wrongly blamed the streamer's permissions. Retry ONLY the transient
// cases — a 401/403/404 (bad token, missing Manage Roles / role hierarchy, or the
// member not being in the server) will not change on a retry, so those return at
// once. 8s timeout per attempt so a stall can't hang the caller.
const RETRIABLE_STATUS = new Set([500, 502, 503, 504]);
async function roleRequest(method, guildId, discordUserId, roleId) {
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`;
  let lastStatus;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 400 * (attempt - 1))); // 400ms, 800ms backoff
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { method, headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}` }, signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) return { ok: true };
      lastStatus = r.status;
      if (!RETRIABLE_STATUS.has(r.status)) {
        const body = await r.text().catch(() => "");
        console.warn(`[discord-role] ${method} failed:`, r.status, body.slice(0, 200));
        return { ok: false, status: r.status };  // permanent for this call — don't retry
      }
      console.warn(`[discord-role] ${method} transient ${r.status} (attempt ${attempt}/3)`);
    } catch (err) {
      clearTimeout(timer);
      lastStatus = null; // network error / timeout — treat as transient
      console.warn(`[discord-role] ${method} error (attempt ${attempt}/3):`, err.message);
    }
  }
  return { ok: false, status: lastStatus }; // retries exhausted
}

/**
 * @param {object} streamerData  the streamers/{uid} document data
 * @param {string} discordUserId
 * @returns {Promise<{expected: boolean, ok: boolean, status?: number}>}
 *          `expected` is whether a role is configured at all, so callers can
 *          tell "not set up" apart from "set up and failed".
 */
async function grantVerifiedRole(streamerData, discordUserId) {
  const cfg     = (streamerData && streamerData.discordConfig && streamerData.discordConfig.verify) || {};
  const guildId = streamerData && streamerData.discordConfig && streamerData.discordConfig.guildId;
  const expected = !!(cfg.assignRole && cfg.roleId);

  if (!expected || !guildId || !discordUserId || !process.env.DISCORD_BOT_TOKEN) {
    return { expected, ok: false };
  }

  // PUT is idempotent: re-verifying someone who already holds the role is a
  // no-op, and it 404s harmlessly if they aren't in the server. The retry inside
  // rides out a transient Discord outage that would otherwise leave them role-less.
  const r = await roleRequest("PUT", guildId, discordUserId, cfg.roleId);
  return r.ok ? { expected, ok: true } : { expected, ok: false, ...(r.status ? { status: r.status } : {}) };
}

/**
 * Take the verified role back off a member.
 *
 * Needed wherever a verification is undone, because otherwise a viewer could
 * move one casino account between several Kick accounts and keep the role each
 * time, ending up with the verified role on several Discord accounts from a
 * single casino account. Same best-effort contract as granting.
 *
 * @param {object} streamerData  the streamers/{uid} document data
 * @param {string} discordUserId
 * @returns {Promise<{expected: boolean, ok: boolean, status?: number}>}
 */
async function revokeVerifiedRole(streamerData, discordUserId) {
  const cfg     = (streamerData && streamerData.discordConfig && streamerData.discordConfig.verify) || {};
  const guildId = streamerData && streamerData.discordConfig && streamerData.discordConfig.guildId;
  const expected = !!(cfg.assignRole && cfg.roleId);

  if (!expected || !guildId || !discordUserId || !process.env.DISCORD_BOT_TOKEN) {
    return { expected, ok: false };
  }

  // DELETE is idempotent, and 404s harmlessly when they have already left or
  // never held the role. Same transient-retry contract as granting.
  const r = await roleRequest("DELETE", guildId, discordUserId, cfg.roleId);
  if (r.ok || r.status === 404) return { expected, ok: true };
  return { expected, ok: false, ...(r.status ? { status: r.status } : {}) };
}

module.exports = { grantVerifiedRole, revokeVerifiedRole };
