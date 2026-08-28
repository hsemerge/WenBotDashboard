// GET/POST /api/admin-outreach  (admin only — staff + owner; outreach is the
// team's core shared surface)
//
// The streamer-recruitment CRM: every prospect is one card in the top-level
// `outreach` collection (rules-locked; all access flows through here with the
// Admin SDK) with a stage, an owning team member, and an append-only notes
// timeline under outreach/{id}/notes — "where's this streamer at" lives in the
// timeline, dated and signed. Stage changes are recorded INTO the timeline
// (stageFrom/stageTo on the note), so the history of a courtship reads top to
// bottom in one place.
//
//   GET                      → { cards: [...] }   (newest activity first)
//   POST {action:'create', channel, platform?, link?, displayName?, stage?, owner?}
//   POST {action:'update', id, fields:{stage?, owner?, channel?, platform?, link?, displayName?, streamerUid?}}
//   POST {action:'note',   id, text}
//   POST {action:'notes',  id}                    → { notes: [...] } (oldest first)
//   POST {action:'delete', id}
//
// Conventions match the rest of the admin surface: Date.now() ms timestamps,
// admin email as the human id, audit entries for anything a teammate would want
// to see in the activity feed.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const STAGES = ["lead", "contacted", "replied", "negotiating", "trial", "won", "lost"];
const MAX_NOTE = 2000;

const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_outreach", 60, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });
  const me = adminUser.email || adminUser.uid;

  const col = db.collection("outreach");

  if (event.httpMethod === "GET") {
    const snap = await col.orderBy("updatedAt", "desc").limit(500).get();
    return res(200, { cards: snap.docs.map((d) => ({ id: d.id, ...d.data() })), stages: STAGES });
  }

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const action = String(body.action || "").trim();

  if (action === "create") {
    const channel = clean(body.channel, 60).replace(/^@/, "");
    if (!channel) return res(400, { error: "Channel / handle is required" });
    const stage = STAGES.includes(body.stage) ? body.stage : "lead";
    const now = Date.now();
    const doc = {
      channel,
      channel_lower: channel.toLowerCase(),
      platform:    clean(body.platform, 30) || "kick",
      displayName: clean(body.displayName, 80) || null,
      link:        clean(body.link, 300) || null,
      stage,
      stageAt:     now,                       // when it entered the current stage
      owner:       clean(body.owner, 120) || me,
      streamerUid: null,                      // set when they sign up (action:update)
      createdBy:   me,
      createdAt:   now,
      updatedAt:   now,
      lastNoteSnippet: null,
      noteCount:   0,
    };
    // One card per handle — a duplicate courtship splits the timeline.
    const dup = await col.where("channel_lower", "==", doc.channel_lower).limit(1).get();
    if (!dup.empty) return res(409, { error: `"${channel}" is already on the board (${dup.docs[0].data().stage}).` });
    const ref = await col.add(doc);
    logAdminAudit(db, adminUser.uid, "outreach_create", { id: ref.id, channel, stage });
    return res(200, { ok: true, id: ref.id });
  }

  const id = String(body.id || "").trim();
  if (!id) return res(400, { error: "Missing id" });
  const ref  = col.doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Prospect not found" });
  const cur = snap.data();

  if (action === "notes") {
    const ns = await ref.collection("notes").orderBy("at", "asc").limit(300).get();
    return res(200, { notes: ns.docs.map((d) => ({ id: d.id, ...d.data() })) });
  }

  if (action === "note") {
    const text = clean(body.text, MAX_NOTE);
    if (!text) return res(400, { error: "Note text is required" });
    const at = Date.now();
    await ref.collection("notes").add({ text, by: me, at, stageFrom: null, stageTo: null });
    await ref.set({
      updatedAt: at,
      lastNoteSnippet: text.replace(/\s+/g, " ").slice(0, 100),
      noteCount: (cur.noteCount || 0) + 1,
    }, { merge: true });
    return res(200, { ok: true });
  }

  if (action === "update") {
    const f = body.fields || {};
    const update = { updatedAt: Date.now() };
    if (f.stage !== undefined) {
      if (!STAGES.includes(f.stage)) return res(400, { error: "Invalid stage" });
      if (f.stage !== cur.stage) {
        update.stage = f.stage;
        update.stageAt = Date.now();
        // The move is part of the story — record it in the timeline.
        await ref.collection("notes").add({ text: null, by: me, at: Date.now(), stageFrom: cur.stage, stageTo: f.stage });
        update.noteCount = (cur.noteCount || 0) + 1;
        logAdminAudit(db, adminUser.uid, "outreach_stage", { id, channel: cur.channel, from: cur.stage, to: f.stage });
      }
    }
    if (f.owner       !== undefined) update.owner       = clean(f.owner, 120) || me;
    if (f.channel     !== undefined) { const c = clean(f.channel, 60).replace(/^@/, ""); if (c) { update.channel = c; update.channel_lower = c.toLowerCase(); } }
    if (f.platform    !== undefined) update.platform    = clean(f.platform, 30) || "kick";
    if (f.link        !== undefined) update.link        = clean(f.link, 300) || null;
    if (f.displayName !== undefined) update.displayName = clean(f.displayName, 80) || null;
    if (f.streamerUid !== undefined) {
      update.streamerUid = clean(f.streamerUid, 60) || null;
      if (update.streamerUid) logAdminAudit(db, adminUser.uid, "outreach_link", { id, channel: cur.channel, streamerUid: update.streamerUid });
    }
    await ref.set(update, { merge: true });
    return res(200, { ok: true });
  }

  if (action === "delete") {
    if (typeof db.recursiveDelete === "function") await db.recursiveDelete(ref); else await ref.delete();
    logAdminAudit(db, adminUser.uid, "outreach_delete", { id, channel: cur.channel, stage: cur.stage });
    return res(200, { ok: true });
  }

  return res(400, { error: "Invalid action" });
};
