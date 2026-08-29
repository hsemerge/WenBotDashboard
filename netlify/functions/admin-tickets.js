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
const { sendEmail, wrap, button } = require("./_lib/email");

const STATUSES   = ["open", "in_progress", "blocked", "done"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const MAX_BODY   = 4000;
const PORTAL     = "https://wenbot.gg/admin/portal/#/tickets";

const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Email the person who now owns this work.
//
// Best-effort by design: a ticket must still be created if Resend is down or
// unconfigured, so every failure here is swallowed and logged. The in-portal
// banner (see the `seen` action) is the reliable channel — this is the nudge
// that reaches someone who isn't looking at the portal.
//
// Never mails you your own action: assigning a ticket to yourself, or commenting
// on your own ticket, is not news.
async function notifyAssignee({ to, actor, kind, ticket, extra }) {
  if (!to || to === actor || !String(to).includes("@")) return;
  if (!process.env.RESEND_API_KEY) return;

  const title = esc(ticket.title || "(untitled)");
  const who   = esc(String(actor || "someone").split("@")[0]);
  const meta  = [
    ticket.priority && ticket.priority !== "normal" ? `<b>Priority:</b> ${esc(ticket.priority)}` : "",
    ticket.relatedChannel ? `<b>Streamer:</b> ${esc(ticket.relatedChannel)}` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");

  const heads = {
    assigned: [`Ticket assigned to you — ${ticket.title}`, `${who} assigned a ticket to you`],
    comment:  [`New comment — ${ticket.title}`,            `${who} commented on your ticket`],
  };
  const [subjectRaw, headline] = heads[kind] || heads.assigned;

  try {
    await sendEmail({
      to,
      subject: `[WenBot] ${subjectRaw}`.slice(0, 180),
      html: wrap(esc(headline), `
        <p style="font-size:16px;color:#f0f6fc;margin:0 0 6px;"><b>${title}</b></p>
        ${meta ? `<p style="font-size:13px;color:#8b949e;margin:0 0 14px;">${meta}</p>` : ""}
        ${extra ? `<div style="background:#0d1117;border-left:3px solid #00e5ff;padding:10px 14px;margin:0 0 8px;white-space:pre-wrap;font-size:14px;">${esc(extra).slice(0, 1200)}</div>` : ""}
        ${button(PORTAL, "Open the ticket")}
      `),
    });
  } catch (e) {
    console.warn("[admin-tickets] notify failed:", e.message);
  }
}

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

  // Per-admin "I have seen the queue up to here" marker. Anything on your plate
  // that moved after this is what the portal surfaces on sign-in.
  const prefRef = db.collection("admin_prefs").doc(adminUser.uid);

  if (event.httpMethod === "GET") {
    const snap = await col.orderBy("lastActivityAt", "desc").limit(500).get();
    const tickets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Done sinks; everything else stays newest-activity-first (the queue order).
    tickets.sort((a, b) => {
      const ad = a.status === "done" ? 1 : 0, bd = b.status === "done" ? 1 : 0;
      return ad !== bd ? ad - bd : (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });
    // First ever sign-in has no marker. Starting at 0 would greet a new admin
    // with every ticket ever filed, so treat "never looked" as "caught up".
    let seenAt = null;
    try { const p = await prefRef.get(); seenAt = p.exists ? (p.data().ticketsSeenAt || null) : null; }
    catch { /* a missing marker just means nothing is flagged */ }
    return res(200, { tickets, statuses: STATUSES, priorities: PRIORITIES, seenAt, me });
  }

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const action = String(body.action || "").trim();

  // "I've read the queue" — clears this admin's sign-in banner.
  if (action === "seen") {
    const at = Date.now();
    await prefRef.set({ ticketsSeenAt: at, email: me }, { merge: true });
    return res(200, { ok: true, seenAt: at });
  }

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
      assignedAt:  clean(body.assignee, 120) ? now : null,
      closedAt:    null,
      commentCount: 0,
    };
    const ref = await col.add(doc);
    logAdminAudit(db, adminUser.uid, "ticket_create", { id: ref.id, title, assignee: doc.assignee });
    await notifyAssignee({ to: doc.assignee, actor: me, kind: "assigned", ticket: doc, extra: doc.body });
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
    // The assignee is the one waiting on this; the person typing already knows.
    await notifyAssignee({ to: cur.assignee, actor: me, kind: "comment", ticket: cur, extra: text });
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
    let handedTo = null;
    if (f.assignee !== undefined) {
      update.assignee = clean(f.assignee, 120) || null;
      if (update.assignee !== cur.assignee) {
        update.assignedAt = update.assignee ? at : null;
        handedTo = update.assignee;
        logAdminAudit(db, adminUser.uid, "ticket_assign", { id, title: cur.title, assignee: update.assignee });
      }
    }
    if (f.title          !== undefined) { const t = clean(f.title, 200); if (t) update.title = t; }
    if (f.body           !== undefined) update.body           = clean(f.body, MAX_BODY) || null;
    if (f.relatedUid     !== undefined) update.relatedUid     = clean(f.relatedUid, 60) || null;
    if (f.relatedChannel !== undefined) update.relatedChannel = clean(f.relatedChannel, 60) || null;
    await ref.set(update, { merge: true });
    if (handedTo) {
      await notifyAssignee({
        to: handedTo, actor: me, kind: "assigned",
        ticket: { ...cur, ...update }, extra: update.body !== undefined ? update.body : cur.body,
      });
    }
    return res(200, { ok: true });
  }

  if (action === "delete") {
    if (typeof db.recursiveDelete === "function") await db.recursiveDelete(ref); else await ref.delete();
    logAdminAudit(db, adminUser.uid, "ticket_delete", { id, title: cur.title });
    return res(200, { ok: true });
  }

  return res(400, { error: "Invalid action" });
};
