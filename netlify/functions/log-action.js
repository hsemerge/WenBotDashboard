// POST /api/log-action
// Server-side audit logging for client-initiated actions.
// Auth: Firebase ID token. The streamer logs to their OWN audit_logs subcollection.
// Body: { action: string, details: object }
//
// Used when dashboard actions can't be routed through dedicated server endpoints
// (e.g. mod points adjustment, raffle draws, redemption fulfillments).
// Rate-limited to prevent runaway client loops from spamming the log.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { logAudit }            = require("./_lib/audit");

// Whitelist of allowed action names — prevents clients from logging arbitrary
// fake events. Add new actions here as we wire up new dashboard log sites.
const ALLOWED_ACTIONS = new Set([
  "mod_points_adjust",     // mod manually added/removed points from a viewer
  "redemption_fulfilled",  // mod marked a store redemption fulfilled
  "raffle_drawn",          // streamer drew a raffle winner
  "verified_user_removed", // streamer removed a verified entry
  "verified_users_cleared",// streamer cleared all verified entries
  "bb_payout",             // streamer paid out a bonus battle match
  "giveaway_started",      // streamer started a giveaway via dashboard
  "giveaway_ended",        // streamer ended a giveaway via dashboard
  "gtb_winner_picked",     // streamer picked a Guess the Balance winner
]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  // 120 logs per minute per IP — generous enough for batch ops, kills runaway loops
  if (!(await checkRateLimit(db, ip, "log_action", 120, 60))) {
    return res(429, { error: "Too many log writes" });
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

  const { action, details } = body;
  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return res(400, { error: "Invalid or missing action" });
  }
  if (details && typeof details !== "object") {
    return res(400, { error: "Details must be an object" });
  }

  await logAudit(uid, action, details || {});
  return res(200, { ok: true });
};
