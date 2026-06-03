// POST /api/link-verified
// Manually links a verified user to a specific leaderboard entry (by Gambulls
// UID) and marks them Under Code. This is the reliable bootstrap for anonymous
// users whose masked name can't be auto-matched: the streamer picks the correct
// board row in the dashboard, we validate that UID is on the live board, capture
// it, and from then on every recheck is UID-based (masking-proof).
//
// Body: { docId, providerUid }   — verified_users doc + the chosen Gambulls user id
// Auth: Firebase ID token (streamer must own the doc)

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { CASINO_NAMES }        = require("./_lib/casinos");
const { lookupAffiliate }     = require("./_lib/affiliate");
const { logAudit }            = require("./_lib/audit");

const API_CASINOS = new Set(["gambulls"]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "linkverified", 30, 60))) {
    return res(429, { error: "Too many requests" });
  }

  const authHeader = event.headers["authorization"] || "";
  const idToken    = authHeader.replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(idToken)).uid;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { docId, providerUid } = body;
  if (!docId || !providerUid) return res(400, { error: "Missing docId or providerUid" });

  try {
    const docRef = db.collection("streamers").doc(uid)
      .collection("verified_users").doc(docId);
    const snap = await docRef.get();
    if (!snap.exists) return res(404, { error: "Verified user not found" });

    const v        = snap.data();
    const provider = v.provider;
    if (!provider || !API_CASINOS.has(provider)) {
      return res(400, { error: "This casino doesn't support API linking." });
    }

    const providerDoc = await db.collection("streamers").doc(uid)
      .collection("providers").doc(provider).get();
    if (!providerDoc.exists) {
      return res(400, { error: `${CASINO_NAMES[provider]} API isn't configured` });
    }
    const { apiKey } = providerDoc.data();

    // Validate the chosen UID is actually on the live board (and grab its wager).
    const diagnostics = [];
    const result = await lookupAffiliate(provider, apiKey, null, diagnostics, { uid: String(providerUid) });
    if (!result) {
      return res(404, { error: "That leaderboard entry is no longer on the current board. Refresh and try again.", diagnostics });
    }

    const wasUnderAffiliate = !!v.underAffiliate;
    await docRef.update({
      providerUid:       result.uid,
      underAffiliate:    true,
      apiVerified:       true,
      manualLink:        true,        // flags that a human confirmed this link
      wagerAmount:       result.wagerAmount || 0,
      wagerLastSyncedAt: Date.now(),
      linkedAt:          Date.now(),
      lastRecheckAt:     Date.now(),
    });

    logAudit(uid, "verified_linked", {
      kickUsername:     v.kickName,
      providerUsername: v.providerUsername,
      provider,
      providerUid:      result.uid,
      from: wasUnderAffiliate ? "Under Code" : "Standard",
      to:   "Under Code",
    });

    return res(200, {
      success:        true,
      underAffiliate: true,
      providerUid:    result.uid,
      wagerAmount:    result.wagerAmount || 0,
    });
  } catch (err) {
    console.error("[link-verified] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
