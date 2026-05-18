// Background function — processes slow Discord commands after a deferred response
// Called by discord-interaction.js; posts followup to Discord webhook

const { getDb, admin } = require("./_lib/firebase");

async function getStreamerByGuild(guildId) {
  const db   = getDb();
  const snap = await db.collection("discord_guilds").doc(guildId).get();
  if (!snap.exists) return null;
  const { uid } = snap.data();
  const profSnap = await db.collection("streamers").doc(uid).get();
  return profSnap.exists ? { uid, profile: profSnap.data() } : null;
}

async function getKickUsername(uid, discordUserId) {
  const db  = getDb();
  const doc = await db.collection("streamers").doc(uid)
    .collection("discord_links").doc(discordUserId).get();
  return doc.exists ? doc.data().kickUsername : null;
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
  return r.ok ? r.json() : null;
}

// Edit the deferred "thinking" message with the actual response
async function followup(appId, token, content, ephemeral = true) {
  await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
    method:  "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, flags: ephemeral ? 64 : 0 }),
  });
}

// ── COMMAND HANDLERS ──────────────────────────────────────────────────────────

async function handlePoints(interaction, reply) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member?.user?.id || interaction.user?.id;
  const tag     = interaction.member?.user?.username || interaction.user?.username;

  const streamer = await getStreamerByGuild(guildId);
  if (!streamer) return reply("❌ This server isn't linked to a WenBot streamer account.");

  const kickUsername = await getKickUsername(streamer.uid, userId);
  if (!kickUsername) return reply("❌ Your Discord isn't linked yet. Use `/register` to connect your account.");

  const db  = getDb();
  const doc = await db.collection("streamers").doc(streamer.uid)
    .collection("viewers").doc(kickUsername.toLowerCase()).get();
  const pts  = doc.exists ? (doc.data().points || 0) : 0;
  const name = streamer.profile?.currencyName || "points";
  reply(`💰 **@${tag}** you have **${pts.toLocaleString()} ${name}**!`);
}

async function handleStore(interaction, reply) {
  const guildId  = interaction.guild_id;
  const streamer = await getStreamerByGuild(guildId);
  if (!streamer) return reply("❌ This server isn't linked to a WenBot streamer account.");

  const db       = getDb();
  const currency = streamer.profile?.currencyName || "points";
  const snap     = await db.collection("streamers").doc(streamer.uid)
    .collection("store_items").where("enabled", "==", true).get();

  if (snap.empty) return reply("🛒 The store is currently empty.");

  const items = snap.docs.map(d => d.data()).sort((a, b) => a.price - b.price);
  const lines = items.map(item => {
    const stock = item.stock != null ? ` · ${item.stock} left` : "";
    const desc  = item.description ? ` — ${item.description}` : "";
    return `• **${item.name}** — ${item.price.toLocaleString()} ${currency}${stock}${desc}`;
  }).join("\n");

  reply(`🛒 **Store**\n\n${lines}\n\nUse \`/buy item: <name>\` to purchase.`);
}

