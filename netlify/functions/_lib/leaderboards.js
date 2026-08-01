// Leaderboard model — one document per board.
//
//   streamers/{uid}/leaderboards/{boardId}
//
// Replaces the single `leaderboardPeriod` object on the streamer doc, which had
// room for exactly one board. Streamers increasingly run several (Meg has Degen +
// CSGOBig; emergeonkick has Gambulls + Stake configured), and the second board
// only existed because it was hardcoded in PORTAL_PRESETS — which is why fixing
// its dates on 1 Aug 2026 needed a code change and a deploy.
//
// SHAPE
//   label       "CSGOBig Race"          display name
//   provider    csgobig|rainbet|gambulls|degen|stake|manual
//   order       0,1,2…                  display order, 0 is primary
//   enabled     bool
//   credential  { refCode?, apiKey? }   null = inherit providers/{provider}
//   period      see PERIOD_MODES below
//   prizes      number[]                rank-indexed, [] = none published
//   baselines · carryover · excluded · liveSnapshot   (same mechanics as before)
//
// PERIOD MODES — every case seen in production so far:
//   provider  follow the casino's own window. What the 5 streamers with no
//             leaderboardPeriod do today; the board is whatever the API returns.
//   rolling   fixed-length window that auto-renews (weekly/biweekly/monthly/custom).
//             What leaderboardPeriod does today.
//   cycle     day-of-month cycle, e.g. Meg's CSGOBig 16th → 16th. Rolls itself.
//   fixed     explicit startAt/endAt, no renewal. One-off races.
const PERIOD_MODES = ["provider", "rolling", "cycle", "fixed"];

// Board ids are readable and stable (the provider name), so a document is
// identifiable without opening it. Suffixed only when one provider is used twice.
function boardIdFor(provider, taken = []) {
  const base = String(provider || "board").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 50; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

// Fill in defaults so callers never have to null-check a half-written board.
function normalizeBoard(raw, id) {
  const b = raw || {};
  const period = b.period || {};
  const mode = PERIOD_MODES.includes(period.mode) ? period.mode : "provider";
  return {
    id,
    label:      b.label || (b.provider ? b.provider[0].toUpperCase() + b.provider.slice(1) : "Leaderboard"),
    provider:   String(b.provider || "").toLowerCase(),
    order:      Number.isFinite(b.order) ? b.order : 0,
    enabled:    b.enabled !== false,
    credential: b.credential || null,
    period: {
      mode,
      // rolling
      duration:  period.duration  || null,
      autoRenew: period.autoRenew !== false,
      // cycle
      cycleDay:  Number.isFinite(period.cycleDay) ? period.cycleDay : null,
      // fixed / the current window of a rolling board
      startAt:   Number.isFinite(period.startAt) ? period.startAt : null,
      endAt:     Number.isFinite(period.endAt)   ? period.endAt   : null,
    },
    prizes:       Array.isArray(b.prizes) ? b.prizes : [],
    baselines:    b.baselines    || {},
    carryover:    b.carryover    || {},
    liveSnapshot: b.liveSnapshot || {},
    excluded:     Array.isArray(b.excluded) ? b.excluded : [],
    anchorMonth:  b.anchorMonth  || null,
    carryMonth:   b.carryMonth   || null,
  };
}

// The window a board is currently running, in ms. Returns null for "provider"
// mode, where the casino decides and there's no window of our own.
//
// `cycle` is the 16th→16th shape: [cycleDay of this month, cycleDay of next) so
// consecutive races never overlap and no wager lands in two of them. Date.UTC
// normalises month under/overflow, so December→January needs no special case.
function boardWindow(board, now = Date.now()) {
  const p = (board && board.period) || {};
  if (p.mode === "fixed")  return (p.startAt && p.endAt) ? { from: p.startAt, to: p.endAt } : null;
  if (p.mode === "cycle") {
    const day = p.cycleDay;
    if (!day) return null;
    const d  = new Date(now);
    const y  = d.getUTCFullYear();
    const m  = d.getUTCMonth();
    const sm = d.getUTCDate() >= day ? m : m - 1;   // before the cycle day = still last month's race
    return {
      from: Date.UTC(y, sm, day, 0, 0, 0),
      to:   Date.UTC(y, sm + 1, day, 0, 0, 0) - 1,
      prevFrom: Date.UTC(y, sm - 1, day, 0, 0, 0),
      prevTo:   Date.UTC(y, sm, day, 0, 0, 0) - 1,
    };
  }
  if (p.mode === "rolling") return (p.startAt && p.endAt) ? { from: p.startAt, to: p.endAt } : null;
  return null; // provider mode
}

// Enabled boards in display order. Callers that only want "the" board take [0].
function sortBoards(boards) {
  return (boards || [])
    .filter((b) => b && b.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
}

module.exports = { PERIOD_MODES, boardIdFor, normalizeBoard, boardWindow, sortBoards };
