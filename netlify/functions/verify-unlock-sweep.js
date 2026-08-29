// Scheduled hourly (see netlify.toml [functions."verify-unlock-sweep"]).
//
// Settles the two-role server gate for the one case no request can catch.
//
// WenBot has no Discord gateway connection — it is HTTP-interactions-only — so
// it never sees GUILD_MEMBER_UPDATE. When a member completes WenBot first and
// the OTHER bot's verification second, nothing of ours runs at the moment the
// second role appears. This is what notices.
//
// Deliberately NARROW. It reconciles only members we already know about who are
// in a state worth re-checking, not the whole server:
//   • verified with WenBot, waiting on the other bot  → grant when it shows up
//   • already unlocked                                → confirm they still qualify
// Walking every member would need the privileged Server Members intent and a
// list call per guild; this needs neither.
//
// REVOKING IS THE DANGEROUS DIRECTION. A Discord outage that answered without a
// member's roles is indistinguishable from "they lost the role", and acting on
// it would lock a whole community out at once. So: never act on a failed read,
// and require TWO consecutive confirmed absences (tracked as unlockMissStreak on
// the verified_users doc) before removing anybody's access. Granting is the
// cheap direction and happens on the first confirmation.

const { getDb } = require("./_lib/firebase");
const { syncUnlockRole } = require("./_lib/discord-role");

const MAX_PER_STREAMER = 300;   // bounded work per guild per run

exports.handler = async () => {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.warn("[unlock-sweep] no DISCORD_BOT_TOKEN — skipped");
    return { statusCode: 200, body: JSON.stringify({ skipped: "no bot token" }) };
  }
  const db = getDb();

  let guilds = 0, checked = 0, granted = 0, revoked = 0, unknown = 0;

  try {
    const snap = await db.collection("streamers").get();
    for (const doc of snap.docs) {
      const s = doc.data();
      const cfg = (s.discordConfig && s.discordConfig.verify) || {};
      // Only streamers who actually switched the gate on.
      if (!(cfg.requireSecondRole && cfg.secondRoleId && cfg.unlockRoleId && cfg.roleId)) continue;
      if (!(s.discordConfig && s.discordConfig.guildId)) continue;
      guilds++;

      let members;
      try {
        members = await doc.ref.collection("verified_users")
          .where("discordUserId", "!=", null).limit(MAX_PER_STREAMER).get();
      } catch (e) {
        // The inequality needs an index on some projects; fall back to a plain
        // read and filter in JS rather than skipping the guild entirely.
        try {
          members = await doc.ref.collection("verified_users").limit(MAX_PER_STREAMER).get();
        } catch (e2) { console.warn("[unlock-sweep] members read failed", doc.id, e2.message); continue; }
      }

      for (const m of members.docs) {
        const v = m.data();
        const discordUserId = v.discordUserId;
        if (!discordUserId) continue;
        checked++;

        const streak = Number(v.unlockMissStreak || 0);
        const r = await syncUnlockRole(s, discordUserId, { confirmedMisses: streak });

        if (r.action === "granted") {
          granted++;
          if (streak) await m.ref.set({ unlockMissStreak: 0 }, { merge: true });
        } else if (r.action === "miss") {
          // First confirmed absence — remember it, act next run if it persists.
          await m.ref.set({ unlockMissStreak: streak + 1 }, { merge: true });
        } else if (r.action === "revoked") {
          revoked++;
          await m.ref.set({ unlockMissStreak: 0, unlockRevokedAt: Date.now() }, { merge: true });
          console.warn(`[unlock-sweep] ${s.kickChannel || doc.id}: removed unlock role from ${discordUserId} — second role gone on two consecutive checks`);
        } else if (r.action === "unknown") {
          unknown++;   // read failed; deliberately changes nothing
        } else if (streak) {
          await m.ref.set({ unlockMissStreak: 0 }, { merge: true });
        }
      }
    }
  } catch (e) {
    console.error("[unlock-sweep] failed:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  console.log(`[unlock-sweep] ${guilds} guild(s), ${checked} member(s): ${granted} unlocked, ${revoked} closed, ${unknown} unreadable`);
  return { statusCode: 200, body: JSON.stringify({ guilds, checked, granted, revoked, unknown }) };
};
