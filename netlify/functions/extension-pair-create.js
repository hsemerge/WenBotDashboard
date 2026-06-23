// POST /api/extension-pair-create
// Called by extension-connect.html (a logged-in WenBot page). Verifies the
// streamer's Firebase ID token, then mints a short, single-use pairing CODE that
// the streamer types into the WenBot Companion extension. The code maps to their
// uid + channel; the extension redeems it via /api/extension-pair for a token.
//
// extension_pairings / extension_tokens are written ONLY by these functions
// (admin SDK) — clients are default-denied by Firestore rules, so no rule change.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I/L

function makeCode() {
  const buf = require("crypto").randomBytes(6);
  let c = "";
  for (let i = 0; i < 6; i++) c += ALPHABET[buf[i] % ALPHABET.length];
  return c;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {}, "*");
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" }, "*");

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "extpair", 10, 60))) {
    return res(429, { error: "Too many requests. Please wait a moment." }, "*");
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Sign in to WenBot first." }, "*");

  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch { return res(401, { error: "Your session expired — refresh and try again." }, "*"); }

  const streamerDoc = await db.collection("streamers").doc(uid).get();
  if (!streamerDoc.exists) return res(404, { error: "No streamer account found." }, "*");
  const sd = streamerDoc.data();
  const channel = (sd.kickChannel || "").toLowerCase();
  if (!channel) return res(400, { error: "Finish setting up your channel first." }, "*");
  const casino = (sd.activeProvider || "").toLowerCase() || null;

  // Mint a fresh code (retry on the rare collision).
  let code;
  for (let i = 0; i < 5; i++) {
    code = makeCode();
    const ref = db.collection("extension_pairings").doc(code);
    if (!(await ref.get()).exists) {
      await ref.set({ uid, channel, casino, createdAt: Date.now(), expiresAt: Date.now() + CODE_TTL_MS });
      break;
    }
    code = null;
  }
  if (!code) return res(500, { error: "Could not generate a code — try again." }, "*");

  return res(200, { code, channel, casino, expiresInMin: 10 }, "*");
};
