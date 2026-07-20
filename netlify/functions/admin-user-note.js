// POST /api/admin-user-note  (admin only)
// Save/clear a free-text internal admin note on a streamer (e.g. "comped elite
// for launch help — revisit Aug"). Shown only in the admin panel; never exposed
// to the streamer. Written via admin SDK, so the streamer can't read or edit it.

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

  const ref  = db.collection("streamers").doc(targetUid);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Streamer not found" });

  await ref.set({
    adminNotes:          note,
    adminNotesUpdatedAt: Date.now(),
    adminNotesUpdatedBy: adminUser.email || adminUser.uid,
  }, { merge: true });

  logAdminAudit(db, adminUser.uid, "set_user_note", {
    targetUid,
    targetChannel: snap.data().kickChannel || null,
    length: note.length,
  });

  return res(200, { ok: true, adminNotes: note, adminNotesUpdatedBy: adminUser.email || adminUser.uid, adminNotesUpdatedAt: Date.now() });
};
