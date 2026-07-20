// Scheduled daily (see netlify.toml [functions."expire-trials"].schedule).
// Downgrades expired Elite trials to starter so the stored `plan` stays truthful
// for the bot + admin views. The web surfaces (dashboard, portal-data) ALSO guard
// against an expired trial live, so entitlements are correct even between runs.
//
// Idempotent + safe to call anytime: it only ever touches trials whose trialEndsAt
// has already passed (the correct action), so it needs no auth — the worst a manual
// hit can do is expire something that was due to expire anyway.

const { getDb } = require("./_lib/firebase");

function ms(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  return null;
}

exports.handler = async () => {
  const db  = getDb();
  const now = Date.now();
  let expired = 0;

  try {
    const snap = await db.collection("streamers").where("planTrial", "==", true).get();
    const batch = db.batch();
    snap.forEach((doc) => {
      const end = ms(doc.data().trialEndsAt);
      if (end && end <= now) {
        batch.set(doc.ref, {
          plan:          "starter",
          planManual:    false,   // release to Stripe — they must subscribe to continue
          planTrial:     false,
          trialExpiredAt: now,
        }, { merge: true });
        expired++;
      }
    });
    if (expired) await batch.commit();
  } catch (e) {
    console.warn("[expire-trials] sweep failed:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  console.log(`[expire-trials] downgraded ${expired} expired trial(s)`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, expired }) };
};
