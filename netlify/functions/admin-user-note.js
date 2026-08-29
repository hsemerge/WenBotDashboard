// POST /api/admin-user-note  (admin only)
//
// Internal notes about a streamer ("comped elite for launch help — revisit
// Aug", "trial ends soon, try to convert"). Team-only: the streamer must never
// be able to read what we write about them.
//
// TWO problems with how these used to work:
//
//   1. ONE STRING. `adminNotes` was a single field, so every save overwrote the
//      last. Two admins couldn't both leave something, and nothing recorded what
//      had already been tried. Notes are a dated, signed thread now — the same
//      shape tickets and outreach already use.
//
//   2. THE STREAMER COULD READ THEM. `adminNotes` lived on the streamer's own
//      document, and firestore.rules allows a streamer (and their moderators) to
//      read that document. Firestore has no field-level read rules, so "internal"
//      was only ever true of the UI — anyone could have read our notes about them
//      straight out of the client SDK. Notes now live in a separate top-level
//      `admin_notes` collection that no rule grants, so they are genuinely
//      admin-SDK-only.
//
//   POST {uid, note}                  → append a note
//   POST {uid, action:'delete', id}   → remove one
//
// Shape:  admin_notes/{uid}            { latest, at, by, count, channel }
//         admin_notes/{uid}/entries/*  { text, by, at }
//
// The summary doc exists so the roster can show a snippet for every streamer in
// ONE read instead of a subcollection query per account.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const MAX_NOTE = 2000;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_user_note", 40, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const targetUid = String(body.uid || "").trim();
  const note      = String(body.note ?? "").slice(0, MAX_NOTE);
  if (!targetUid) return res(400, { error: "Missing uid" });

  const sref = db.collection("streamers").doc(targetUid);
  const snap = await sref.get();
  if (!snap.exists) return res(404, { error: "Streamer not found" });
  const channel = snap.data().kickChannel || null;

  const nref    = db.collection("admin_notes").doc(targetUid);
  const entries = nref.collection("entries");
  const who     = adminUser.email || adminUser.uid;
  const action  = String(body.action || "add");

  // Point the summary at the newest surviving entry, so the roster snippet
  // can't go stale when one is added or deleted.
  const syncSummary = async () => {
    const latest = await entries.orderBy("at", "desc").limit(1).get();
    const all    = await entries.count().get().catch(() => null);
    const top    = latest.empty ? null : latest.docs[0].data();
    await nref.set({
      channel,
      latest: top ? top.text : null,
      at:     top ? top.at   : null,
      by:     top ? top.by   : null,
      count:  all ? all.data().count : (top ? 1 : 0),
    }, { merge: true });
    return top;
  };

  if (action === "delete") {
    const id = String(body.id || "").trim();
    if (!id) return res(400, { error: "Missing note id" });
    await entries.doc(id).delete();
    const top = await syncSummary();
    logAdminAudit(db, adminUser.uid, "user_note_deleted", { targetUid, targetChannel: channel });
    return res(200, { ok: true, adminNotes: top ? top.text : "" });
  }

  const text = note.trim();
  if (!text) return res(400, { error: "Write something first." });

  const at = Date.now();
  const added = await entries.add({ text, by: who, at });

  // Carry a legacy single note in as the first entry, then CLEAR it from the
  // streamer doc — that field is readable by the streamer, so leaving it there
  // would keep leaking the most recent thing we wrote about them.
  const legacy = String(snap.data().adminNotes || "").trim();
  if (legacy) {
    if (legacy !== text) {
      await entries.add({
        text: legacy,
        by:   snap.data().adminNotesUpdatedBy || "unknown",
        at:   Number(snap.data().adminNotesUpdatedAt) || (at - 1),
        migrated: true,
      });
    }
    await sref.set({ adminNotes: "", adminNotesUpdatedAt: null, adminNotesUpdatedBy: null }, { merge: true });
  }

  await syncSummary();
  logAdminAudit(db, adminUser.uid, "set_user_note", { targetUid, targetChannel: channel, length: text.length });

  return res(200, { ok: true, id: added.id, at, by: who, adminNotes: text, adminNotesUpdatedBy: who, adminNotesUpdatedAt: at });
};
