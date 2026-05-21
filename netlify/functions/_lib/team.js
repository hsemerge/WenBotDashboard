// Moderator-delegation helpers.
//
// A streamer can grant up to MAX_MODS Firebase users dashboard access to their
// account. The grant lives in two places:
//
//   1. `streamers/{ownerUid}.modUids: [modUid1, modUid2]`  — source of truth
//      used by the dashboard UI + a sanity check on the server.
//
//   2. Firebase custom claim on each moderator's auth user:
//      `delegatedFor: [ownerUid1, ownerUid2, ...]`         — read by Firestore
//      rules (cheap, no per-read get()) and by the dashboard to decide which
//      account it's operating as.
//
// Both are kept in sync by team-add-mod.js / team-remove-mod.js.

const { getDb, admin } = require("./firebase");

const MAX_MODS = 2;

// Verify the caller is the streamer-owner of `ownerUid`. Used by team-add-mod
// and team-remove-mod to ensure mods can't add or remove peers (only the owner
// can).
async function requireOwner(idToken, ownerUid) {
  if (!idToken) throw Object.assign(new Error("Missing auth token"), { status: 401 });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { throw Object.assign(new Error("Invalid auth token"), { status: 401 }); }
  if (decoded.uid !== ownerUid) {
    throw Object.assign(new Error("Only the streamer-owner can manage moderators."), { status: 403 });
  }
  return decoded;
}

// Look up a Firebase user by email. Returns the UserRecord or null.
async function findUserByEmail(email) {
  try { return await admin.auth().getUserByEmail(email); }
  catch (err) {
    if (err.code === "auth/user-not-found") return null;
    throw err;
  }
}

// Add `ownerUid` to the moderator's `delegatedFor` claim. Idempotent.
async function grantDelegation(modUid, ownerUid) {
  const userRec = await admin.auth().getUser(modUid);
  const existing = Array.isArray(userRec.customClaims?.delegatedFor)
    ? userRec.customClaims.delegatedFor
    : [];
  if (existing.includes(ownerUid)) return; // already granted
  const next = [...existing, ownerUid];
  await admin.auth().setCustomUserClaims(modUid, {
    ...(userRec.customClaims || {}),
    delegatedFor: next,
  });
}

// Remove `ownerUid` from the moderator's `delegatedFor` claim. Idempotent.
// Also revokes refresh tokens so the moderator's existing JWT can't continue
// to be used until expiry — guarantees instant cutoff.
async function revokeDelegation(modUid, ownerUid) {
  const userRec = await admin.auth().getUser(modUid);
  const existing = Array.isArray(userRec.customClaims?.delegatedFor)
    ? userRec.customClaims.delegatedFor
    : [];
  const next = existing.filter(uid => uid !== ownerUid);
  await admin.auth().setCustomUserClaims(modUid, {
    ...(userRec.customClaims || {}),
    delegatedFor: next.length ? next : admin.firestore.FieldValue.delete(),
  });
  // Force the moderator's next request to re-authenticate. Without this their
  // existing token still carries the stale `delegatedFor` claim until expiry
  // (~1 hour). With it, Firestore rules reject reads/writes immediately on
  // the next API call.
  try { await admin.auth().revokeRefreshTokens(modUid); } catch {}
}

// Read the current mod list off the streamer doc and hydrate each entry with
// the mod's email + Kick username (best-effort) for display in the Team card.
async function listMods(ownerUid) {
  const db   = getDb();
  const doc  = await db.collection("streamers").doc(ownerUid).get();
  const uids = (doc.exists && Array.isArray(doc.data().modUids)) ? doc.data().modUids : [];
  if (uids.length === 0) return [];

  const out = await Promise.all(uids.map(async modUid => {
    let email = null, kickUsername = null;
    try {
      const u = await admin.auth().getUser(modUid);
      email = u.email || null;
    } catch {}
    try {
      const s = await db.collection("streamers").doc(modUid).get();
      if (s.exists) kickUsername = s.data().kickUsername || null;
    } catch {}
    return { modUid, email, kickUsername };
  }));
  return out;
}

module.exports = {
  MAX_MODS,
  requireOwner,
  findUserByEmail,
  grantDelegation,
  revokeDelegation,
  listMods,
};
