// POST /api/finalize-period
// Body: { idToken, label? }
//
// Ends the streamer's CURRENT leaderboard period right now and records the
// official Past Winners entry — the same thing the WenBotServer auto-rollover
// does at endAt, just triggered manually (e.g. to wrap a period early). Pulls the
// live standings, fills prizes from the dashboard config, writes the canonical
// period doc (so it edits-in-place rather than duplicating), marks the period
// inactive, and clears that period's interim checkpoints.

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");
const { CASINO_NAMES } = require("./_lib/casinos");

const TOP_N = 10;

function ymd(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function rangeLabel(startMs, endMs) {
  const s = new Date(startMs);
  const e = new Date(endMs - 1);
  const opt = { month: "short", day: "numeric" };
  const sameYear = s.getFullYear() === e.getFullYear();
  const sStr = s.toLocaleDateString("en-US", sameYear ? opt : { ...opt, year: "numeric" });
  const eStr = e.toLocaleDateString("en-US", opt);
  return `${sStr} – ${eStr}, ${e.getFullYear()}`;
}

function prizeAt(prizes, rank) {
  if (!Array.isArray(prizes)) return 0;
  const n = Number(prizes[rank - 1]);
  return n > 0 ? n : 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Invalid JSON" }); }
  if (!body.idToken) return res(400, { error: "Missing idToken" });

  try {
    const db = getDb();
    const decoded = await admin.auth().verifyIdToken(body.idToken);
    const uid = decoded.uid;

    const profSnap = await db.collection("streamers").doc(uid).get();
    if (!profSnap.exists) return res(404, { error: "Streamer not found" });
    const profile = profSnap.data();

    const lp = profile.leaderboardPeriod || {};
    if (!lp.active) return res(400, { error: "No active period to finalize." });

    const casino   = (profile.activeProvider || "").toLowerCase();
    const channel  = (profile.kickChannel || "").toLowerCase();
    if (!channel) return res(400, { error: "No Kick channel on file." });
    if (!casino)  return res(400, { error: "No casino is set — choose one in Settings first." });

    const now      = Date.now();
    const startAt  = lp.startAt || (lp.endAt ? lp.endAt - 7 * 86400000 : now - 7 * 86400000);
    const schedEnd = lp.endAt || now;
    // Canonical id (matches the auto-rollover + where checkpoints live) so this
    // edits in place instead of creating a duplicate Past Winners entry.
    const periodId = `${casino}_${ymd(startAt)}_${ymd(schedEnd)}`;

    // Pull the live, period-applied standings the same way the auto-rollover does.
    const base = `https://${event.headers.host}`;
    let rankings = [];
    let casinoName = CASINO_NAMES[casino] || casino;
    try {
      const r = await fetch(`${base}/api/leaderboard-live?channel=${encodeURIComponent(channel)}&casino=${encodeURIComponent(casino)}&internal=1`);
      if (r.ok) {
        const d = await r.json();
        rankings = Array.isArray(d.rankings) ? d.rankings : [];
        casinoName = d.casinoName || casinoName;
      }
    } catch (e) {
      console.warn("[finalize-period] standings fetch failed:", e.message);
    }

    const winners = rankings.slice(0, TOP_N).map((w, i) => ({
      rank:      w.rank || i + 1,
      username:  w.username || "Unknown",
      wagered:   w.wagered || 0,
      prize:     prizeAt(profile.leaderboardPrizes, w.rank || i + 1),
      avatarUrl: w.avatarUrl || null,
    }));

    // Record the official entry (end = now, since we're ending it now).
    await db.collection("streamers").doc(uid)
      .collection("leaderboard_periods").doc(periodId)
      .set({
        casino,
        casinoName,
        period:    (body.label && String(body.label).trim()) || rangeLabel(startAt, now),
        startDate: startAt,
        endDate:   now,
        duration:  lp.duration || null,
        finalizedManually: true,
        savedAt:   now,
        winners,
      }, { merge: true });

    // End the live period.
    await db.collection("streamers").doc(uid)
      .update({ "leaderboardPeriod.active": false });

    // Clear the period's interim checkpoints — the official entry is saved.
    try {
      const cpSnap = await db.collection("streamers").doc(uid)
        .collection("leaderboard_periods").doc(periodId).collection("checkpoints").get();
      if (!cpSnap.empty) {
        const batch = db.batch();
        cpSnap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) { console.warn("[finalize-period] checkpoint cleanup failed:", e.message); }

    return res(200, { success: true, periodId, count: winners.length, withPrizes: winners.some(w => w.prize > 0) });

  } catch (err) {
    if (err.code === "auth/argument-error" || err.code === "auth/id-token-expired") {
      return res(401, { error: "Unauthorized" });
    }
    console.error("[finalize-period] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
