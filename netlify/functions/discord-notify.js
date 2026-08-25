// POST /api/discord-notify (internal — called by other functions/dashboard actions)
// Sends embeds to a streamer's configured Discord channels
// Body: { uid, type, data }
//
// Which channel an event lands in is decided by _lib/discord-events.js, not here:
// the streamer's per-event route wins, otherwise the event's bucket (the Giveaway
// or Announcements dropdown). Adding an event = a catalogue entry + a builder.

const { getDb, admin } = require("./_lib/firebase");
const { CASINO_NAMES } = require("./_lib/casinos");
const { resolveDiscordRoute } = require("./_lib/discord-events");

// Local res() — no CORS header (internal-only endpoint, not called from browser)
function res(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function discordPost(path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method:  "POST",
    headers: {
      "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Discord API ${r.status}: ${err}`);
  }
  return r.json();
}

const streamerName = (profile) =>
  profile?.displayName || profile?.kickChannel || "the streamer";

// Appended to the "come watch" embeds. Omitted entirely when no Kick channel is
// set, rather than linking kick.com/undefined.
function watchLine(profile) {
  return profile?.kickChannel
    ? `\n\n[▶ Watch on Kick](https://kick.com/${encodeURIComponent(profile.kickChannel)})`
    : "";
}

function buildGiveawayStartEmbed(data, profile) {
  const type      = data.type || "code";
  const keyword   = data.keyword || "!join";
  const typeLabel = type === "everyone" ? "Open to everyone" : "Verified users only";
  // Use the streamer's actual casino (proper-cased). If none is set, omit the
  // field entirely rather than mislabel it as Gambulls.
  const provider     = (profile?.activeProvider || "").toLowerCase();
  const platformName = provider ? (CASINO_NAMES[provider] || provider) : null;

  // A DISCORD-type giveaway is entered with the Join button on this card. A KICK
  // (stream) giveaway is entered IN KICK CHAT — its Discord post is only a
  // heads-up, with NO button (which would let a Discord tap skip the Kick-side
  // eligibility rules), just the keyword and a link to the stream.
  const isDiscord  = data.target === "discord";
  const howToEnter = isDiscord
    ? "Click the **Join Giveaway** button below."
    : `Head to Kick chat and type \`${keyword}\` to enter.${watchLine(profile)}`;

  return {
    color:       0x00e5ff,
    title:       "🎉 Giveaway is LIVE!",
    description: `A new giveaway has started on **${profile?.displayName || profile?.kickChannel || "stream"}**!`,
    fields: [
      { name: "Eligibility", value: typeLabel, inline: true },
      ...(platformName ? [{ name: "Platform", value: platformName, inline: true }] : []),
      { name: "How to enter", value: howToEnter, inline: false },
    ],
    footer:    { text: "WenBot • Giveaway" },
    timestamp: new Date().toISOString(),
  };
}

function buildGiveawayWinnerEmbed(data, profile) {
  return {
    color:       0xffd700,
    title:       "🏆 We have a winner!",
    description: `**${data.winner}** has won the giveaway on **${profile?.displayName || profile?.kickChannel || "stream"}**!`,
    fields:      [{ name: "Total entries", value: String(data.totalEntries || 0), inline: true }],
    footer:      { text: "WenBot • Giveaway" },
    timestamp:   new Date().toISOString(),
  };
}

function buildRedemptionEmbed(data) {
  return {
    color:       0x00ff88,
    description: `✅ **${data.itemName}** was redeemed by **${data.kickUsername}**`,
    footer:      { text: "WenBot • Store" },
    timestamp:   new Date().toISOString(),
  };
}

function buildHuntStartEmbed(data, profile) {
  const cost = Number(data?.totalCost) || 0;
  return {
    color:       0xffd700,
    title:       "🎰 Bonus Hunt is LIVE!",
    description: `**${streamerName(profile)}** just started a bonus hunt with a `
      + `**$${cost.toLocaleString()}** start balance.` + watchLine(profile),
    footer:      { text: "WenBot • Bonus Hunt" },
    timestamp:   new Date().toISOString(),
  };
}

function buildGtbOpenEmbed(data, profile) {
  const keyword = data?.keyword || "!gtb";
  return {
    color:       0x9b6bff,
    title:       "🎲 Guess the Balance is OPEN!",
    description: `Guessing is live on **${streamerName(profile)}**'s stream — `
      + `how much will the bonus hunt finish on?` + watchLine(profile),
    fields: [
      { name: "How to guess", value: `Type \`${keyword} <amount>\` in Kick chat — e.g. \`${keyword} 4250\``, inline: false },
    ],
    footer:    { text: "WenBot • Guess the Balance" },
    timestamp: new Date().toISOString(),
  };
}

function buildGtbWinnerEmbed(data, profile) {
  const guess  = Number(data?.guess)  || 0;
  const actual = Number(data?.actual) || 0;
  const diff   = Math.abs(guess - actual);
  return {
    color:       0xffd700,
    title:       "🎲 GTB winner!",
    description: `**${data?.winner || "Someone"}** had the closest guess on `
      + `**${streamerName(profile)}**'s bonus hunt.`,
    fields: [
      { name: "Their guess",     value: `$${guess.toLocaleString()}`,  inline: true },
      { name: "Actual balance",  value: `$${actual.toLocaleString()}`, inline: true },
      { name: "Off by",          value: `$${diff.toLocaleString()}`,   inline: true },
    ],
    footer:    { text: "WenBot • Guess the Balance" },
    timestamp: new Date().toISOString(),
  };
}

function buildSlotRequestEmbed(data) {
  const bet = Number(data?.betSize) || 0;
  return {
    color:       0x9b6bff,
    description: `\u{1F3B0} **${data?.slotName || "A slot"}** requested by **${data?.kickUsername || "a viewer"}**`
      + (bet ? `\n\u{1F4B5} Bet size: $${bet.toLocaleString()}` : ""),
    footer:      { text: "WenBot \u2022 Slot Requests" },
    timestamp:   new Date().toISOString(),
  };
}

// ── Mod-log winner: red-flag detection ──────────────────────────────────────
// Compute the flags to surface on a giveaway winner for the staff channel:
// verification status, and whether they share a connection fingerprint (a salted
// IP hash — never the raw IP) with other verified accounts. A lone fingerprint
// match is "shared connection"; a match that ALSO shares a Discord or casino
// account is "likely alt" (the same tiering the /lookup command uses). Best
// effort — a read failure just yields fewer flags, never a failed post.
async function computeWinnerFlags(db, uid, winnerName) {
  const out = { verified: false, underCode: false, provider: null,
                sharedCount: 0, likelyAlt: false, sharedNames: [], newAccount: false };
  const kickKey = String(winnerName || "").toLowerCase().trim();
  if (!kickKey) return out;
  try {
    const ver = await db.collection("streamers").doc(uid).collection("verified_users")
      .where("kickName_lower", "==", kickKey).get();
    const recs   = ver.docs.map((d) => d.data());
    const casino = recs.find((r) => r.provider && r.provider !== "none");
    out.verified = recs.length > 0;
    if (casino) { out.provider = casino.provider; out.underCode = !!casino.underAffiliate; }

    const cur = casino || recs[0];
    if (cur && cur.connHash) {
      const cs = await db.collection("streamers").doc(uid).collection("verified_users")
        .where("connHash", "==", cur.connHash).get();
      const members = new Map();
      cs.forEach((d) => {
        const o = d.data();
        const k = (o.kickName_lower || "").toLowerCase();
        if (!k || k === kickKey) return;
        const m = members.get(k) || { name: o.kickName || k, sharesDiscord: false, sharesCasino: false };
        if (cur.discordUserId && o.discordUserId && String(o.discordUserId) === String(cur.discordUserId)) m.sharesDiscord = true;
        const sameName = o.providerUsername_lower && cur.providerUsername_lower && o.providerUsername_lower === cur.providerUsername_lower;
        const sameUid  = o.providerUid && cur.providerUid && String(o.providerUid) === String(cur.providerUid);
        if (sameName || sameUid) m.sharesCasino = true;
        members.set(k, m);
      });
      const arr = [...members.values()];
      out.sharedCount = arr.length;
      out.sharedNames = arr.slice(0, 8).map((m) => m.name);
      out.likelyAlt   = arr.some((m) => m.sharesDiscord || m.sharesCasino);
    }
  } catch (e) { console.warn("[discord-notify] winner flags failed:", e.message); }

  // New-account (bot) signal from the linked Discord, if any. Isolated so a bad
  // snowflake never wipes the flags gathered above.
  try {
    const dl = await db.collection("streamers").doc(uid).collection("discord_links")
      .where("kickUsername", "==", winnerName).limit(1).get();
    if (!dl.empty) {
      const created = Number(BigInt(dl.docs[0].id) >> 22n) + 1420070400000; // Discord epoch
      if (created && (Date.now() - created) < 14 * 24 * 60 * 60 * 1000) out.newAccount = true;
    }
  } catch { /* no linked Discord / unparseable id — not a new-account flag */ }
  return out;
}

function buildGiveawayWinnerModEmbed(data, profile, flags) {
  const f = flags || {};
  const anyFlag = f.likelyAlt || f.sharedCount > 0 || !f.verified || !f.underCode || f.newAccount;
  // Red = likely alt, amber = something to look at, green = clean.
  const color = f.likelyAlt ? 0xed4245 : anyFlag ? 0xfaa61a : 0x57f287;

  const lines = [];
  if (f.likelyAlt) {
    lines.push(`❗ **Likely alt / multi-account** — shares a connection **and** a Discord/casino account with ${f.sharedCount} other verified account${f.sharedCount === 1 ? "" : "s"}.`);
  } else if (f.sharedCount > 0) {
    lines.push(`⚠️ **Shared connection** — same network fingerprint as ${f.sharedCount} other verified account${f.sharedCount === 1 ? "" : "s"} (could be a shared home).`);
  }
  if (!f.verified)      lines.push(`🤖 **Not verified** — no Kick/casino verification on record.`);
  else if (!f.underCode) lines.push(`↔️ Verified, but **not under your code**.`);
  if (f.newAccount)     lines.push(`🆕 **New Discord account** (created less than 14 days ago).`);
  if (!lines.length)    lines.push(`✅ No red flags detected.`);

  const fields = [{ name: "Total entries", value: String(data.totalEntries || 0), inline: true }];
  if (f.provider) fields.push({ name: "Verified on", value: `${f.provider}${f.underCode ? " (under code)" : ""}`, inline: true });
  if (f.sharedNames && f.sharedNames.length) {
    fields.push({
      name:  "Shares a connection with",
      value: f.sharedNames.join(", ") + (f.sharedCount > f.sharedNames.length ? ", …" : ""),
      inline: false,
    });
  }

  return {
    color,
    title:       "🏆 Winner drawn — mod review",
    description: `**${data.winner}** won on **${profile?.displayName || profile?.kickChannel || "stream"}**.\n\n${lines.join("\n")}`,
    fields,
    footer:      { text: "WenBot • Giveaway (staff only)" },
    timestamp:   new Date().toISOString(),
  };
}

// One builder per event key. `components` is optional — only the giveaway entry
// card needs a button.
const EMBED_BUILDERS = {
  giveaway_start:   buildGiveawayStartEmbed,
  giveaway_winner:  buildGiveawayWinnerEmbed,
  hunt_start:       buildHuntStartEmbed,
  gtb_open:         buildGtbOpenEmbed,
  gtb_winner:       buildGtbWinnerEmbed,
  slot_request:     buildSlotRequestEmbed,
  store_redemption: buildRedemptionEmbed,
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  // Auth: Firebase ID token from dashboard (streamer must be signed in)
  const authHeader = event.headers["authorization"] || "";
  const idToken    = authHeader.replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }

  const { type, data } = body;
  if (!type) return res(400, { error: "Missing type" });

  // Verify Firebase ID token to get uid. body.uid lets a moderator / agency
  // admin (delegatedFor claim) notify the MANAGED streamer's Discord — without
  // it, a mod running a giveaway posted to their own server (or nowhere).
  const db = getDb();
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const requested = body.uid || decoded.uid;
    const delegated = Array.isArray(decoded.delegatedFor) && decoded.delegatedFor.includes(requested);
    if (requested !== decoded.uid && !delegated) {
      return res(403, { error: "You don't have access to that account." });
    }
    uid = requested;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  const profSnap = await db.collection("streamers").doc(uid).get();
  if (!profSnap.exists) return res(404, { error: "Streamer not found" });

  const profile = profSnap.data();
  const cfg     = profile.discordConfig || {};

  if (!cfg.guildId) return res(200, { skipped: "No Discord configured for this streamer" });

  const isModWinner = type === "giveaway_winner_mod";
  const build = EMBED_BUILDERS[type];
  if (!build && !isModWinner) return res(400, { error: `Unknown notify type: ${type}` });

  // Per-event route wins, then the event's bucket channel, then nothing. An
  // event the streamer switched off, or one whose bucket was never picked, is a
  // skip rather than a misfile into whichever channel happens to be set. The
  // mod-log winner is mustRoute, so this also guards it from ever posting to a
  // viewer-facing default channel.
  const route = resolveDiscordRoute(cfg, type);
  if (!route.enabled) return res(200, { skipped: route.reason });

  let payload;
  if (isModWinner) {
    // Detailed staff card: compute the winner's red flags, then attach a
    // Show-more button (handled by WenBotServer) that posts the full lookup into
    // this private channel for the whole staff to see.
    const flags = await computeWinnerFlags(db, uid, data.winner);
    payload = { embeds: [buildGiveawayWinnerModEmbed(data, profile, flags)] };
    payload.components = [{
      type: 1,
      components: [{
        type: 2, style: 2,   // grey / secondary
        label: "🔍 Show more",
        custom_id: `gwlookup:${String(data.winner || "").slice(0, 80)}`,
      }],
    }];
  } else {
    payload = { embeds: [build(data, profile)] };
    // The Join button belongs ONLY on a Discord-type giveaway. A Kick giveaway's
    // Discord post is a heads-up; entry must happen in Kick chat where the
    // eligibility rules (follow date, subs-only, verified, wager) can be enforced.
    if (type === "giveaway_start" && data.target === "discord") {
      payload.components = [{
        type:       1,
        components: [{
          type:      2,
          style:     1,
          label:     "🎉 Join Giveaway",
          custom_id: "join_giveaway",
        }],
      }];
    }
  }

  try {
    await discordPost(`/channels/${route.channelId}/messages`, payload);
    return res(200, { success: true });
  } catch (err) {
    console.error("[discord-notify] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
