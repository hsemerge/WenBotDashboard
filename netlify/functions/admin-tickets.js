// GET/POST /api/admin-tickets  (admin only — staff + owner)
//
// The team's internal ticket queue: work the three of us assign to each other.
// Top-level `tickets` collection (rules-locked; all access flows through here
// with the Admin SDK), with a comments subcollection per ticket.
//
//   GET                        → { tickets: [...] }  open first, then by age
//   POST {action:'create', title, body?, assignee?, priority?, relatedUid?, relatedChannel?}
//   POST {action:'update', id, fields:{status?, assignee?, priority?, title?, body?, relatedUid?, relatedChannel?}}
//   POST {action:'comment', id, text}
//   POST {action:'comments', id}   → { comments: [...] } (oldest first)
//   POST {action:'delete', id}
//
// A ticket's "age" for the queue is lastActivityAt — a comment or a field change
// counts as work, so a ticket someone is actively pushing on doesn't look stale
// next to one nobody has touched in a week.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const STATUSES   = ["open", "in_progress", "blocked", "done"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const MAX_BODY   = 4000;

const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_tickets", 60, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });
  const me = adminUser.email || adminUser.uid;

  const col = db.collection("tickets");

  if (event.httpMethod === "GET") {
    const snap = await col.orderBy("lastActivityAt", "desc").limit(500).get();
    const tickets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Done sinks; everything else stays newest-activity-first (the queue order).
    tickets.sort((a, b) => {
      const ad = a.status === "done" ? 1 : 0, bd = b.status === "done" ? 1 : 0;
      return ad !== bd ? ad - bd : (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });
    return res(200, { tickets, statuses: STATUSES, priorities: PRIORITIES });
  }

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const action = String(body.action || "").trim();

  if (action === "create") {
    const title = clean(body.title, 200);
    if (!title) return res(400, { error: "Title is required" });
    const now = Date.now();
    const doc = {
      title,
      body:        clean(body.body, MAX_BODY) || null,
      status:      "open",
      priority:    PRIORITIES.includes(body.priority) ? body.priority : "normal",
      assignee:    clean(body.assignee, 120) || null,   // null = unassigned
      relatedUid:     clean(body.relatedUid, 60) || null,
      relatedChannel: clean(body.relatedChannel, 60) || null,
      createdBy:   me,
      createdAt:   now,
      updatedAt:   now,
      lastActivityAt: now,
      closedAt:    null,
      commentCount: 0,
    };
    const ref = await col.add(doc);
    logAdminAudit(db, adminUser.uid, "ticket_create", { id: ref.id, title, assignee: doc.assignee });
    return res(200, { ok: true, id: ref.id });
  }

  const id = String(body.id || "").trim();
  if (!id) return res(400, { error: "Missing id" });
  const ref  = col.doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Ticket not found" });
  const cur = snap.data();

  if (action === "comments") {
    const cs = await ref.collection("comments").orderBy("at", "asc").limit(300).get();
    return res(200, { comments: cs.docs.map((d) => ({ id: d.id, ...d.data() })) });
  }

  if (action === "comment") {
    const text = clean(body.text, MAX_BODY);
    if (!text) return res(400, { error: "Comment text is required" });
    const at = Date.now();
    await ref.collection("comments").add({ text, by: me, at, statusFrom: null, statusTo: null });
    await ref.set({ lastActivityAt: at, updatedAt: at, commentCount: (cur.commentCount || 0) + 1 }, { merge: true });
    return res(200, { ok: true });
  }

  if (action === "update") {
    const f = body.fields || {};
    const at = Date.now();
    const update = { updatedAt: at, lastActivityAt: at };
    if (f.status !== undefined) {
      if (!STATUSES.includes(f.status)) return res(400, { error: "Invalid status" });
      if (f.status !== cur.status) {
        update.status  = f.status;
        update.closedAt = f.status === "done" ? at : null;
        // Status moves land in the comment thread, so the ticket reads as a story.
        await ref.collection("comments").add({ text: null, by: me, at, statusFrom: cur.status, statusTo: f.status });
        update.commentCount = (cur.commentCount || 0) + 1;
        logAdminAudit(db, adminUser.uid, "ticket_status", { id, title: cur.title, from: cur.status, to: f.status });
      }
    }
    if (f.priority !== undefined) {
      if (!PRIORITIES.includes(f.priority)) return res(400, { error: "Invalid priority" });
      update.priority = f.priority;
    }
    if (f.assignee !== undefined) {
      update.assignee = clean(f.assignee, 120) || null;
      if (update.assignee !== cur.assignee) {
        logAdminAudit(db, adminUser.uid, "ticket_assign", { id, title: cur.title, assignee: update.assignee });
      }
    }
    if (f.title          !== undefined) { const t = clean(f.title, 200); if (t) update.title = t; }
    if (f.body           !== undefined) update.body           = clean(f.body, MAX_BODY) || null;
    if (f.relatedUid     !== undefined) update.relatedUid     = clean(f.relatedUid, 60) || null;
    if (f.relatedChannel !== undefined) update.relatedChannel = clean(f.relatedChannel, 60) || null;
    await ref.set(update, { merge: true });
    return res(200, { ok: true });
  }

  if (action === "delete") {
    if (typeof db.recursiveDelete === "function") await db.recursiveDelete(ref); else await ref.delete();
    logAdminAudit(db, adminUser.uid, "ticket_delete", { id, title: cur.title });
    return res(200, { ok: true });
  }

  return res(400, { error: "Invalid action" });
};
