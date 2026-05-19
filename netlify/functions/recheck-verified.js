// POST /api/recheck-verified
// Re-runs the affiliate lookup for an existing verified_users doc and updates
// underAffiliate + wagerAmount + wagerLastSyncedAt. Used by the dashboard's
// "↻ Re-check" button so streamers can refresh a user whose affiliate status
// has changed since they verified (e.g., they're now active on the leaderboard).
//
// Body: { docId }                — the verified_users doc ID to re-check
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
  // 30 rechecks per minute per IP — generous enough for batch use, kills runaway loops
  if (!(await checkRateLimit(db, ip, "recheck", 30, 60))) {
    return res(429, { error: "Too many recheck requests" });
  }

  const authHeader = event.headers["authorization"] || "";
  const idToken    = authHeader.replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { docId } = body;
  if (!docId) return res(400, { error: "Missing docId" });

  try {
    const docRef = db.collection("streamers").doc(uid)
      .collection("verified_users").doc(docId);
    const snap = await docRef.get();
    if (!snap.exists) return res(404, { error: "Verified user not found" });

    const v        = snap.data();
    const provider = v.provider;
    const affiliateUsername = v.providerUsername || v.providerUsername_lower;
    if (!provider || !affiliateUsername) {
      return res(400, { error: "Doc is missing provider or providerUsername" });
    }

    if (!API_CASINOS.has(provider)) {
      return res(400, { error: `${CASINO_NAMES[provider] || provider} is honor-system — no API check available` });
    }

    // Load the streamer's casino API key
    const providerDoc = await db.collection("streamers").doc(uid)
      .collection("providers").doc(provider).get();
    if (!providerDoc.exists) {
      return res(400, { error: `${CASINO_NAMES[provider]} API isn't configured` });
    }
    const { apiKey } = providerDoc.data();

    const diagnostics = [];
    const result = await lookupAffiliate(provider, apiKey, affiliateUsername, diagnostics);
    const wasUnderAffiliate = !!v.underAffiliate;
    const nowUnderAffiliate = !!result;

    await docRef.update({
      apiVerified:        nowUnderAffiliate,
      underAffiliate:     nowUnderAffiliate,
      wagerAmount:        result?.wagerAmount || 0,
      wagerLastSyncedAt:  Date.now(),
      lastRecheckAt:      Date.now(),
    });

    // Audit log — only when status actually changed (avoid noise)
    if (wasUnderAffiliate !== nowUnderAffiliate) {
      logAudit(uid, "verified_status_updated", {
        kickUsername:    v.kickName,
        providerUsername: affiliateUsername,
        provider,
        from: wasUnderAffiliate ? "Under Code" : "Standard",
        to:   nowUnderAffiliate ? "Under Code" : "Standard",
      });
    }

    return res(200, {
      success:         true,
      underAffiliate:  nowUnderAffiliate,
      wagerAmount:     result?.wagerAmount || 0,
      leaderboardType: result?.leaderboardType || null,
      statusChanged:   wasUnderAffiliate !== nowUnderAffiliate,
      diagnostics,   // per-leaderboard search details for debugging
      target:          affiliateUsername,
    });
  } catch (err) {
    console.error("[recheck-verified] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
