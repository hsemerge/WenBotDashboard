// Moderator feed for verifications.
//
// Posts one embed per verification into a channel the streamer picks, so mods
// and admins can see who verified, from where, and anything about it worth a
// second look.
//
// The point is the LAST part. A plain "X verified" feed is a nicer audit log at
// best. What a mod actually needs is the thing they cannot see: that this casino
// account was already claimed by somebody else last week, or that this Discord
// has now been attached to its third Kick name. Those are the multi-account
// patterns, and we already hold the data to spot them.
//
// Everything here is best-effort. A failed post, a missing channel, a Discord
// outage: none of it may break a verification that has already been written.
const { CASINO_NAMES } = require("./casinos");

const GREEN = 0x00ff88;   // clean
const AMBER = 0xffa726;   // worth a look
const GREY  = 0x8b949e;   // informational only

async function discordPost(channelId, body) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method:  "POST",
    headers: {
      "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Discord ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
}

/**
 * Look for things a moderator would want flagged.
 *
 * Scoped to THIS streamer's own records. Deliberately not cross-channel: another
 * streamer's verified list is their data, and "this person is also in someone
 * else's community" is not misconduct.
 *
 * @returns {Promise<string[]>} human sentences, empty when nothing stands out
 */
async function detectAnomalies(db, uid, v) {
  const notes = [];
  const kickKey = (v.kickUsername || "").toLowerCase();
  const col = db.collection("streamers").doc(uid).collection("verified_users");

  // ── The casino account is already somebody else's ──────────────────────────
  // The strongest signal we can produce. One casino account verified under two
  // Kick names is either a shared account, a name change we did not follow, or
  // someone farming a second entry into giveaways.
  try {
    const checks = [];
    if (v.providerUid) checks.push(col.where("providerUid", "==", v.providerUid).limit(5).get());
    if (v.providerUsername) {
      checks.push(col.where("providerUsername_lower", "==", String(v.providerUsername).toLowerCase()).limit(5).get());
    }
    const snaps = await Promise.all(checks);
    const others = new Map();
    for (const s of snaps) {
      s.forEach((d) => {
        const o = d.data();
        const k = (o.kickName || "").toLowerCase();
        if (k && k !== kickKey) others.set(k, o);
      });
    }
    for (const [k, o] of others) {
      const when = o.verifiedAt ? ` on ${new Date(o.verifiedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "";
      notes.push(`This ${CASINO_NAMES[v.provider] || v.provider} account is also verified to Kick user **${o.kickName || k}**${when}.`);
    }
  } catch { /* non-fatal */ }

  // ── The Discord account has been on another Kick name ──────────────────────
  // A second account made by the same person usually reuses the same Discord,
  // because that is the part they cannot easily duplicate.
  try {
    if (v.discordUserId) {
      const links = await db.collection("streamers").doc(uid).collection("discord_links").get();
      const prior = links.docs
        .filter((d) => d.id === String(v.discordUserId))
        .map((d) => d.data())
        .filter((d) => (d.kickUsername || "").toLowerCase() !== kickKey);
      for (const p of prior) {
        notes.push(`This Discord was previously linked to Kick user **${p.kickUsername}**.`);
      }
    }
  } catch { /* non-fatal */ }

  // ── They already had a different casino account here ───────────────────────
  // Usually innocent (a typo being corrected, a genuine account switch), but the
  // streamer should know a name changed under a record they may have paid out to.
  //
  // Read from the caller, not re-queried: verification OVERWRITES the record, so
  // by the time this runs the old name is already gone. The caller captures it
  // before the write.
  const oldName = (v.previousProviderUsername || "").toLowerCase();
  const newName = (v.providerUsername || "").toLowerCase();
  if (oldName && newName && oldName !== newName) {
    notes.push(`Changed their ${CASINO_NAMES[v.provider] || v.provider} name from **${v.previousProviderUsername}** to **${v.providerUsername}**.`);
  }

  return notes;
}

/**
 * Post the verification to the streamer's moderator channel.
 *
 * @param {object} v  { kickUsername, kickUserId, provider, providerUsername,
 *                      providerUid, underAffiliate, wagerAmount, discordUserId,
 *                      discordUsername, source, casinoSkipped }
 */
async function postVerifyLog(db, uid, streamerData, v) {
  try {
    const cfg = (streamerData.discordConfig && streamerData.discordConfig.verify) || {};
    const channelId = cfg.logChannelId;
    // Off unless a channel is chosen. No channel means the streamer never asked
    // for this, so silence is the correct behaviour.
    if (!channelId || cfg.logEnabled === false) return;
    if (!process.env.DISCORD_BOT_TOKEN) return;

    const notes = await detectAnomalies(db, uid, v);
    const casino = CASINO_NAMES[v.provider] || v.provider || "casino";

    // Status line carries the two things a mod judges at a glance: is this
    // person actually under the code, and how much have they wagered.
    let status;
    if (v.casinoSkipped)        status = "Kick only, no casino linked";
    else if (v.underAffiliate)  status = `✅ Under code${v.wagerAmount ? ` · $${Number(v.wagerAmount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} wagered` : ""}`;
    else                        status = "⏳ Not confirmed under the code yet";

    const fields = [
      { name: "Kick",    value: `[${v.kickUsername}](https://kick.com/${encodeURIComponent(v.kickUsername)})${v.kickUserId ? `\n\`${v.kickUserId}\`` : ""}`, inline: true },
      { name: casino,    value: v.casinoSkipped ? "_skipped_" : `${v.providerUsername || "?"}${v.providerUid ? `\n\`${String(v.providerUid).slice(0, 18)}\`` : ""}`, inline: true },
      { name: "Discord", value: v.discordUsername ? `@${v.discordUsername}` : "_not linked_", inline: true },
      { name: "Status",  value: status, inline: false },
      { name: "Came from", value: v.source || "Web link", inline: true },
    ];

    if (notes.length) {
      fields.push({ name: "⚠️ Worth a look", value: notes.map((n) => `• ${n}`).join("\n").slice(0, 1000), inline: false });
    }

    await discordPost(channelId, {
      embeds: [{
        // Their name leads, because that is what a mod is scanning for.
        title: `🛡️ ${v.kickUsername} verified`,
        color: notes.length ? AMBER : (v.underAffiliate ? GREEN : GREY),
        fields,
        footer: { text: notes.length ? `${notes.length} thing${notes.length === 1 ? "" : "s"} to check` : "Nothing unusual" },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (err) {
    // Never surfaces to the viewer. Their verification already succeeded.
    console.warn("[verify-log] post failed:", err.message);
  }
}

module.exports = { postVerifyLog, detectAnomalies };
