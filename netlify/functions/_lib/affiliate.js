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
const { lookupClashAffiliate } = require("./clash");

async function lookupAffiliate(provider, credential, affiliateUsername, diagnostics = null, opts = {}) {
  const target   = (affiliateUsername || "").toLowerCase().trim();
  const knownUid = opts && opts.uid != null ? String(opts.uid) : null;

  // Callers historically passed just the API key string. Duelbits needs two
  // secrets, so a whole provider doc is accepted too — both shapes work, and
  // nothing that already passes a string had to change.
  const cred   = (credential && typeof credential === "object") ? credential : { apiKey: credential };
  const apiKey = cred.apiKey;

  // ── Clash.gg ───────────────────────────────────────────────────────────────
  // Real usernames and stable ids, matched against the whole referral history
  // rather than a race window, so someone under the code who has not played
  // this period still resolves as under-code.
  if (provider === "clash") {
    const token = cred.apiToken || cred.token || apiKey;
    const hit = await lookupClashAffiliate(token, affiliateUsername);
    if (diagnostics) diagnostics.push({ provider, matched: !!(hit && hit.found), error: hit ? null : "clash api unreachable" });
    if (hit && hit.found) {
      return { username: hit.username, uid: hit.userId, wagerAmount: hit.wagered || 0, matchedViaMask: false };
    }
    return null;
  }

  // -- Winovo --------------------------------------------------------------
  // One keyed call returns every referred player with recorded wager, so this
  // answers "under the code" directly rather than off a race window. Real
  // usernames, no masking; Winovo expose no per-player id, so the name is the key.
  if (provider === "winovo") {
    const { lookupWinovoAffiliate } = require("./winovo");
    const hit = await lookupWinovoAffiliate(cred.apiKey || apiKey, affiliateUsername);
    if (diagnostics) diagnostics.push({ provider, matched: !!(hit && hit.found), error: hit ? null : "winovo api unreachable" });
    if (hit && hit.found) {
      return { username: hit.username, uid: null, wagerAmount: hit.wagered || 0, matchedViaMask: false };
    }
    return null;
  }

  // ── Gamba ────────────────────────────────────────────────────────────────
  // No private affiliate API — matched against the public race's competitors,
  // the same best-effort shape as Degen/CSGOBig. The "credential" is the race
  // link (or id), stored under referralCode like Degen; a bare string works too.
  // Names are full or "Hidden" (unmatchable), so no mask. A miss means "no
  // recorded play in this race", not proof they're not under the code.
  if (provider === "gamba") {
    const { lookupGamba } = require("./gamba");
    // Primary casino saves the link under referralCode; the extra-board editor
    // saves it under refCode. Accept both (+ a bare string) so either setup works.
    const raceRef = cred.referralCode || cred.refCode || cred.raceId || cred.leaderboardId || apiKey;
    const hit = await lookupGamba(raceRef, affiliateUsername);
    if (diagnostics) diagnostics.push({ provider, matched: !!(hit && hit.found), error: hit ? null : "gamba unreachable" });
    if (hit && hit.found) {
      return { username: hit.username, uid: null, wagerAmount: hit.wagered || 0, matchedViaMask: false };
    }
    return null;
  }

  // ── Rainbet ────────────────────────────────────────────────────────────────
  // Real usernames + stable ids, so matching is exact (no masking to unpick).
  // We look back ~4 months (the API's max range) so someone who plays under the
  // code but hasn't wagered this week still resolves as under-code.
  if (provider === "rainbet") {
    const diag = { type: "rainbet-4mo", target, knownUid };
    try {
      const { fetchRainbetRange, clampRange } = require("./rainbet");
      const range = clampRange(0, Date.now());   // clamps to the max window ending today
      const board = await fetchRainbetRange(apiKey, range.from, range.to);
      if (!board) {
        diag.error = "fetch failed (bad key or API error)";
        if (diagnostics) diagnostics.push(diag);
        return null;
      }
      diag.totalEntries = board.rankings.length;
      diag.totalWagered = board.totalWagered;
      diag.sample       = board.rankings.slice(0, 5).map(r => r.username);
      const hit = (knownUid && board.rankings.find(r => String(r.uid) === knownUid))
               || board.rankings.find(r => (r.username || "").toLowerCase().trim() === target);
      diag.matched = !!hit;
      if (diagnostics) diagnostics.push(diag);
      if (!hit) return null;
      return {
        uid:             hit.uid,
        username:        hit.username,
        wagerAmount:     hit.wagered || 0,
        leaderboardType: "rainbet",
        matchedViaMask:  false,
      };
    } catch (err) {
      diag.error = err.message;
      if (diagnostics) diagnostics.push(diag);
      return null;
    }
  }

  // ── Hype.bet (Affilka) ──────────────────────────────────────────────────────
  // Real usernames, but the API returns no user id and no masking, so matching is
  // a straight username compare (like Gamba). get-stats lists every referred
  // player with recorded wager in the window, so we look back the widest window
  // the API allows — someone under the code who hasn't played this week still
  // resolves as under-code. A miss means "no recorded play in that window".
  if (provider === "hypebet") {
    const diag = { type: "hypebet", target, knownUid };
    try {
      const { fetchHypebetRange, clampRange } = require("./hypebet");
      const range = clampRange(0, Date.now());   // widest window ending today
      const board = await fetchHypebetRange(apiKey, range.from, range.to);
      if (!board) {
        diag.error = "fetch failed (bad key, cooldown, or API error)";
        if (diagnostics) diagnostics.push(diag);
        return null;
      }
      diag.totalEntries = board.rankings.length;
      diag.totalWagered = board.totalWagered;
      diag.sample       = board.rankings.slice(0, 5).map((r) => r.username);
      const hit = board.rankings.find((r) => (r.username || "").toLowerCase().trim() === target);
      diag.matched = !!hit;
      if (diagnostics) diagnostics.push(diag);
      if (!hit) return null;
      return {
        uid:             null,                       // API exposes no stable id
        username:        hit.username,
        wagerAmount:     hit.wagered || 0,
        leaderboardType: "hypebet",
        matchedViaMask:  false,
      };
    } catch (err) {
      diag.error = err.message;
      if (diagnostics) diagnostics.push(diag);
      return null;
    }
  }

  // ── ETHbet ───────────────────────────────────────────────────────────────────
  // One API key, one fixed board. The API returns standings by username with no
  // user id and no per-user endpoint, so — like Gamba/Hype.bet — verification is a
  // straight username compare against the board's standings. ETHbet returns only
  // the top standings, so a miss means "not among the board's ranked players",
  // which for a small wagerer can happen even when they are under the code.
  if (provider === "ethbet") {
    const diag = { type: "ethbet", target, knownUid };
    try {
      const { fetchEthbetBoard } = require("./ethbet");
      const board = await fetchEthbetBoard(apiKey);
      if (!board) {
        diag.error = "fetch failed (bad key, rate-limited, or API error)";
        if (diagnostics) diagnostics.push(diag);
        return null;
      }
      diag.totalEntries = board.rankings.length;
      diag.totalWagered = board.totalWagered;
      diag.sample       = board.rankings.slice(0, 5).map((r) => r.username);
      const hit = board.rankings.find((r) => (r.username || "").toLowerCase().trim() === target);
      diag.matched = !!hit;
      if (diagnostics) diagnostics.push(diag);
      if (!hit) return null;
      return {
        uid:             null,                       // API exposes no stable id
        username:        hit.username,
        wagerAmount:     hit.wagered || 0,
        leaderboardType: "ethbet",
        matchedViaMask:  false,
      };
    } catch (err) {
      diag.error = err.message;
      if (diagnostics) diagnostics.push(diag);
      return null;
    }
  }

  // ── Duelbits ───────────────────────────────────────────────────────────────
  // Masked names (first2 *** last1, same as Gambulls) but flat rows with stable
  // ids (like Rainbet), so it reuses findMatch for the masking while mapping the
  // flat shape into what findMatch expects.
  //
  // Verification asks "is this person under the affiliate at all", which is a
  // broader question than "are they on the current race", so it unions every
  // board it can see rather than querying one window. Callers must pass
  // opts.period or they only get Duelbits' current cycle, which is the narrower
  // of the two.
  if (provider === "duelbits") {
    const diag = { type: "duelbits", target, knownUid };
    try {
      const { fetchDuelbits, fetchDuelbitsForPeriod } = require("./duelbits");

      // BOTH boards, unioned. The no-window call returns Duelbits' own current
      // cycle, which I first assumed was the broader set — it isn't. It's
      // NARROWER than a 30-day race (41 players against 50), so checking status
      // against it alone missed anyone who is on the race but hasn't played in
      // the current cycle. They'd verify, sit visibly at rank 13 on the board,
      // and still be told they aren't under the code.
      //
      // Being under the affiliate is a durable fact, so any board they appear on
      // proves it. Deduped by uid, race window first so its row wins.
      // Fetched CONCURRENTLY. Each call is ~2.5s against Duelbits, and this now
      // runs inside verify-affiliate, which has a viewer waiting on it and a
      // function timeout to stay under. Sequentially that was 5s of the budget
      // spent on two independent requests.
      const [raceBoard, cycleBoard] = await Promise.all([
        (opts && opts.period && opts.period.active)
          ? fetchDuelbitsForPeriod(cred.affiliateId, cred.password, opts.period)
          : Promise.resolve(null),
        fetchDuelbits(cred.affiliateId, cred.password),
      ]);
      if (!raceBoard && !cycleBoard) {
        diag.error = "fetch failed (bad credentials or API error)";
        if (diagnostics) diagnostics.push(diag);
        return null;
      }
      const byUid = new Map();
      for (const r of (raceBoard ? raceBoard.rankings : [])) byUid.set(String(r.uid), r);
      for (const r of (cycleBoard ? cycleBoard.rankings : [])) {
        if (!byUid.has(String(r.uid))) byUid.set(String(r.uid), r);
      }
      const board = { rankings: [...byUid.values()] };
      diag.totalEntries = board.rankings.length;
      diag.raceEntries  = raceBoard ? raceBoard.rankings.length : 0;
      diag.cycleEntries = cycleBoard ? cycleBoard.rankings.length : 0;
      diag.sample       = board.rankings.slice(0, 5).map(r => r.username);

      // findMatch reads e.user.name / e.user.id, so adapt rather than duplicate
      // the masking rules — they're identical and worth having in one place.
      const adapted = board.rankings.map(r => ({
        user: { id: r.uid, name: r.username },
        wagerAmount: r.wagered || 0,
      }));
      // A viewer who pastes their Duelbits User ID instead of their username
      // should just work. Duelbits shows that id on the profile page with a copy
      // button, and it's the same identifier the board returns (verified), so
      // treat a UUID-shaped entry as a uid rather than comparing it against
      // masked names — where it could never match.
      const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
      const uidToUse  = knownUid || (looksLikeUuid ? target : null);
      const nameToUse = looksLikeUuid ? "" : target;
      if (looksLikeUuid) diag.enteredUuid = true;

      const { match, via, ambiguous } = findMatch(adapted, nameToUse, uidToUse);
      if (ambiguous) {
        diag.matched = false;
        diag.ambiguous = ambiguous;
        if (diagnostics) diagnostics.push(diag);
        return null;
      }
      diag.matched = !!match;
      if (via) diag.via = via;
      if (diagnostics) diagnostics.push(diag);
      if (!match) return null;

      // Status and wager answer different questions, so they use different
      // windows. Being "under the code" is durable — a viewer who played last
      // month is still referred — so that's decided against the broad board
      // above. But the WAGER a streamer sees has to be the one on the race, or
      // the verified list disagrees with /lb, the portal and whatever gets paid
      // out. Zero when they're under the code but haven't played this race,
      // which is the honest answer rather than a stale figure.
      let wagerAmount = match.wagerAmount || 0;
      const matchUid = uidOf(match);
      if (raceBoard) {
        const inRace = raceBoard.rankings.find(r => String(r.uid) === String(matchUid));
        wagerAmount = inRace ? (inRace.wagered || 0) : 0;
        diag.raceWindow = { from: raceBoard.from, to: raceBoard.to, onRace: !!inRace };
      }
      return {
        uid:             matchUid,
        username:        match.user?.name || null,
        wagerAmount,
        leaderboardType: "duelbits",
        matchedViaMask:  via === "mask",
      };
    } catch (err) {
      diag.error = err.message;
      if (diagnostics) diagnostics.push(diag);
      return null;
    }
  }

  if (provider !== "gambulls") return null;

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

module.exports = { lookupAffiliate, nameMatches, findMatch, fetchGambulls, uidOf };
