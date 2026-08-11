// Duelbits affiliate leaderboard.
//
//   GET https://ws.duelbits.com/affiliate-leaderboards/<affiliateId>
//   Authorization: Basic base64(<affiliateId>:<password>)
//
// The header is derived here from the two stored fields rather than saved
// pre-encoded: base64 is not encryption, storing it as one opaque blob just
// makes the credential harder to rotate or eyeball, and the affiliate id is
// needed separately for the URL anyway.
//
// WEIGHTED BOARD — the thing that makes Duelbits different from every other
// casino we read. The response carries BOTH `betAmount` (raw volume) and
// `points` (volume x inverse RTP, so a slots spin is worth more than a
// low-edge blackjack hand), and Duelbits ranks by POINTS. Verified against live
// data: sorting the response by points reproduces its own order exactly, while
// sorting by betAmount does not — the #1 player had LOWER volume than #2.
//
// So `wagered` here carries points, not volume, because every consumer of this
// shape (portal board, prize splits, /lb) treats `wagered` as the thing the
// board ranks on. Raw volume rides along as `betAmount` for display. Ranking by
// volume instead would produce a board that disagrees with the streamer's own
// Duelbits page, which is the one comparison a viewer will actually make.
//
// Names arrive masked as first-2 + "***" + last-1, the same shape Gambulls
// uses, so _lib/affiliate.js's mask matcher applies unchanged. Every row also
// carries a stable `id`, which is what makes UID-based verification possible.

const ENDPOINT = "https://ws.duelbits.com/affiliate-leaderboards";

function authHeader(affiliateId, password) {
  return "Basic " + Buffer.from(`${affiliateId}:${password}`).toString("base64");
}

/**
 * Fetch and normalise one affiliate's standings.
 *
 * @param {string} affiliateId  uuid from the Duelbits partner
 * @param {string} password     the API password issued with it
 * @param {string} [from]       YYYY-MM-DD, inclusive. Omit for the current cycle.
 * @param {string} [to]         YYYY-MM-DD
 * @returns {Promise<{rankings, totalWagered, totalUsers, totalVolume, cacheUpdatedAt}|null>}
 *          null on any failure, so callers can fall back to cache rather than
 *          blanking a live board.
 */
