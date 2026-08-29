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

// Which roles a member currently holds.
//
// Returns null when we genuinely could not tell (network error, 5xx, timeout) —
// deliberately distinct from [] (they're in the server with no roles) and from
// "not a member". Callers MUST treat null as "no information" and never act on
// it, because the destructive branch of the two-role gate is removing somebody's
// access to a whole Discord server.
async function fetchMemberRoleIds(guildId, discordUserId) {
  if (!guildId || !discordUserId || !process.env.DISCORD_BOT_TOKEN) return null;
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }, signal: ctrl.signal });
    clearTimeout(timer);
    if (r.status === 404) return { notMember: true, roles: [] };
    if (!r.ok) return null;
    const m = await r.json();
    return { notMember: false, roles: Array.isArray(m.roles) ? m.roles : [] };
  } catch (e) {
    clearTimeout(timer);
    console.warn("[discord-role] member fetch failed:", e.message);
    return null;
  }
}

// The two-role gate, off unless a streamer switches it on.
//
// Discord permissions are ADDITIVE: there is no way to express "needs role A
// AND role B" with channel overrides, because either role granting View Channel
// is enough on its own. The standard answer is a third role that only a bot
// hands out once both are present, and that is what this is.
//
// `requireSecondRole` + `secondRoleId` (another bot's verified role — Double
// Counter, Wick, whatever) + `unlockRoleId` (the role the server's channels
// actually key off).
function gateCfg(cfg) {
  return {
    on:       !!(cfg.requireSecondRole && cfg.secondRoleId && cfg.unlockRoleId),
    second:   cfg.secondRoleId || null,
    unlock:   cfg.unlockRoleId || null,
  };
}

/**
 * @param {object} streamerData  the streamers/{uid} document data
 * @param {string} discordUserId
 * @returns {Promise<{expected: boolean, ok: boolean, status?: number, blocked?: string, unlocked?: boolean}>}
 *          `expected` is whether a role is configured at all, so callers can
 *          tell "not set up" apart from "set up and failed".
 *          `blocked:'needs-second-role'` means the member has not completed the
 *          other bot's verification yet — nothing was granted, and the caller
 *          should say so rather than leaving them silently locked out.
 */
async function grantVerifiedRole(streamerData, discordUserId) {
  const cfg     = (streamerData && streamerData.discordConfig && streamerData.discordConfig.verify) || {};
  const guildId = streamerData && streamerData.discordConfig && streamerData.discordConfig.guildId;
  const expected = !!(cfg.assignRole && cfg.roleId);

  if (!expected || !guildId || !discordUserId || !process.env.DISCORD_BOT_TOKEN) {
    return { expected, ok: false };
  }

  const gate = gateCfg(cfg);
  if (gate.on) {
    const member = await fetchMemberRoleIds(guildId, discordUserId);
    // Couldn't ask Discord. Grant nothing and say nothing was wrong with them —
    // the hourly sweep will settle it once Discord answers again.
    if (member === null) return { expected, ok: false, pending: true };
    if (!member.notMember && !member.roles.includes(gate.second)) {
      // They are not through the other gate yet. Withhold BOTH roles: on this
      // setting the verified role means nothing on its own, and granting it
      // would leave them looking verified while still locked out.
      return { expected, ok: false, blocked: "needs-second-role" };
    }
  }

  // PUT is idempotent: re-verifying someone who already holds the role is a
  // no-op, and it 404s harmlessly if they aren't in the server. The retry inside
  // rides out a transient Discord outage that would otherwise leave them role-less.
  const r = await roleRequest("PUT", guildId, discordUserId, cfg.roleId);
  if (!r.ok) return { expected, ok: false, ...(r.status ? { status: r.status } : {}) };

  let unlocked = false;
  if (gate.on) {
    const u = await roleRequest("PUT", guildId, discordUserId, gate.unlock);
    unlocked = u.ok;
    if (!u.ok) console.warn(`[discord-role] unlock role not granted (${u.status || "error"}) — check WenBot sits above it`);
  }
  return { expected, ok: true, ...(gate.on ? { unlocked } : {}) };
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

  // Losing the WenBot verification must also close the server. Otherwise
  // unlinking a casino account leaves the unlock role behind, which is the exact
  // hole the two-role setup exists to close.
  const gate = gateCfg(cfg);
  if (gate.on) await roleRequest("DELETE", guildId, discordUserId, gate.unlock);

  if (r.ok || r.status === 404) return { expected, ok: true };
  return { expected, ok: false, ...(r.status ? { status: r.status } : {}) };
}

/**
 * Reconcile ONE member against the two-role gate. Used by the hourly sweep for
 * the case no request can catch: they completed the other bot's verification
 * after WenBot, so nothing of ours ran at that moment.
 *
 * Returns an action so the caller can record a miss streak:
 *   'granted' | 'revoked' | 'noop' | 'unknown' | 'miss'
 *
 * REVOKING IS THE DANGEROUS DIRECTION. A Discord blip that returned a member
 * without their roles would look identical to "they lost the role", so this
 * never revokes off a failed read (`unknown`), and reports a single confirmed
 * absence as `miss` — the caller decides how many consecutive misses it takes.
 */
async function syncUnlockRole(streamerData, discordUserId, { confirmedMisses = 0 } = {}) {
  const cfg     = (streamerData && streamerData.discordConfig && streamerData.discordConfig.verify) || {};
  const guildId = streamerData && streamerData.discordConfig && streamerData.discordConfig.guildId;
  const gate    = gateCfg(cfg);
  if (!gate.on || !guildId || !discordUserId || !cfg.roleId) return { action: "noop" };

  const member = await fetchMemberRoleIds(guildId, discordUserId);
  if (member === null) return { action: "unknown" };          // never act on this
  if (member.notMember) return { action: "noop" };            // they left the server

  const hasSecond = member.roles.includes(gate.second);
  const hasUnlock = member.roles.includes(gate.unlock);

  if (hasSecond) {
    if (hasUnlock) return { action: "noop" };
    const put = await roleRequest("PUT", guildId, discordUserId, gate.unlock);
    if (!put.ok) return { action: "unknown" };
    // They passed the other gate after us — give them the verified role too, so
    // the two roles can't drift apart.
    await roleRequest("PUT", guildId, discordUserId, cfg.roleId);
    return { action: "granted" };
  }

  if (!hasUnlock) return { action: "noop" };                  // nothing to take back
  // Confirmed absent. Two agreeing reads before removing anyone's access.
  if (confirmedMisses < 1) return { action: "miss" };
  const del = await roleRequest("DELETE", guildId, discordUserId, gate.unlock);
  return { action: del.ok || del.status === 404 ? "revoked" : "unknown" };
}

module.exports = { grantVerifiedRole, revokeVerifiedRole, syncUnlockRole, fetchMemberRoleIds };
