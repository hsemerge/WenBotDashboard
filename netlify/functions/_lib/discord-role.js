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

  try {
    // PUT is idempotent: re-verifying someone who already holds the role is a
    // no-op, and it 404s harmlessly if they aren't in the server.
    const r = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}/roles/${cfg.roleId}`,
      { method: "PUT", headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn("[discord-role] grant failed:", r.status, body.slice(0, 200));
      return { expected, ok: false, status: r.status };
    }
    return { expected, ok: true };
  } catch (err) {
    console.warn("[discord-role] grant error:", err.message);
    return { expected, ok: false };
  }
}

module.exports = { grantVerifiedRole };
