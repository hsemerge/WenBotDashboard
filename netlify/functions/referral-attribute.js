// POST /api/referral-attribute
// Records that the authenticated streamer was referred by another streamer.
// Called ONCE during onboarding with the ref code captured at signup. Attribution
// is server-side and immutable: it's set only if not already set, never overwritten,
// and self-referral is rejected. Rewards are NOT issued here (track-only for now) —
// this just establishes the relationship + counters for the dashboard/admin views.
// Requires a Firebase ID token in the Authorization header.

const { getDb, admin } = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { logAudit } = require("./_lib/audit");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "referral_attr", 10, 60))) {
    return res(429, { error: "Too many requests. Please wait a moment." });
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch { return res(401, { error: "Invalid token" }); }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const refCode = String(body.refCode || "").trim().toUpperCase();
  if (!refCode) return res(200, { ok: false, reason: "no_code" }); // nothing to do

  const selfRef = db.collection("streamers").doc(uid);
  const selfSnap = await selfRef.get();
  if (!selfSnap.exists) return res(404, { error: "Streamer profile not found" });
  const self = selfSnap.data();

  // Immutable: never re-attribute. Idempotent so the onboarding call is safe to retry.
  if (self.referredBy) return res(200, { ok: true, alreadyAttributed: true });

  // Resolve the code → referrer.
  const refQ = await db.collection("streamers").where("referralCode", "==", refCode).limit(1).get();
  if (refQ.empty) return res(200, { ok: false, reason: "invalid_code" });
  const referrerDoc = refQ.docs[0];
  const referrerUid = referrerDoc.id;
  const referrer = referrerDoc.data();

  // Anti-fraud: no self-referral, and not the same person via Kick id / email.
  if (referrerUid === uid) return res(200, { ok: false, reason: "self_referral" });
  if (self.kickUserId && referrer.kickUserId && String(self.kickUserId) === String(referrer.kickUserId)) {
    return res(200, { ok: false, reason: "same_kick" });
  }
  if (self.email && referrer.email && self.email.toLowerCase() === referrer.email.toLowerCase()) {
    return res(200, { ok: false, reason: "same_email" });
  }

  const now = admin.firestore.Timestamp.now();
  const batch = db.batch();
  // Mark the new streamer as referred (immutable field, server-only per rules).
  batch.set(selfRef, { referredBy: referrerUid, referredAt: now }, { merge: true });
  // Mirror under the referrer + bump their counter.
  batch.set(referrerDoc.ref.collection("referrals").doc(uid), {
    uid,
    kickChannel: self.kickChannel || null,
    plan:        self.plan || "starter",
    status:      "onboarded", // becomes "converted" later when rewards land
    joinedAt:    now,
  }, { merge: true });
  batch.set(referrerDoc.ref, {
    referralCount: admin.firestore.FieldValue.increment(1),
  }, { merge: true });
  await batch.commit();

  // Audit on both sides for traceability.
  logAudit(referrerUid, "referral_joined", { referredUid: uid, referredChannel: self.kickChannel || null });
  logAudit(uid, "referred_by", { referrerUid, referrerChannel: referrer.kickChannel || null });

  return res(200, { ok: true, referrerChannel: referrer.kickChannel || null });
};
