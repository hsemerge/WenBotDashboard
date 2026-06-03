// Shared HTTP helpers for Netlify functions.
// res(status, body, origin?) builds a Lambda-style JSON response with CORS.
// Default origin is "https://wenbot.gg" — pass "*" or another value for the exceptions.

const crypto = require("crypto");

// Constant-time string comparison for secrets/keys — avoids leaking match info
// via response timing. Returns false on missing values or length mismatch
// (timingSafeEqual throws if the buffers differ in length).
function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function res(statusCode, body, origin = "https://wenbot.gg") {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
    },
    body: JSON.stringify(body),
  };
}

// Firestore-backed IP rate limiter. Fails CLOSED on Firestore errors to prevent
// abuse during a Firestore outage.
async function checkRateLimit(db, ip, bucket, maxReqs = 20, windowSecs = 60) {
  const key = `${bucket}_${(ip || 'unknown').replace(/[^a-z0-9]/gi, '_').slice(0, 64)}`;
  const ref = db.collection('_rate_limits').doc(key);
  const now = Date.now();
  try {
    return await db.runTransaction(async txn => {
      const doc = await txn.get(ref);
      const d = doc.exists ? doc.data() : {};
      const reset = d.resetAt || 0;
      const count = reset > now ? (d.count || 0) : 0;
      if (count >= maxReqs) return false;
      txn.set(ref, { count: count + 1, resetAt: reset > now ? reset : now + windowSecs * 1000 });
      return true;
    });
  } catch (err) {
    console.error(`[RateLimit:${bucket}] Firestore error — failing closed:`, err.message);
    return false;
  }
}

module.exports = { res, checkRateLimit, timingSafeEq };
