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
    // 500 is far above any realistic affiliate board and the response is small.
    const params = ["limit=500"];
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
  const endMs = period.endAt && period.endAt < Date.now() ? period.endAt : Date.now();
  return fetchDuelbits(affiliateId, password, ymd(startMs), ymd(endMs));
}

module.exports = { fetchDuelbits, fetchDuelbitsForPeriod, authHeader, ymd };
