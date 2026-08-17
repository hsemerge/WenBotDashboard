// A viewer's OWN wagered total for the current race.
//
// The public board masks names (`nO***W`), deliberately, so a portal page cannot
// pick a viewer's row out of it to show them their own progress. The unmasked
// figure only exists server-side, behind the streamer's affiliate credential.
//
// So this returns exactly one number: the total belonging to the Kick account
// whose access token is presented. It never returns anyone else's, and it never
// returns the unmasked board. Authorisation is possession of the Kick token, the
// same model as verify-unlink.
//
// The number is the one the BOARD RANKS ON. For Duelbits that is weighted wager
// (volume x inverse RTP), not raw volume, so a milestone ladder written in
// weighted terms lines up with the leaderboard a viewer is looking at. Anywhere
// the two differ, `weighted: true` says so and the page can label it.

const { getDb }                 = require("./_lib/firebase");
const { res }                   = require("./_lib/http");
const { getKickUser }           = require("./_lib/kick");
const { CASINO_NAMES }          = require("./_lib/casinos");
const { lookupAffiliate }       = require("./_lib/affiliate");
const { findStreamerByChannel } = require("./_lib/streamer");

// Per viewer, per race. Every visit to the rewards tab would otherwise be a
// live call against the streamer's affiliate key.
const CACHE_TTL_MS = 90 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Bad request" }); }

  const { channel, kickAccessToken, casino } = body;
  if (!channel || !kickAccessToken) return res(400, { error: "Missing channel or Kick session." });

  try {
    const db = getDb();

    const kickLookup = await getKickUser(kickAccessToken);
    if (!kickLookup || !kickLookup.username) {
      return res(401, { error: "Your Kick session has expired. Sign in again." });
    }
    const kickKey = String(kickLookup.username).toLowerCase();

    const streamerDoc = await findStreamerByChannel(db, channel);
    if (!streamerDoc) return res(404, { error: "Streamer not found." });
    const streamerUid  = streamerDoc.id;
    const streamerData = streamerDoc.data();

    const provider = String(casino || streamerData.activeProvider || "").toLowerCase();
    if (!provider || !CASINO_NAMES[provider]) return res(400, { error: "This streamer hasn't set a casino." });

    // Their verification IS the link between Kick and the casino name. No asking
    // the viewer to type it again: they already proved it once.
    const vSnap = await db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(`${kickKey}_${provider}`).get();
    if (!vSnap.exists) {
      return res(200, {
        verified: false, provider, casinoName: CASINO_NAMES[provider],
        kickUsername: kickLookup.username,
      });
    }
    const v = vSnap.data();
    const providerUsername = v.providerUsername || null;
    if (!providerUsername) {
      // Verified with Kick only, no casino name attached.
      return res(200, {
        verified: true, casinoLinked: false, provider, casinoName: CASINO_NAMES[provider],
        kickUsername: kickLookup.username,
      });
    }

    const period = streamerData.leaderboardPeriod || null;
    const cacheRef = db.collection("_cache")
      .doc(`vw_${channel.toLowerCase()}_${provider}_${kickKey}_${(period && period.startAt) || "cycle"}`);
    let cached = null;
    try {
      const c = await cacheRef.get();
      if (c.exists) {
        cached = c.data();
        if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
          return res(200, { ...cached.data, cached: true });
        }
      }
    } catch { /* fall through to a live lookup */ }

    // Credential: providers/ first, then the board doc, because a casino that is
    // only an additional board keeps its credential there.
    const provDoc = await db.collection("streamers").doc(streamerUid)
      .collection("providers").doc(provider).get();
    let cred = provDoc.exists ? provDoc.data() : null;
    if (!cred || !Object.keys(cred).length) {
      const bSnap = await db.collection("streamers").doc(streamerUid).collection("leaderboards").get();
      const board = bSnap.docs.map((d) => d.data())
        .find((b) => String(b.provider || "").toLowerCase() === provider && b.enabled !== false);
      if (board && board.credential) cred = board.credential;
    }
    if (!cred) return res(200, { verified: true, casinoLinked: true, providerUsername, wagered: null, provider, casinoName: CASINO_NAMES[provider] });

    const hit = await lookupAffiliate(provider, cred, providerUsername, null, { period });

    const payload = {
      verified:     true,
      casinoLinked: true,
      kickUsername: kickLookup.username,
      provider,
      casinoName:   CASINO_NAMES[provider],
      providerUsername,
      // null means the lookup could not answer, which is different from zero.
      wagered:      hit ? (hit.wagerAmount || 0) : null,
      // Duelbits ranks on weighted wager, so a ladder written in weighted terms
      // matches. Said out loud so the page can label the number honestly.
      weighted:     provider === "duelbits",
      period:       period ? { startAt: period.startAt || null, endAt: period.endAt || null } : null,
    };

    if (hit) { try { await cacheRef.set({ cachedAt: Date.now(), data: payload }); } catch {} }
    else if (cached && cached.data) return res(200, { ...cached.data, stale: true });

    return res(200, payload);
  } catch (err) {
    console.error("[viewer-wager] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
