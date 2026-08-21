// Per-viewer moderation history: a durable trail of the identity events a mod
// needs to judge whether someone is multi-accounting - a Discord hopping between
// Kick names, a Kick rename - surfaced in the /lookup command.
//
// Stored at streamers/{uid}/viewer_history/{kickKey}, a bounded, deduped list of
// { ts, type, text }. Keyed by the lowercased Kick name, the same key everything
// else viewer-side uses, so the merge tool carries it forward when a rename is
// confirmed. Admin-SDK only (see firestore.rules): a mod reads it through
// /lookup, never writes it, so the trail cannot be tampered with from a client.
//
// Writes are rare (they fire on a move or a rename, not on activity), so the
// read-modify-write in a transaction is cheap and keeps the array correctly
// bounded, which arrayUnion cannot.

const MAX_EVENTS = 25;

/**
 * Append an event to a viewer's history. Deduped on (type + text): re-verifying
 * or re-detecting the same condition will not stack identical rows, so the
 * history stays a list of DISTINCT things that happened rather than a spam log.
 *
 * Best-effort by contract: callers wrap it so a failure never breaks the link or
 * verification it rides on.
 *
 * @param {string} kickName   the Kick name the event is ABOUT (filed under it)
 * @param {object} event      { type, text }
 */
async function recordViewerEvent(db, streamerUid, kickName, event) {
  const key = String(kickName || "").toLowerCase().trim();
  if (!key || !event || !event.type) return;

  const ref   = db.collection("streamers").doc(streamerUid).collection("viewer_history").doc(key);
  const entry = { ts: Date.now(), type: String(event.type), text: String(event.text || "").slice(0, 300) };

  await db.runTransaction(async (tx) => {
    const snap   = await tx.get(ref);
    const events = (snap.exists && Array.isArray(snap.data().events)) ? snap.data().events.slice() : [];
    // Skip an exact repeat, but refresh its timestamp so "last seen" is current.
    const dupe = events.find((e) => e.type === entry.type && e.text === entry.text);
    if (dupe) { dupe.ts = entry.ts; }
    else      { events.push(entry); }
    tx.set(ref, { events: events.slice(-MAX_EVENTS), updatedAt: Date.now() }, { merge: true });
  });
}

module.exports = { recordViewerEvent };
