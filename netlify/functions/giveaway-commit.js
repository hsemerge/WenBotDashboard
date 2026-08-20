// POST /api/giveaway-commit
// Opens a verifiable giveaway: generates the secret seed and publishes only its
// hash. Called by the dashboard when a giveaway starts.
//
// Body: { uid? }   (uid = the MANAGED streamer when a mod/agency admin runs it)
// Returns: { serverSeedHash, committedAt }
//
// The seed lands in the top-level `giveaway_fairness` collection, which is
// `allow read, write: if false` — NOT under streamers/{uid}, where the catch-all
// subcollection rule would let the streamer read their own seed before the draw
// and defeat the entire point.

const { getDb, admin } = require("./_lib/firebase");
const { res } = require("./_lib/http");
const { newServerSeed, sha256Hex } = require("./_lib/fairness");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }

  const db = getDb();
  let uid;
  try {
    const decoded   = await admin.auth().verifyIdToken(idToken);
    const requested = body.uid || decoded.uid;
    const delegated = Array.isArray(decoded.delegatedFor) && decoded.delegatedFor.includes(requested);
    if (requested !== decoded.uid && !delegated) {
      return res(403, { error: "You don't have access to that account." });
    }
    uid = requested;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  try {
    const [profDoc, existing] = await Promise.all([
      db.collection("streamers").doc(uid).get(),
      db.collection("giveaway_fairness").doc(uid).get(),
    ]);
    const profile = profDoc.data() || {};
    // Identifies the round this commitment belongs to. A giveaway already running
    // when this shipped has no giveawayStartedAt of its own to match against, so
    // fall back to now — it gets a commitment from this moment on.
    const forGiveawayAt = profile.giveawayStartedAt || Date.now();

    // Replacing a live commitment would throw away the promise entries were
    // collected under and reset the nonce, so a re-roll could reuse a number.
    // Committing to a round that has NONE is fine and is how an in-flight
    // giveaway becomes verifiable without being restarted.
    if (existing.exists
        && existing.data().forGiveawayAt === forGiveawayAt
        && profile.giveawayActive) {
      return res(200, {
        serverSeedHash: existing.data().serverSeedHash,
        committedAt:    existing.data().committedAt,
        reused:         true,
      });
    }

    const serverSeed     = newServerSeed();
    const serverSeedHash = sha256Hex(serverSeed);
    const committedAt    = Date.now();

    // Secret half — unreadable by any client.
    await db.collection("giveaway_fairness").doc(uid).set({
      serverSeed, serverSeedHash, committedAt, drawNonce: 0, forGiveawayAt,
    });
    // Public half — the streamer shows this hash before entries open.
    await db.collection("streamers").doc(uid).update({
      giveawayFairness: { serverSeedHash, committedAt, draws: 0, forGiveawayAt },
    });
    return res(200, { serverSeedHash, committedAt });
  } catch (err) {
    console.error("[giveaway-commit] error:", err.message);
    return res(500, { error: "Could not start a verifiable draw" });
  }
};
