// Gamba.com exclusive-leaderboard provider.
//
// Gamba runs affiliate "races" at
//   https://gamba.com/promotions/exclusive-leaderboards/<raceId>
// There is no documented API, but that page is a Nuxt app that loads the race
// from Gamba's own GraphQL gateway, and we call the same endpoint directly:
//
//   POST https://gamba.com/_api/@
//   query getRaceById($raceId: Int!) { getRaceById(raceId){ …race, competitors{…} } }
//
// No key or login is needed — the race is public. Gamba's edge WAF answers 403
// "Forbidden" to anything that doesn't look like a browser (a bare server fetch
// is blocked), so we send the same Origin/Referer/User-Agent a browser sends;
// with those headers it returns 200. This is the same class of block Kick puts
// on datacenter IPs, cleared the same way.
//
// Like Degen/Clash the race owns its own window and prize ladder, so WenBot just
// passes it through live — no baselines, no finalize, no WenBot-set period. One
// race per raceId. Matching is display-name only: Gamba exposes no stable public
// per-user id, and hides some entrants' names as "Hidden".
//
// Unofficial + undocumented: if Gamba restructure this endpoint the fetch goes
// null and callers serve their cached copy, the same failure mode as Degen and
// CSGOBig scraping already carry.

const GAMBA_GQL = "https://gamba.com/_api/@";

// The whole race in one call: window, prize distribution, sponsor and the ranked
// competitors. Only the fields the board actually renders.
const RACE_QUERY = `query getRaceById($raceId: Int!) {
  getRaceById(raceId: $raceId) {
    id
    race_name
    prize_pool
    start_date
    end_date
    sponsor { id username display_name }
    currency { id code }
    prize_distribution { position amount }
    competitors { position display_name total_wagered }
  }
}`;

// Gamba's edge WAF blocks non-browser requests with 403 unless Origin + Referer
// + a browser User-Agent are present, so mirror what the site's own page sends.
function gambaHeaders(raceId) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Origin": "https://gamba.com",
    "Referer": `https://gamba.com/promotions/exclusive-leaderboards/${raceId}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
}

// Accept a bare id ("17326"), a number, or a full/partial race URL and pull the
// numeric id out, so a streamer can paste either the link or the number.
function parseRaceId(input) {
  if (input == null) return null;
  const m = String(input).trim().match(/(\d{2,})/); // the id in .../exclusive-leaderboards/17326
  return m ? m[1] : null;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Gamba dates are "YYYY-MM-DD HH:mm:ss" with no zone; they are UTC, but
// Date.parse would read the bare form as local time, so pin it to UTC.
function parseGambaDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : null;
}

/**
 * Fetch + normalise a Gamba race. Accepts a race id or its page URL.
 * Returns null on any failure (blocked, restructured, bad id) so callers serve
 * their cached copy rather than blanking a live board. Amounts are in the race's
 * own currency (data.currency, e.g. USDT).
 */
async function fetchGambaRace(raceIdInput) {
  const raceId = parseRaceId(raceIdInput);
  if (!raceId) return null;

  let body;
  try {
    const resp = await fetch(GAMBA_GQL, {
      method: "POST",
      headers: gambaHeaders(raceId),
      body: JSON.stringify({ query: RACE_QUERY, variables: { raceId: Number(raceId) } }),
    });
    if (!resp.ok) return null;
    body = await resp.json();
  } catch {
    return null;
  }
  const race = body && body.data && body.data.getRaceById;
  if (!race || !Array.isArray(race.competitors)) return null;

  // Rank-indexed prize ladder from the race's own distribution, so prizes line
  // up with standings even if the distribution comes back out of order.
  const prizes = [];
  (race.prize_distribution || []).forEach((p) => {
    const pos = Number(p.position);
    if (pos > 0) prizes[pos - 1] = num(p.amount);
  });

  const rankings = race.competitors
    .map((c) => {
      const rank = Number(c.position) || 0;
      return {
        rank,
        uid:       null, // Gamba exposes no stable per-user id on the public race
        username:  c.display_name || "Anonymous",
        wagered:   num(c.total_wagered),
        avatarUrl: null,
        prize:     Number(prizes[rank - 1]) > 0 ? Number(prizes[rank - 1]) : 0,
      };
    })
    .filter((r) => r.rank > 0)
    .sort((a, b) => a.rank - b.rank);

  const startAt = parseGambaDate(race.start_date);
  const endAt   = parseGambaDate(race.end_date);
  const now     = Date.now();

  return {
    raceName:     race.race_name || null,
    rankings,
    prizes,
    prizePool:    num(race.prize_pool),
    currency:     (race.currency && race.currency.code) || null,
    sponsor:      (race.sponsor && (race.sponsor.display_name || race.sponsor.username)) || null,
    startAt,
    endAt,
    active:       !!(startAt && endAt && now >= startAt && now <= endAt),
    totalWagered: rankings.reduce((s, r) => s + r.wagered, 0),
    totalUsers:   rankings.length,
  };
}

// Under-code lookup for verification. Gamba has no per-user affiliate API, but
// the public race lists its competitors by display name, so — exactly like Degen
// and CSGOBig — we match the claimed username against that list. Names come back
// in full or hidden as "Hidden" (a privacy setting we cannot see through), so
// there is no mask to unpick: a plain case-insensitive match, and "Hidden" rows
// are unmatchable by design.
//
// Returns { found, username, wagered, place }; found:false on a genuine miss;
// null when the race could not be fetched, so callers can tell "not under this
// race" apart from "couldn't check". A miss means "no recorded play in this
// race", not proof of nothing — someone signed up under the code who has not
// wagered in the race won't appear, the same caveat Degen/Clash carry.
async function lookupGamba(raceIdInput, username) {
  const race = await fetchGambaRace(raceIdInput);
  if (!race) return null;
  const u = String(username || "").trim().toLowerCase();
  if (!u || u === "hidden") return { found: false };
  const hit = race.rankings.find(
    (r) => r.username && r.username.toLowerCase() === u && r.username.toLowerCase() !== "hidden"
  );
  return hit
    ? { found: true, username: hit.username, wagered: hit.wagered || 0, place: hit.rank }
    : { found: false };
}

module.exports = { fetchGambaRace, lookupGamba, parseRaceId };
