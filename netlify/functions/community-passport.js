// POST /api/community-passport
// Body: { kickUsername, accessToken }
// The viewer-facing "WenBot Passport": one call returns everything a signed-in
// Kick viewer has across the WHOLE WenBot creator community — per-channel
// points, giveaway wins, raffle tickets — plus community-wide totals.
//
// Identity: the viewer's Kick OAuth token (same model as store-buy / bb-vote —
// getKickUser must resolve the token to the claimed username). No Firebase
// account needed; viewers are Kick-native.
//
// Cost design: the channel list comes from the community/creators aggregate
// (1 read). Per creator we do at most 3 bounded lookups (viewer doc, wins
// count(), ticket docs limit 25) — ~capped at 25 creators. Results are cached
// per viewer for 2 minutes, so page refreshes are ~1 read.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { getKickUser }         = require("./_lib/kick");

const TTL_MS       = 2 * 60 * 1000;
const MAX_CREATORS = 25;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const kickUsername = String(body.kickUsername || "").trim();
  const accessToken  = String(body.accessToken || "").trim();
  if (!kickUsername || !accessToken) return res(400, { error: "Missing sign-in" });
  const userKey = kickUsername.toLowerCase();

  try {
    // 1. Verify the token belongs to the claimed viewer.
    const kickLookup = await getKickUser(accessToken);
    if (kickLookup.error) return res(kickLookup.status, { error: kickLookup.error });
    if (kickLookup.user.name.toLowerCase() !== userKey) {
      return res(401, { error: "Identity mismatch — please sign in again" });
    }
    const avatarUrl = kickLookup.user.profile_picture || null;

    const db = getDb();
    if (!(await checkRateLimit(db, userKey, "passport", 30, 60))) {
      return res(429, { error: "Too many requests — one moment" });
    }

    // 2. Serve from cache when fresh.
    const cacheRef = db.collection("_cache").doc(`passport_${userKey}`);
    try {
      const c = await cacheRef.get();
      if (c.exists && c.data().payload && (Date.now() - c.data().cachedAt) < TTL_MS) {
        return res(200, { ...c.data().payload, avatarUrl, cached: true });
      }
    } catch { /* rebuild */ }

    // 3. The community's creators (aggregate doc) + the viewer's global
    //    WenPoints ledger — 2 reads, fetched together.
    const [commDoc, wpDoc] = await Promise.all([
      db.collection("community").doc("creators").get(),
      db.collection("wenpoints").doc(userKey).get(),
    ]);
    const creators = (commDoc.exists ? commDoc.data().creators || [] : []).slice(0, MAX_CREATORS);
    const wp = wpDoc.exists ? wpDoc.data() : {};

    // 4. Per-creator lookups, all in parallel, all bounded.
    const channels = (await Promise.all(creators.map(async (c) => {
      try {
        const sref = db.collection("streamers").doc(c.uid);
        const [viewerDoc, winsAgg, ticketSnap] = await Promise.all([
          sref.collection("viewers").doc(userKey).get(),
          sref.collection("winners_log").where("kickKey", "==", userKey).count().get()
            .then((a) => a.data().count || 0).catch(() => 0),
          sref.collection("store_redemptions")
            .where("kickUsernameKey", "==", userKey)
            .where("status", "==", "raffle_entry")
            .limit(25).get().catch(() => null),
        ]);
        const v = viewerDoc.exists ? viewerDoc.data() : {};
        const points = v.points || 0;
        let  tickets = 0;
        if (ticketSnap) ticketSnap.forEach((d) => { tickets += d.data().qty || 1; });
        if (!viewerDoc.exists && !winsAgg && !tickets) return null; // no presence here
        return {
          channel: c.channel, name: c.name, avatarUrl: c.avatarUrl || null,
          isLive: !!c.isLive, viewers: c.viewers || 0, title: c.title || "",
          currency: c.currency || "points",
          schedule: c.schedule || null,
          points, wins: winsAgg, tickets,
          msgs:     v.msgCount || 0,
          lastSeen: v.lastSeen || null,
          streak:   v.checkinStreak || v.streak || 0,
        };
      } catch { return null; }
    }))).filter(Boolean)
       .sort((a, b) => (b.isLive - a.isLive) || (b.points - a.points));

    const payload = {
      username: kickLookup.user.name,
      channels,
      wenpoints: {
        balance:     wp.balance || 0,
        lifetime:    wp.lifetime || 0,
        streak:      wp.streak || 0,
        lastCheckin: wp.lastCheckin || null,
        owned:       wp.owned || { theme: [], flair: [] },
        equipped:    wp.equipped || {},
      },
      totals: {
        channels: channels.length,
        points:   channels.reduce((s, x) => s + x.points, 0),
        wins:     channels.reduce((s, x) => s + x.wins, 0),
        tickets:  channels.reduce((s, x) => s + x.tickets, 0),
      },
    };
    try { await cacheRef.set({ cachedAt: Date.now(), payload }); } catch { /* skip */ }
    return res(200, { ...payload, avatarUrl, cached: false });
  } catch (err) {
    console.error("[community-passport]", err.message);
    return res(500, { error: "Failed to load your passport" });
  }
};
