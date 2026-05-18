// POST /api/discord-interaction
// Handles all Discord slash commands and button interactions
// Verified with Ed25519 signature check (required by Discord)

const nacl = require("tweetnacl");
const { getDb, admin } = require("./_lib/firebase");

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

// ── SHARED: guild → streamer uid (1 read) ────────────────────────────────────
async function getStreamerUid(guildId) {
  const snap = await getDb().collection("discord_guilds").doc(guildId).get();
  return snap.exists ? snap.data().uid : null;
}

// ── HANDLERS ──────────────────────────────────────────────────────────────────

async function handlePoints(interaction) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member.user.id;
  const tag     = interaction.member.user.username;
  const db      = getDb();

  // Round 1: guild → uid
  const uid = await getStreamerUid(guildId);
  if (!uid) return message("❌ This server isn't linked to a WenBot streamer account.");

  // Round 2: parallel — profile + discord link
  const [profSnap, linkSnap] = await Promise.all([
    db.collection("streamers").doc(uid).get(),
    db.collection("streamers").doc(uid).collection("discord_links").doc(userId).get(),
  ]);

  if (!profSnap.exists) return message("❌ This server isn't linked to a WenBot streamer account.");
  const profile      = profSnap.data();
  const kickUsername = linkSnap.exists ? linkSnap.data().kickUsername : null;

  if (!kickUsername) {
    return message("❌ Your Discord isn't linked yet. Use `/register` to connect your account.", true);
  }

  // Round 3: viewer points
  const doc = await db.collection("streamers").doc(uid)
    .collection("viewers").doc(kickUsername.toLowerCase()).get();
  const pts  = doc.exists ? (doc.data().points || 0) : 0;
  const name = profile.currencyName || "points";

  return message(`💰 **@${tag}** you have **${pts.toLocaleString()} ${name}**!`, true);
}

async function handleStore(interaction) {
  const guildId = interaction.guild_id;
  const db      = getDb();

  // Round 1: guild → uid
  const uid = await getStreamerUid(guildId);
  if (!uid) return message("❌ This server isn't linked to a WenBot streamer account.");

  // Round 2: parallel — profile + store items
  const [profSnap, itemsSnap] = await Promise.all([
    db.collection("streamers").doc(uid).get(),
    db.collection("streamers").doc(uid).collection("store_items").where("enabled", "==", true).get(),
  ]);

  if (!profSnap.exists) return message("❌ This server isn't linked to a WenBot streamer account.");
  const currency = profSnap.data().currencyName || "points";

  if (itemsSnap.empty) return message("🛒 The store is currently empty.", true);

  const items = itemsSnap.docs.map(d => d.data()).sort((a, b) => a.price - b.price);
  const lines = items.map(item => {
    const stock = item.stock != null ? ` · ${item.stock} left` : "";
    const desc  = item.description ? ` — ${item.description}` : "";
    return `• **${item.name}** — ${item.price.toLocaleString()} ${currency}${stock}${desc}`;
  }).join("\n");

  return message(`🛒 **Store**\n\n${lines}\n\nUse \`/buy item: <name>\` to purchase.`, true);
}

async function handleBuy(interaction) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member.user.id;
  const tag     = interaction.member.user.username;
  const itemId  = interaction.data.options?.find(o => o.name === "item")?.value || "";
  const db      = getDb();

  if (!itemId) return message("❌ Specify an item to buy.", true);

  // Round 1: guild → uid
  const uid = await getStreamerUid(guildId);
  if (!uid) return message("❌ This server isn't linked to a WenBot streamer account.");

  // Round 2: parallel — profile + discord link + store items
  const [profSnap, linkSnap, itemsSnap] = await Promise.all([
    db.collection("streamers").doc(uid).get(),
    db.collection("streamers").doc(uid).collection("discord_links").doc(userId).get(),
    db.collection("streamers").doc(uid).collection("store_items").where("enabled", "==", true).get(),
  ]);

  if (!profSnap.exists) return message("❌ This server isn't linked to a WenBot streamer account.");
  const profile      = profSnap.data();
  const kickUsername = linkSnap.exists ? linkSnap.data().kickUsername : null;

  if (!kickUsername) {
    return message("❌ Your Discord isn't linked yet. Use `/register` to connect your account.", true);
  }

  const matchDoc = itemsSnap.docs.find(d =>
    d.data().name.toLowerCase() === itemId.toLowerCase()
  );
  if (!matchDoc) return message(`❌ Item \`${itemId}\` not found. Use \`/store\` to see available items.`, true);

  const item = matchDoc.data();

  if (item.stock !== undefined && item.stock !== null && item.stock <= 0) {
    return message(`❌ **${item.name}** is out of stock.`, true);
  }

  // Round 3: viewer points
  const viewerRef = db.collection("streamers").doc(uid)
    .collection("viewers").doc(kickUsername.toLowerCase());
  const viewerDoc = await viewerRef.get();
  const pts       = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;

  if (pts < item.price) {
    return message(`❌ You need **${item.price}** ${profile.currencyName || "points"} but only have **${pts}**. Keep watching to earn more!`, true);
  }

  // Round 4: batch write
  const batch = db.batch();
  batch.set(viewerRef, { points: pts - item.price }, { merge: true });
  batch.set(db.collection("streamers").doc(uid).collection("store_redemptions").doc(), {
    kickUsername,
    discordUserId:   userId,
    discordUsername: tag,
    itemId:          matchDoc.id,
    itemName:        item.name,
    pointsSpent:     item.price,
    redeemedAt:      admin.firestore.Timestamp.now(),
    status:          "pending",
    source:          "discord",
  });
  if (item.stock !== undefined && item.stock !== null) {
    batch.update(matchDoc.ref, { stock: item.stock - 1 });
  }
  await batch.commit();

  // Announce (fire and forget)
  const cfg = profile.discordConfig || {};
  if (cfg.announcementChannelId) {
    discordPost(`/channels/${cfg.announcementChannelId}/messages`, {
      embeds: [{
        color:       0x00e5ff,
        description: `✅ **${item.name}** was redeemed by <@${userId}> with Kick \`${kickUsername}\``,
        timestamp:   new Date().toISOString(),
      }],
    }).catch(() => {});
  }

  return message(`✅ You've redeemed **${item.name}**! The streamer will fulfill your order shortly.`, true);
}

