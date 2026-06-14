// POST /api/leaderboard-checkpoints
// Body: { idToken, action: "list" | "promote", periodId?, checkpointId? }
//
// Interim leaderboard checkpoints are written by the WenBotServer scheduler as a
// safety net for the official end-of-period snapshot. This endpoint lets a
// streamer (a) list the checkpoints for their current period and (b) promote one
// into an official Past Winners entry if the automatic rollover didn't land.

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");

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

// Resolve the active/most-recent period id from the streamer's saved period.
function currentPeriod(data) {
  const lp = data.leaderboardPeriod || {};
  if (!lp.endAt) return null;
  const casino  = (data.activeProvider || "").toLowerCase();
  if (!casino) return null; // no casino set → no period (never assume Gambulls)
  const startAt = lp.startAt || (lp.endAt - 7 * 86400000);
  const endAt   = lp.endAt;
  return { periodId: `${casino}_${ymd(startAt)}_${ymd(endAt)}`, casino, startAt, endAt };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Invalid JSON" }); }

  const { idToken, action } = body;
  if (!idToken || !action) return res(400, { error: "Missing required fields" });

  try {
    const db = getDb();
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const profileSnap = await db.collection("streamers").doc(uid).get();
    if (!profileSnap.exists) return res(404, { error: "Streamer not found" });
    const data = profileSnap.data();

    const cur = currentPeriod(data);
    const periodId = body.periodId || (cur && cur.periodId);
    if (!periodId) return res(400, { error: "No active period" });

    const cpCol = db.collection("streamers").doc(uid)
      .collection("leaderboard_periods").doc(periodId).collection("checkpoints");

    if (action === "list") {
      const snap = await cpCol.orderBy("takenAt", "desc").get();
      const checkpoints = snap.docs.map((d) => {
        const c = d.data();
        return {
          id:          d.id,
          takenAt:     c.takenAt || 0,
          finalWindow: !!c.finalWindow,
          count:       (c.winners || []).length,
          top:         (c.winners || []).slice(0, 3).map((w) => ({ username: w.username, wagered: w.wagered })),
        };
      });
      return res(200, { success: true, periodId, checkpoints });
    }

    if (action === "promote") {
      const { checkpointId } = body;
      if (!checkpointId) return res(400, { error: "Missing checkpointId" });
      const cpSnap = await cpCol.doc(checkpointId).get();
      if (!cpSnap.exists) return res(404, { error: "Checkpoint not found" });
      const cp = cpSnap.data();

      const startAt = cp.startDate || (cur && cur.startAt);
      const endAt   = cp.endDate   || (cur && cur.endAt);

      await db.collection("streamers").doc(uid)
        .collection("leaderboard_periods").doc(periodId)
        .set({
          casino:     cp.casino || (cur && cur.casino) || "",
          casinoName: cp.casinoName || cp.casino || null,
          period:     (startAt && endAt) ? rangeLabel(startAt, endAt) : "Restored period",
          startDate:  startAt || null,
          endDate:    endAt || null,
          savedAt:    Date.now(),
          restoredFromCheckpoint: true,
          restoredFrom: cp.takenAt || null,
          winners:    cp.winners || [],
        }, { merge: true });

      return res(200, { success: true, periodId, restoredFrom: cp.takenAt || null });
    }

    return res(400, { error: "Unknown action" });

  } catch (err) {
    if (err.code === "auth/argument-error" || err.code === "auth/id-token-expired") {
      return res(401, { error: "Unauthorized" });
    }
    console.error("[leaderboard-checkpoints] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
