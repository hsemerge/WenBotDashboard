// GET /api/draw-proof?uid=<uid>&d=<drawId>   or   ?code=<shortCode>
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

  let uid    = (event.queryStringParameters?.uid || "").trim();
  let drawId = (event.queryStringParameters?.d   || "").trim();
  const code = (event.queryStringParameters?.code || "").trim();

  try {
    // Short code from a chat link — one extra read to find what it points at.
    if (code) {
      if (!/^[a-z0-9]{4,16}$/.test(code)) return res(400, { error: "Malformed code" }, PUBLIC);
      const hit = await getDb().collection("draw_codes").doc(code).get();
      if (!hit.exists) return res(404, { error: "No such draw" }, PUBLIC);
      uid    = hit.data().uid;
      drawId = hit.data().drawId;
    }

    if (!uid || !drawId) return res(400, { error: "Missing uid or draw id" }, PUBLIC);
    // Ids we generate ourselves; anything else is someone probing paths.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !/^[0-9]+-[0-9]+$/.test(drawId)) {
      return res(400, { error: "Malformed id" }, PUBLIC);
    }

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
      code:          d.code  || "",
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
