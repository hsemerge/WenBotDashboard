// Shared raffle-ticket storage helpers.
//
// TICKET STORAGE MODEL (v2, July 2026):
// One doc per (raffle item, viewer) with a qty counter — NOT one doc per
// ticket. Doc id is deterministic: t_<itemId>_<kickKey>. A viewer buying 500
// tickets is ONE doc with qty:500, so a 100k-ticket raffle is a few hundred
// docs instead of 100k. Every reader treats a missing qty as 1, which keeps
// legacy per-ticket docs (auto-ids, no qty) counting correctly until the
// migrate_item op compacts them.
//
// A running total also lives ON the store_item doc (raffleTickets), maintained
// by every write path — so portal entry counts are read for free with the item.

const { admin } = require("./firebase");

function ticketRef(db, uid, itemId, kickKey) {
  return db.collection("streamers").doc(uid)
    .collection("store_redemptions").doc(`t_${itemId}_${kickKey}`);
}

// Add tickets for a viewer — coalesced merge-set (atomic increments, safe under
// concurrency, no transaction needed). `tx` optional: pass a Firestore
// transaction to ride inside it. Returns the ticket doc ref.
function addTickets(db, { uid, itemId, itemName, kickUsername, qty, pointsSpent, source, extra = {} }, tx = null) {
  const kickKey = String(kickUsername || "").toLowerCase();
  const tRef    = ticketRef(db, uid, itemId, kickKey);
  const iRef    = db.collection("streamers").doc(uid).collection("store_items").doc(itemId);
  const data = {
    itemId, itemName: itemName || "Raffle",
    kickUsername, kickUsernameKey: kickKey,
    status: "raffle_entry",
    qty:         admin.firestore.FieldValue.increment(qty),
    pointsSpent: admin.firestore.FieldValue.increment(pointsSpent || 0),
    redeemedAt:  new Date(),
    source: source || "kick",
    ...extra,
  };
  const counter = { raffleTickets: admin.firestore.FieldValue.increment(qty) };
  if (tx) {
    tx.set(tRef, data, { merge: true });
    tx.set(iRef, counter, { merge: true });
  } else {
    return Promise.all([
      tRef.set(data, { merge: true }),
      iRef.set(counter, { merge: true }),
    ]);
  }
  return tRef;
}

// Bust the cached aggregates a mutation invalidates (raffle-detail + portal totals).
async function bustRaffleCaches(db, uid, itemId) {
  await Promise.allSettled([
    db.collection("_cache").doc(`raffle_detail_${uid}_${itemId}`).delete(),
    db.collection("_cache").doc(`raffle_${uid}`).delete(),
    db.collection("_cache").doc(`raffle_scan_${uid}`).delete(),
  ]);
}

module.exports = { ticketRef, addTickets, bustRaffleCaches };