async function handleJoinGiveaway(interaction) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member.user.id;
  const tag     = interaction.member.user.username;
  const db      = getDb();

  // Round 1: guild → uid
  const uid = await getStreamerUid(guildId);
  if (!uid) return message("❌ Server not linked to WenBot.");

  // Round 2: parallel — profile + giveaway state + discord link
  const [profSnap, snapDoc, linkSnap] = await Promise.all([
    db.collection("streamers").doc(uid).get(),
    db.collection("streamers").doc(uid).collection("giveaway_state").doc("snapshot").get(),
    db.collection("streamers").doc(uid).collection("discord_links").doc(userId).get(),
  ]);

  const snapshot     = snapDoc.exists ? snapDoc.data() : {};
  if (!snapshot.active) return message("❌ There's no active giveaway right now.", true);

  const profile      = profSnap.exists ? profSnap.data() : {};
  const type         = profile.giveawayType || "everyone";
  const kickUsername = linkSnap.exists ? linkSnap.data().kickUsername : null;

  if (type === "code" && !kickUsername) {
    return message("❌ This giveaway is for verified users only. Use `/register` to link your account first.", true);
  }

  const entryName = kickUsername || tag;
  const entries   = snapshot.entries || [];

  if (entries.includes(entryName)) {
    return message("✅ You're already in the giveaway! Good luck.", true);
  }

  // Round 3: add entry
  const updated = [...entries, entryName];
  await db.collection("streamers").doc(uid)
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
  const db      = getDb();

  // Round 1: guild → uid
  const uid = await getStreamerUid(guildId);
  if (!uid) return message("❌ This server isn't linked to a WenBot streamer account.", true);

  // Round 2: parallel — profile + existing link check
  const [profSnap, linkSnap] = await Promise.all([
    db.collection("streamers").doc(uid).get(),
    db.collection("streamers").doc(uid).collection("discord_links").doc(userId).get(),
  ]);

  if (!profSnap.exists) return message("❌ This server isn't linked to a WenBot streamer account.", true);
  const profile = profSnap.data();

  const channel = profile.kickChannel;
  if (!channel) return message("❌ Streamer channel not configured.", true);

  if (linkSnap.exists) {
    const existing = linkSnap.data().kickUsername;
    return message(`✅ You're already linked as Kick user **${existing}**! Use \`/points\` to check your balance.`, true);
  }

  // Round 3: write token
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const token = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");

  await db.collection("discord_verify_tokens").doc(token).set({
    discordUserId:   userId,
    discordUsername: tag,
    guildId,
    streamerUid:     uid,
    expiresAt:       Date.now() + 10 * 60 * 1000,
    used:            false,
  });

  const casino = profile.activeProvider || "gambulls";
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
    if (name === "points")   return handlePoints(body);
    if (name === "store")    return handleStore(body);
    if (name === "join")     return handleJoinGiveaway(body);
    if (name === "register") return handleRegister(body);

    // /buy deferred: trigger background function then return "thinking" immediately
    if (name === "buy") {
      const base = process.env.URL || "https://wenbot.gg";
      await fetch(`${base}/.netlify/functions/discord-process-background`, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "x-process-key": process.env.WENBOT_ADMIN_KEY,
        },
        body: JSON.stringify({ command: "buy", interaction: body }),
      }).catch(() => {});
      return respond(200, { type: 5, data: { flags: 64 } });
    }

    return message("❓ Unknown command.");
  }

  // BUTTON — Join Giveaway button
  if (body.type === 3) {
    const customId = body.data?.custom_id;
    if (customId === "join_giveaway") return handleJoinGiveaway(body);
  }

  return respond(200, { type: 1 });
};
