// POST /api/admin-set-referrer  (admin only)
// Attribute a streamer as referred by another streamer — the admin override for
// the normally-immutable `referredBy`. Used for comped/manually-provisioned
// accounts that never went through the signup ref-code flow.
//
// Body: { uid: <targetUid>, referrer: "<channel or refCode>", override?: true }
// Resolves the referrer by kickChannel first, then referralCode. If the target
// already has a referrer, only changes it when override is set (and fixes the old
// referrer's count/mirror). Audit-logged.

const { getDb, admin }                = require("./_lib/firebase");
const { res, checkRateLimit }         = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_set_referrer", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const targetUid     = String(body.uid || "").trim();
  const referrerInput = String(body.referrer || "").trim();
  const override      = body.override === true;
  if (!targetUid || !referrerInput) return res(400, { error: "Missing uid or referrer" });

  const tRef  = db.collection("streamers").doc(targetUid);
  const tSnap = await tRef.get();
  if (!tSnap.exists) return res(404, { error: "Target streamer not found" });
  const t = tSnap.data();

  // Resolve referrer: by kickChannel first, then by referralCode.
  let rQ = await db.collection("streamers").where("kickChannel", "==", referrerInput.toLowerCase()).limit(1).get();
  if (rQ.empty) rQ = await db.collection("streamers").where("referralCode", "==", referrerInput.toUpperCase()).limit(1).get();
  if (rQ.empty) return res(404, { error: `No streamer found for referrer "${referrerInput}".` });
  const referrerDoc = rQ.docs[0];
  const referrerUid = referrerDoc.id;
  const referrerChannel = referrerDoc.data().kickChannel || referrerUid;

  if (referrerUid === targetUid) return res(400, { error: "A streamer can't refer themselves." });

  if (t.referredBy && t.referredBy === referrerUid) {
    return res(200, { success: true, unchanged: true, referrerChannel });
  }
  if (t.referredBy && !override) {
    let prev = t.referredBy;
    try { const p = await db.collection("streamers").doc(t.referredBy).get(); if (p.exists) prev = p.data().kickChannel || prev; } catch {}
    return res(409, { error: `Already referred by ${prev}. Pass override to change.`, currentReferrerChannel: prev });
  }

  const now   = admin.firestore.Timestamp.now();
  const batch = db.batch();

  // Changing referrers: undo the previous one's counter + mirror.
  if (t.referredBy && t.referredBy !== referrerUid) {
    const oldRef = db.collection("streamers").doc(t.referredBy);
    batch.set(oldRef, { referralCount: admin.firestore.FieldValue.increment(-1) }, { merge: true });
    batch.delete(oldRef.collection("referrals").doc(targetUid));
  }

  batch.set(tRef, { referredBy: referrerUid, referredAt: now }, { merge: true });
  batch.set(referrerDoc.ref.collection("referrals").doc(targetUid), {
    uid:         targetUid,
    kickChannel: t.kickChannel || null,
    plan:        t.plan || "starter",
    status:      "onboarded",
    joinedAt:    now,
    viaAdmin:    true,
  }, { merge: true });
  batch.set(referrerDoc.ref, { referralCount: admin.firestore.FieldValue.increment(1) }, { merge: true });

  await batch.commit();

  logAdminAudit(db, adminUser.uid, "admin_set_referrer", {
    targetUid, targetChannel: t.kickChannel || null, referrerUid, referrerChannel,
    changedFrom: t.referredBy || null,
  });

  return res(200, { success: true, referrerChannel });
};
