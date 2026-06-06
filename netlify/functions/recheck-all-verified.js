// POST /api/recheck-all-verified
// Bulk re-check of ALL of a streamer's verified users against the CURRENT
// Gambulls board, in a single pass: fetch the board ONCE, then match every
// verified user (UID fast-path → name fallback) and self-heal stale UIDs. This
// is the one-click recovery for when Gambulls rotates/regenerates user IDs and
// multiple "Under Code" users silently drop off at once.
//
// UPGRADE-ONLY: the board only shows current-window wagerers, so a "not found"
// must NOT downgrade anyone — we only flip TRUE + heal the UID when matched.
//
// Body: {}    (uses the caller's own streamer account)
// Auth: Firebase ID token

const { getDb, admin }                 = require("./_lib/firebase");
const { res, checkRateLimit }          = require("./_lib/http");
const { CASINO_NAMES }                 = require("./_lib/casinos");
const { findMatch, fetchGambulls, uidOf } = require("./_lib/affiliate");
const { logAudit }                     = require("./_lib/audit");

const API_CASINOS = new Set(["gambulls"]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  // Heavy-ish op (one board fetch + a full verified scan) → cap to a few/min/IP.
  if (!(await checkRateLimit(db, ip, "recheckall", 6, 60))) {
    return res(429, { error: "Too many bulk rechecks — wait a moment." });
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });
  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch { return res(401, { error: "Invalid auth token" }); }

  try {
    const provider = "gambulls"; // only API casino today
    const providerDoc = await db.collection("streamers").doc(uid)
      .collection("providers").doc(provider).get();
    if (!providerDoc.exists || !providerDoc.data().apiKey) {
      return res(400, { error: `${CASINO_NAMES[provider]} API isn't configured.` });
    }

    // Fetch the live board ONCE.
    const board = await fetchGambulls(providerDoc.data().apiKey, "monthly");
    if (board.error || !Array.isArray(board.rankings)) {
      return res(502, { error: "Couldn't reach the Gambulls leaderboard right now." });
    }

    const vSnap = await db.collection("streamers").doc(uid)
      .collection("verified_users").where("provider", "==", provider).get();

    let rechecked = 0, healed = 0, upgraded = 0;
    const now = Date.now();
    // Chunk writes under the 500-op batch cap.
    let batch = db.batch(), ops = 0;
    const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

    for (const doc of vSnap.docs) {
      const v = doc.data();
      rechecked++;
      const target = (v.providerUsername_lower || v.providerUsername || "").toLowerCase().trim();
      const { match } = findMatch(board.rankings, target, v.providerUid || null);
      if (!match) continue; // upgrade-only: leave non-matches untouched

      const newUid = uidOf(match);
      const update = {
        apiVerified:       true,
        underAffiliate:    true,
        wagerAmount:       match.wagerAmount || 0,
        wagerLastSyncedAt: now,
        lastRecheckAt:     now,
      };
      if (newUid && newUid !== v.providerUid) { update.providerUid = newUid; healed++; }
      if (!v.underAffiliate) upgraded++;
      batch.update(doc.ref, update);
      if (++ops >= 400) await flush();
    }
    await flush();

    logAudit(uid, "verified_recheck_all", { rechecked, healed, upgraded });
    return res(200, { success: true, rechecked, healed, upgraded });
  } catch (err) {
    console.error("[recheck-all-verified] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
