// POST /api/leaderboard-discord-post
// Body: { uid? }
// The dashboard's "Post one now". Ignores cadence and posts immediately.
//
// Separate file from the cron on purpose: Netlify refuses HTTP invocation of
// any function carrying a `schedule`, which is why the button previously came
// back with a bare 403 and no body.
//
// Auth: Firebase ID token; owner-self or the delegatedFor claim (mods).

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { postStandings }       = require("./_lib/leaderboard-post");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = String(body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) {
    return res(403, { error: "Not authorized for that account" });
  }

  const db = getDb();
  if (!(await checkRateLimit(db, uid, "lb_discord_post", 10, 60))) {
    return res(429, { error: "Too many requests — wait a minute." });
  }

  try {
    const doc = await db.collection("streamers").doc(uid).get();
    if (!doc.exists) return res(404, { error: "Account not found" });

    const out = await postStandings(doc);
    if (!out.ok) {
      await doc.ref.set({ lbDiscordPost: { lastError: out.error } }, { merge: true });
      return res(400, { error: out.error });
    }

    await doc.ref.set({ lbDiscordPost: { lastPostAt: Date.now(), lastError: null } }, { merge: true });
    return res(200, { ok: true });
  } catch (err) {
    console.error("[lb-discord-post]", err.message);
    return res(500, { error: "Internal server error" });
  }
};
