// GET /api/team-list-mods
// Headers: Authorization: Bearer <streamer-owner Firebase ID token>
//
// Returns the streamer's current moderator list, hydrated with each mod's
// email + Kick username for display in the Team card.
// Owner-only — moderators don't need this endpoint (they can't see the Team
// card on someone else's dashboard).

const { getDb, admin } = require("./_lib/firebase");
const { res: _res }    = require("./_lib/http");
const { listMods }     = require("./_lib/team");
const res = (s, b) => _res(s, b, "*");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET")     return res(405, { error: "Method not allowed" });

  // Lazy init of the Firebase Admin SDK via getDb() — otherwise admin.auth()
  // calls run against an uninitialized app and verifyIdToken throws,
  // surfacing as a misleading "Sign in to manage moderators." error.
  getDb();

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
    const mods = await listMods(ownerUid);
    return res(200, { success: true, mods });
  } catch (err) {
    console.error("[team-list-mods] error:", err.message);
    return res(500, { error: "Failed to load moderators." });
  }
};
