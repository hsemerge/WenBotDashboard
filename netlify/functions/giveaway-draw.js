// POST /api/giveaway-draw
// Draws a giveaway winner verifiably and publishes the proof.
//
// Body: { uid?, luck: {sub,code,wager}, rules: {subOnly,casino,discord,board} }
// Returns: { winner, winnerKey, drawId, proofUrl, nonce, totalTickets, excluded }
//
// The draw itself lives in _lib/giveaway-draw-core.js, shared with /api/share so
// a mod holding a scoped link draws under exactly the same odds and publishes
// exactly the same kind of proof.

const { getDb, admin } = require("./_lib/firebase");
const { res } = require("./_lib/http");
const { sanitiseLuck, sanitiseRules } = require("./_lib/giveaway-odds");
const { performDraw } = require("./_lib/giveaway-draw-core");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }

  const db = getDb();
  let uid;
  try {
    const decoded   = await admin.auth().verifyIdToken(idToken);
    const requested = body.uid || decoded.uid;
    const delegated = Array.isArray(decoded.delegatedFor) && decoded.delegatedFor.includes(requested);
    if (requested !== decoded.uid && !delegated) {
      return res(403, { error: "You don't have access to that account." });
    }
    uid = requested;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  try {
    const out = await performDraw(
      db, admin, uid,
      sanitiseLuck(body.luck),
      sanitiseRules(body.rules),
    );
    if (!out.ok) return res(out.status, { error: out.error, code: out.code, excluded: out.excluded });
    return res(200, out.result);
  } catch (err) {
    console.error("[giveaway-draw] error:", err.message);
    return res(500, { error: "Could not complete the draw" });
  }
};
