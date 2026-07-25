// POST /api/wenpoints-checkin
// Body: { kickUsername, accessToken }
// Daily community check-in: +10 WenPoints once per UTC day for a signed-in
// viewer. Identity is the viewer's Kick OAuth token (same model as
// community-passport / store-buy). The award runs in a transaction on the
// viewer's global wenpoints ledger so refresh-spam can't double-claim.
//
// WenPoints are the community-wide currency: earned passively by chatting on
// any WenBot channel (bot-side) plus this daily check-in; spent later in the
// WenBot store (cosmetics, sponsored raffles, plan-discount vouchers).

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { getKickUser }         = require("./_lib/kick");

const DAILY_AWARD = 10;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const kickUsername = String(body.kickUsername || "").trim();
  const accessToken  = String(body.accessToken || "").trim();
  if (!kickUsername || !accessToken) return res(400, { error: "Missing sign-in" });
  const userKey = kickUsername.toLowerCase();

  try {
    const kickLookup = await getKickUser(accessToken);
    if (kickLookup.error) return res(kickLookup.status, { error: kickLookup.error });
    if (kickLookup.user.name.toLowerCase() !== userKey) {
      return res(401, { error: "Identity mismatch — please sign in again" });
    }

    const db = getDb();
    if (!(await checkRateLimit(db, userKey, "wp_checkin", 10, 60))) {
      return res(429, { error: "Too many requests" });
    }

    const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const ref = db.collection("wenpoints").doc(userKey);
    const out = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const d = doc.exists ? doc.data() : {};
      if (d.lastCheckin === today) {
        return { awarded: 0, balance: d.balance || 0, streak: d.streak || 0 };
      }
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const streak = d.lastCheckin === yesterday ? (d.streak || 0) + 1 : 1;
      tx.set(ref, {
        kickUsernameKey: userKey,
        balance:  admin.firestore.FieldValue.increment(DAILY_AWARD),
        lifetime: admin.firestore.FieldValue.increment(DAILY_AWARD),
        lastCheckin: today,
        streak,
        updatedAt: Date.now(),
      }, { merge: true });
      return { awarded: DAILY_AWARD, balance: (d.balance || 0) + DAILY_AWARD, streak };
    });

    return res(200, { ok: true, ...out });
  } catch (err) {
    console.error("[wenpoints-checkin]", err.message);
    return res(500, { error: "Check-in failed" });
  }
};
