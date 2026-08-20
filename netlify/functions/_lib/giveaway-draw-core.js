// The actual draw, extracted so it has exactly one implementation.
//
// Two callers reach it: /api/giveaway-draw (the streamer or a delegated mod, via
// a Firebase token) and /api/share (someone holding a scoped share link). They
// authenticate completely differently and must not be able to produce different
// results — a second copy of this logic is a second set of odds.

const { entryListHash, drawTicket, ownerOfTicket, newServerSeed, sha256Hex, newDrawCode } = require("./fairness");
const { buildPool, anyRuleActive } = require("./giveaway-odds");

// Two extra reads per draw, not per entry, and a draw is an occasional human
// action rather than a polled endpoint.
async function loadEligibilitySets(db, uid) {
  const [vSnap, dSnap] = await Promise.all([
    db.collection("streamers").doc(uid).collection("verified_users").get(),
    db.collection("streamers").doc(uid).collection("discord_links").get(),
  ]);
  const casino = new Set(), discord = new Set(), boards = {};
  vSnap.docs.forEach(d => {
    const data = d.data() || {};
    if (!data.kickName) return;
    const k = data.kickName.toLowerCase();
    casino.add(k);
    (boards[k] = boards[k] || []).push(String(data.provider || "none").toLowerCase());
  });
  dSnap.docs.forEach(d => {
    const data = d.data() || {};
    if (data.kickUsername) discord.add(data.kickUsername.toLowerCase());
  });
  return { casino, discord, boards };
}

// The requirements and multipliers as the STREAMER last saved them. Used for any
// caller that is not the streamer's own dashboard — a share-link holder must not
// be able to hand us their own weights, and gets the settings the channel is
// actually running under instead.
function settingsFromProfile(profile) {
  return {
    luck: {
      sub:   profile.giveawaySubLuck   || 1,
      code:  profile.giveawayCodeLuck  || 1,
      wager: profile.giveawayWagerLuck || 1,
    },
    rules: {
      subOnly: !!profile.giveawaySubOnly,
      casino:  !!profile.giveawayVerifiedCasino,
      discord: !!profile.giveawayVerifiedDiscord,
      board:   profile.giveawayVerifiedBoard || "",
    },
  };
}

/**
 * Draw a winner and publish the proof.
 *
 * The pool is never supplied by the caller — it is read from Firestore here, so
 * a doctored client cannot add a friend, drop a rival or inflate a ticket count
 * and still produce a proof that verifies.
 *
 * `opts.fromProfile` ignores the passed luck/rules and reads them off the
 * streamer's profile. The dashboard passes its live slider values (it IS the
 * streamer, setting them in public); every other caller must not be trusted with
 * that, because the scope check gates the action name, not its arguments.
 * `opts.requireActive` refuses unless a giveaway is actually running.
 *
 * @returns {{ ok: true, result: object } | { ok: false, status: number, error: string, code?: string, excluded?: Array }}
 */