async function handleBuy(interaction, reply) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member?.user?.id || interaction.user?.id;
  const tag     = interaction.member?.user?.username || interaction.user?.username;
  const itemId  = interaction.data.options?.find(o => o.name === "item")?.value || "";

  if (!itemId) return reply("❌ Specify an item to buy.");

  const streamer = await getStreamerByGuild(guildId);
  if (!streamer) return reply("❌ This server isn't linked to a WenBot streamer account.");

  const db = getDb();

  const [kickUsername, itemsSnap] = await Promise.all([
    getKickUsername(streamer.uid, userId),
    db.collection("streamers").doc(streamer.uid)
      .collection("store_items").where("enabled", "==", true).get(),
  ]);

  if (!kickUsername) return reply("❌ Your Discord isn't linked yet. Use `/register` to connect your account.");

  const matchDoc = itemsSnap.docs.find(d =>
    d.data().name.toLowerCase() === itemId.toLowerCase()
  );
  if (!matchDoc) return reply(`❌ Item \`${itemId}\` not found. Use \`/store\` to see available items.`);

  const item      = matchDoc.data();
  const viewerRef = db.collection("streamers").doc(streamer.uid)
    .collection("viewers").doc(kickUsername.toLowerCase());
  const viewerDoc = await viewerRef.get();
  const pts       = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;
  const currency  = streamer.profile?.currencyName || "points";

  if (pts < item.price) {
    return reply(`❌ You need **${item.price}** ${currency} but only have **${pts}**. Keep watching to earn more!`);
  }
  if (item.stock !== undefined && item.stock !== null && item.stock <= 0) {
    return reply(`❌ **${item.name}** is out of stock.`);
  }

  const batch = db.batch();
  batch.update(viewerRef, { points: pts - item.price });
  batch.set(db.collection("streamers").doc(streamer.uid).collection("store_redemptions").doc(), {
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
    batch.update(db.collection("streamers").doc(streamer.uid).collection("store_items").doc(matchDoc.id), {
      stock: item.stock - 1,
    });
  }
  await batch.commit();

  // Announce (fire and forget)
  const cfg = streamer.profile?.discordConfig || {};
  if (cfg.announcementChannelId) {
    discordPost(`/channels/${cfg.announcementChannelId}/messages`, {
      embeds: [{
        color:       0x00e5ff,
        description: `✅ **${item.name}** redeemed by <@${userId}> (Kick: \`${kickUsername}\`)`,
        timestamp:   new Date().toISOString(),
      }],
    }).catch(() => {});
  }

  reply(`✅ You've redeemed **${item.name}**! The streamer will fulfill your order shortly.`);
}

async function handleJoin(interaction, reply) {
  const guildId = interaction.guild_id;
  const userId  = interaction.member?.user?.id || interaction.user?.id;

  const streamer = await getStreamerByGuild(guildId);
  if (!streamer) return reply("❌ This server isn't linked to a WenBot streamer account.");

  const [kickUsername, profSnap] = await Promise.all([
    getKickUsername(streamer.uid, userId),
    Promise.resolve(streamer),
  ]);
  if (!kickUsername) return reply("❌ Your Discord isn't linked yet. Use `/register` to connect your account.");

  const db          = getDb();
  const profileData = streamer.profile || {};
  if (!profileData.giveawayActive) return reply("❌ There's no active giveaway right now.");

  if (profileData.giveawayType === "code") {
    return reply("❌ This giveaway requires a code. Type `!join <code>` in Kick chat.");
  }

  const entryRef = db.collection("streamers").doc(streamer.uid)
    .collection("giveaway_entries").doc(kickUsername.toLowerCase());
  const existing = await entryRef.get();
  if (existing.exists) return reply("✅ You're already in the giveaway! Good luck!");

  await entryRef.set({ username: kickUsername, joinedAt: Date.now(), source: "discord" });
  reply(`🎉 You're in! Good luck **${kickUsername}**!`);
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const key = event.headers["x-process-key"];
  if (!key || key !== process.env.WENBOT_ADMIN_KEY) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: "Bad JSON" }; }

  const { command, interaction } = body;
  if (!command || !interaction) return { statusCode: 400, body: "Missing command or interaction" };

  const appId = process.env.DISCORD_APPLICATION_ID;
  const token = interaction.token;

  const reply = (content) => followup(appId, token, content, true);

  try {
    if (command === "points") await handlePoints(interaction, reply);
    else if (command === "store") await handleStore(interaction, reply);
    else if (command === "buy")   await handleBuy(interaction, reply);
    else if (command === "join")  await handleJoin(interaction, reply);
  } catch (err) {
    console.error("discord-process error:", err);
    await followup(appId, token, "❌ Something went wrong. Please try again.", true);
  }

  return { statusCode: 200, body: "ok" };
};
