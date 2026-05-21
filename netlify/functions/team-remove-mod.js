// POST /api/team-remove-mod
// Body: { modUid }
// Headers: Authorization: Bearer <streamer-owner Firebase ID token>
//
// Removes a moderator from the calling streamer's account. Idempotent.
// Also revokes the moderator's refresh tokens so their existing JWT can't
// continue carrying the stale `delegatedFor` claim — instant cutoff.

const { getDb, admin }       = require("./_lib/firebase");
const { res: _res }          = require("./_lib/http");
const { logAudit }           = require("./_lib/audit");
const { revokeDelegation, listMods } = require("./_lib/team");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  // Lazy init the Firebase Admin SDK before any admin.* call.
  const db = getDb();

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const modUid = String(body.modUid || "").trim();
  if (!modUid) return res(400, { error: "Missing modUid" });

  const auth = event.headers.authorization || event.headers.Authorization || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  let ownerUid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken || "");
    ownerUid = decoded.uid;
  } catch {
    return res(401, { error: "Sign in to manage moderators." });
  }

  try {
    const streamerRef = db.collection("streamers").doc(ownerUid);

    // 1. Remove the custom claim + revoke their refresh tokens.
    //    Best-effort — if the mod's auth user was deleted, this throws but we
    //    still want to clean the streamer doc.
    try { await revokeDelegation(modUid, ownerUid); }
    catch (err) { console.warn("[team-remove-mod] revokeDelegation failed:", err.message); }

    // 2. Atomically remove from the streamer doc's modUids array
    await streamerRef.update({
      modUids: admin.firestore.FieldValue.arrayRemove(modUid),
    });

    logAudit(ownerUid, "mod_removed", { modUid, removedBy: ownerUid });

    const mods = await listMods(ownerUid);
    return res(200, { success: true, mods });

  } catch (err) {
    console.error("[team-remove-mod] error:", err.message);
    return res(500, { error: "Failed to remove moderator. Try again." });
  }
};
