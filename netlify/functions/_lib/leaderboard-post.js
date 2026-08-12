// Shared by leaderboard-discord-cron (scheduled) and leaderboard-discord-post
// (the dashboard's "Post one now"). Netlify blocks HTTP invocation of any
// function carrying a `schedule`, so the two entry points must be separate
// files — this keeps them rendering an identical embed.

const ORIGIN   = process.env.URL || "https://wenbot.gg";
const MAX_ROWS = 10;

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

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
  let msg = text.slice(0, 180);
  try { const j = JSON.parse(text); if (j.message) msg = `${j.message} (code ${j.code})`; } catch {}
  return { ok: false, status: r.status, error: msg };
}

// Monospace block so columns line up in any Discord client.
function buildEmbed(cfg, streamer, board) {
  const rows  = (board.rankings || []).slice(0, MAX_ROWS);
  const nameW = Math.max(...rows.map((r) => String(r.name || "").length), 4);
  const lines = rows.map((r, i) => {
    const rank = String(i + 1).padStart(2, " ");
    const name = String(r.name || "").padEnd(nameW, " ");
    const amt  = money(r.wagerAmount != null ? r.wagerAmount : r.wagered);
    return `${rank}. ${name}  ${amt.padStart(10, " ")}`;
  });

  const total = (board.rankings || []).reduce(
    (s, r) => s + (Number(r.wagerAmount != null ? r.wagerAmount : r.wagered) || 0), 0);

  const title = cfg.title || `${streamer.displayName || streamer.kickChannel} Wager Race — Live Standings`;
  const bits  = [];
  if (streamer.activeProvider) bits.push(`on ${streamer.activeProvider}`);
  bits.push(`every ${cfg.everyHours || 5}h`);

  return {
    title: `🏆 ${title}`.slice(0, 250),
    color: 0xffc93c,
    description: lines.length ? "```\n" + lines.join("\n") + "\n```" : "_No wagers on the board yet._",
    fields: [
      { name: "Players",       value: String((board.rankings || []).length), inline: true },
      { name: "Total wagered", value: money(total), inline: true },
    ],
    footer: { text: bits.filter(Boolean).join(" • ") },
    timestamp: new Date().toISOString(),
  };
}

// Builds and posts for one streamer doc. Returns { ok } or { ok:false, error }.
async function postStandings(doc) {
  const s   = doc.data();
  const cfg = s.lbDiscordPost || {};
  const channelId = (s.discordConfig || {}).lbChannelId;
  if (!channelId) return { ok: false, error: "No Discord channel picked for standings." };

  const channel = String(s.kickChannel || "").toLowerCase();
  if (!channel) return { ok: false, error: "No Kick channel on this account." };

  let board = null;
  try {
    const r = await fetch(`${ORIGIN}/api/portal-data?channel=${encodeURIComponent(channel)}`);
    const d = await r.json();
    board = d && d.leaderboard;
  } catch {
    return { ok: false, error: "Couldn't load the leaderboard right now." };
  }
  if (!board || !Array.isArray(board.rankings)) {
    return { ok: false, error: "No leaderboard is running for this channel yet." };
  }

  const out = await discordPost(channelId, { embeds: [buildEmbed(cfg, s, board)] });
  if (!out.ok) {
    return {
      ok: false,
      status: out.status,
      error: out.status === 403
        ? "WenBot can't post in that channel — check its permissions."
        : (out.error || "Discord rejected the post."),
    };
  }
  return { ok: true };
}

module.exports = { postStandings, buildEmbed, discordPost, money };
