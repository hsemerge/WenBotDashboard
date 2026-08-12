// POST /api/bounty-post
// Body: { uid?, bountyId, action: "post" | "update" | "close" }
//
// Publishes a bounty to the streamer's Discord bounty channel and keeps that
// message in sync. Editing, completing or closing a bounty EDITS the original
// Discord message rather than posting a new one, so the channel never fills
// with stale copies and a bounty always reads as its true current state.
//
// Auth: Firebase ID token; owner-self or the delegatedFor custom claim (mods).
// Elite tier (or white-label / owner) — bounties are an Elite feature.
//
// Discord posting happens here rather than on the bot: Netlify already holds
// DISCORD_BOT_TOKEN (discord-channels.js et al), so this needs no Railway
// deploy and no dashboard→bot handoff.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

const TIER_RANK = { starter: 0, pro: 1, elite: 2, agency: 3 };
const OWNER_CHANNELS = new Set(["emergeonkick"]);

const STATUS_STYLE = {
  active:   { colour: 0xffc93c, prefix: "🏆 Challenge" },
  complete: { colour: 0x53e077, prefix: "✅ Completed" },
  closed:   { colour: 0x6b7280, prefix: "🔒 Closed" },
};

async function discordRequest(method, path, body) {
  try {
    const resp = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers: {
        "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type":  "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); if (j.message) msg = `${j.message} (code ${j.code})`; } catch {}
      console.warn(`[bounty] ${method} ${path} -> ${resp.status} ${msg}`);
      return { ok: false, status: resp.status, error: msg };
    }
    try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: {} }; }
  } catch (e) {
    console.warn("[bounty] discord request failed:", e.message);
    return { ok: false, error: "Could not reach Discord" };
  }
}

// The announcement embed. Kept deliberately plain: a streamer pastes their own
// rules in, so the only formatting we impose is the section split.
function buildEmbed(b, streamer) {
  const style = STATUS_STYLE[b.status] || STATUS_STYLE.active;
  const fields = [
    { name: "Objective", value: String(b.objective || "—").slice(0, 1024) },
    { name: "Prize",     value: String(b.prize || "—").slice(0, 1024) },
  ];
  if (b.deadline) fields.push({ name: "Deadline", value: String(b.deadline).slice(0, 1024) });

  const howTo = (b.howTo && b.howTo.trim()) ? b.howTo.trim() : [
    "• Spin + bet clearly visible on screen",
    "• Clip or VOD showing the win",
    "• No demo / hyperplay",
  ].join("\n");
  const entry = b.extraRule && b.extraRule.trim()
    ? `${howTo}\n• ${b.extraRule.trim()}`
    : howTo;
  fields.push({ name: "How to enter", value: entry.slice(0, 1024) });

  const embed = {
    title: `${style.prefix}: ${String(b.game || "Bounty").slice(0, 200)}`,
    color: style.colour,
    fields,
    footer: { text: streamer.displayName || streamer.kickChannel || "WenBot" },
    timestamp: new Date().toISOString(),
  };
  if (b.imageUrl) embed.image = { url: b.imageUrl };
  return embed;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  // getDb() initialises the Admin SDK; admin.auth() below depends on it.
  const db = getDb();

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  // Managing mode: a mod acts for an owner listed in their delegatedFor claim.
  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = String(body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) {
    return res(403, { error: "Not authorized for that account" });
  }

  const bountyId = String(body.bountyId || "").trim();
  const action   = String(body.action || "post").trim();
  if (!bountyId) return res(400, { error: "Missing bountyId" });

  if (!(await checkRateLimit(db, uid, "bounty_post", 30, 60))) {
    return res(429, { error: "Too many requests" });
  }

  try {
    const streamerRef = db.collection("streamers").doc(uid);
    const [sSnap, bSnap] = await Promise.all([
      streamerRef.get(),
      streamerRef.collection("bounties").doc(bountyId).get(),
    ]);
    if (!sSnap.exists) return res(404, { error: "Account not found" });
    if (!bSnap.exists) return res(404, { error: "Bounty not found" });

    const streamer = sSnap.data();
    const bounty   = bSnap.data();

    // Elite gate. White-label and the owner channel are comped, matching how
    // every other tier check in the codebase treats them.
    const tier = TIER_RANK[streamer.plan] ?? 0;
    const comped = streamer.whiteLabel === true
      || OWNER_CHANNELS.has(String(streamer.kickChannel || "").toLowerCase());
    if (!comped && tier < TIER_RANK.elite) {
      return res(403, { error: "Bounties are an Elite feature." });
    }

    const channelId = (streamer.discordConfig || {}).bountyChannelId;
    if (!channelId) {
      return res(400, { error: "No Discord bounty channel set. Pick one on the Bounties page." });
    }

    const embed = buildEmbed(bounty, streamer);
    const existingId = bounty.discordMessageId;

    // Edit in place when we already own a message for this bounty, so status
    // changes update the original announcement instead of stacking new ones.
    if (existingId && action !== "post") {
      const out = await discordRequest("PATCH", `/channels/${channelId}/messages/${existingId}`, { embeds: [embed] });
      if (!out.ok) {
        // The message was deleted in Discord — fall through and post a fresh
        // one rather than leaving the bounty with a dead reference.
        if (out.status !== 404) return res(502, { error: out.error || "Discord rejected the edit" });
      } else {
        await bSnap.ref.set({ discordSyncedAt: Date.now() }, { merge: true });
        return res(200, { ok: true, edited: true, messageId: existingId });
      }
    }

    const content = bounty.status === "active" ? "@here new challenge is live 👇" : null;
    const post = await discordRequest("POST", `/channels/${channelId}/messages`, {
      content: content || undefined,
      embeds:  [embed],
      allowed_mentions: { parse: ["everyone"] },
    });
    if (!post.ok) return res(502, { error: post.error || "Discord rejected the post" });

    await bSnap.ref.set({
      discordMessageId: post.data.id || null,
      discordChannelId: channelId,
      discordSyncedAt:  Date.now(),
    }, { merge: true });

    return res(200, { ok: true, posted: true, messageId: post.data.id || null });
  } catch (err) {
    console.error("[bounty-post]", err.message);
    return res(500, { error: "Internal server error" });
  }
};
