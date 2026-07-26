// POST /api/discord-verify-diagnose
// Checks whether WenBot can actually grant the configured Verified role:
//   1. bot is in the guild
//   2. bot has Manage Roles (or Administrator)
//   3. bot's highest role sits ABOVE the target role in the hierarchy
//   4. target role still exists (not deleted / not @everyone / not managed)
// Auth: Firebase ID token (same delegation rules as discord-post-gate).
// Returns { ok, problems: [..], notes: [..] } — dashboard renders them verbatim.

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");

const PERM_ADMIN        = 0x8n;
const PERM_MANAGE_ROLES = 0x10000000n;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const authHeader = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!authHeader) return res(401, { error: "Missing auth token" });

  const db = getDb();
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(authHeader);
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  let reqBody = {}; try { reqBody = JSON.parse(event.body || "{}"); } catch {}
  const ownerUid  = (reqBody.uid || decoded.uid);
  const delegated = Array.isArray(decoded.delegatedFor) && decoded.delegatedFor.includes(ownerUid);
  if (ownerUid !== decoded.uid && !delegated) {
    return res(403, { error: "You don't have access to that account." });
  }

  const profSnap = await db.collection("streamers").doc(ownerUid).get();
  if (!profSnap.exists) return res(404, { error: "Streamer not found" });
  const data    = profSnap.data() || {};
  const guildId = data.discordConfig?.guildId;
  const verify  = data.discordConfig?.verify || {};
  if (!guildId) return res(400, { error: "No Discord server connected yet." });

  const botHeaders = { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}` };
  const problems = [];
  const notes    = [];

  try {
    // Bot membership + its roles. 404 here = bot kicked from the server.
    const botId = process.env.DISCORD_APPLICATION_ID;
    const [memberResp, rolesResp] = await Promise.all([
      fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${botId}`, { headers: botHeaders }),
      fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`,            { headers: botHeaders }),
    ]);

    if (memberResp.status === 404 || rolesResp.status === 403 || rolesResp.status === 404) {
      return res(200, { ok: false, problems: ["WenBot isn't in your Discord server anymore — reconnect it from the Discord card above."], notes: [] });
    }
    if (!memberResp.ok || !rolesResp.ok) {
      return res(502, { error: `Discord API error (${memberResp.status}/${rolesResp.status}) — try again in a minute.` });
    }

    const member = await memberResp.json();
    const roles  = await rolesResp.json();
    const byId   = new Map(roles.map(r => [r.id, r]));

    const botRoles = (member.roles || []).map(id => byId.get(id)).filter(Boolean);
    const botTop   = botRoles.reduce((best, r) => (r.position > (best?.position ?? -1) ? r : best), null);

    let perms = 0n;
    for (const r of botRoles) { try { perms |= BigInt(r.permissions || "0"); } catch {} }
    // @everyone perms apply to every member too.
    try { perms |= BigInt(byId.get(guildId)?.permissions || "0"); } catch {}
    const isAdmin      = (perms & PERM_ADMIN) !== 0n;
    const canManage    = isAdmin || (perms & PERM_MANAGE_ROLES) !== 0n;

    if (!canManage) {
      problems.push("WenBot is missing the **Manage Roles** permission. Server Settings → Roles → WenBot → enable Manage Roles (or re-invite the bot).");
    }

    const roleConfigured = !!(verify.assignRole && verify.roleId);
    if (!roleConfigured) {
      notes.push("Role assignment is turned off (or no role picked) in your saved settings — enable it above and Save, then run this check again.");
    } else {
      const target = byId.get(verify.roleId);
      if (!target) {
        problems.push("Your saved Verified role no longer exists in the server — pick a new one and Save.");
      } else {
        if (target.id === guildId) problems.push("The Verified role can't be @everyone — pick a real role.");
        if (target.managed) problems.push(`@${target.name} is managed by an integration — bots can't grant it. Pick a normal role.`);
        if (!isAdmin && botTop && target.position >= botTop.position) {
          problems.push(`WenBot's role (@${botTop.name}) is BELOW @${target.name} in your role list — Discord blocks the grant. Server Settings → Roles → drag @${botTop.name} above @${target.name}.`);
        }
        if (!problems.length) notes.push(`WenBot can grant @${target.name} — hierarchy and permissions look good.`);
      }
    }

    return res(200, { ok: problems.length === 0, problems, notes });
  } catch (err) {
    console.error("[discord-verify-diagnose] error:", err.message);
    return res(500, { error: "Internal error running the check." });
  }
};
