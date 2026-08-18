// Clash.gg affiliate leaderboard provider.
//
//   GET https://api.clash.gg/affiliates/leaderboards/my-leaderboards-api
//       Authorization: Bearer <streamer affiliate token>
//       Cookie: let-me-in=<gate cookie>
//
//   → { data: [ { id, name, startDate, durationDays, type, status, currency,
//                 rewards: [ { type, amount } ], winnerIds, topPlayers: [...] } ] }
//
// This returns the races the streamer actually configured ON Clash, so the
// period, the prize ladder and the standings all come from one call and none of
// them can drift from what Clash is really paying out. That is the reason it is
// used instead of the affiliate summary endpoint (detailed-summary/v2), which
// only answers "totals per user since a date" and would have meant re-entering
// the period and prizes by hand in WenBot and hoping they matched.
//
// Facts confirmed against the live API:
//   • `topPlayers[].wagered` is the ADJUSTED wager the race is scored on, and it
//     is NOT the same number as `xp` (xp is the raw figure the summary endpoint
//     calls "wagered"). Ranking on anything but `wagered` would order the board
//     differently from Clash's own.
//   • EVERY money figure on both endpoints is in GEM CENTS - hundredths of a
//     gem - so all of them are divided by 100 on the way out. Verified field by
//     field against what Clash's own UI displays for the same race:
//       topPlayers[].wagered  13008.006448666298  ->    130.08   ("Points")
//       rewards[].amount                   50000  ->    500.00   ("Prize")
//       summary wagered (BroBert)         562483  ->  5,624.83   ("Total Played")
//     An earlier version of this file divided the ladder but NOT `wagered`, on
//     the assumption that a figure already carrying decimals must be in gems.
//     It is not: Clash carry sub-cent precision. That shipped a board reading
//     100x high, which a streamer reasonably read as her race doing half a
//     million in volume. Do not re-derive these scales from how the numbers
//     look; check them against Clash's own display of the same race.
//   • `startDate` + `durationDays` define the window; there is no end date field.
//   • `status` is LIVE for a running race.
//   • Clash generate this response on demand and ask that it be cached, so every
//     caller here must go through a cache. Nothing calls this per page view.

const CLASH_URL   = "https://api.clash.gg/affiliates/leaderboards/my-leaderboards-api";
const GATE_COOKIE = process.env.CLASH_GATE_COOKIE || "";
const DAY_MS      = 24 * 60 * 60 * 1000;
// Clash report money in gem cents on both endpoints, so this divides every money
// figure leaving this file. Nothing downstream rescales, which means one number
// here is the whole conversion.
const GEM_CENTS = 100;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Clash serve avatars as paths on their own site, so resolve them or they 404
// against our domain.
function absUrl(u) {
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : "https://clash.gg" + (u.startsWith("/") ? u : "/" + u);
}

function shape(lb) {
  const startAt = lb.startDate ? Date.parse(lb.startDate) : null;
  const endAt   = startAt && lb.durationDays ? startAt + Number(lb.durationDays) * DAY_MS : null;

  const rankings = (lb.topPlayers || [])
    .map((p) => ({
      username:  p.name || "Anonymous",
      userId:    p.userId != null ? String(p.userId) : null,
      // Adjusted wager - what the race is scored on - converted from gem cents
      // to gems so it reads as the same figure Clash show on their own board.
      wagered:   num(p.wagered) / GEM_CENTS,
      avatarUrl: absUrl(p.avatar),
    }))
    .filter((p) => p.wagered > 0)
    .sort((a, b) => b.wagered - a.wagered)
    .map((p, i) => ({ rank: i + 1, ...p }));

  return {
    id:       lb.id != null ? String(lb.id) : null,
    name:     lb.name ? String(lb.name).trim() : "",
    status:   lb.status || null,
    currency: lb.currency || null,
    startAt,
    endAt,
    // Rank-ordered prize ladder, same gem-cent scale as the standings.
    prizes:   (lb.rewards || []).map((r) => num(r.amount) / GEM_CENTS),
    rankings,
    totalUsers:   rankings.length,
    totalWagered: rankings.reduce((sum, p) => sum + p.wagered, 0),
  };
}

