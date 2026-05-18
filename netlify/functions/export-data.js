// POST /api/export-data
// GDPR-style data export: gathers everything under streamers/{uid}/* into one JSON file.
// Auth: Firebase ID token in Authorization header.
// Sensitive fields (Kick OAuth tokens) are stripped. Ops-only subcollections are skipped.
// Rate-limited to 5 exports per hour per IP.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

// Stripped from the top-level streamer doc — never include OAuth tokens in an export.
const SENSITIVE_PROFILE_FIELDS = [
  "kickAccessToken",
  "kickRefreshToken",
  "kickTokenExpiresAt",
];

// Ops-only subcollections that aren't useful to the user (and may be noisy).
const SKIP_SUBCOLLECTIONS = new Set([
  "bot_locks",   // distributed lock dedup — internal only
  "bot_status",  // heartbeat doc — current state, not historical
]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "export", 5, 3600))) {
    return res(429, { error: "Export limit reached. Please wait an hour before trying again." });
  }

  const authHeader = event.headers["authorization"] || "";
  const idToken    = authHeader.replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let uid, email;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid   = decoded.uid;
    email = decoded.email || null;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  try {
    const streamerRef  = db.collection("streamers").doc(uid);
    const profileSnap  = await streamerRef.get();
    if (!profileSnap.exists) return res(404, { error: "Account not found" });

    // Strip sensitive fields from profile
    const profile = { ...profileSnap.data() };
    for (const field of SENSITIVE_PROFILE_FIELDS) delete profile[field];

    // Dump every subcollection under streamers/{uid}/
    const subcollections = await streamerRef.listCollections();
    const data = {};
    for (const subcol of subcollections) {
      if (SKIP_SUBCOLLECTIONS.has(subcol.id)) continue;
      const snap = await subcol.get();
      data[subcol.id] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    const exportPayload = {
      exportedAt:  new Date().toISOString(),
      account:     { uid, email },
      profile,
      collections: data,
      _note: "Kick OAuth tokens have been excluded from this export.",
    };

    return res(200, exportPayload);
  } catch (err) {
    console.error("[export-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