async function fetchDuelbits(affiliateId, password, from, to) {
  if (!affiliateId || !password) return null;
  try {
    // startDate/endDate are the ONLY date parameters this endpoint honours —
    // from/to, days and period are all accepted silently and ignored, which is
    // what made it look like no windowing existed at all. Without them the API
    // returns the current cycle, which is a different (shorter) board than the
    // race a streamer is actually running.
    // LIMIT MATTERS MORE THAN IT LOOKS. The endpoint silently returns only 50
    // rows by default — no total, no pagination hint, nothing to suggest the
    // list is truncated. A player at rank 59 was simply absent: invisible on the
    // board AND unverifiable, because the lookup could not see her either. The
    // streamer's own site showed 75, which is how the gap surfaced at all.
    // 1000 is the API's hard maximum — it answers 400 "limit must not be greater
    // than 1000" above that, so asking for more breaks the request entirely
    // rather than degrading. Taking the ceiling because the failure mode of
    // asking for too FEW is silent and invisible (a truncated board that looks
    // complete), while asking for too many is a loud, immediate error. This
    // affiliate has 76 players, so there is enormous headroom either way.
    const params = ["limit=1000"];
    if (from && to) {
      params.push(`startDate=${encodeURIComponent(from)}`, `endDate=${encodeURIComponent(to)}`);
    }
    const qs = `?${params.join("&")}`;
    const r = await fetch(`${ENDPOINT}/${encodeURIComponent(affiliateId)}${qs}`, {
      headers: { Authorization: authHeader(affiliateId, password) },
    });
    if (!r.ok) {
      console.warn("[duelbits] HTTP", r.status, (await r.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const data = await r.json();
    const standings = Array.isArray(data?.standings) ? data.standings : [];

    const rankings = standings
      // `private` is Duelbits' own opt-out. It's false across the board today,
      // but a player who hides themselves shouldn't be republished on a portal.
      .filter((e) => !e.private)
      .map((e) => ({
        uid:       e.id != null ? String(e.id) : null,
        username:  e.displayName || "Anonymous",
        // MINOR UNITS. Duelbits sends integers in cents, not dollars. Confirmed
        // against the streamer's own raw view: a player showing $519.90 there
        // comes back as 51990 here — exactly x100 — and a second player matched
        // to within 0.1%. Passing these straight through inflated every figure
        // on the portal a hundredfold.
        wagered:   (Number(e.points) || 0) / 100,      // what the board ranks on
        betAmount: (Number(e.betAmount) || 0) / 100,   // raw volume, for display
      }))
      .sort((a, b) => b.wagered - a.wagered)
      // Stamped here, like the Rainbet lib does, because Duelbits sends no rank
      // of its own and every consumer expects one — without it the dashboard
      // renders "undefined" beside each name.
      .map((r, i) => ({ rank: i + 1, ...r }));

    return {
      from: from || null,
      to:   to || null,
      rankings,
      totalUsers:    rankings.length,
      totalWagered:  rankings.reduce((s, e) => s + e.wagered, 0),
      totalVolume:   rankings.reduce((s, e) => s + e.betAmount, 0),
      cacheUpdatedAt: data?.lastUpdated || null,
    };
  } catch (e) {
    console.warn("[duelbits] fetch failed:", e.message);
    return null;
  }
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Fetch the standings for a WenBot leaderboard period.
 *
 * Mirrors fetchRainbetForPeriod: an active period supplies the window, a
 * finished one freezes at its end date, and with no period configured we fall
 * back to whatever cycle Duelbits serves by default rather than inventing a
 * range the streamer never set.
 */
async function fetchDuelbitsForPeriod(affiliateId, password, period) {
  const startMs = period && period.active && period.startAt ? period.startAt : null;
  if (!startMs) return fetchDuelbits(affiliateId, password);

  // endDate behaves EXCLUSIVELY. Clamping it to "today" therefore dropped
  // everything wagered today: a player whose only activity was today appeared
  // on the race board when queried to the race's real end date and vanished
  // when queried to now — same window, one day apart, 76 rows against 75.
  //
  // So the race's own end is used, and only clamped for a FINISHED period,
  // where the end has already passed and freezing is the point. A future end
  // date costs nothing: the API cannot return wagers that have not happened.
  //
  // Capped at 90 days because the API rejects wider ranges outright
  // ("Time range cannot exceed 90 days"), and a race longer than that would
  // otherwise fail every fetch rather than degrade.
  const MAX_DAYS = 90;
  let endMs = period.endAt || Date.now();
  if (endMs - startMs > MAX_DAYS * 864e5) endMs = startMs + MAX_DAYS * 864e5;

  return fetchDuelbits(affiliateId, password, ymd(startMs), ymd(endMs));
}

// One day forward. Duelbits' endDate is EXCLUSIVE, so asking for [day, day] is
// an empty window and returns nothing. Getting this wrong is quiet: the baseline
// comes back empty, subtracts zero, and the bug it exists to fix stays.
const ymdNext = (ms) => ymd(ms + 864e5);

/**
 * What each player had already wagered on the period's START DAY at the moment
 * the period began.
 *
 * Duelbits takes whole DATES, so a period starting at, say, 22:49 is queried as
 * startDate=<that date> and drags in the whole day before it — the same fault
 * that opened a Rainbet board with $2,048 of wager already on it and its top
 * player on $837 having genuinely not played since the previous night.
 *
 * Captured once, when the period starts. Nothing can rebuild it afterwards: the
 * API cannot be asked what a day looked like partway through once it has closed.
 * Both figures are stored because the board ranks on `wagered` (weighted points)
 * while `betAmount` carries the raw volume shown beside it, and leaving one
 * unadjusted would make the two disagree.
 */
async function fetchDuelbitsDayBaseline(affiliateId, password, startMs) {
  // A midnight-aligned start has NOTHING before it on its own day, so the
  // baseline is zero by definition and asking for it is not merely pointless but
  // dangerous: if the capture ever runs late (a retry, a backfill, a scheduler
  // tick after the boundary) the query returns wager done INSIDE the period and
  // subtracts it. Every auto-roll from a midnight period lands here.
  if (startMs % 864e5 === 0) return {};
  const data = await fetchDuelbits(affiliateId, password, ymd(startMs), ymdNext(startMs));
  const out  = {};
  for (const r of ((data && data.rankings) || [])) {
    if (r.uid != null) out[`id:${r.uid}`] = { wagered: r.wagered || 0, betAmount: r.betAmount || 0 };
  }
  return out;
}

/**
 * Subtract the start-day baseline and re-rank.
 *
 * `dayBaselines` is deliberately its own field rather than the shared
 * `baselines`, which is captured from whatever window was live at roll time and
 * means something different per provider. A board without one is returned
 * untouched, so nothing changes underneath a streamer until a correct baseline
 * exists for their period.
 */
function applyDuelbitsPeriod(data, period) {
  const base = (period && period.active && period.dayBaselines) || null;
  if (!data || !base) return data;
  // Two shapes are accepted on purpose. The scheduler stores the rich one
  // ({wagered, betAmount}), while the dashboard's capture is shared with Rainbet
  // and stores a bare number. Normalizing here keeps one capture path instead of
  // forking it per provider, and a bare number simply leaves volume unadjusted.
  const at = (uid) => {
    const b = base[`id:${uid}`];
    if (b == null) return { wagered: 0, betAmount: 0 };
    return typeof b === "number" ? { wagered: b, betAmount: 0 } : b;
  };
  const rankings = data.rankings
    .map((r) => {
      const b = at(r.uid);
      // Clamped: a casino can restate a day slightly, and a negative wager is
      // never the honest answer.
      return {
        ...r,
        wagered:   Math.max(0, (r.wagered   || 0) - (b.wagered   || 0)),
        betAmount: Math.max(0, (r.betAmount || 0) - (b.betAmount || 0)),
      };
    })
    .sort((a, b) => b.wagered - a.wagered)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return {
    ...data,
    rankings,
    totalUsers:   rankings.length,
    totalWagered: rankings.reduce((s, e) => s + e.wagered, 0),
    totalVolume:  rankings.reduce((s, e) => s + e.betAmount, 0),
  };
}

module.exports = {
  fetchDuelbits, fetchDuelbitsForPeriod, fetchDuelbitsDayBaseline,
  applyDuelbitsPeriod, authHeader, ymd, ymdNext,
};
