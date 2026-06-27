// POST /api/set-undercode
// Manually mark a verified user as under-code (or remove it). For casinos with no
// per-user lookup API (e.g. Degen), where the auto-check can only see the top of
// the leaderboard and can't confirm everyone else.
//
// Body: { docId, underAffiliate: boolean }
// Auth: Firebase ID token (streamer must own the verified_users doc).

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { logAudit }            = require("./_lib/audit");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "setundercode", 30, 60))) {
    return res(429, { error: "Too many requests" });
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { docId } = body;
  const flag = !!body.underAffiliate;
  if (!docId) return res(400, { error: "Missing docId" });

  // Operate on the MANAGED streamer (impersonation-safe), not the caller's own —
  // otherwise a mod/admin managing another streamer's account would 404 (the doc
  // lives under that streamer's uid). Authorize via owner-self or delegatedFor.
  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = (body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) return res(403, { error: "Not authorized for that account" });

  try {
    const docRef = db.collection("streamers").doc(uid).collection("verified_users").doc(docId);
    const snap = await docRef.get();
    if (!snap.exists) return res(404, { error: "Verified user not found" });
    const v = snap.data();

    await docRef.update({
      underAffiliate:    flag,
      manualLink:        flag,            // a human set this (audit + so rechecks don't downgrade)
      manualUnderCodeAt: Date.now(),
    });

    logAudit(uid, "verified_undercode_manual", {
      kickUsername: v.kickName,
      provider:     v.provider,
      to:           flag ? "Under Code" : "Standard",
    });

    return res(200, { success: true, underAffiliate: flag });
  } catch (err) {
    console.error("[set-undercode] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
