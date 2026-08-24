// POST /api/jetpacks-result — settle a Jetpacks flight into channel points.
//
// The game (a Godot web build at /jetpacks/, running as the streamer's OBS
// browser source) POSTs this when a flight ends and the streamer's game URL
// carries ?results=https://wenbot.gg/api/jetpacks-result&token=<secret>:
//
//   { game: "jetpacks", channel: "<kick slug>", token: "<per-streamer secret>",
//     raceId: "<slug>-<n>-<unix>", length, players, winnersWanted,
//     awardPoints, raceNumber,
//     results: [ { place, username, finished, eliminated, death, time_ms,
//                  score, level, points, winner }, ... ] }
//
// Trust model (identical to wenball-result): the game is a browser client, so
// nothing money-shaped is taken from it. The token must match the streamer's
// stored jetpacks.token (generated on the dashboard's Jetpacks page, same
// client-side pattern as streamdeckToken), and the payout is RE-DERIVED from
// the streamer's stored prize table — the client's "points" numbers are
// ignored entirely. Each raceId settles at most once (jetpacks_flights/{raceId}
// doc written in the same transaction as the credits), so a replayed POST
// cannot pay twice.
//
// What the token can't prove is that the usernames flew: that list comes from
// the streamer's own OBS instance, which is exactly as trusted as the streamer
// pressing "give points" anywhere else on the dashboard.

const { getDb, admin }                 = require("./_lib/firebase");
const { res: _res, checkRateLimit, timingSafeEq } = require("./_lib/http");
const { findStreamerByChannel }        = require("./_lib/streamer");
const { logAudit }                     = require("./_lib/audit");
const res = (s, b) => _res(s, b, "*");

// Hard caps: a mis-set (or maliciously rewritten) prize table can never exceed
// these, whatever the streamer doc says.
const MAX_POINTS_PER_PLACE = 100000;
const MAX_WINNERS = 5;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const channel = String(body.channel || "").toLowerCase().trim();
  const token   = String(body.token || "").trim();
  // raceId becomes a Firestore doc id — constrain the charset so a hostile
  // token-holder can't feed a path separator into .doc() (which would throw a
  // 500 where a 400 belongs). The game generates "<slug>-<n>-<unix>".
  const raceId  = String(body.raceId || "").slice(0, 80);
  const results = Array.isArray(body.results) ? body.results : [];
  if (!channel || !token || !raceId || !results.length) return res(400, { error: "Bad request" });
  if (!/^[a-z0-9_-]+$/i.test(raceId)) return res(400, { error: "Bad raceId" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "jetpacks_result", 30, 60))) return res(429, { error: "Too many requests" });

  try {
    const snap = await findStreamerByChannel(db, channel);
    if (!snap) return res(404, { error: "Channel not found" });
    const uid     = snap.id;
    const profile = snap.data();
    const cfg     = profile.jetpacks || {};
    if (!cfg.token || !timingSafeEq(String(cfg.token), token)) {
      return res(401, { error: "Bad token" });
    }

    // Payout table is the streamer's stored config, never the client's claim.
    const prizes = (Array.isArray(cfg.prizes) && cfg.prizes.length ? cfg.prizes : [500, 250, 100, 50, 25])
      .map((n) => Math.max(0, Math.min(MAX_POINTS_PER_PLACE, Math.floor(Number(n) || 0))));
    const winnersWanted = Math.max(1, Math.min(MAX_WINNERS, Number(body.winnersWanted) || 1));
    const awardPoints   = body.awardPoints !== false && cfg.awardPoints !== false;

    const winners = results
      .filter((r) => r && Number(r.place) >= 1 && Number(r.place) <= winnersWanted)
      .map((r) => ({
        username: String(r.username || "").trim().slice(0, 40),
        key:      String(r.username || "").trim().toLowerCase(),
        place:    Number(r.place),
      }))
      // Same shape Kick names actually take; anything else can't be a chatter.
      .filter((w) => /^[a-z0-9_-]{1,32}$/.test(w.key));

    const flightRef = db.collection("streamers").doc(uid).collection("jetpacks_flights").doc(raceId);
    const awarded = await db.runTransaction(async (tx) => {
      const existing = await tx.get(flightRef);
      if (existing.exists) throw { code: 409, msg: "Flight already settled" };
      const out = [];
      for (const w of winners) {
        const pts = awardPoints ? (prizes[w.place - 1] || 0) : 0;
        if (pts > 0) {
          // Same viewer-doc shape as every other credit path (wenball-result,
          // portal-daily-claim, tournament payouts): lowercased doc key,
          // kickName in display casing, points via increment, merge:true so a
          // first-time viewer doc appears.
          const vref = db.collection("streamers").doc(uid).collection("viewers").doc(w.key);
          tx.set(vref, {
            kickName:         w.username,
            points:           admin.firestore.FieldValue.increment(pts),
            lastSeen:         Date.now(),
            lastJetpacksWin:  Date.now(),
          }, { merge: true });
        }
        out.push({ username: w.username, place: w.place, points: pts });
      }
      tx.set(flightRef, {
        raceId,
        length:   String(body.length || "").slice(0, 30),
        players:  Number(body.players) || 0,
        winnersWanted, awardPoints,
        awarded:  out,
        settledAt: Date.now(),
      });
      return out;
    });

    // AWAITED on purpose: Netlify freezes the container the moment the response
    // returns, so a fire-and-forget audit write can be silently cut off.
    await logAudit(uid, "jetpacks_flight_settled", {
      raceId,
      length: String(body.length || ""),
      players: Number(body.players) || 0,
      awarded,
    });

    return res(200, { ok: true, raceId, awarded });
  } catch (err) {
    if (err && err.code && err.msg) return res(err.code, { error: err.msg });
    console.error("[jetpacks-result]", err.message || err);
    return res(500, { error: "Settlement failed" });
  }
};
