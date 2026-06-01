// Shared leaderboard period logic — used by BOTH leaderboard-live.js (dashboard
// + standard portal) and portal-data.js (portal aggregator) so the public
// leaderboard always reflects the SAME baselines / carryover / exclusions the
// dashboard shows. Keeping this in one place is why a custom-date snapshot now
// carries over seamlessly into the white-label / bespoke portals.

// Normalize a raw Gambulls responseObject into our ranking rows. Each row gets a
// stable provider `uid` (the ONLY reliable per-user key — Gambulls anonymizes
// some users behind a shared "Anonymous" name, so we must NOT key on the name).
function normalizeGambulls(responseObject) {
  return (responseObject.rankings || []).map((e, i) => ({
    rank: i + 1,
    uid: e.user?.id != null ? String(e.user.id) : null,
    username: e.user?.isAnonymous ? "Anonymous" : (e.user?.name || "Unknown"),
    wagered: e.wagerAmount || 0,
    avatarUrl: e.user?.imageUrl || null,
  }));
}

// Stable key for matching a row to a baseline / removal / carryover entry.
function periodKey(e) {
  if (e.uid != null && e.uid !== "") return "id:" + e.uid;
  const name = (e.username || "").toLowerCase();
  if (name && name !== "anonymous") return "nm:" + name;
  return null;
}

// UTC year-month, e.g. "2026-06". Gambulls totals are monthly.
function monthOf(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Apply the leaderboard period to raw casino rankings.
//
// Within the period's anchor (starting) month, a user's shown wager is
// (current - baseline) — the reset-to-0 behavior. Gambulls resets all totals at
// each month boundary AND drops $0 users from the feed, so to survive a
// mid-period rollover we add `carryover`: wager banked from prior months of this
// period (the bot scheduler snapshots it just before each reset). After the
// anchor month, the current month's full total is added on top of carryover.
// Excluded users are dropped; then re-rank. With no active period, returns as-is.
//
// `data` is { rankings:[{uid,username,wagered,avatarUrl}], totalWagered, totalUsers }.
function applyPeriod(data, period) {
  if (!period) return data;
  const active    = period.active;
  const baselines = (active && period.baselines) ? period.baselines : null;
  const carryover = (active && period.carryover) ? period.carryover : null;
  const excluded  = new Set((period.excluded || []).map(String));
  if (!baselines && !carryover && excluded.size === 0) return data;

  const anchorMonth = period.anchorMonth ||
    (period.startAt ? monthOf(period.startAt) : monthOf(Date.now()));
  const inAnchorMonth = monthOf(Date.now()) === anchorMonth;

  const merged = new Map();

  // 1) Seed with banked carryover (prior months of this period).
  if (carryover) {
    for (const [key, c] of Object.entries(carryover)) {
      if (excluded.has(key)) continue;
      merged.set(key, { wagered: c.wagered || 0, username: c.username || "Unknown", avatarUrl: c.avatarUrl || null });
    }
  }

  // 2) Add the current month's contribution from the live feed.
  for (const e of (data.rankings || [])) {
    const key = periodKey(e);
    if (key && excluded.has(key)) continue;

    if (!baselines && !carryover) { merged.set(key || Symbol(), { wagered: e.wagered || 0, username: e.username, avatarUrl: e.avatarUrl }); continue; }
    if (!key) continue; // untrackable anonymous — can't reconcile across resets

    const cur  = e.wagered || 0;
    const base = baselines ? (baselines[key] || 0) : 0;
    let contribution = inAnchorMonth ? Math.max(0, cur - base) : cur;
    if (inAnchorMonth && cur < base) contribution = cur; // missed-reset guard

    const prev = merged.get(key);
    if (prev) { prev.wagered += contribution; if (e.avatarUrl) prev.avatarUrl = e.avatarUrl; prev.username = e.username; }
    else merged.set(key, { wagered: contribution, username: e.username, avatarUrl: e.avatarUrl });
  }

  let rankings = [...merged.values()].filter((e) => e.wagered > 0);
  rankings.sort((a, b) => b.wagered - a.wagered);
  rankings = rankings.map((e, i) => ({ ...e, rank: i + 1 }));
  const totalWagered = rankings.reduce((s, e) => s + e.wagered, 0);
  return { ...data, rankings, totalWagered, totalUsers: rankings.length };
}

module.exports = { normalizeGambulls, periodKey, monthOf, applyPeriod };