async function performDraw(db, admin, uid, luck, rules, opts) {
  const options = opts || {};
  const secretRef = db.collection("giveaway_fairness").doc(uid);
  const [secretDoc, snapDoc, profDoc] = await Promise.all([
    secretRef.get(),
    db.collection("streamers").doc(uid).collection("giveaway_state").doc("snapshot").get(),
    db.collection("streamers").doc(uid).get(),
  ]);

  const profile = profDoc.data() || {};

  if (!secretDoc.exists) {
    return {
      ok: false, status: 409, code: "no_commitment",
      error: "This giveaway has no draw seed yet.",
    };
  }
  // A seed left over from an earlier round has already been published by that
  // round's proofs, so drawing against it would be drawing against a seed the
  // streamer can read. Refuse rather than produce a proof that verifies but
  // guarantees nothing.
  const committedFor = secretDoc.data().forGiveawayAt;
  const roundStarted = profile.giveawayStartedAt;
  if (committedFor !== undefined && roundStarted !== undefined && committedFor !== roundStarted) {
    return {
      ok: false, status: 409, code: "stale_commitment",
      error: "The draw seed belongs to a previous giveaway. Get a fresh one before drawing.",
    };
  }

  if (options.requireActive && !profile.giveawayActive) {
    return {
      ok: false, status: 409, code: "not_active",
      error: "No giveaway is running right now.",
    };
  }
  if (options.fromProfile) {
    const s = settingsFromProfile(profile);
    luck  = s.luck;
    rules = s.rules;
  }

  const bot     = snapDoc.exists ? (snapDoc.data().entries || []) : [];
  // Hand-added entrants live on the profile, not the snapshot: the bot rewrites
  // the snapshot wholesale every few seconds and would erase them.
  const manual  = Array.isArray(profile.giveawayManualEntries) ? profile.giveawayManualEntries : [];
  const blocked = new Set((Array.isArray(profile.giveawayBlocked) ? profile.giveawayBlocked : [])
    .map(k => String(k).toLowerCase()));

  // Manual entries are appended rather than merged in place, so the published
  // pool order stays the order the list actually filled up in.
  const seen = new Set();
  const entries = [...bot, ...manual].filter(e => {
    const k = String(e.kickKey || e.kickName || e.username || "").toLowerCase();
    if (!k || blocked.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // verified_users and discord_links are full collection reads. Only fetch them
  // when a requirement actually consults them — buildPool skips every eligibility
  // check when no rule is on, so for an open giveaway (the common case, and the
  // one that gets re-rolled) these two reads were pure cost.
  const sets = anyRuleActive(rules)
    ? await loadEligibilitySets(db, uid)
    : { casino: new Set(), discord: new Set(), boards: {} };

  const { pool, totalTickets, excluded } = buildPool(entries, luck, rules, sets);
  if (!pool.length) {
    return {
      ok: false, status: 400, code: "empty_pool", excluded,
      error: "No entries qualify under the current requirements.",
    };
  }

  const listHash = entryListHash(pool);

  // Consume the committed seed and commit the next one, atomically. Two things
  // depend on this being a transaction rather than a read-then-write:
  //   * two draws fired at once must never share a seed or a nonce, or one proof
  //     would claim two different winners;
  //   * the seed this draw reveals must be retired in the same breath, so it can
  //     never be reused once it is public.
  const consumed = await db.runTransaction(async txn => {
    const d   = await txn.get(secretRef);
    const cur = d.data() || {};
    // Read everything off the snapshot BEFORE queueing the write. Firestore hands
    // back an immutable snapshot so ordering would not matter to it, but reading
    // a value you have just told the transaction to overwrite is the kind of line
    // that silently becomes wrong the moment anything about it changes.
    const used = {
      nonce:          cur.drawNonce || 0,
      serverSeed:     cur.serverSeed,
      serverSeedHash: cur.serverSeedHash,
      committedAt:    cur.committedAt,
    };
    const next     = newServerSeed();
    const nextHash = sha256Hex(next);
    txn.update(secretRef, {
      serverSeed:     next,
      serverSeedHash: nextHash,
      committedAt:    Date.now(),
      drawNonce:      used.nonce + 1,
    });
    return Object.assign(used, { nextSeedHash: nextHash });
  });
  const { nonce, serverSeed, serverSeedHash, committedAt, nextSeedHash } = consumed;

  const { digest, ticket } = drawTicket(serverSeed, listHash, nonce, totalTickets);
  const won    = ownerOfTicket(pool, ticket);
  const drawId = `${committedAt}-${nonce}`;

  // Short code for the chat link. Retried on the vanishing chance of a
  // collision; if every attempt somehow lands on a taken code the draw still
  // completes and the long URL still works, because the code is a convenience
  // and never the source of truth.
  let code = null;
  for (let i = 0; i < 4 && !code; i++) {
    const candidate = newDrawCode();
    const held = await db.collection("draw_codes").doc(candidate).get();
    if (!held.exists) {
      await db.collection("draw_codes").doc(candidate).set({ uid, drawId, at: Date.now() });
      code = candidate;
    }
  }

  const proof = {
    uid, drawId, nonce,
    serverSeed, serverSeedHash,          // the seed for THIS draw, revealed now it is done
    nextSeedHash,                        // commitment for the next draw, made before its pool exists
    entryListHash: listHash,
    digest,
    winningTicket: ticket,
    totalTickets,
    winnerKey:  won.key,
    winnerName: won.name,
    pool, luck, rules,
    code,
    drawnAt: Date.now(),
    channel: profile.kickChannel || "",
  };

  await db.collection("streamers").doc(uid).collection("giveaway_draws").doc(drawId).set(proof);
  await db.collection("streamers").doc(uid).update({
    "giveawayFairness.draws":         admin.firestore.FieldValue.increment(1),
    "giveawayFairness.lastDrawId":    drawId,
    // The strip shows the commitment the NEXT draw will run under.
    "giveawayFairness.serverSeedHash": nextSeedHash,
    "giveawayFairness.committedAt":    Date.now(),
  });

  return {
    ok: true,
    result: {
      winner:    won.name,
      winnerKey: won.key,
      drawId, nonce, totalTickets,
      winningTicket: ticket,
      serverSeedHash,
      nextSeedHash,
      code,
      // Short form when we have a code, long form as the fallback. Both land on
      // the same page.
      proofUrl: code
        ? `https://wenbot.gg/v/${code}`
        : `https://wenbot.gg/verify-draw?uid=${encodeURIComponent(uid)}&d=${encodeURIComponent(drawId)}`,
      excluded,
    },
  };
}

module.exports = { performDraw, loadEligibilitySets, settingsFromProfile };
