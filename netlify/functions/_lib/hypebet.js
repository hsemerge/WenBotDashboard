// Hype.bet (Affilka) affiliate leaderboard provider.
//
//   POST https://api.hype.bet/wallet/api/v1/affiliate/creator/get-stats
//   body: { apiKey: "<apiKeyBase>-<affiliateId>", from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
//
// Response: {
//   summary: { totalUsers },
//   summarizedBets: [ { user: { username, avatar }, wagered, bets, xpPoints } ],
//   dateRange: { from, to }, processingTime
// }
//
// Shape notes learned from the spec (v1.1.2):
//   • Affilka keys are "<apiKeyBase>-<affiliateId>" — the whole string is the key.
//   • `wagered` and `xpPoints` are in CENTS → divide by 100 for dollars, matching
//     how Rainbet/Gambulls store dollar figures elsewhere in the app.
//   • Real usernames + avatars, but NO stable user id is returned. Matching is
//     therefore username-only (like Gamba), with no masking to unpick.
//   • Cooldown: 5 minutes between requests PER API KEY (429-equivalent comes back
//     as HTTP 401 { code: "RATE_LIMIT_EXCEEDED" }). Callers MUST cache >= 5 min
//     and fall back to the last good board on a cooldown hit.
//   • Date errors: 400 { code: INVALID_DATE_FORMAT | INVALID_DATE_RANGE |
//     DATE_RANGE_TOO_BIG }. The exact max range isn't documented; MAX_RANGE_DAYS
//     is a conservative guess — widen it only once a live key proves a bigger
//     window is accepted (watch for DATE_RANGE_TOO_BIG).
//
// TRANSPORT: Hype.bet sits behind Cloudflare and (per the honour-system note this
// replaces in _lib/casinos.js) 403s datacenter IPs. `hypebetPost` is the ONLY
// place that talks to the origin, so if a Netlify Lambda fetch is blocked in
// production the whole provider can be pointed at an edge-function proxy by
// changing this one function — nothing above it needs to know.

const HYPEBET_URL    = "https://api.hype.bet/wallet/api/v1/affiliate/creator/get-stats";
const MAX_RANGE_DAYS = 92;                 // conservative until a live key proves more
const DAY_MS         = 24 * 60 * 60 * 1000;

// UTC YYYY-MM-DD (the API takes whole days).
function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Clamp a requested window to the max range, keeping the END fixed (a live board
// cares about the most recent data). `startMs` of 0/null means "as far back as
// allowed". Do NOT write `startMs || end` — 0 is falsy and would collapse the
// window to today only (the bug Rainbet hit).
function clampRange(startMs, endMs) {
  const end     = Math.min(endMs || Date.now(), Date.now());
  const maxBack = end - MAX_RANGE_DAYS * DAY_MS;
  let   start   = (startMs === null || startMs === undefined) ? maxBack : Number(startMs);
  if (!Number.isFinite(start)) start = maxBack;
  if (start > end)             start = end;
  if (end - start > MAX_RANGE_DAYS * DAY_MS) start = maxBack;
  return { from: ymd(start), to: ymd(end) };
}

// Current calendar month to date — the default live-board window.
function monthToDateRange() {
  const now = new Date();
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return clampRange(first, Date.now());
}

// The ONE place that talks to the Hype.bet origin. Returns the parsed body on a
// 200, or { __error, code, httpStatus } on anything else so callers can tell a
// cooldown (serve cache) apart from a hard failure. Swap the fetch here for an
// edge-proxy call if datacenter IPs are blocked in production.
async function hypebetPost(apiKey, from, to) {
  let resp, text;
  try {
    resp = await fetch(HYPEBET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ apiKey, from, to }),
    });
    text = await resp.text();
  } catch (err) {
    return { __error: true, code: "FETCH_FAILED", message: err.message, httpStatus: 0 };
  }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON (e.g. a CF 403 HTML page) */ }
  if (!resp.ok) {
    return {
      __error: true,
      code: (body && body.code) || `HTTP_${resp.status}`,
      message: (body && body.message) || (text || "").slice(0, 160),
      httpStatus: resp.status,
    };
  }
  return body || {};
}

