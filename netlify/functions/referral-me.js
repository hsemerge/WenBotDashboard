// GET/POST /api/referral-me
// Returns the authenticated streamer's referral code + link, their invite count,
// and the list of streamers they've referred. Lazily generates a unique referral
// code on first call (server-side, so it can't be forged or collide).
// Requires a Firebase ID token in the Authorization header.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

const SITE_URL = (process.env.SITE_URL || "https://wenbot.gg").replace(/\/+$/, "");
// Readable code alphabet — no 0/O/1/I/L to avoid copy/read mistakes.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function genCode(len = 8) {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

// Generate a code not already taken (a few attempts is plenty at this scale).
async function uniqueCode(db) {
  for (let i = 0; i < 6; i++) {
    const code = genCode();
    const hit = await db.collection("streamers").where("referralCode", "==", code).limit(1).get();
    if (hit.empty) return code;
  }
  // Extremely unlikely fallback: longer code.
  return genCode(12);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "referral_me", 30, 60))) {
    return res(429, { error: "Too many requests. Please wait a moment." });
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch { return res(401, { error: "Invalid token" }); }

  const ref = db.collection("streamers").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Streamer profile not found" });
  const data = snap.data();

  // Ensure a referral code exists (generate once, store server-side).
  let referralCode = data.referralCode;
  if (!referralCode) {
    referralCode = await uniqueCode(db);
    await ref.set({ referralCode }, { merge: true });
  }

  // List who they've referred (capped — this is a display, not analytics).
  let referrals = [];
  try {
    const rs = await ref.collection("referrals").orderBy("joinedAt", "desc").limit(200).get();
    referrals = rs.docs.map((d) => {
      const r = d.data();
      const joinedAt = r.joinedAt && r.joinedAt.toMillis ? r.joinedAt.toMillis() : (r.joinedAt || null);
      return {
        kickChannel: r.kickChannel || null,
        plan:        r.plan || "starter",
        status:      r.status || "onboarded",
        joinedAt,
      };
    });
  } catch {
    // Missing index / empty subcollection — non-fatal, just return an empty list.
    referrals = [];
  }

  return res(200, {
    referralCode,
    referralLink:  `${SITE_URL}/signup?ref=${referralCode}`,
    referralCount: data.referralCount || referrals.length || 0,
    referrals,
  });
};
