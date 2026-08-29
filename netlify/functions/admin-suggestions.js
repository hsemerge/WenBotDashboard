// GET/POST /api/admin-suggestions  (admin only — staff + owner)
//
// The product suggestion board. Feature ideas lived in a Discord channel, where
// they scrolled away and nothing could be sorted, counted or decided — so the
// only record of what people asked for was whoever remembered reading it.
//
//   GET                          → { suggestions: [...] }
//   POST {action:'create', title, body?}
//   POST {action:'vote',   id, dir:1|-1|0}      one vote per admin, 0 clears
//   POST {action:'note',   id, text}
//   POST {action:'notes',  id}   → { notes: [...] }
//   POST {action:'update', id, fields:{status?, title?, body?}}
//   POST {action:'delete', id}
//   POST {action:'import', channelId, limit?}   pull from a Discord channel
//
// Votes are stored per-admin (uid → 1/-1) rather than as a counter, so a second
// click changes your mind instead of stuffing the ballot, and `score` is kept
// denormalised alongside purely so the list can be sorted without reading every
// vote map.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const STATUSES = ["new", "planned", "in_progress", "shipped", "declined"];
const MAX_BODY = 4000;

const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const scoreOf = (votes) => Object.values(votes || {}).reduce((a, b) => a + (Number(b) || 0), 0);

