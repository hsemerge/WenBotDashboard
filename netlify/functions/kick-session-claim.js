// POST /api/kick-session-claim
// Body: { code }
// Cross-domain viewer-session handoff (step 2 of 2). The custom-domain portal
// page exchanges the one-time code (from ?s=<code>) for the viewer session that
// /api/kick-session-mint stashed after OAuth completed on wenbot.gg. The code is
// single-use and expires in 60s, so even though it briefly rides in the URL it
// can't be replayed.

const { getDb } = require("./_lib/firebase");
const { res }   = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const code = body.code;
  if (!code || typeof code !== "string") return res(400, { error: "Missing code" });

  const db  = getDb();
  const ref = db.collection("kick_session_codes").doc(code);

  // Single-use: claim inside a transaction so a code can't be redeemed twice.
  let session;
  try {
    session = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists)              throw { code: 404, msg: "Invalid or expired code" };
      const d = doc.data();
      if (d.used)                   throw { code: 410, msg: "Code already used" };
      if (Date.now() > d.expiresAt) throw { code: 410, msg: "Code expired" };
      tx.update(ref, { used: true });
      return d.session;
    });
  } catch (e) {
    if (e && e.code && e.msg) return res(e.code, { error: e.msg });
    throw e;
  }

  // Best-effort cleanup (don't block the response on it).
  ref.delete().catch(() => {});

  return res(200, { session });
};
