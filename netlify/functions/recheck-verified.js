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
const { lookupDegen }         = require("./_lib/degen");
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

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { docId } = body;
  if (!docId) return res(400, { error: "Missing docId" });

  // Operate on the MANAGED streamer (impersonation-safe), not the caller's own.
  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = (body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) return res(403, { error: "Not authorized for that account" });

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

    // Degen: public race, masked-name match (no per-user API / no UID). Re-check
    // refreshes the wager + confirms under-code from the live race. Upgrade-only:
    // if not found (anonymous row / inactive), leave the existing status alone so a
    // manual under-code isn't wiped.
    if (provider === "degen") {
      const provDoc = await db.collection("streamers").doc(uid).collection("providers").doc("degen").get();
      const code = provDoc.exists ? (provDoc.data().referralCode || provDoc.data().apiKey) : null;
      if (!code) return res(400, { error: "Degen referral code isn't configured." });
      const m = await lookupDegen(code, affiliateUsername);
      if (!m) return res(502, { error: "Couldn't reach the Degen race right now." });
      const wasUnder = !!v.underAffiliate;
      const update = { lastRecheckAt: Date.now() };
      if (m.underAffiliate) {
        update.apiVerified       = true;
        update.underAffiliate    = true;
        update.wagerAmount       = m.wagerAmount || 0;
        update.wagerLastSyncedAt = Date.now();
      }
      await docRef.update(update);
      if (!wasUnder && m.underAffiliate) {
        logAudit(uid, "verified_status_updated", { kickUsername: v.kickName, providerUsername: affiliateUsername, provider, from: "Standard", to: "Under Code" });
      }
      return res(200, {
        success:           true,
        underAffiliate:    m.underAffiliate ? true : wasUnder,
        foundOnLeaderboard: !!m.underAffiliate,
        wagerAmount:       m.wagerAmount || 0,
        ambiguous:         !!m.ambiguous,
        statusChanged:     !wasUnder && !!m.underAffiliate,
        target:            affiliateUsername,
      });
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
    // If we already know this user's provider UID (captured at verify or via a
    // manual link), match on it — reliable and immune to Gambulls' name masking.
    const knownUid = v.providerUid || null;
    const result = await lookupAffiliate(provider, apiKey, affiliateUsername, diagnostics, { uid: knownUid });
    const wasUnderAffiliate = !!v.underAffiliate;
    const foundOnLeaderboard = !!result;

    // UPGRADE-ONLY recheck. The public Gambulls leaderboard endpoint only shows
    // users who've wagered THIS MONTH — it can't tell us about inactive users
    // who are still registered under the affiliate code. So if we don't find
    // them, we LEAVE THEIR STATUS ALONE (could have been correctly TRUE from
    // a previous check). We only flip them to TRUE when the leaderboard confirms.
    const nowUnderAffiliate = foundOnLeaderboard ? true : wasUnderAffiliate;

    const update = {
      lastRecheckAt: Date.now(),
    };
    if (foundOnLeaderboard) {
      update.apiVerified       = true;
      update.underAffiliate    = true;
      update.wagerAmount       = result.wagerAmount || 0;
      update.wagerLastSyncedAt = Date.now();
      // SELF-HEAL the UID: Gambulls IDs can rotate/regenerate, so always refresh to
      // the ID that matched THIS time (whether via the UID fast-path or a name
      // fallback). This auto-recovers users whose cached UID went stale — without
      // this they'd silently drop off "Under Code" forever.
      if (result.uid && result.uid !== v.providerUid) update.providerUid = result.uid;
    }
    await docRef.update(update);

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
      success:           true,
      underAffiliate:    nowUnderAffiliate,
      foundOnLeaderboard,            // true if API confirmed; false means status was preserved
      wagerAmount:       result?.wagerAmount || 0,
      leaderboardType:   result?.leaderboardType || null,
      statusChanged:     wasUnderAffiliate !== nowUnderAffiliate,
      diagnostics,
      target:            affiliateUsername,
    });
  } catch (err) {
    console.error("[recheck-verified] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
