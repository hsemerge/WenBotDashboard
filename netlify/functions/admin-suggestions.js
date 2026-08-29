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
        discordReplies: x.discordReplies || 0,
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

    const dget = async (path) => {
      const r = await fetch(`https://discord.com/api/v10${path}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      });
      return { ok: r.ok, status: r.status, json: r.ok ? await r.json().catch(() => null) : null };
    };

    // What kind of channel is this? A FORUM holds posts as THREADS, and asking
    // it for messages returns an empty list — which is why importing a forum
    // reported "0 messages read" while looking perfectly healthy.
    let chan;
    try {
      const c = await dget(`/channels/${channelId}`);
      if (c.status === 403) return res(400, { error: "The bot can't see that channel. Give it View Channel + Read Message History." });
      if (c.status === 404) return res(400, { error: "No such channel — check the ID." });
      if (!c.ok) return res(400, { error: `Discord said ${c.status} when reading the channel.` });
      chan = c.json || {};
    } catch (e) {
      return res(500, { error: "Could not reach Discord: " + e.message });
    }
    const IS_FORUM = chan.type === 15 || chan.type === 16;   // GUILD_FORUM / GUILD_MEDIA
    const guildId  = chan.guild_id || "@me";

    // Normalised list of candidates, whichever kind of channel this is.
    // { id, title, body, author, up, at }
    const items = [];
    let scanned = 0;

    try {
      if (IS_FORUM) {
        // Posts live as threads: active ones come from the guild, archived ones
        // from the channel. A busy forum has most of its history archived, so
        // both are needed or the import silently sees only recent posts.
        const threads = [];
        const act = await dget(`/guilds/${guildId}/threads/active`);
        if (act.ok && act.json && Array.isArray(act.json.threads)) {
          threads.push(...act.json.threads.filter((t) => t.parent_id === channelId));
        }
        const arc = await dget(`/channels/${channelId}/threads/archived/public?limit=100`);
        if (arc.status === 403) return res(400, { error: "The bot needs Read Message History on that forum to see older posts." });
        if (arc.ok && arc.json && Array.isArray(arc.json.threads)) threads.push(...arc.json.threads);

        scanned = threads.length;
        for (const t of threads.slice(0, 50)) {
          // The post's opening message shares the thread's id. It can be gone
          // (deleted starter) — the post still counts, just with no body.
          let starter = null;
          const sm = await dget(`/channels/${t.id}/messages/${t.id}`);
          if (sm.ok) starter = sm.json;
          const parsed = starter ? fromDiscord(starter) : null;
          items.push({
            id: t.id,
            title: String(t.name || (parsed && parsed.title) || "Untitled post").slice(0, 200),
            // The thread name is already the title, so the starter message is
            // all body — don't drop its first line the way a text post does.
            body: starter ? String(starter.content || "").slice(0, MAX_BODY) || (parsed ? parsed.body : null) : null,
            author: (starter && starter.author && (starter.author.global_name || starter.author.username)) || null,
            up: parsed ? parsed.up : 0,
            replies: Number(t.message_count || 0),
            at: (t.thread_metadata && t.thread_metadata.create_timestamp)
              ? new Date(t.thread_metadata.create_timestamp).getTime()
              : (starter && starter.timestamp ? new Date(starter.timestamp).getTime() : Date.now()),
          });
        }
      } else {
        const r = await dget(`/channels/${channelId}/messages?limit=${limit}`);
        if (r.status === 403) return res(400, { error: "The bot can't read that channel. Give it View Channel + Read Message History." });
        if (!r.ok) return res(400, { error: `Discord said ${r.status}.` });
        const msgs = Array.isArray(r.json) ? r.json : [];
        scanned = msgs.length;
        for (const m of msgs) {
          const parsed = fromDiscord(m);
          if (!parsed) continue;
          items.push({
            id: m.id, title: parsed.title, body: parsed.body,
            author: (m.author && (m.author.global_name || m.author.username)) || null,
            up: parsed.up, replies: 0,
            at: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
          });
        }
      }
    } catch (e) {
      return res(500, { error: "Could not read from Discord: " + e.message });
    }

    const seen = new Set();
    const have = await col.where("source", "==", "discord").limit(500).get();
    have.forEach((d) => { const m = d.data().discordMessageId; if (m) seen.add(m); });

    let added = 0, skipped = 0;
    for (const it of items) {
      if (seen.has(it.id)) { skipped++; continue; }
      await col.add({
        title: it.title, body: it.body || null,
        status: "new", source: "discord",
        votes: {}, noteCount: 0,
        discordMessageId: it.id,
        discordChannelId: channelId,
        discordAuthor: it.author,
        discordUrl: `https://discord.com/channels/${guildId}/${IS_FORUM ? it.id : channelId}${IS_FORUM ? "" : "/" + it.id}`,
        discordUp: it.up,
        discordReplies: it.replies || 0,
        createdBy: me, createdAt: it.at, updatedAt: Date.now(), lastActivityAt: it.at,
      });
      added++;
    }
    // Remember the channel so the next import is one click.
    await db.collection("admin_prefs").doc("suggestions").set({ lastChannelId: channelId }, { merge: true });
    logAdminAudit(db, uid, "suggestions_import", { channelId, added, skipped, kind: IS_FORUM ? "forum" : "text" });
    return res(200, {
      ok: true, added, skipped, scanned,
      kind: IS_FORUM ? "forum" : "text",
      channelName: chan.name || null,
    });
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
