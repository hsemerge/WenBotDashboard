// POST /api/discord-interaction
// Handles all Discord slash commands and button interactions
// Verified with Ed25519 signature check (required by Discord)

const nacl   = require("tweetnacl");
const admin  = require("firebase-admin");

// ── FIREBASE ──────────────────────────────────────────────────────────────────
function getDb() {
  if (!admin.apps.length) {
    const raw  = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
    const cred = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(cred) });
  }
  return admin.firestore();
}

// ── DISCORD SIGNATURE VERIFICATION ───────────────────────────────────────────
function verifyRequest(event) {
  const sig       = event.headers["x-signature-ed25519"];
  const timestamp = event.headers["x-signature-timestamp"];
  if (!sig || !timestamp) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + event.body),
      Buffer.from(sig, "hex"),
      Buffer.from(process.env.DISCORD_PUBLIC_KEY, "hex")
    );
  } catch {
    return false;
  }
}

// ── RESPONSE HELPERS ──────────────────────────────────────────────────────────
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function message(content, ephemeral = true) {
  return respond(200, {
    type: 4,
    data: { content, flags: ephemeral ? 64 : 0 },
  });
}

function embed(embeds, ephemeral = false) {
  return respond(200, {
    type: 4,
    data: { embeds, flags: ephemeral ? 64 : 0 },
  });
}

// ── GUILD → STREAMER LOOKUP ──────────────────────────────────────────────────
async function getStreamerByGuild(guildId) {
  const db   = getDb();
  const snap = await db.collection("discord_guilds").doc(guildId).get();
  if (!snap.exists) return null;
  const { uid } = snap.data();
  const profSnap = await db.collection("streamers").doc(uid).get();
  return profSnap.exists ? { uid, profile: profSnap.data() } : null;
}

// ── DISCORD USER → KICK USERNAME ─────────────────────────────────────────────
async function getKickUsername(uid, discordUserId) {
  const db  = getDb();
  const doc = await db.collection("streamers").doc(uid)
    .collection("discord_links").doc(discordUserId).get();
  return doc.exists ? doc.data().kickUsername : null;
}

// ── DISCORD REST HELPER ───────────────────────────────────────────────────────
async function discordPost(path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method:  "POST",
    headers: {
      "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
  });
  return r.ok ? r.json() : null;
}

// ── HANDLERS ──────────────────────────────────────────────────────────────────

async function handlePoints(interaction) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member.user.id;
  const tag     = interaction.member.user.username;

  const streamer = await getStreamerByGuild(guildId);
  if (!streamer) return message("❌ This server isn't linked to a WenBot streamer account.");

  const kickUsername = await getKickUsername(streamer.uid, userId);
  if (!kickUsername) {
    return message("❌ Your Discord isn't linked yet. Use `/register` to connect your account.", true);
  }

  const db   = getDb();
  const doc  = await db.collection("streamers").doc(streamer.uid)
    .collection("viewers").doc(kickUsername.toLowerCase()).get();
  const pts  = doc.exists ? (doc.data().points || 0) : 0;
  const name = streamer.profile?.currencyName || "points";

  return message(`💰 **@${tag}** you have **${pts.toLocaleString()} ${name}**!`, true);
}

async function handleBuy(interaction) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member.user.id;
  const tag     = interaction.member.user.username;
  const itemId  = interaction.data.options?.find(o => o.name === "item")?.value || "";

  const streamer = await getStreamerByGuild(guildId);
  if (!streamer) return message("❌ This server isn't linked to a WenBot streamer account.");

  const kickUsername = await getKickUsername(streamer.uid, userId);
  if (!kickUsername) {
    return message("❌ Your Discord isn't linked yet. Use `/register` to connect your account.", true);
  }

  if (!itemId) return message("❌ Specify an item to buy.", true);

  const db      = getDb();
  const itemDoc = await db.collection("streamers").doc(streamer.uid)
    .collection("store_items").doc(itemId).get();

  if (!itemDoc.exists) return message(`❌ Item \`${itemId}\` not found.`, true);

  const item     = itemDoc.data();
  const viewerRef = db.collection("streamers").doc(streamer.uid)
    .collection("viewers").doc(kickUsername.toLowerCase());
  const viewerDoc = await viewerRef.get();
  const pts       = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;

  if (pts < item.price) {
    return message(`❌ You need **${item.price}** ${streamer.profile?.currencyName || "points"} but only have **${pts}**. Keep watching to earn more!`, true);
  }

  if (item.stock !== undefined && item.stock <= 0) {
    return message(`❌ **${item.name}** is out of stock.`, true);
  }

  // Deduct points + add redemption
  const batch = db.batch();
  batch.update(viewerRef, { points: pts - item.price });
  batch.set(db.collection("streamers").doc(streamer.uid).collection("store_redemptions").doc(), {
    kickUsername,
    discordUserId:   userId,
    discordUsername: tag,
    itemId,
    itemName:        item.name,
    pointsSpent:     item.price,
    redeemedAt:      admin.firestore.Timestamp.now(),
    status:          "pending",
    source:          "discord",
  });
  if (item.stock !== undefined) {
    batch.update(db.collection("streamers").doc(streamer.uid).collection("store_items").doc(itemId), {
      stock: item.stock - 1,
    });
  }
  await batch.commit();

  // Announce in the store/announcement channel
  const cfg = streamer.profile?.discordConfig || {};
  if (cfg.announcementChannelId) {
    await discordPost(`/channels/${cfg.announcementChannelId}/messages`, {
      embeds: [{
        color:       0x00e5ff,
        description: `✅ **${item.name}** was redeemed by <@${userId}> with Kick \`${kickUsername}\``,
        timestamp:   new Date().toISOString(),
      }],
    });
  }

  return message(`✅ You've redeemed **${item.name}**! The streamer will fulfill your order shortly.`, true);
}

