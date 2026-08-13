// POST /api/portal-daily-claim
// Body: { channel, kickUsername, accessToken }
//
// Website "daily reward": a signed-in viewer claims once per day and gets a
// RANDOM amount of the streamer's points. The portal plays a video while the
// result is revealed, but the amount is decided HERE, server-side — the client
// never sends or influences it.
//
// Separate from the bot's chat check-in (`lastCheckIn` / `checkInStreak`, awarded
// automatically on a viewer's first message of the day). This uses its own
// `lastPortalClaim` field so the two don't clobber each other; a viewer can
// legitimately get both. Day boundary matches the bot's todayStr() so "come back
// tomorrow" means the same thing in chat and on the site.
//
// The claim + award happen in ONE transaction, so double-clicking or opening two
// tabs can't pay out twice.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { findStreamerByChannel } = require("./_lib/streamer");
const { getKickUser }         = require("./_lib/kick");

const MIN_AWARD = 10;
const MAX_AWARD = 500;

// "Today" as YYYY-MM-DD in the streamer's timezone if set, else UTC. Mirrors
// todayStr() in WenBotServer/src/commands/points.js — keep them in step.
function todayStr(profile) {
  const tz = profile && profile.timezone;
  const now = new Date();
  if (tz) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(now);
    } catch { /* bad tz — fall through to UTC */ }
  }
  return now.toISOString().slice(0, 10);
}

// Millis until the next local midnight, so the UI can show a countdown.
function msUntilTomorrow(profile) {
  const tz = profile && profile.timezone;
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
    const secsToday = (+parts.hour) * 3600 + (+parts.minute) * 60 + (+parts.second);
    return (86400 - secsToday) * 1000;
  } catch {
    return 86400000 - (now.getTime() % 86400000);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, kickUsername, accessToken } = body;
  if (!channel || !kickUsername || !accessToken) {
    return res(400, { error: "Missing required fields" });
  }

  const channelKey = String(channel).toLowerCase().trim();
  const userKey    = String(kickUsername).toLowerCase().trim();

  try {
    // 1. Prove the token really belongs to the claimed Kick user.
    const kickLookup = await getKickUser(accessToken);
    if (kickLookup.error) return res(kickLookup.status, { error: kickLookup.error });
    if (kickLookup.user.name.toLowerCase() !== userKey) {
      return res(401, { error: "Identity mismatch — please log in again" });
    }

    const db = getDb();
    // Keyed on the verified Kick identity, not IP, so viewers behind one NAT
    // don't block each other. The transaction is what actually stops double pay.
    if (!(await checkRateLimit(db, userKey, "daily_claim", 20, 60))) {
      return res(429, { error: "Too many requests — slow down a moment." });
    }

    const streamerSnapDoc = await findStreamerByChannel(db, channelKey);
    if (!streamerSnapDoc) return res(404, { error: "Channel not found" });
    const uid      = streamerSnapDoc.id;
    const profile  = streamerSnapDoc.data();
    const currency = profile.currencyName || "points";

    // Streamer can turn this off, or narrow the range, from their config.
    const cfg = profile.portalDailyClaim || {};
    if (cfg.enabled === false) return res(403, { error: "Daily reward is turned off for this channel." });
    const min = Math.max(1, parseInt(cfg.min, 10) || MIN_AWARD);
    const max = Math.max(min, parseInt(cfg.max, 10) || MAX_AWARD);

    const today     = todayStr(profile);
    const viewerRef = db.collection("streamers").doc(uid).collection("viewers").doc(userKey);

    // Read-only status, so the page can show CLAIMED on load instead of letting
    // someone sit through the video only to be told they already claimed.
    if (body.action === "status") {
      const snap = await viewerRef.get();
      const data = snap.exists ? snap.data() : {};
      return res(200, {
        ok: true,
        claimedToday:  data.lastPortalClaim === today,
        balance:       data.points || 0,
        currency,
        nextClaimInMs: msUntilTomorrow(profile),
      });
    }

    let awarded = 0, balance = 0, already = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(viewerRef);
      const data = snap.exists ? snap.data() : {};
      if (data.lastPortalClaim === today) { already = true; balance = data.points || 0; return; }

      // Rolled server-side. Inclusive of both ends.
      awarded = Math.floor(Math.random() * (max - min + 1)) + min;
      balance = (data.points || 0) + awarded;

      tx.set(viewerRef, {
        points:               admin.firestore.FieldValue.increment(awarded),
        lastPortalClaim:      today,
        lastPortalClaimAt:    Date.now(),
        portalClaimTotal:     admin.firestore.FieldValue.increment(awarded),
        portalClaimCount:     admin.firestore.FieldValue.increment(1),
        kickName:             kickLookup.user.name, // preserve original casing
        lastSeen:             Date.now(),
      }, { merge: true });
    });

    if (already) {
      return res(409, {
        error: "already_claimed",
        message: "You've already claimed today — come back tomorrow!",
        nextClaimInMs: msUntilTomorrow(profile),
        currency, balance,
      });
    }

    return res(200, {
      ok: true, awarded, balance, currency,
      nextClaimInMs: msUntilTomorrow(profile),
    });
  } catch (err) {
    console.error("[portal-daily-claim] error:", err.message);
    return res(500, { error: "Could not claim right now — try again shortly." });
  }
};
