// Scheduled hourly (see netlify.toml [functions."leaderboard-discord-cron"]).
// Posts live wager standings to each opted-in streamer's Discord channel on
// their chosen cadence.
//
// Runs every hour and checks each streamer's own interval, rather than one
// cron per cadence — a streamer can pick 1h or 12h without new infrastructure.
//
// Standings come from /api/portal-data, which already resolves every provider
// (Duelbits, Gambulls, Rainbet, CSGOBig, Degen) and caches for 60s, so this
// adds no provider-specific logic and no meaningful load.

const { getDb, admin } = require("./_lib/firebase");

const ORIGIN = process.env.URL || "https://wenbot.gg";
const MAX_ROWS = 10;

async function discordPost(channelId, body) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true };
  const text = await r.text().catch(() => "");
  return { ok: false, status: r.status, error: text.slice(0, 180) };
}

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

// Monospace block so the columns line up in Discord regardless of client width.
function buildEmbed(cfg, streamer, board) {
  const rows = (board.rankings || []).slice(0, MAX_ROWS);
  const nameW = Math.max(...rows.map((r) => String(r.name || "").length), 4);
  const lines = rows.map((r, i) => {
    const rank = String(i + 1).padStart(2, " ");
    const name = String(r.name || "").padEnd(nameW, " ");
    return `${rank}. ${name}  ${money(r.wagerAmount != null ? r.wagerAmount : r.wagered).padStart(10, " ")}`;
  });

  const total = (board.rankings || []).reduce(
    (s, r) => s + (Number(r.wagerAmount != null ? r.wagerAmount : r.wagered) || 0), 0);

  const title = cfg.title || `${streamer.displayName || streamer.kickChannel} Wager Race — Live Standings`;
  const bits  = [];
  if (streamer.activeProvider) bits.push(`code ${cfg.code || streamer.affiliateCode || ""} on ${streamer.activeProvider}`.trim());
  bits.push(`every ${cfg.everyHours || 5}h`);

  return {
    title: `🏆 ${title}`.slice(0, 250),
    color: 0xffc93c,
    description: lines.length ? "```\n" + lines.join("\n") + "\n```" : "_No wagers on the board yet._",
    fields: [
      { name: "Players", value: String((board.rankings || []).length), inline: true },
      { name: "Total wagered", value: money(total), inline: true },
    ],
    footer: { text: bits.filter(Boolean).join(" • ") },
    timestamp: new Date().toISOString(),
  };
}

// Posts for ONE streamer. Shared by the schedule and the dashboard's
// "Post one now", so both render an identical embed.
async function postFor(doc) {
  const s   = doc.data();
  const cfg = s.lbDiscordPost || {};
  const channelId = (s.discordConfig || {}).lbChannelId;
  if (!channelId) return { ok: false, error: "No Discord channel set for standings." };

  const channel = String(s.kickChannel || "").toLowerCase();
  if (!channel) return { ok: false, error: "No Kick channel on the account." };

  let board = null;
  try {
    const r = await fetch(`${ORIGIN}/api/portal-data?channel=${encodeURIComponent(channel)}`);
    const d = await r.json();
    board = d && d.leaderboard;
  } catch (e) {
    return { ok: false, error: "Couldn't load the leaderboard." };
  }
  if (!board || !Array.isArray(board.rankings)) return { ok: false, error: "No leaderboard is running." };

  const out = await discordPost(channelId, { embeds: [buildEmbed(cfg, s, board)] });
  if (!out.ok) return { ok: false, error: out.error || "Discord rejected the post", status: out.status };
  return { ok: true };
}

exports.handler = async (event) => {
  const db = getDb();

  // Manual trigger from the dashboard. Auth'd, single streamer, ignores cadence.
  const authHeader = (event && event.headers && event.headers["authorization"]) || "";
  if (authHeader) {
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(authHeader.replace("Bearer ", "").trim()); }
    catch { return { statusCode: 401, body: JSON.stringify({ error: "Invalid auth token" }) }; }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
    const uid = String(body.uid || "").trim() || decoded.uid;
    if (uid !== decoded.uid && !delegated.includes(uid)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Not authorized for that account" }) };
    }

    const doc = await db.collection("streamers").doc(uid).get();
    if (!doc.exists) return { statusCode: 404, body: JSON.stringify({ error: "Account not found" }) };

    const out = await postFor(doc);
    if (!out.ok) return { statusCode: 400, body: JSON.stringify({ error: out.error }) };
    await doc.ref.set({ lbDiscordPost: { lastPostAt: Date.now(), lastError: null } }, { merge: true });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  let posted = 0, skipped = 0, failed = 0;

  try {
    const snap = await db.collection("streamers")
      .where("lbDiscordPost.enabled", "==", true).get();

    for (const doc of snap.docs) {
      const s   = doc.data();
      const cfg = s.lbDiscordPost || {};
      const channelId = (s.discordConfig || {}).lbChannelId;
      if (!channelId) { skipped++; continue; }

      const everyHours = Math.max(1, Math.min(Number(cfg.everyHours) || 5, 24));
      const dueAt = (cfg.lastPostAt || 0) + everyHours * 3600000;
      // 5 min of slack so an hourly tick that drifts late doesn't skip a slot.
      if (Date.now() < dueAt - 5 * 60000) { skipped++; continue; }

      const out = await postFor(doc);
      if (!out.ok) {
        console.warn(`[lb-cron] ${doc.id}: ${out.error}`);
        failed++;
        // Stamp on a permissions/missing-channel error so it doesn't retry
        // every hour forever.
        if (out.status === 403 || out.status === 404) {
          await doc.ref.set({ lbDiscordPost: { lastPostAt: Date.now(), lastError: out.error || null } }, { merge: true });
        }
        continue;
      }

      await doc.ref.set({ lbDiscordPost: { lastPostAt: Date.now(), lastError: null } }, { merge: true });
      posted++;
    }

    console.log(`[lb-cron] posted ${posted}, skipped ${skipped}, failed ${failed}`);
    return { statusCode: 200, body: JSON.stringify({ posted, skipped, failed }) };
  } catch (err) {
    console.error("[lb-cron]", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "cron failed" }) };
  }
};
