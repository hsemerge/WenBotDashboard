// GET /api/community-creators
// Public read of the aggregated creators doc (community/creators) that the
// WenBot server rebuilds every ~2 minutes: eligible creators (paid plan or
// active trial, minus opt-outs) with live status, viewers, and stream titles.
//
// Serves the dashboard Creators page today and the public front-page strip
// later. In-memory cached for 60s per function instance, so page traffic
// costs at most ~1 Firestore read/minute — the same read-cost discipline as
// the portal endpoints. Only non-sensitive display fields pass through.

const { getDb } = require("./_lib/firebase");

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 60 * 1000;

function res(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  try {
    if (_cache && Date.now() - _cacheAt < TTL_MS) return res(200, _cache);
    const doc = await getDb().collection("community").doc("creators").get();
    if (!doc.exists) return res(200, { creators: [], totals: { creators: 0, live: 0, viewers: 0 }, updatedAt: null });
    const d = doc.data() || {};
    _cache = {
      updatedAt: d.updatedAt || null,
      totals:    d.totals || { creators: 0, live: 0, viewers: 0 },
      creators:  (Array.isArray(d.creators) ? d.creators : []).map((c) => ({
        // uid is needed client-side to open DM threads (it grants nothing on
        // its own — every community collection is rules-gated by auth).
        uid: c.uid || null,
        channel: c.channel, name: c.name, avatarUrl: c.avatarUrl || null,
        plan: c.plan, trial: !!c.trial,
        isLive: !!c.isLive, viewers: c.viewers || 0, title: c.title || "",
        category: c.category || "", blurb: c.blurb || "",
        lastLiveAt: c.lastLiveAt || null,
        hoursStreamed: c.hoursStreamed || 0, sessions: c.sessions || 0,
        giveawaysRun: c.giveawaysRun || 0, winnersDrawn: c.winnersDrawn || 0,
        // memberSince may be a Firestore Timestamp on older docs — normalize to millis
        huntsRun: c.huntsRun || 0,
        memberSince: typeof c.memberSince === "number" ? c.memberSince
          : (c.memberSince && typeof c.memberSince.toMillis === "function") ? c.memberSince.toMillis()
          : (c.memberSince && c.memberSince._seconds != null) ? c.memberSince._seconds * 1000
          : null,
      })),
    };
    _cacheAt = Date.now();
    return res(200, _cache);
  } catch (err) {
    console.error("[community-creators]", err.message);
    return res(500, { error: "Failed to load creators" });
  }
};
