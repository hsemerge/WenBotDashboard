// Scoped share links — hand a mod one tool without handing them the account.
//
// Team delegation already exists, but it is Elite, capped at two people, needs
// them to have a WenBot login, and gives them the whole dashboard. The common
// case is smaller than that: "you run the slot queue tonight". This is a link
// that opens one tool, does nothing else, expires on its own, and can be killed
// instantly.
//
// The token is a bearer credential, so:
//   * only its SHA-256 is stored — a database leak yields no working links
//   * the document id IS the hash, so validating is one keyed read, no scan
//   * every action is whitelisted per scope on the server; the page it opens is
//     a convenience, never the boundary
//   * links expire, default 12 hours, hard maximum 7 days

const crypto = require("crypto");

const TOKEN_BYTES  = 24;
const DEFAULT_TTL_H = 12;
const MAX_TTL_H     = 24 * 7;
const MAX_ACTIVE    = 20;     // per streamer, so a forgotten loop cannot pile up

// What each scope may see and do. Adding a capability means adding it HERE —
// the endpoint refuses anything not on the list, so a scope can never quietly
// grow because a new action was added elsewhere.
const SHARE_SCOPES = {
  slotrequest: {
    label:   "Slot request queue",
    blurb:   "See pending slot requests, mark them played, and dismiss them.",
    actions: ["dismiss", "mark_played"],
  },
  giveaway: {
    label:   "Giveaway draws",
    blurb:   "See who has entered and draw a winner. Cannot start, end, or change the giveaway.",
    actions: ["draw"],
  },
};

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function isValidScope(scope) {
  return Object.prototype.hasOwnProperty.call(SHARE_SCOPES, scope);
}

function scopeAllows(scope, action) {
  return isValidScope(scope) && SHARE_SCOPES[scope].actions.includes(action);
}

function ttlHours(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_H;
  return Math.min(MAX_TTL_H, n);
}

/**
 * Resolve a token to its link, or explain why not.
 * Never says which of "wrong", "revoked" or "expired" applies to a caller —
 * that is a probing oracle. The distinction is kept for our own logs only.
 */
async function resolveToken(db, token) {
  if (typeof token !== "string" || token.length < 16 || token.length > 200) {
    return { ok: false, reason: "malformed" };
  }
  const doc = await db.collection("share_links").doc(hashToken(token)).get();
  if (!doc.exists) return { ok: false, reason: "unknown" };
  const link = doc.data();
  if (link.revoked)               return { ok: false, reason: "revoked" };
  if (!link.expiresAt || link.expiresAt < Date.now()) return { ok: false, reason: "expired" };
  if (!isValidScope(link.scope))  return { ok: false, reason: "bad_scope" };
  return { ok: true, link, ref: doc.ref };
}

module.exports = {
  SHARE_SCOPES, MAX_ACTIVE, DEFAULT_TTL_H, MAX_TTL_H,
  newToken, hashToken, isValidScope, scopeAllows, ttlHours, resolveToken,
};
