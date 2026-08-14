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

// The two standings sources name their columns differently: portal-data returns
// name/wagerAmount, /api/leaderboard-live returns username/wagered. Read both, or
// an extra board posts a table of blank names.
const rowName = (r) => String(r.name || r.username || "");
const rowAmt  = (r) => Number(r.wagerAmount != null ? r.wagerAmount : r.wagered) || 0;

// Monospace block so columns line up in any Discord client.
// `label` names the board when this is an extra board rather than the main one.
function buildEmbed(cfg, streamer, board, label) {
  const rows  = (board.rankings || []).slice(0, MAX_ROWS);
  const nameW = Math.max(...rows.map((r) => rowName(r).length), 4);
  const lines = rows.map((r, i) => {
    const rank = String(i + 1).padStart(2, " ");
    const name = rowName(r).padEnd(nameW, " ");
    const amt  = money(rowAmt(r));
    return `${rank}. ${name}  ${amt.padStart(10, " ")}`;
  });

  const total = (board.rankings || []).reduce((s, r) => s + rowAmt(r), 0);

  const who   = streamer.displayName || streamer.kickChannel;
  const title = cfg.title || (label
    ? `${who} ${label} Race — Live Standings`
    : `${who} Wager Race — Live Standings`);
  const bits  = [];
  const on = board.casinoName || label || streamer.activeProvider;
  if (on) bits.push(`on ${on}`);
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

// Builds and posts standings for one board.
//
// `boardDoc` is a leaderboards/{id} snapshot for an EXTRA board, or null for the
// streamer's main board. The two keep their config in different places on
// purpose: the main board's lives on the streamer doc, where it always has, and
// not every streamer running auto-post even has a board doc (thetiltbros has
// none). Inventing one just to hold a Discord setting would change what his
// portal and /lb serve, which is too much blast radius for a posting feature.
//
// Returns { ok } or { ok:false, error }.
async function postStandings(doc, boardDoc = null) {
  const s = doc.data();
  const b = boardDoc ? (boardDoc.data() || {}) : null;
  const cfg = b ? (b.discordPost || {}) : (s.lbDiscordPost || {});

  // Extra boards carry their own channel; falling back to the main one means a
  // half-filled form posts somewhere sensible instead of failing silently.
  const channelId = (b ? cfg.channelId : null) || (s.discordConfig || {}).lbChannelId;
  if (!channelId) return { ok: false, error: "No Discord channel picked for standings." };

  const channel = String(s.kickChannel || "").toLowerCase();
  if (!channel) return { ok: false, error: "No Kick channel on this account." };

  const label = b ? (b.label || b.provider || "") : "";
  let board = null;
  try {
    // Main board reads the portal payload it always has. An extra board asks
    // leaderboard-live for its own casino, which applies that board's period.
    const url = b
      ? `${ORIGIN}/api/leaderboard-live?channel=${encodeURIComponent(channel)}&casino=${encodeURIComponent(b.provider || "")}&internal=1`
      : `${ORIGIN}/api/portal-data?channel=${encodeURIComponent(channel)}`;
    const d = await (await fetch(url)).json();
    board = b ? d : (d && d.leaderboard);
  } catch {
    return { ok: false, error: "Couldn't load the leaderboard right now." };
  }
  if (!board || !Array.isArray(board.rankings)) {
    return { ok: false, error: "No leaderboard is running for this channel yet." };
  }

  const out = await discordPost(channelId, { embeds: [buildEmbed(cfg, s, board, label)] });
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
