// POST /api/admin-backfill-notes  (admin only)
// One-time importer: older comps recorded their "reason" into the admin audit log
// (admin_audit_logs, action set_plan) rather than a per-user field. This copies each
// streamer's MOST RECENT non-empty comp reason into the new adminNotes field — but
// only where a note doesn't already exist, so it never clobbers a real note.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

function ms(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  return 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_backfill_notes", 5, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  // Latest non-empty comp reason per target uid. Single-equality query (no orderBy),
  // so no composite index is needed — we pick the newest in JS.
  const latest = {}; // uid -> { reason, at }
  try {
    const snap = await db.collection("admin_audit_logs").where("action", "==", "set_plan").limit(5000).get();
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const det = d.details || {};
      const uid = det.targetUid;
      const reason = (det.reason || "").trim();
      if (!uid || !reason) return;
      const at = ms(d.at);
      if (!latest[uid] || at > latest[uid].at) latest[uid] = { reason, at };
    });
  } catch (e) {
    return res(500, { error: "Audit scan failed: " + e.message });
  }

  // Import into admin_notes, NOT onto the streamer document.
  //
  // This used to write `adminNotes` onto streamers/{uid}, which the streamer and
  // their moderators can read (firestore.rules grants read on the whole doc, and
  // Firestore has no field-level reads). So an admin clicking "import old comp
  // notes" published our internal comp rationale to the people it was about —
  // and, after the notes migration, one click here would have silently undone it.
  const uids = Object.keys(latest);
  let imported = 0, skipped = 0;
  for (const uid of uids) {
    const sref = db.collection("streamers").doc(uid);
    const snap = await sref.get();
    if (!snap.exists) { skipped++; continue; }

    const nref    = db.collection("admin_notes").doc(uid);
    const entries = nref.collection("entries");
    // Don't clobber, and don't duplicate on a re-run.
    const existing = await entries.limit(1).get();
    if (!existing.empty) { skipped++; continue; }

    const at = latest[uid].at || Date.now();
    await entries.add({ text: latest[uid].reason, by: "imported from comp log", at, migrated: true });
    await nref.set({
      channel: snap.data().kickChannel || null,
      latest: latest[uid].reason, at, by: "imported from comp log", count: 1,
    }, { merge: true });
    imported++;
  }

  logAdminAudit(db, adminUser.uid, "backfill_notes", { imported, skipped, candidates: uids.length });
  return res(200, { ok: true, imported, skipped, candidates: uids.length });
};
