// Verifiable giveaway draws — commit/reveal.
//
// The problem this solves is social, not technical: in a chat full of people who
// gamble, "that was rigged, you gave it to your mate" is a permanent background
// accusation, and until now neither we nor the streamer could disprove it. The
// draw ran on Math.random() inside the streamer's own browser.
//
// The scheme:
//   1. COMMIT  — when the giveaway opens, the server generates a 32-byte secret
//      seed and publishes only SHA-256(seed). The streamer never sees the seed,
//      so they cannot shop for one that favours anyone.
//   2. DRAW    — the winning ticket is HMAC-SHA256(seed, entryListHash:nonce).
//      The entry list is hashed from what the SERVER reads out of Firestore, not
//      from anything the client sends, so the pool cannot be doctored either.
//   3. REVEAL  — the seed, the full entry list and the nonce are published with
//      the result. Anyone can recompute the winner and check the seed against
//      the hash that was published before entries opened.
//
// EVERY draw gets its OWN seed. Draw N is computed from seed N, and the same
// transaction that consumes it commits seed N+1 by publishing its hash. This is
// not optional bookkeeping — reusing one seed across a round would break the
// guarantee completely on re-rolls: once draw #1 reveals the seed, anyone can
// compute HMAC(seed, listHash:nonce) offline for a hypothetical pool, and the
// streamer controls the pool (hand-added entrants, remove-from-pool, the luck
// sliders — each changes the list hash and so the winner). They could grind
// variants until their friend won and still publish a proof that verified.
//
// The nonce remains as the draw counter: it orders the draws, makes each draw id
// unique, and means a re-roll is published rather than done invisibly.
//
// js/fairness-verify.js reimplements verifyDraw() against SubtleCrypto for the
// public verifier page. The two MUST agree byte for byte; if you change how the
// message is built here, change it there and in the shared test.

const crypto = require("crypto");

const SEED_BYTES = 32;

// Alphabet for the short verify code. No 0/O/1/I/L — a viewer reading this off
// a stream and typing it into a phone should not have to guess which character
// they are looking at. 8 chars over 30 symbols is ~6.5e11 combinations, so
// collisions stay theoretical even at a lot of draws (the caller retries anyway).
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH   = 8;

function newDrawCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  // Rejection-free mapping is not needed here: the tiny modulo bias across a
  // 31-symbol alphabet costs a fraction of a bit and this is an identifier, not
  // a secret — nothing about the draw depends on the code being unguessable.
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function newServerSeed() {
  return crypto.randomBytes(SEED_BYTES).toString("hex");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

// The exact bytes the entry list commits to. Canonical and boring on purpose:
// one "key:tickets" pair per entry, in pool order, newline separated. A verifier
// rebuilds this from the published list, so any change to the format breaks
// every historical proof — treat it as frozen.
function canonicalEntryList(pool) {
  return pool.map(p => `${p.key}:${p.tickets}`).join("\n");
}

function entryListHash(pool) {
  return sha256Hex(canonicalEntryList(pool));
}

/**
 * Pick the winning ticket for one draw.
 *
 * @param {string} serverSeed  the revealed secret
 * @param {string} listHash    entryListHash(pool)
 * @param {number} nonce       draw number within this giveaway, from 0
 * @param {number} totalTickets
 * @returns {{ digest: string, ticket: number }}
 */
function drawTicket(serverSeed, listHash, nonce, totalTickets) {
  if (!totalTickets || totalTickets < 1) throw new Error("No tickets in the pool");
  const message = `${listHash}:${nonce}`;
  const digest  = crypto.createHmac("sha256", serverSeed).update(message, "utf8").digest("hex");
  // 64 bits of the digest. Modulo bias against any realistic ticket count
  // (< 2^32) is far below one part in a billion, and using the whole digest
  // would make the browser verifier need BigInt gymnastics for no gain.
  const ticket = Number(BigInt("0x" + digest.slice(0, 16)) % BigInt(totalTickets));
  return { digest, ticket };
}

// Walk the cumulative ticket ranges to find which entry owns a ticket index.
function ownerOfTicket(pool, ticket) {
  let running = 0;
  for (const p of pool) {
    running += p.tickets;
    if (ticket < running) return p;
  }
  return pool[pool.length - 1];   // unreachable while ticket < totalTickets
}

/**
 * Recompute a published proof from scratch. Used by the verifier endpoint and
 * mirrored in the browser.
 * @returns {{ ok: boolean, reasons: string[], winnerKey: string|null }}
 */
function verifyDraw(proof) {
  const reasons = [];
  const pool    = Array.isArray(proof?.pool) ? proof.pool : [];
  if (!pool.length) return { ok: false, reasons: ["Proof contains no entries"], winnerKey: null };

  if (sha256Hex(proof.serverSeed) !== proof.serverSeedHash) {
    reasons.push("The revealed seed does not match the hash published before entries opened");
  }
  const listHash = entryListHash(pool);
  if (listHash !== proof.entryListHash) {
    reasons.push("The entry list does not match the hash recorded at draw time");
  }
  const total = pool.reduce((n, p) => n + p.tickets, 0);
  if (total !== proof.totalTickets) {
    reasons.push(`Ticket total is ${total}, the proof claims ${proof.totalTickets}`);
  }

  let winnerKey = null;
  try {
    const { ticket } = drawTicket(proof.serverSeed, listHash, proof.nonce, total);
    if (ticket !== proof.winningTicket) {
      reasons.push(`Recomputed ticket ${ticket}, the proof claims ${proof.winningTicket}`);
    }
    winnerKey = ownerOfTicket(pool, ticket).key;
    if (winnerKey !== proof.winnerKey) {
      reasons.push(`Ticket ${ticket} belongs to ${winnerKey}, the proof names ${proof.winnerKey}`);
    }
  } catch (e) {
    reasons.push("Could not recompute the draw: " + e.message);
  }

  return { ok: reasons.length === 0, reasons, winnerKey };
}

module.exports = {
  newServerSeed, newDrawCode, sha256Hex, canonicalEntryList, entryListHash,
  drawTicket, ownerOfTicket, verifyDraw,
};
