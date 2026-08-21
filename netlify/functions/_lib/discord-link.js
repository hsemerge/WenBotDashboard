// Saving a Discord link means two writes, not one.
//
// The link itself lives in streamers/{uid}/discord_links/{discordUserId}. But the
// giveaway gate ("Require verification -> Discord Verified") runs inside the bot
// against its cached verified_users map, which it reloads every 2 minutes. It has
// no discord_links in hand and can't scan that collection on a 2-minute timer
// without adding an unbounded read per streamer per cycle.
//
// So the flag has to live ON the verified_users doc. Nothing wrote it: the gate
// read `discordVerified`, the verify endpoint wrote `discordLinked` and only into
// its own HTTP response and audit log, never into the doc. The result was a gate
// that rejected every viewer on every channel, while the dashboard read
// discord_links directly and cheerfully showed them as Discord-linked.
//
// Every writer of discord_links goes through here so the two can't drift again.

/**
 * Write the discord_links doc and stamp discordVerified onto every verified_users
 * doc belonging to that Kick user (a viewer can be verified on several boards).
 *
 * The stamp is best-effort: a viewer can link Discord before verifying a casino,
 * in which case there is nothing to stamp yet and verify-affiliate picks it up on
 * the way through. Failing to stamp must never fail the link itself.
 *
 * @returns {number} how many verified_users docs were stamped
 */
const lc = (v) => String(v || "").toLowerCase().trim();

async function saveDiscordLink(db, streamerUid, discordUserId, link) {
  const { kickUsername, discordUsername } = link;

  const base    = db.collection("streamers").doc(streamerUid);
  const linkRef = base.collection("discord_links").doc(discordUserId);

  // A Discord id maps to ONE link doc, so re-linking overwrites it. Read the
  // name it pointed at FIRST: if this Discord was on a different Kick account,
  // that account must lose the Discord-verified badge it was stamped with -
  // otherwise one Discord silently keeps certifying every Kick alt it ever
  // touched, which is exactly how a Discord-verify gate gets farmed.
  let previousKick = null;
  try {
    const prev = await linkRef.get();
    if (prev.exists) {
      const pk = prev.data().kickUsername;
      if (pk && lc(pk) !== lc(kickUsername)) previousKick = pk;
    }
  } catch { /* first-time link, or read failed → treat as no move */ }

  await linkRef.set({ ...link, linkedAt: Date.now() });

  let stamped = 0;
  try {
    stamped = await stampDiscordVerified(db, streamerUid, kickUsername, { discordUserId, discordUsername });
  } catch (err) {
    console.warn("[discord-link] stamp failed:", err.message);
  }

  if (previousKick) {
    // Best-effort: a failure here must never fail the link that succeeded above.
    try { await handleDiscordMove(db, streamerUid, discordUserId, previousKick, kickUsername, discordUsername); }
    catch (err) { console.warn("[discord-link] move handling failed:", err.message); }
  }
  return stamped;
}

/**
 * Undo a Discord move away from `previousKick`: if no OTHER Discord is still
 * linked to that Kick name, clear its Discord-verified badge; if one is, keep it
 * verified but repoint the stamp to a link that still exists. Then tell the mods.
 */
async function handleDiscordMove(db, streamerUid, discordUserId, previousKick, newKick, discordUsername) {
  const base = db.collection("streamers").doc(streamerUid);

  // discord_links is small per streamer and a move is rare, so a full scan is
  // fine - and it sidesteps the display-vs-lowercase casing of kickUsername.
  const all = await base.collection("discord_links").get();
  const remaining = all.docs.filter((d) => d.id !== discordUserId && lc(d.data().kickUsername) === lc(previousKick));

  let clearedOld;
  if (remaining.length) {
    // Still legitimately Discord-linked by someone else → stays verified, but
    // repointed to a Discord that actually still links to it.
    const r = remaining[0].data();
    await stampDiscordVerified(db, streamerUid, previousKick, { discordUserId: remaining[0].id, discordUsername: r.discordUsername || null });
    clearedOld = false;
  } else {
    await clearDiscordVerified(db, streamerUid, previousKick);
    clearedOld = true;
  }

  // Real-time note to the verification channel so a mod sees the move happen.
  try {
    const { postDiscordMoveAlert } = require("./verify-log");
    await postDiscordMoveAlert(db, streamerUid, {
      discordUsername, discordUserId, fromKick: previousKick, toKick: newKick, clearedOld,
    });
  } catch (err) {
    console.warn("[discord-link] move alert failed:", err.message);
  }
}

/**
 * Clear the Discord-verified stamp from every board doc of a Kick user. The
 * mirror of stampDiscordVerified, used when a Discord moves away and leaves the
 * old name with no Discord linked.
 */
async function clearDiscordVerified(db, streamerUid, kickUsername) {
  const kickKey = lc(kickUsername);
  if (!kickKey) return 0;
  const col = db.collection("streamers").doc(streamerUid).collection("verified_users");
  let snap = await col.where("kickName_lower", "==", kickKey).get();
  if (snap.empty) snap = await col.where("kickName", "==", kickUsername).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.forEach((doc) => {
    batch.set(doc.ref, {
      discordVerified: false,
      discordUserId:   null,
      discordUsername: null,
      discordLinkedAt: null,
    }, { merge: true });
  });
  await batch.commit();
  return snap.size;
}

/**
 * Mark every board doc for this Kick user as Discord-linked.
 *
 * Looked up by the denormalized kickName_lower, with a fallback to the
 * original-case kickName for docs written before that field existed. NOT by doc-id
 * prefix: ids are `${kickKey}_${provider}` and Kick usernames may contain
 * underscores, so a range scan over `emerge` would also sweep up `emerge_on`.
 */
async function stampDiscordVerified(db, streamerUid, kickUsername, fields = {}) {
  const kickKey = (kickUsername || "").toLowerCase();
  if (!kickKey) return 0;

  const col = db.collection("streamers").doc(streamerUid).collection("verified_users");
  let snap = await col.where("kickName_lower", "==", kickKey).get();
  if (snap.empty) snap = await col.where("kickName", "==", kickUsername).get();
  if (snap.empty) return 0;

  const batch = db.batch();
  snap.forEach((doc) => {
    batch.set(doc.ref, {
      discordVerified: true,
      discordUserId:   fields.discordUserId || null,
      discordUsername: fields.discordUsername || null,
      discordLinkedAt: Date.now(),
    }, { merge: true });
  });
  await batch.commit();
  return snap.size;
}

/**
 * The reverse direction: a viewer who linked Discord FIRST and is verifying a
 * casino now. The freshly written verified_users doc would have no flag, because
 * the link predates it. Called by verify-affiliate for the no-dtoken case, where
 * the flow itself carries no Discord identity.
 *
 * @returns {object|null} the existing link, or null if there isn't one
 */
async function findExistingDiscordLink(db, streamerUid, kickUsername) {
  const snap = await db.collection("streamers").doc(streamerUid)
    .collection("discord_links")
    .where("kickUsername", "==", kickUsername)
    .limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

module.exports = { saveDiscordLink, stampDiscordVerified, findExistingDiscordLink, clearDiscordVerified };
