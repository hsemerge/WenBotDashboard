// POST /api/extension-pair  { code }
// The WenBot Companion extension redeems a pairing code (from extension-connect)
// for a long-lived, revocable token. The token is the extension's credential for
// /api/ext-bonus-hunt. Codes are single-use and short-lived.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {}, "*");
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" }, "*");

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "extpair", 10, 60))) {
    return res(429, { error: "Too many tries. Wait a moment." }, "*");
  }

  let body; try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }, "*"); }
  const code = String(body.code || "").trim().toUpperCase();
  if (!code) return res(400, { error: "Missing pairing code." }, "*");

  const pairRef = db.collection("extension_pairings").doc(code);
  const pairSnap = await pairRef.get();
  if (!pairSnap.exists) return res(404, { error: "Invalid or already-used code. Generate a fresh one." }, "*");
  const pair = pairSnap.data();
  if (Date.now() > pair.expiresAt) {
    await pairRef.delete().catch(() => {});
    return res(410, { error: "That code expired. Generate a fresh one." }, "*");
  }

  // Mint the token, store token→streamer mapping, consume the code.
  const token = require("crypto").randomBytes(32).toString("hex");
  await db.collection("extension_tokens").doc(token).set({
    uid:        pair.uid,
    channel:    pair.channel,
    casino:     pair.casino || null,
    createdAt:  Date.now(),
    lastUsedAt: Date.now(),
  });
  await pairRef.delete().catch(() => {});

  return res(200, { token, channel: pair.channel, casino: pair.casino || null }, "*");
};
