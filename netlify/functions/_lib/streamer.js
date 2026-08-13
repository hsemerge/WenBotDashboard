// Resolve a streamer by their Kick channel slug, including slugs they used to
// have.
//
// A rename on Kick used to break everything at once. 28 functions each did their
// own exact match on `kickChannel`, so the moment irishqueenoftheslots became
// meggambles, every old link, bookmark, custom domain and hardcoded page
// constant started 404-ing: no portal, no points, no daily reward, no store, no
// raffle. The account was fine the whole time; only the name it was being asked
// for had changed.
//
// The bot's reconciler records every former slug in `previousChannels`, so an
// old address can still find its account. One helper so a new endpoint cannot
// quietly reintroduce the exact-match bug.
//
// Returns the QueryDocumentSnapshot (so callers keep using .id and .data()) or
// null when nothing matches.
async function findStreamerByChannel(db, channel) {
  const slug = String(channel || "").trim().toLowerCase();
  if (!slug) return null;

  let snap = await db.collection("streamers")
    .where("kickChannel", "==", slug).limit(1).get();
  if (!snap.empty) return snap.docs[0];

  // Former slug. Costs a second read only when the first misses, which after a
  // rename is exactly the case worth paying for.
  snap = await db.collection("streamers")
    .where("previousChannels", "array-contains", slug).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

module.exports = { findStreamerByChannel };
