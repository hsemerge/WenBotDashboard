// POST /api/team-add-mod
// Body: { email }
// Headers: Authorization: Bearer <streamer-owner Firebase ID token>
//
// Adds a moderator to the calling streamer's account.
// - Mod must already have a WenBot Firebase account (lookup by email)
// - Streamer must have fewer than MAX_MODS already
// - Mod cannot be the owner themselves
// - Idempotent: re-adding an existing mod is a no-op

const { getDb, admin }          = require("./_lib/firebase");
const { res: _res }             = require("./_lib/http");
const { logAudit }              = require("./_lib/audit");
const {
  MAX_MODS, findUserByEmail, grantDelegation, listMods,
} = require("./_lib/team");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res(400, { error: "Enter a valid email address." });
  }

  // Pull the caller's Firebase ID token from Authorization header
  const auth = event.headers.authorization || event.headers.Authorization || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  // Owner UID = the streamer doc we're attaching the mod to. Comes from the
  // caller's verified Firebase token — they can only add mods to their own
  // account.
  let ownerUid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken || "");
    ownerUid = decoded.uid;
  } catch {
    return res(401, { error: "Sign in to manage moderators." });
  }

  try {
    const db = getDb();

    // Confirm the streamer doc exists (defensive — should always be true)
    const streamerSnap = await db.collection("streamers").doc(ownerUid).get();
    if (!streamerSnap.exists) {
      return res(404, { error: "Streamer profile not found." });
    }
    const streamerData = streamerSnap.data();
    const existingMods = Array.isArray(streamerData.modUids) ? streamerData.modUids : [];

    // Find the moderator's Firebase user by email
    const modUser = await findUserByEmail(email);
    if (!modUser) {
      return res(404, { error: "No WenBot account found for that email. Ask them to sign up first." });
    }
    const modUid = modUser.uid;

    // Don't let someone add themselves
    if (modUid === ownerUid) {
      return res(400, { error: "You can't add yourself as a moderator." });
    }

    // Already a mod?
    if (existingMods.includes(modUid)) {
      return res(409, { error: "That account is already a moderator on your channel." });
    }

    // Cap
    if (existingMods.length >= MAX_MODS) {
      return res(400, { error: `You can have at most ${MAX_MODS} moderators. Remove one to add another.` });
    }

    // 1. Set the custom claim on the mod's auth user
    await grantDelegation(modUid, ownerUid);

    // 2. Atomically add to the streamer doc's modUids array
    await db.collection("streamers").doc(ownerUid).update({
      modUids:     admin.firestore.FieldValue.arrayUnion(modUid),
      modAddedAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    logAudit(ownerUid, "mod_added", {
      modUid,
      modEmail:    modUser.email,
      addedBy:     ownerUid,
    });

    // Return the freshly-hydrated mod list so the UI can re-render in one round-trip
    const mods = await listMods(ownerUid);
    return res(200, {
      success: true,
      mod: {
        modUid,
        email:        modUser.email,
        kickUsername: null, // hydrated by listMods if available
      },
      mods,
      note: "They need to log out and back in for moderator access to take effect.",
    });

  } catch (err) {
    if (err.status && err.status < 500) {
      return res(err.status, { error: err.message });
    }
    console.error("[team-add-mod] error:", err.message);
    return res(500, { error: "Failed to add moderator. Try again." });
  }
};
