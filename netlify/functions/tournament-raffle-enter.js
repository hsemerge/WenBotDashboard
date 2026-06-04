// POST /api/tournament-raffle-enter
// Body: { channel, kickUsername, accessToken, slot }
// Raffle-format tournament entry: verifies Kick identity, deducts the entry cost,
// and writes one ticket to the tournament_entries pool (with the viewer's chosen
// slot). The streamer later DRAWS bracketSize entrants from this pool. Entries are
// NOT refunded (luck-based). Honors config.maxEntriesPerUser + config.requireSlot.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { logAudit }            = require("./_lib/audit");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, kickUsername, accessToken, slot } = body;
  if (!channel || !kickUsername || !accessToken) {
    return res(400, { error: "Missing required fields" });
  }

  const channelKey = channel.toLowerCase().trim();
  const userKey    = kickUsername.toLowerCase().trim();

  try {
    // 1. Verify Kick identity
    const kickResp = await fetch("https://api.kick.com/public/v1/users", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!kickResp.ok) return res(401, { error: "Could not verify Kick identity — please log in again" });
    const kickData = await kickResp.json();
    const kickUser = kickData.data?.[0];
    if (!kickUser || kickUser.name.toLowerCase() !== userKey) {
      return res(401, { error: "Identity mismatch — please log in again" });
    }

    const db = getDb();
    if (!(await checkRateLimit(db, userKey, "tourney_raffle", 30, 60))) {
      return res(429, { error: "Too many requests — please slow down a moment." });
    }

    // 2. Find streamer + tournament
    const streamerSnap = await db.collection("streamers").where("kickChannel", "==", channelKey).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });
    const uid = streamerSnap.docs[0].id;

    const tRef = db.collection("streamers").doc(uid).collection("tournaments").doc("current");
    const tDoc = await tRef.get();
    const t    = tDoc.exists ? tDoc.data() : null;
    if (!t || !t.active || t.status !== "registration") {
      return res(400, { error: "Tournament registration is not open." });
    }
    if (t.mode !== "raffle") {
      return res(400, { error: "This tournament isn't a points raffle." });
    }

    const cfg         = t.config || {};
    const entryCost   = cfg.entryCost || 0;
    const maxPerUser  = Math.max(1, cfg.maxEntriesPerUser || 1);
    const requireSlot = !!cfg.requireSlot;
    const slotName    = (slot && typeof slot === "object" ? slot.name : slot) ? String((slot.name || slot)).slice(0, 80) : "";
    if (requireSlot && !slotName) {
      return res(400, { error: "Please pick a slot to enter." });
    }

    // 3. Ticket cap per user
    const entriesCol = db.collection("streamers").doc(uid).collection("tournament_entries");
    const mine = await entriesCol.where("kickUsernameKey", "==", userKey).get();
    if (mine.size >= maxPerUser) {
      return res(400, { error: maxPerUser === 1 ? "You're already entered." : `You've used all ${maxPerUser} of your tickets.` });
    }

    // 4. Points check + deduct, write the ticket (one batch)
    const viewerRef = db.collection("streamers").doc(uid).collection("viewers").doc(userKey);
    const viewerDoc = await viewerRef.get();
    const points    = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;
    if (points < entryCost) {
      return res(400, { error: `Not enough points. You have ${points.toLocaleString()}, need ${entryCost.toLocaleString()}.` });
    }

    const entry = {
      kickUsername,
      kickUsernameKey: userKey,
      slot: slotName ? { name: slotName, thumbnailUrl: (slot && slot.thumbnailUrl) || null, gameId: (slot && slot.gameId) || null } : null,
      pointsSpent: entryCost,
      enteredAt: Date.now(),
    };

    const batch = db.batch();
    if (entryCost > 0) batch.update(viewerRef, { points: admin.firestore.FieldValue.increment(-entryCost) });
    batch.set(entriesCol.doc(), entry);
    batch.update(tRef, {
      prizePool:    admin.firestore.FieldValue.increment(entryCost),
      entriesCount: admin.firestore.FieldValue.increment(1),
      updatedAt:    Date.now(),
    });
    await batch.commit();

    logAudit(uid, "tournament_raffle_enter", { kickUsername, entryCost, slot: slotName || null });

    return res(200, {
      success: true,
      message: `You're in the raffle${slotName ? ` with ${slotName}` : ""}! Good luck 🎟️`,
      ticketsUsed: mine.size + 1,
      maxTickets: maxPerUser,
      newBalance: points - entryCost,
    });
  } catch (err) {
    console.error("[tournament-raffle-enter] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
