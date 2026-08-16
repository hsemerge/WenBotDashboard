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
//   • `rewards` is in rank order, in Clash balance units, not dollars.
//   • `startDate` + `durationDays` define the window; there is no end date field.
//   • `status` is LIVE for a running race.
//   • Clash generate this response on demand and ask that it be cached, so every
//     caller here must go through a cache. Nothing calls this per page view.

const CLASH_URL   = "https://api.clash.gg/affiliates/leaderboards/my-leaderboards-api";
const GATE_COOKIE = process.env.CLASH_GATE_COOKIE || "";
const DAY_MS      = 24 * 60 * 60 * 1000;

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
      wagered:   num(p.wagered),          // adjusted wager: what the race is scored on
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
    // Rank-ordered prize ladder, straight from Clash.
    prizes:   (lb.rewards || []).map((r) => num(r.amount)),
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

/**
 * Is this viewer playing under the streamer's code?
 *
 * Only the current race's top players are visible through this endpoint, so a
 * miss means "not in the standings", NOT "not under the code". Callers must not
 * treat a false here as proof the viewer is unaffiliated.
 */
async function lookupClashAffiliate(token, username) {
  const name = String(username || "").trim().toLowerCase();
  if (!name) return { found: false, partial: true };

  const lb = await fetchClashBoard(token, null);
  if (!lb) return null;                       // API failure, distinct from "not found"

  const hit = lb.rankings.find((r) => String(r.username).trim().toLowerCase() === name);
  return hit
    ? { found: true, username: hit.username, userId: hit.userId, wagered: hit.wagered }
    : { found: false, partial: true };
}

module.exports = { fetchClashLeaderboards, fetchClashBoard, lookupClashAffiliate };
