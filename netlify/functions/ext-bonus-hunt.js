// POST /api/ext-bonus-hunt   header: x-wenbot-ext-token
// The WenBot Companion extension's authed endpoint for the live bonus hunt.
//   { action: "get" }                       → returns the current hunt
//   { action: "add", bonus: {...} }         → appends a bonus to the live hunt
//
// Writes the SAME `streamers/{uid}/bonus_hunt/current` doc the dashboard uses, so
// adds show instantly on the overlay, portal, and Guess-the-Balance. The token
// (from /api/extension-pair) maps to the streamer's uid; tokens are revocable.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function resolveToken(db, token) {
  // Validate format before hitting Firestore: a token containing "/" makes an
  // odd-segment doc path (throws → 500), and junk lengths are never valid tokens.
  if (!token || token.length < 8 || token.length > 128 || /[^A-Za-z0-9_-]/.test(token)) return null;
  const snap = await db.collection("extension_tokens").doc(token).get();
  if (!snap.exists) return null;
  snap.ref.update({ lastUsedAt: Date.now() }).catch(() => {}); // best-effort
  return snap.data(); // { uid, channel, casino }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {}, "*");
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" }, "*");

  const db = getDb();
  // Throttle by IP so the token endpoint can't be brute-forced unmetered.
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "ext_bonus_hunt", 60, 60))) return res(429, { error: "Too many requests" }, "*");

  const token = (event.headers["x-wenbot-ext-token"] || "").trim();
  const auth = await resolveToken(db, token);
  if (!auth) return res(401, { error: "Extension not connected. Re-pair in the popup." }, "*");
  const uid = auth.uid;

  let body; try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }, "*"); }
  const action = body.action || "get";
  const huntRef = db.collection("streamers").doc(uid).collection("bonus_hunt").doc("current");

  if (action === "get") {
    const snap = await huntRef.get();
    return res(200, snap.exists ? snap.data() : { active: false }, "*");
  }

  if (action === "add") {
    const b = body.bonus || {};
    const name = String(b.name || "").trim();
    const betSize = Number(b.betSize);
    if (!name) return res(400, { error: "Missing slot name." }, "*");
    if (!betSize || betSize <= 0) return res(400, { error: "Invalid bet size." }, "*");

    const entry = {
      id:           genId(),
      name,
      provider:     String(b.provider || "").trim(),
      betSize,
      payout:       null,
      multiplier:   null,
      playedAt:     null,
      thumbnailUrl: b.thumbnailUrl || null,
      gameId:       b.gameId || null,
      notes:        String(b.notes || "").slice(0, 120),  // note from the companion (e.g. "super", "5-scat")
      addedAt:      Date.now(),
      source:       "extension",
    };

    try {
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(huntRef);
        if (!snap.exists || !snap.data().active) {
          throw Object.assign(new Error("No active hunt — start one in WenBot first."), { status: 409 });
        }
        const bonuses = Array.isArray(snap.data().bonuses) ? snap.data().bonuses : [];
        txn.update(huntRef, { bonuses: [...bonuses, entry], updatedAt: Date.now() });
      });
    } catch (e) {
      if (e.status) return res(e.status, { error: e.message }, "*");
      console.error("[ext-bonus-hunt] add failed:", e.message);
      return res(500, { error: "Could not add the bonus. Try again." }, "*");
    }

    return res(200, { ok: true, added: entry }, "*");
  }

  return res(400, { error: "Unknown action." }, "*");
};
