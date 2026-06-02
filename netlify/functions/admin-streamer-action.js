// POST /api/admin-streamer-action  (admin only)
// Archive / unarchive / delete a streamer account.
//   archive   → soft, reversible: sets archived:true + onboarded:false (the bot
//               watches onboarded==true, so this disconnects it) and remembers the
//               prior onboarded state. Hidden from the default admin view.
//   unarchive → restores archived:false + the prior onboarded state (reconnects bot).
//   delete    → HARD, irreversible: recursively deletes the streamer doc + all
//               subcollections, and the Firebase Auth user.
// Owner channels and the acting admin's own account are protected from both.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const PROTECTED_CHANNELS = new Set(["emergeonkick"]); // never archivable/deletable

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_streamer_action", 20, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const targetUid = String(body.uid || "").trim();
  const action    = String(body.action || "").trim();
  const reason    = String(body.reason || "").slice(0, 300);
  if (!targetUid) return res(400, { error: "Missing uid" });
  if (!["archive", "unarchive", "delete"].includes(action)) return res(400, { error: "Invalid action" });

  const ref  = db.collection("streamers").doc(targetUid);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Streamer not found" });
  const cur = snap.data();

  // Safety guards.
  if (targetUid === adminUser.uid) return res(400, { error: "You can't archive/delete your own account here." });
  if (PROTECTED_CHANNELS.has((cur.kickChannel || "").toLowerCase())) {
    return res(400, { error: `${cur.kickChannel} is a protected account.` });
  }

  if (action === "archive") {
    await ref.set({
      archived: true,
      archivedAt: admin.firestore.Timestamp.now(),
      archivedPrevOnboarded: cur.onboarded === true,
      onboarded: false, // drops out of the bot's onboarded==true watch → disconnects
    }, { merge: true });
    logAdminAudit(db, adminUser.uid, "streamer_archive", { targetUid, channel: cur.kickChannel || null, reason });
    return res(200, { ok: true, archived: true });
  }

  if (action === "unarchive") {
    await ref.set({
      archived: false,
      onboarded: cur.archivedPrevOnboarded === true, // restore prior state (reconnects bot)
    }, { merge: true });
    logAdminAudit(db, adminUser.uid, "streamer_unarchive", { targetUid, channel: cur.kickChannel || null, reason });
    return res(200, { ok: true, archived: false });
  }

  // action === "delete"  — hard, irreversible
  try {
    if (typeof db.recursiveDelete === "function") {
      await db.recursiveDelete(ref);          // doc + all subcollections
    } else {
      await ref.delete();                      // fallback (leaves subcollections)
    }
  } catch (e) {
    return res(500, { error: "Delete failed: " + e.message });
  }
  // Remove the Firebase Auth user too (best-effort).
  let authDeleted = false;
  try { await admin.auth().deleteUser(targetUid); authDeleted = true; } catch {}

  logAdminAudit(db, adminUser.uid, "streamer_delete", {
    targetUid, channel: cur.kickChannel || null, email: cur.email || null, authDeleted, reason,
  });
  return res(200, { ok: true, deleted: true, authDeleted });
};
