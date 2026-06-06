// Shared casino affiliate lookup. Used by:
//   - verify-affiliate.js  (initial verification)
//   - recheck-verified.js  (manual re-check from dashboard)
//   - link-verified.js      (manual "link to leaderboard entry")
//
// Returns { uid, username, wagerAmount, leaderboardType, matchedViaMask } or null.
//
// IDENTITY MODEL — match by UID, not name. Gambulls returns a stable per-user
// `id` for EVERY entry (even anonymized ones), but masks anonymous users' NAMES
// (first-2 + "***" + last-1, e.g. "Beastedx" -> "Be***x"). So:
//   • If we already know the user's provider UID (stored from a prior match or a
//     manual link), we match on UID — 100% reliable, immune to masking.
//   • Otherwise we bootstrap by name: exact match first, then a best-effort
//     masked match. If TWO masked entries could fit, we refuse to guess and
//     report it as ambiguous (the streamer resolves it via the manual picker).
// Once any match captures the UID, every future check is UID-based.

// Gambulls hard-caps the leaderboard limit at 100. Valid types: daily/weekly/
// monthly only. `monthly` is the widest public window.
const LIMIT_PER_LB = 100;

const LB_TYPES_BY_PROVIDER = {
  gambulls: ["monthly"],
};

// True if a claimed name matches a (possibly masked) leaderboard name.
// Exact match, or — for Gambulls' "first2 *** last1" mask — same visible prefix
// and suffix with real masked content in between. Best-effort for a SPECIFIC
// claimed name; ambiguity is handled separately by the caller.
function nameMatches(leaderboardName, target) {
  const ln = String(leaderboardName || "").toLowerCase().trim();
  const t  = String(target || "").toLowerCase().trim();
  if (!ln || !t) return false;
  if (ln === t) return true;
  const first = ln.indexOf("*");
  if (first === -1) return false;          // unmasked → exact-only (already failed)
  const prefix = ln.slice(0, first);
  const suffix = ln.slice(ln.lastIndexOf("*") + 1);
  if (prefix.length < 2) return false;     // too little signal → skip to avoid collisions
  return t.startsWith(prefix)
      && (suffix === "" || t.endsWith(suffix))
      && t.length > (prefix.length + suffix.length); // must have masked middle content
}

function uidOf(e) {
  return e && e.user && e.user.id != null ? String(e.user.id) : null;
}

// Fetch one leaderboard type's raw rankings (or null on any failure).
async function fetchGambulls(apiKey, type) {
  const resp = await fetch(
    `https://api.gambulls.com/api/public/streamer/leaderboard?type=${encodeURIComponent(type)}&limit=${LIMIT_PER_LB}`,
    { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } }
  );
  if (!resp.ok) return { error: `non-200 status`, httpStatus: resp.status };
  const data = await resp.json();
  if (!data.success || !data.responseObject?.rankings) {
    return { error: `unexpected response shape`, responseKeys: Object.keys(data || {}) };
  }
  return {
    rankings:     data.responseObject.rankings,
    totalUsers:   data.responseObject.totalUsers || null,
    totalWagered: data.responseObject.totalWagered || null,
  };
}

// Pick the matching ranking entry. Returns { match, via } or { ambiguous:[...] }.
function findMatch(rankings, target, knownUid) {
  // 1) UID FAST-PATH — authoritative ONLY while it still matches the live board.
  //    Gambulls' user.id has proven NOT to be permanently stable for anonymous
  //    users (it can rotate, and a bulk ID regeneration invalidates every cached
  //    ID), so a miss must NOT be terminal. On a miss we fall through to name
  //    matching, and the caller self-heals the stored UID to the one that matched.
  if (knownUid != null && String(knownUid) !== "") {
    const m = rankings.find(e => uidOf(e) === String(knownUid));
    if (m) return { match: m, via: "uid" };
    // stale/changed/regenerated UID → keep going and try to re-resolve by name.
  }
  // 2) Exact (case-insensitive) name. (Skip when no name to match by — e.g. the
  //    manual link path passes a UID only; a dead UID there just means "not found".)
  const t = String(target || "").toLowerCase().trim();
  if (!t) return { match: null };
  const exact = rankings.find(e => String(e.user?.name || "").toLowerCase().trim() === t);
  if (exact) return { match: exact, via: "name" };
  // 3) Masked candidates — only auto-accept when exactly one fits.
  const masked = rankings.filter(e => nameMatches(e.user?.name, t));
  if (masked.length === 1) return { match: masked[0], via: "mask" };
  if (masked.length > 1) {
    return {
      match: null,
      ambiguous: masked.map(e => ({ uid: uidOf(e), name: e.user?.name || null, wagered: e.wagerAmount || 0 })),
    };
  }
  return { match: null };
}

// opts: { uid } — when provided, match by provider UID (durable, masking-proof).
async function lookupAffiliate(provider, apiKey, affiliateUsername, diagnostics = null, opts = {}) {
  if (provider !== "gambulls") return null;
  const target   = (affiliateUsername || "").toLowerCase().trim();
  const knownUid = opts && opts.uid != null ? String(opts.uid) : null;

  for (const type of LB_TYPES_BY_PROVIDER.gambulls) {
    const diag = { type, target, knownUid, limit: LIMIT_PER_LB };
    try {
      const board = await fetchGambulls(apiKey, type);
      if (board.error) {
        Object.assign(diag, board);
        if (diagnostics) diagnostics.push(diag);
        continue;
      }
      diag.totalEntries = board.rankings.length;
      diag.totalUsers   = board.totalUsers;
      diag.totalWagered = board.totalWagered;
      diag.sample       = board.rankings.slice(0, 5).map(e => e.user?.name).filter(Boolean);

      const { match, via, ambiguous } = findMatch(board.rankings, target, knownUid);
      if (ambiguous) {
        diag.matched   = false;
        diag.ambiguous = ambiguous;   // surfaced so the dashboard can prompt a manual link
        if (diagnostics) diagnostics.push(diag);
        continue;
      }
      if (match) {
        diag.matched = true;
        diag.via     = via;
        if (diagnostics) diagnostics.push(diag);
        return {
          uid:             uidOf(match),
          username:        match.user?.name || null,
          wagerAmount:     match.wagerAmount || 0,
          leaderboardType: type,
          matchedViaMask:  via === "mask",
        };
      }
      diag.matched = false;
      if (diagnostics) diagnostics.push(diag);
    } catch (err) {
      diag.error = err.message;
      if (diagnostics) diagnostics.push(diag);
    }
  }
  return null;
}

module.exports = { lookupAffiliate, nameMatches };
