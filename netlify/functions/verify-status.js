// POST /api/verify-status
// Body: { channel, kickAccessToken }
//
// Lightweight pre-check the verify page hits AFTER Kick OAuth completes — lets
// us skip the casino-username form entirely when the viewer is already verified
// for the streamer's active casino. The full verify-affiliate.js flow does too
// much (rate limit, affiliate API call, writes) to repurpose for a passive
// status check, so this is its own minimal endpoint.

const { getDb, admin } = require("./_lib/firebase");
const { findStreamerByChannel } = require("./_lib/streamer");
const { res }          = require("./_lib/http");
const { getKickUser }  = require("./_lib/kick");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, kickAccessToken } = body;
  if (!channel || !kickAccessToken) return res(400, { error: "Missing channel or kickAccessToken" });

  try {
    // Prove Kick identity — hardened shared lookup (clear, retryable errors).
    const kickLookup = await getKickUser(kickAccessToken);
    if (kickLookup.error) return res(kickLookup.status, { error: kickLookup.error });
    const kickUsername = kickLookup.user.name;
    const kickKey      = kickUsername.toLowerCase();

    const db = getDb();
    const streamerSnapDoc = await findStreamerByChannel(db, channel);
    if (!streamerSnapDoc) return res(404, { error: "Channel not found" });
    const uid          = streamerSnapDoc.id;
    const streamerData = streamerSnapDoc.data();
    // Streamer policy: when false, the verify page offers "skip the casino step"
    // (Kick-only verification). Default true — leaderboard/code streamers.
    const casinoRequired = streamerData.casinoRequired !== false;
    // Never assume a casino — if none is set there's nothing to verify against.
    const activeProvider = (streamerData.activeProvider || "").toLowerCase();
    if (!activeProvider) {
      return res(200, { kickUsername, verified: false, provider: null, noCasino: true, casinoRequired, discordLinkedAny: false });
    }

    // Every board this streamer runs, with the viewer's status on each. A
    // streamer can run more than one race (Meg: Degen + CSGOBig), and a viewer
    // may play one, the other, or both — verifications are stored per provider
    // (`${kickKey}_${provider}`), so all of this is representable. Until now the
    // page only ever offered the ACTIVE provider, so a viewer who plays the second
    // casino had no way to verify against it.
    //
    // Additive: every field below this is unchanged, so the existing single-board
    // page keeps working exactly as it does today.
    let boards = [];
    try {
      const bSnap = await db.collection("streamers").doc(uid).collection("leaderboards").get();
      const enabled = bSnap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) }))
        .filter((b) => b.enabled !== false && b.provider)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      boards = await Promise.all(enabled.map(async (b) => {
        const prov = String(b.provider).toLowerCase();
        const vs   = await db.collection("streamers").doc(uid)
          .collection("verified_users").doc(`${kickKey}_${prov}`).get();
        const v = vs.exists ? vs.data() : null;
        return {
          provider:         prov,
          label:            b.label || prov,
          isPrimary:        prov === activeProvider,
          verified:         !!v,
          providerUsername: v ? (v.providerUsername || null) : null,
          underAffiliate:   v ? !!v.underAffiliate : false,
        };
      }));
    } catch (e) {
      console.warn("[verify-status] boards lookup failed:", e.message);
    }

    // Direct lookups by the known doc ID format — `${kickKey}_${provider}`,
    // plus the Kick-only doc (`${kickKey}_none`) written by the skip path.
    const [verifySnap, skipSnap, discordSnap] = await Promise.all([
      db.collection("streamers").doc(uid).collection("verified_users").doc(`${kickKey}_${activeProvider}`).get(),
      db.collection("streamers").doc(uid).collection("verified_users").doc(`${kickKey}_none`).get(),
      db.collection("streamers").doc(uid).collection("discord_links")
        .where("kickUsername", "==", kickUsername).limit(1).get(),
    ]);

    if (verifySnap.exists) {
      const v = verifySnap.data();
      return res(200, {
        kickUsername,
        verified:         true,
        provider:         activeProvider,
        providerUsername: v.providerUsername || null,
        underAffiliate:   !!v.underAffiliate,
        casinoRequired,
        boards,
        discordLinkedAny: !discordSnap.empty,
      });
    }

    // Kick-only verified (casino skipped) — page shows the "verified, add your
    // casino anytime" card instead of the blank form.
    if (skipSnap.exists) {
      return res(200, {
        kickUsername,
        verified:         true,
        casinoSkipped:    true,
        provider:         activeProvider,
        providerUsername: null,
        underAffiliate:   false,
        casinoRequired,
        boards,
        discordLinkedAny: !discordSnap.empty,
      });
    }

    return res(200, {
      kickUsername,
      verified:     false,
      provider:     activeProvider,
      casinoRequired,
      boards,
      discordLinkedAny: !discordSnap.empty,
    });
  } catch (err) {
    console.error("[verify-status] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
