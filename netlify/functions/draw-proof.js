// GET /api/draw-proof?uid=<uid>&d=<drawId>
//
// Public. Serves one published draw proof so anyone — a viewer who lost, a mod,
// a rival streamer — can recompute the result. This is deliberately an endpoint
// rather than a Firestore rule: proofs stay unreadable in the database and only
// this shape, with only these fields, ever leaves.
//
// Everything returned is already public by design (the seed is revealed after
// the draw, and the entry list is chat names that were typed in public chat).
// Nothing else from the streamer document comes with it.

const { getDb } = require("./_lib/firebase");
const { res } = require("./_lib/http");
const { verifyDraw } = require("./_lib/fairness");

const PUBLIC = "*";   // a proof nobody else can load is not a proof

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(204, {}, PUBLIC);
  if (event.httpMethod !== "GET") return res(405, { error: "Method not allowed" }, PUBLIC);

  const uid    = (event.queryStringParameters?.uid || "").trim();
  const drawId = (event.queryStringParameters?.d   || "").trim();
  if (!uid || !drawId) return res(400, { error: "Missing uid or draw id" }, PUBLIC);
  // Ids we generate ourselves; anything else is someone probing paths.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !/^[0-9]+-[0-9]+$/.test(drawId)) {
    return res(400, { error: "Malformed id" }, PUBLIC);
  }

  try {
    const doc = await getDb().collection("streamers").doc(uid)
      .collection("giveaway_draws").doc(drawId).get();
    if (!doc.exists) return res(404, { error: "No such draw" }, PUBLIC);

    const d = doc.data();
    const proof = {
      drawId:        d.drawId,
      channel:       d.channel || "",
      drawnAt:       d.drawnAt || 0,
      nonce:         d.nonce,
      serverSeed:    d.serverSeed,
      serverSeedHash:d.serverSeedHash,
      nextSeedHash:  d.nextSeedHash || "",
      entryListHash: d.entryListHash,
      digest:        d.digest,
      winningTicket: d.winningTicket,
      totalTickets:  d.totalTickets,
      winnerKey:     d.winnerKey,
      winnerName:    d.winnerName,
      pool:          d.pool || [],
      luck:          d.luck  || {},
      rules:         d.rules || {},
    };

    // Verify our own copy on the way out. If this ever says false, something
    // rewrote a stored proof and the page should say so loudly rather than
    // rubber-stamp it.
    const check = verifyDraw(proof);

    return res(200, { proof, serverCheck: check }, PUBLIC);
  } catch (err) {
    console.error("[draw-proof] error:", err.message);
    return res(500, { error: "Could not load that draw" }, PUBLIC);
  }
};