// Fetch + normalize one date range. Returns null on ANY failure (bad key,
// cooldown, blocked IP, malformed body) so callers degrade to cache / empty
// board instead of 500-ing. `from`/`to` are YYYY-MM-DD.
async function fetchHypebetRange(apiKey, from, to) {
  const key = (apiKey || "").trim();
  if (!key || !from || !to) return null;

  const data = await hypebetPost(key, from, to);
  if (!data || data.__error) {
    if (data && data.__error) {
      console.warn(`[hypebet] ${data.httpStatus} ${data.code}: ${String(data.message || "").slice(0, 120)}`);
    }
    return null;
  }
  if (!Array.isArray(data.summarizedBets)) return null;

  const rankings = data.summarizedBets
    .map((e) => ({
      uid:       null,                                        // API returns no stable id
      username:  (e.user && e.user.username) || "Anonymous",
      // cents -> dollars, matching how every other provider stores wager here.
      wagered:   (Number(e.wagered) || 0) / 100,
      bets:      Number(e.bets) || 0,
      avatarUrl: (e.user && e.user.avatar) || null,
    }))
    .filter((r) => r.wagered > 0)
    .sort((a, b) => b.wagered - a.wagered)                    // don't trust upstream order
    .map((r, i) => ({ rank: i + 1, ...r }));

  return {
    rankings,
    totalUsers:     (data.summary && data.summary.totalUsers) != null
                      ? data.summary.totalUsers : rankings.length,
    totalWagered:   rankings.reduce((s, r) => s + r.wagered, 0),
    cacheUpdatedAt: null,
    from,
    to,
  };
}

// Fetch the window a WenBot leaderboard period describes. No active period (or no
// start) falls back to month-to-date. A finished period freezes at its end date.
async function fetchHypebetForPeriod(apiKey, period) {
  const startMs = period && period.active && period.startAt ? period.startAt : null;
  const endMs   = period && period.active && period.endAt && period.endAt < Date.now()
    ? period.endAt
    : Date.now();
  const range = startMs ? clampRange(startMs, endMs) : monthToDateRange();
  return fetchHypebetRange(apiKey, range.from, range.to);
}

// Wager each player had already done on the period's START DAY when it began.
// The API takes whole dates, so a period starting mid-day drags in that whole
// day; subtracting this baseline removes the overhang. Captured once at period
// start (dashboard Start button / scheduler roll). Mirrors Rainbet — but there is
// no per-user id, so the baseline is keyed by lowercased username.
async function fetchHypebetDayBaseline(apiKey, startMs) {
  if (startMs % DAY_MS === 0) return {};                      // midnight-aligned → nothing before it
  const day  = ymd(startMs);
  const data = await fetchHypebetRange(apiKey, day, day);
  const out  = {};
  for (const r of ((data && data.rankings) || [])) {
    const k = (r.username || "").toLowerCase();
    if (k) out[`name:${k}`] = r.wagered || 0;
  }
  return out;
}

// Apply the WenBot-period parts the API can't express: the start-day baseline
// above and manual exclusions (removed users), then re-rank. Keyed by username
// (no uid). `dayBaselines` is its own field, not the shared `baselines` (that one
// is captured against whatever window was live at roll time and is meaningless
// against a fresh range — same reasoning as Rainbet).
function applyHypebetExclusions(data, period) {
  const excluded = new Set((period?.excluded || []).map((s) => String(s).toLowerCase()));
  const dayBase  = (period && period.active && period.dayBaselines) || null;
  if (!data || (excluded.size === 0 && !dayBase)) return data;
  const rankings = data.rankings
    .filter((r) => !excluded.has((r.username || "").toLowerCase()))
    .map((r) => dayBase
      ? { ...r, wagered: Math.max(0, (r.wagered || 0) - (dayBase[`name:${(r.username || "").toLowerCase()}`] || 0)) }
      : r)
    .sort((a, b) => b.wagered - a.wagered)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return {
    ...data,
    rankings,
    totalUsers:   rankings.length,
    totalWagered: rankings.reduce((s, r) => s + r.wagered, 0),
  };
}

module.exports = {
  fetchHypebetRange,
  fetchHypebetForPeriod,
  fetchHypebetDayBaseline,
  applyHypebetExclusions,
  monthToDateRange,
  clampRange,
  ymd,
  hypebetPost,
};
