// Degen affiliate-race leaderboard provider.
//
// Unlike Gambulls (header API key + WenBot-managed periods/baselines/prizes),
// Degen is PUBLIC and KEYLESS — the streamer's referral code is in the URL path
// — and it returns the ENTIRE race in one call: the period (startsAt→endTime),
// the prize pool, a per-rank prize for each leaderboard row, and the standings.
// So Degen owns the race; WenBot just passes it through live (no baselines, no
// finalize, no streamer-set prizes). One race per referral code at a time.
//
//   GET https://api.degen.com/v1/public/affiliate-races/by-referral/<code>/leaderboard
//
// Response shape (trimmed): { name, status, startsAt, endTime, prizePool,
//   prizes:[...], fiat, referralCode, participantsCount, totalWagered,
//   leaderboard:[ { place, user:{userName,levelImageUrl}|null, wagered, prize } ] }

const DEGEN_BASE = "https://api.degen.com/v1/public/affiliate-races/by-referral";

// Fetch + normalize the live race for a referral code. Returns null on any
// failure so callers can degrade gracefully. Amounts are USD (data.fiat).
async function fetchDegenRace(referralCode) {
  const code = (referralCode || "").trim();
  if (!code) return null;

  let data;
  try {
    const resp = await fetch(`${DEGEN_BASE}/${encodeURIComponent(code)}/leaderboard`, {
      headers: { "Accept": "application/json" },
    });
    if (!resp.ok) return null;
    data = await resp.json();
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.leaderboard)) return null;

  const rankings = data.leaderboard.map((e, i) => ({
    rank:      e.place || i + 1,
    uid:       null, // Degen exposes no stable per-user id
    username:  (e.user && e.user.userName) ? e.user.userName : "Anonymous",
    wagered:   parseFloat(e.wagered) || 0,
    avatarUrl: (e.user && e.user.levelImageUrl) ? e.user.levelImageUrl : null,
    prize:     Number(e.prize) > 0 ? Number(e.prize) : 0,
  }));

  return {
    raceName:     data.name || null,
    status:       data.status || null,
    rankings,
    totalWagered: parseFloat(data.totalWagered) || 0,
    totalUsers:   data.participantsCount || rankings.length,
    prizePool:    parseFloat(data.prizePool) || 0,
    prizes:       Array.isArray(data.prizes) ? data.prizes : [],
    fiat:         data.fiat || "USD",
    startAt:      data.startsAt ? Date.parse(data.startsAt) : null,
    endAt:        data.endTime  ? Date.parse(data.endTime)  : null,
    active:       (data.status || "").toUpperCase() === "ACTIVE",
  };
}

// Degen masks names as "<prefix>***<suffix>" (e.g. "krek" -> "k***k"). A claimed
// username matches a masked board name when it starts with the prefix and ends
// with the suffix and is long enough to fill the masked middle.
function degenNameMatch(claimed, masked) {
  if (!masked || !masked.includes("*")) return false;
  const c   = (claimed || "").toLowerCase();
  const pre = masked.slice(0, masked.indexOf("*")).toLowerCase();
  const suf = masked.slice(masked.lastIndexOf("*") + 1).toLowerCase();
  return c.length >= pre.length + suf.length && c.startsWith(pre) && c.endsWith(suf);
}

// Under-code lookup for verification: is `username` in this referral code's race?
// Degen only exposes MASKED names (+ fully anonymous rows we can't match), so this
// is best-effort prefix/suffix matching. Returns { underAffiliate, wagerAmount,
// place, ambiguous } — ambiguous=true when >1 masked row fits (we take the highest
// wager). Returns underAffiliate:false when no row fits, null on fetch failure.
async function lookupDegen(referralCode, username) {
  const race = await fetchDegenRace(referralCode);
  if (!race) return null;
  const u = (username || "").trim();
  if (!u) return { underAffiliate: false, wagerAmount: 0 };
  const fits = race.rankings.filter(
    (r) => r.username && r.username !== "Anonymous" && degenNameMatch(u, r.username)
  );
  if (!fits.length) return { underAffiliate: false, wagerAmount: 0 };
  fits.sort((a, b) => b.wagered - a.wagered);
  return { underAffiliate: true, wagerAmount: fits[0].wagered || 0, place: fits[0].rank, ambiguous: fits.length > 1 };
}

module.exports = { fetchDegenRace, lookupDegen, degenNameMatch };