/**
 * Every race this token can see, newest first.
 * Returns null on any failure so callers serve their cached copy rather than
 * blanking a live board.
 */
async function fetchClashLeaderboards(token) {
  if (!token) return null;
  let body;
  try {
    const r = await fetch(CLASH_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(GATE_COOKIE ? { Cookie: GATE_COOKIE } : {}),
      },
    });
    if (!r.ok) return null;
    body = await r.json();
  } catch {
    return null;
  }
  if (!body || !Array.isArray(body.data)) return null;
  return body.data.map(shape).sort((a, b) => (b.startAt || 0) - (a.startAt || 0));
}

/**
 * The one race to show.
 *
 * `preferId` pins a specific race, for a streamer running more than one at once.
 * Otherwise: the LIVE one, else the most recent that has already started, else
 * the newest known. Picking blindly would show a finished race the day a new one
 * opens, which reads as the board being stuck.
 */
async function fetchClashBoard(token, preferId) {
  const all = await fetchClashLeaderboards(token);
  if (!all || !all.length) return all === null ? null : null;

  if (preferId) {
    const pinned = all.find((lb) => lb.id === String(preferId));
    if (pinned) return pinned;
  }
  const now = Date.now();
  return all.find((lb) => lb.status === "LIVE")
      || all.find((lb) => lb.startAt && lb.startAt <= now)
      || all[0];
}

// ── Affiliate verification ───────────────────────────────────────────────────
//
//   GET https://api.clash.gg/affiliates/detailed-summary/v2/{since}
//
// A different endpoint from the leaderboard one above, and the right one for
// "is this viewer under the code": it returns EVERY referred user with activity
// since the given date, not just a race's top players. Asked from the epoch, it
// is the whole referral list.
//
// Caveat, same as Rainbet: someone who signed up under the code but has never
// wagered does not appear, because the endpoint reports activity. A miss is
// therefore "no recorded play under this code", not proof of nothing.
const SUMMARY_URL = "https://api.clash.gg/affiliates/detailed-summary/v2";

async function fetchClashReferrals(token, sinceMs) {
  if (!token) return null;
  const since = new Date(Number(sinceMs) || 0).toISOString();
  try {
    const r = await fetch(`${SUMMARY_URL}/${encodeURIComponent(since)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(GATE_COOKIE ? { Cookie: GATE_COOKIE } : {}),
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;
    return rows.map((e) => ({
      username: e.name || "",
      userId:   e.userId != null ? String(e.userId) : null,
      // NOTE: this endpoint's `wagered` is the RAW figure, which the leaderboard
      // endpoint calls `xp`. It is fine for "did they play", but it is NOT the
      // adjusted number a race is scored on, so never rank a board with it.
      // Gem cents here too: this is the figure Clash label "Total Played" on the
      // referrals tab, and they divide it by 100 to display it. It reaches the
      // giveaway minimum-wager gate via verify-affiliate, so the scale has to be
      // the one a streamer sees on Clash when they choose a threshold.
      wagered:  num(e.wagered) / GEM_CENTS,
    }));
  } catch {
    return null;
  }
}

/**
 * Is this viewer playing under the streamer's Clash code?
 * Matched on display name, case-insensitively, from the whole referral history.
 * Returns null when the API could not be reached, so callers can tell that
 * apart from a genuine miss.
 */
async function lookupClashAffiliate(token, username) {
  const name = String(username || "").trim().toLowerCase();
  if (!name) return { found: false };

  const rows = await fetchClashReferrals(token, 0);
  if (!rows) return null;

  const hit = rows.find((r) => String(r.username).trim().toLowerCase() === name);
  return hit
    ? { found: true, username: hit.username, userId: hit.userId, wagered: hit.wagered }
    : { found: false };
}

module.exports = { fetchClashLeaderboards, fetchClashBoard, fetchClashReferrals, lookupClashAffiliate };
