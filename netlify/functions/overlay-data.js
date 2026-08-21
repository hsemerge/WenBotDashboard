// GET /api/overlay-data?channel=xxx
// Returns giveaway snapshot + profile criteria for OBS overlays — no auth required

const { getDb } = require("./_lib/firebase");
const { findStreamerByChannel } = require("./_lib/streamer");
const { memo } = require("./_lib/overlay-cache");

// SHORT ttl on purpose. This endpoint carries the giveaway spin/raffle
// triggers that the wheel + winner overlays poll at 300ms waiting on, so the
// cache must not delay a "go spin" edge by more than ~1s. At 1s it still
// caps reads at ~1/sec/channel however fast the overlay polls, which is the
// whole cost win - so the spinner poll rate is left fast for responsiveness.
const CACHE_TTL_MS = 1000;

// Local res() — includes Cache-Control: no-store for overlay freshness
function res(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing ?channel=" });

  try {
    const { code, body } = await memo(`overlay:${channel}`, CACHE_TTL_MS, async () => {
    const db = getDb();

    const snapDoc = await findStreamerByChannel(db, channel);
    if (!snapDoc) return { code: 404, body: { error: "Channel not found" } };

    const uid     = snapDoc.id;
    const profile = snapDoc.data();

    const snapshotDoc = await db.collection("streamers").doc(uid)
      .collection("giveaway_state").doc("snapshot").get();

    const snapshot = snapshotDoc.exists ? snapshotDoc.data() : { active: false, count: 0, entries: [] };

    return { code: 200, body: {
      active:          !!snapshot.active,
      count:           snapshot.count  || 0,
      entries:         snapshot.entries || [],
      updatedAt:       snapshot.updatedAt || null,
      spinTrigger:     snapshot.spinTrigger   || null,
      clearSpin:       snapshot.clearSpin     || null,
      raffleTrigger:   snapshot.raffleTrigger || null,
      keyword:         profile.giveawayKeyword  || "!join",
      type:            profile.giveawayType     || "code",
      minWager:        profile.giveawayMinWager || 0,
      subOnly:         !!profile.giveawaySubOnly,
      verifiedCasino:  !!profile.giveawayVerifiedCasino,
      verifiedDiscord: !!profile.giveawayVerifiedDiscord,
      // Trivia rides along on the profile read this endpoint already does, so
      // the trivia overlay costs no extra Firestore reads.
      trivia: {
        active:   !!profile.triviaActive,
        question: profile.triviaQuestion || '',
        winner:   profile.triviaWinner   || '',
        answer:   profile.triviaAnswer   || '',
        endsAt:   profile.triviaEndsAt   || 0,
      },
    } };
    });
    return res(code, body);
  } catch (err) {
    console.error("[overlay-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