async function handleJoinGiveaway(interaction) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member.user.id;
  const tag     = interaction.member.user.username;

  const streamer = await getStreamerByGuild(guildId);
  if (!streamer) return message("❌ Server not linked to WenBot.");

  const db        = getDb();
  const snapDoc   = await db.collection("streamers").doc(streamer.uid)
    .collection("giveaway_state").doc("snapshot").get();
  const snapshot  = snapDoc.exists ? snapDoc.data() : {};

  if (!snapshot.active) return message("❌ There's no active giveaway right now.", true);

  // Check eligibility type
  const type = streamer.profile?.giveawayType || "everyone";
  let kickUsername = await getKickUsername(streamer.uid, userId);

  if (type === "code" && !kickUsername) {
    return message("❌ This giveaway is for verified users only. Use `/register` to link your account first.", true);
  }

  const entryName = kickUsername || tag;

  // Check if already entered
  const entries = snapshot.entries || [];
  if (entries.includes(entryName)) {
    return message("✅ You're already in the giveaway! Good luck.", true);
  }

  // Add entry
  const updated = [...entries, entryName];
  await db.collection("streamers").doc(streamer.uid)
    .collection("giveaway_state").doc("snapshot").update({
      entries:   updated,
      count:     updated.length,
      updatedAt: Date.now(),
    });

  return message(`🎉 You're in! Good luck **${entryName}**!`, true);
}

async function handleRegister(interaction) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member.user.id;
  const tag     = interaction.member.user.username;

  const streamer = await getStreamerByGuild(guildId);
  if (!streamer) return message("❌ This server isn't linked to a WenBot streamer account.", true);

  const channel = streamer.profile?.kickChannel;
  if (!channel) return message("❌ Streamer channel not configured.", true);

  // Check if already linked
  const existing = await getKickUsername(streamer.uid, userId);
  if (existing) {
    return message(`✅ You're already linked as Kick user **${existing}**! Use \`/points\` to check your balance.`, true);
  }

  // Generate a short-lived one-time token
  const db    = getDb();
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const token = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");

  await db.collection("discord_verify_tokens").doc(token).set({
    discordUserId:   userId,
    discordUsername: tag,
    guildId,
    streamerUid:     streamer.uid,
    expiresAt:       Date.now() + 10 * 60 * 1000,
    used:            false,
  });

  const casino = streamer.profile?.activeProvider || "gambulls";
  const url    = `https://wenbot.gg/verify.html?channel=${encodeURIComponent(channel)}&casino=${encodeURIComponent(casino)}&dtoken=${token}`;

  return message(
    `🔗 **Link your account to WenBot**\n\nClick the link below, enter your Kick username and casino username — done!\n\n${url}\n\n*This link expires in 10 minutes.*`,
    true
  );
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return respond(405, { error: "Method not allowed" });

  if (!verifyRequest(event)) return respond(401, { error: "Invalid signature" });

  let body;
  try { body = JSON.parse(event.body); } catch { return respond(400, { error: "Bad JSON" }); }

  // PING — Discord verifies the endpoint
  if (body.type === 1) return respond(200, { type: 1 });

  // SLASH COMMANDS
  if (body.type === 2) {
    const name = body.data?.name;
    if (name === "points") return handlePoints(body);
    if (name === "buy")    return handleBuy(body);
    if (name === "join")   return handleJoinGiveaway(body);
    if (name === "register") return handleRegister(body);
    return message("❓ Unknown command.");
  }

  // BUTTON — Join Giveaway button
  if (body.type === 3) {
    const customId = body.data?.custom_id;
    if (customId === "join_giveaway") return handleJoinGiveaway(body);
  }

  return respond(200, { type: 1 });
};
