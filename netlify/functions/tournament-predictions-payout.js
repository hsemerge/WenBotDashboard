// POST /api/tournament-predictions-payout
// Body: { idToken }
// Pays out champion predictions when a tournament completes. Idempotent via
// tournament.championPaid. Two modes (config.championMode):
//   bonus — split config.championPool equally among everyone who predicted the
//           champion (tournament_predictions where pick == champion).
//   wager — parimutuel: pot = all stakes (tournament_bets); the champion's
//           backers split pot*(1-rake) proportional to their stake. If nobody
//           backed the champion, all stakes are refunded.
// Auth: Firebase ID token (streamer/owner of the tournament).

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");

async function creditAll(db, uid, credits) {
  // credits: { voterKey: points }. Chunk to stay under the 500-op batch cap.
  const entries = Object.entries(credits).filter(([, v]) => v > 0);
  for (let i = 0; i < entries.length; i += 400) {
    const batch = db.batch();
    for (const [voterKey, pts] of entries.slice(i, i + 400)) {
      batch.set(
        db.collection("streamers").doc(uid).collection("viewers").doc(voterKey),
        { points: admin.firestore.FieldValue.increment(pts) },
        { merge: true }
      );
    }
    await batch.commit();
  }
  return entries.length;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const idToken = (body.idToken || "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch { return res(401, { error: "Invalid auth token" }); }

  try {
    const db   = getDb();
    const tRef = db.collection("streamers").doc(uid).collection("tournaments").doc("current");
    const tDoc = await tRef.get();
    if (!tDoc.exists) return res(404, { error: "No tournament" });
    const t = tDoc.data();
    if (t.championPaid) return res(200, { success: true, alreadyPaid: true });

    const mode = t.config?.championMode || "off";
    if (mode === "off") { await tRef.update({ championPaid: true }); return res(200, { success: true, paid: 0 }); }

    // Champion = the only participant never eliminated.
    const champion = (t.participants || []).find(p => p && !p.eliminated);
    if (!champion) return res(400, { error: "No champion yet" });
    const championKey = champion.kickUsernameKey;

    let summary;
    if (mode === "bonus") {
      const pool = t.config?.championPool || 0;
      const snap = await db.collection("streamers").doc(uid).collection("tournament_predictions")
        .where("pick", "==", championKey).get();
      const n = snap.size;
      if (n === 0 || pool <= 0) {
        await tRef.update({ championPaid: true, championPayout: { mode, winners: n, each: 0, pool } });
        return res(200, { success: true, mode, winners: n, each: 0 });
      }
      const each = Math.floor(pool / n);
      const credits = {};
      snap.docs.forEach(d => { credits[d.id] = each; });
      await creditAll(db, uid, credits);
      summary = { mode, winners: n, each, pool, champion: champion.kickUsername };
    } else { // wager (parimutuel)
      const betsSnap = await db.collection("streamers").doc(uid).collection("tournament_bets").get();
      const bets = betsSnap.docs.map(d => d.data());
      const pot  = bets.reduce((s, b) => s + (b.amount || 0), 0);
      const winners = bets.filter(b => b.pick === championKey);
      const winnerStake = winners.reduce((s, b) => s + (b.amount || 0), 0);
      const rake = Math.min(20, Math.max(0, t.config?.championRake || 0));
      const credits = {};
      if (winnerStake === 0) {
        // Nobody backed the champion → refund every stake.
        bets.forEach(b => { credits[b.voterKey] = (credits[b.voterKey] || 0) + (b.amount || 0); });
        summary = { mode, refunded: true, pot, champion: champion.kickUsername };
      } else {
        const payoutPool = Math.floor(pot * (1 - rake / 100));
        winners.forEach(b => { credits[b.voterKey] = (credits[b.voterKey] || 0) + Math.floor((b.amount || 0) / winnerStake * payoutPool); });
        summary = { mode, pot, winnerStake, payoutPool, rakePct: rake, winners: Object.keys(credits).length, champion: champion.kickUsername };
      }
      await creditAll(db, uid, credits);
    }

    await tRef.update({ championPaid: true, championPayout: summary });
    return res(200, { success: true, ...summary });
  } catch (err) {
    console.error("[tournament-predictions-payout] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