// A Discord message becomes a suggestion: first line is the title, the rest is
// the body. Suggestion channels are often driven by a bot that posts embeds, so
// fall back to the embed when there's no plain content.
function fromDiscord(m) {
  let text = String(m.content || "").trim();
  if (!text && Array.isArray(m.embeds) && m.embeds.length) {
    const e = m.embeds[0] || {};
    text = [e.title, e.description].filter(Boolean).join("\n").trim();
  }
  if (!text) return null;
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const title = lines[0].slice(0, 200);
  const body  = lines.slice(1).join("\n").slice(0, MAX_BODY);
  // 👍-style reactions are the community's own vote and worth carrying over as
  // context — kept separate from the team's votes, which decide what we build.
  let up = 0;
  (m.reactions || []).forEach((r) => {
    const n = (r.emoji && r.emoji.name) || "";
    if (n.includes("👍") || n === "+1" || n === "⬆️" || n === "upvote") up += (r.count || 0);
  });
  return { title, body: body || null, up };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_suggestions", 60, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });
  const me  = adminUser.email || adminUser.uid;
  const uid = adminUser.uid;

  const col = db.collection("suggestions");

  if (event.httpMethod === "GET") {
    const snap = await col.orderBy("createdAt", "desc").limit(500).get();
    const suggestions = snap.docs.map((d) => {
      const x = d.data();
      const votes = x.votes || {};
      return {
        id: d.id,
        title: x.title, body: x.body || null,
        status: x.status || "new",
        source: x.source || "manual",
        score: scoreOf(votes),
        voters: Object.keys(votes).length,
        myVote: Number(votes[uid] || 0),      // never ship the whole vote map
        discordUrl: x.discordUrl || null,
        discordAuthor: x.discordAuthor || null,
        discordUp: x.discordUp || 0,
        noteCount: x.noteCount || 0,
        createdBy: x.createdBy || null,
        createdAt: x.createdAt || null,
        lastActivityAt: x.lastActivityAt || x.createdAt || null,
      };
    });
    return res(200, { suggestions, statuses: STATUSES });
  }

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const action = String(body.action || "").trim();

  if (action === "create") {
    const title = clean(body.title, 200);
    if (!title) return res(400, { error: "A title is required" });
    const now = Date.now();
    const ref = await col.add({
      title, body: clean(body.body, MAX_BODY) || null,
      status: "new", source: "manual",
      votes: {}, noteCount: 0,
      createdBy: me, createdAt: now, updatedAt: now, lastActivityAt: now,
    });
    logAdminAudit(db, uid, "suggestion_create", { id: ref.id, title });
    return res(200, { ok: true, id: ref.id });
  }

  // Pull a Discord channel's history onto the board. Idempotent: every imported
  // message keeps its id, and ids already on the board are skipped — so running
  // it again picks up only what's new instead of duplicating the channel.
  if (action === "import") {
    const channelId = clean(body.channelId, 40).replace(/\D/g, "");
    if (!channelId) return res(400, { error: "A Discord channel ID is required" });
    if (!process.env.DISCORD_BOT_TOKEN) return res(500, { error: "DISCORD_BOT_TOKEN is not configured" });
    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 100);

    let msgs;
    try {
      const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      });
      if (r.status === 403) return res(400, { error: "The bot can't read that channel. Give it View Channel + Read Message History." });
      if (r.status === 404) return res(400, { error: "No such channel — check the ID." });
      if (!r.ok) return res(400, { error: `Discord said ${r.status}.` });
      msgs = await r.json();
    } catch (e) {
      return res(500, { error: "Could not reach Discord: " + e.message });
    }
    if (!Array.isArray(msgs)) return res(400, { error: "Unexpected reply from Discord." });

    const seen = new Set();
    const have = await col.where("source", "==", "discord").limit(500).get();
    have.forEach((d) => { const m = d.data().discordMessageId; if (m) seen.add(m); });

    let added = 0, skipped = 0;
    for (const m of msgs) {
      if (seen.has(m.id)) { skipped++; continue; }
      const parsed = fromDiscord(m);
      if (!parsed) { skipped++; continue; }
      const at = m.timestamp ? new Date(m.timestamp).getTime() : Date.now();
      await col.add({
        title: parsed.title, body: parsed.body,
        status: "new", source: "discord",
        votes: {}, noteCount: 0,
        discordMessageId: m.id,
        discordChannelId: channelId,
        discordAuthor: (m.author && (m.author.global_name || m.author.username)) || null,
        discordUrl: `https://discord.com/channels/${m.guild_id || "@me"}/${channelId}/${m.id}`,
        discordUp: parsed.up,
        createdBy: me, createdAt: at, updatedAt: Date.now(), lastActivityAt: at,
      });
      added++;
    }
    // Remember the channel so the next import is one click.
    await db.collection("admin_prefs").doc("suggestions").set({ lastChannelId: channelId }, { merge: true });
    logAdminAudit(db, uid, "suggestions_import", { channelId, added, skipped });
    return res(200, { ok: true, added, skipped, scanned: msgs.length });
  }

  const id = clean(body.id, 60);
  if (!id) return res(400, { error: "Missing id" });
  const ref  = col.doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Suggestion not found" });
  const cur = snap.data();

  if (action === "notes") {
    const ns = await ref.collection("notes").orderBy("at", "asc").limit(300).get();
    return res(200, { notes: ns.docs.map((d) => ({ id: d.id, ...d.data() })) });
  }

  if (action === "vote") {
    const dir = Number(body.dir);
    if (![1, -1, 0].includes(dir)) return res(400, { error: "Invalid vote" });
    const votes = { ...(cur.votes || {}) };
    if (dir === 0) delete votes[uid]; else votes[uid] = dir;
    await ref.set({ votes, score: scoreOf(votes), updatedAt: Date.now() }, { merge: true });
    return res(200, { ok: true, score: scoreOf(votes), myVote: dir });
  }

  if (action === "note") {
    const text = clean(body.text, MAX_BODY);
    if (!text) return res(400, { error: "Note text is required" });
    const at = Date.now();
    await ref.collection("notes").add({ text, by: me, at });
    await ref.set({ noteCount: (cur.noteCount || 0) + 1, lastActivityAt: at, updatedAt: at }, { merge: true });
    return res(200, { ok: true });
  }

  if (action === "update") {
    const f = body.fields || {};
    const at = Date.now();
    const update = { updatedAt: at, lastActivityAt: at };
    if (f.status !== undefined) {
      if (!STATUSES.includes(f.status)) return res(400, { error: "Invalid status" });
      update.status = f.status;
      if (f.status !== cur.status) logAdminAudit(db, uid, "suggestion_status", { id, title: cur.title, from: cur.status, to: f.status });
    }
    if (f.title !== undefined) { const t = clean(f.title, 200); if (t) update.title = t; }
    if (f.body  !== undefined) update.body = clean(f.body, MAX_BODY) || null;
    await ref.set(update, { merge: true });
    return res(200, { ok: true });
  }

  if (action === "delete") {
    if (typeof db.recursiveDelete === "function") await db.recursiveDelete(ref); else await ref.delete();
    logAdminAudit(db, uid, "suggestion_delete", { id, title: cur.title });
    return res(200, { ok: true });
  }

  return res(400, { error: "Invalid action" });
};
