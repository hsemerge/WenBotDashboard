// POST /api/leaderboard-discord-post
// Body: { uid?, boardId? }   boardId targets an extra leaderboard; omit for the
//                            streamer's main board.
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

  // getDb() is what initialises the Admin SDK, so it MUST run before
  // admin.auth() — otherwise a cold start throws inside verifyIdToken and
  // reports a perfectly good token as invalid.
  const db = getDb();

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

  if (!(await checkRateLimit(db, uid, "lb_discord_post", 10, 60))) {
    return res(429, { error: "Too many requests — wait a minute." });
  }

  try {
    const doc = await db.collection("streamers").doc(uid).get();
    if (!doc.exists) return res(404, { error: "Account not found" });

    // An extra board keeps its own config and its own last-post stamp, so the
    // result is written back to whichever doc actually owns this posting.
    const boardId = String(body.boardId || "").trim();
    let boardDoc = null;
    if (boardId) {
      boardDoc = await doc.ref.collection("leaderboards").doc(boardId).get();
      if (!boardDoc.exists) return res(404, { error: "That leaderboard no longer exists." });
    }
    const target = boardDoc || doc;
    const field  = boardDoc ? "discordPost" : "lbDiscordPost";

    const out = await postStandings(doc, boardDoc);
    if (!out.ok) {
      await target.ref.set({ [field]: { lastError: out.error } }, { merge: true });
      return res(400, { error: out.error });
    }

    await target.ref.set({ [field]: { lastPostAt: Date.now(), lastError: null } }, { merge: true });
    return res(200, { ok: true });
  } catch (err) {
    console.error("[lb-discord-post]", err.message);
    return res(500, { error: "Internal server error" });
  }
};
