// Let a viewer undo their OWN verification for one casino.
//
// Why this exists: a casino username can only be claimed by one Kick account per
// streamer, which is what stops someone verifying the same casino account on
// several Kick alts to multiply their giveaway entries. That check cannot tell
// an abuser from someone who signed in with the wrong Kick account by accident,
// and Kick's OAuth never asks which account to use, so the accident is common.
// Both got the same dead end: "already linked to another Kick account, contact
// a mod". Every innocent mistake became a support ticket.
//
// This is the self-service way out, and it is safe by construction rather than
// by rule: the ONLY record it can touch is the one belonging to the Kick account
// whose access token is presented. There is no "release someone else's claim"
// path here, because proving you hold the account IS the authorisation.
//
// What it deliberately does NOT do:
//   • release a claim held by a different account (that needs their token)
//   • leave the Discord role behind. Undoing a verification takes the role back,
//     or a viewer could walk one casino account through several Kick accounts
//     and collect the verified role on each of their Discord accounts.
//
// Ping-ponging one casino account between two Kick accounts they own gains
// nothing OUTSIDE a giveaway: only one account holds the claim at a time, and
// the role moves with it. DURING one it would, because an entry is banked when
// it is made and is not re-checked at the draw. Verify on Kick A, join, release,
// verify on Kick B, join again, and the pool holds two entries from one casino
// account even though only one of them is verified by then. So unlinking is
// refused while a giveaway is running. A mistake can wait for the draw, or a mod
// can do it, which is a deliberate and visible act rather than a self-serve one.
//
// The durable fix is for the draw to confirm the winner is still verified, which
// also covers mod removals mid-round. That lives in the bot, not here.
//
// Every release is written to the audit log so a streamer can see it happening.

const { getDb }              = require("./_lib/firebase");
const { res }                = require("./_lib/http");
const { getKickUser }        = require("./_lib/kick");
const { CASINO_NAMES }       = require("./_lib/casinos");
const { logAudit }           = require("./_lib/audit");
const { revokeVerifiedRole } = require("./_lib/discord-role");
const { findStreamerByChannel } = require("./_lib/streamer");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Bad request" }); }

  const { channel, kickAccessToken, casino } = body;
  if (!channel || !kickAccessToken || !casino) {
    return res(400, { error: "Missing channel, casino or Kick session." });
  }

  const provider = String(casino).toLowerCase();
  if (!CASINO_NAMES[provider]) return res(400, { error: "Unknown casino." });

  try {
    const db = getDb();

    // Identity comes from the token, never from the request body. This is the
    // whole security model: you can only unlink what you can prove you own.
    const kickLookup = await getKickUser(kickAccessToken);
    if (!kickLookup || !kickLookup.username) {
      return res(401, { error: "Your Kick session has expired. Sign in again." });
    }
    const kickKey = String(kickLookup.username).toLowerCase();

    const streamerDoc = await findStreamerByChannel(db, channel);
    if (!streamerDoc) return res(404, { error: "Streamer not found." });
    const streamerUid  = streamerDoc.id;
    const streamerData = streamerDoc.data();

    // See the header: a release mid-giveaway is the one case that turns into a
    // second entry from one casino account.
    if (streamerData.giveawayActive) {
      return res(409, {
        error: "A giveaway is running right now, so accounts can't be switched until it's drawn. "
             + "Ask a mod if you need this changed sooner.",
        reason: "giveaway_active",
      });
    }

    const ref  = db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(`${kickKey}_${provider}`);
    const snap = await ref.get();
    if (!snap.exists) {
      // Already gone. Report success so a double press is not an error.
      return res(200, { success: true, alreadyUnlinked: true });
    }
    const record = snap.data();

    // The Discord link belongs to the Kick account, not to one casino, and a
    // viewer can be verified on several boards at once (Meg runs four). Dropping
    // the link whenever ANY one of them is released would sign someone out of
    // Discord and take their role for unlinking a second casino they still had
    // every right to leave. So it only goes when this was their LAST
    // verification for this streamer.
    const remainingSnap = await db.collection("streamers").doc(streamerUid)
      .collection("verified_users").where("kickName", "==", kickKey).get();
    const stillVerifiedElsewhere = remainingSnap.docs.some((d) => d.id !== ref.id);

    const linksSnap = stillVerifiedElsewhere
      ? { docs: [], size: 0 }
      : await db.collection("streamers").doc(streamerUid)
          .collection("discord_links").where("kickUsername", "==", kickKey).get();

    // The role goes back BEFORE the link is deleted, or we lose the id we need
    // to address the member.
    let roleRevoked = false;
    for (const d of linksSnap.docs) {
      const id = d.data().discordUserId;
      if (!id) continue;
      const r = await revokeVerifiedRole(streamerData, id);
      if (r.ok) roleRevoked = true;
    }

    const batch = db.batch();
    batch.delete(ref);
    linksSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    await logAudit(streamerUid, "verify_self_unlink", {
      kickUsername:     kickKey,
      provider,
      providerUsername: record.providerUsername || null,
      discordLinksRemoved: linksSnap.size,
      roleRevoked,
      keptDiscordLink: stillVerifiedElsewhere,
    });

    return res(200, {
      success: true,
      provider,
      casinoName:  CASINO_NAMES[provider],
      discordUnlinked: linksSnap.size,
      roleRevoked,
      // Tells the page whether to say "you are still verified for your other
      // casinos" rather than implying everything was undone.
      stillVerifiedElsewhere,
    });
  } catch (err) {
    console.error("[verify-unlink] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
