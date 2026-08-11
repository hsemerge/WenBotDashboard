// Rainbet affiliate leaderboard provider.
//
//   GET https://services.rainbet.com/v1/external/affiliates
//       ?start_at=YYYY-MM-DD&end_at=YYYY-MM-DD&key=<streamer api key>
//
// Response: { affiliates: [ { username, id, wagered_amount } ], cache_updated_at }
//
// Rainbet computes the wagered total for an ARBITRARY DATE RANGE server-side, so
// — unlike Gambulls (fixed monthly totals that reset) — we do NOT need baselines
// or carryover: we just ask for the period's exact start/end dates and Rainbet
// returns that window's numbers. Names are real (never masked) and every row has
// a stable `id`, so matching is straightforward.
//
// Constraints learned from the live API:
//   • range must be <= 4 months           → er_end_at_parameter_within_4_month
//   • bad key returns HTTP 400            → er_invalid_key
//   • wagered_amount is a STRING          → parseFloat
//   • only users who wagered in the range are returned

const RAINBET_URL   = "https://services.rainbet.com/v1/external/affiliates";
const MAX_RANGE_DAYS = 118;               // stay just inside Rainbet's 4-month cap
const DAY_MS         = 24 * 60 * 60 * 1000;

// UTC YYYY-MM-DD (Rainbet takes whole days: start of start_at → end of end_at).
function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Clamp a requested window to Rainbet's max range, keeping the END fixed (the
// most recent data is what a live board cares about).
//
// `startMs` of 0 (or null) means "as far back as the API allows". Do NOT write
// `startMs || end` here: 0 is falsy, so that collapsed the window to end→end,
// i.e. TODAY ONLY. That silently broke every Rainbet verification — a viewer who
// hadn't wagered today read as "not under the affiliate code".
function clampRange(startMs, endMs) {
  const end     = Math.min(endMs || Date.now(), Date.now());
  const maxBack = end - MAX_RANGE_DAYS * DAY_MS;
  let   start   = (startMs === null || startMs === undefined) ? maxBack : Number(startMs);
  if (!Number.isFinite(start)) start = maxBack;
  if (start > end)             start = end;
  if (end - start > MAX_RANGE_DAYS * DAY_MS) start = maxBack;
  return { from: ymd(start), to: ymd(end) };
}

// Current calendar month to date (Gambulls-equivalent default window).
function monthToDateRange() {
  const now = new Date();
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return clampRange(first, Date.now());
}

// Fetch + normalize one date range. Returns null on any failure so callers can
// degrade gracefully (serve cache / empty board) instead of 500-ing.
// `from` / `to` are YYYY-MM-DD strings.
async function fetchRainbetRange(apiKey, from, to) {
  const key = (apiKey || "").trim();
  if (!key || !from || !to) return null;

  let data;
  try {
    const url = `${RAINBET_URL}?start_at=${encodeURIComponent(from)}&end_at=${encodeURIComponent(to)}&key=${encodeURIComponent(key)}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`[rainbet] ${resp.status} for ${from}..${to}:`, body.slice(0, 120));
      return null;
    }
    data = await resp.json();
  } catch (err) {
    console.warn("[rainbet] fetch failed:", err.message);
    return null;
  }
  if (!data || !Array.isArray(data.affiliates)) return null;

  const rankings = data.affiliates
    .map((e) => ({
      uid:       e.id != null ? String(e.id) : null,
      username:  e.username || "Anonymous",
      wagered:   parseFloat(e.wagered_amount) || 0,
      avatarUrl: null,                       // Rainbet exposes no avatars
    }))
    .filter((r) => r.wagered > 0)
    .sort((a, b) => b.wagered - a.wagered)   // defensive: don't trust upstream order
    .map((r, i) => ({ rank: i + 1, ...r }));

  return {
    rankings,
    totalUsers:     rankings.length,
    totalWagered:   rankings.reduce((s, r) => s + r.wagered, 0),
    cacheUpdatedAt: data.cache_updated_at || null,
    from,
    to,
  };
}

// Convenience: fetch the window a leaderboard period describes. With no active
// period (or no start), falls back to month-to-date.
async function fetchRainbetForPeriod(apiKey, period) {
  const startMs = period && period.active && period.startAt ? period.startAt : null;
  const endMs   = period && period.active && period.endAt && period.endAt < Date.now()
    ? period.endAt          // finished period → freeze at its end date
    : Date.now();
  const range = startMs ? clampRange(startMs, endMs) : monthToDateRange();
  return fetchRainbetRange(apiKey, range.from, range.to);
}

// Wager each player had already done on the period's START DAY at the moment the
// period began. Rainbet only accepts whole dates, so a period beginning at, say,
// 22:49 is queried as `start_at=<that date>` and drags in the whole day before
// it. Subtracting this removes exactly that overhang.
//
// Captured once, when the period starts, by the dashboard's Start button and by
// the scheduler's auto-roll. Nothing can reconstruct it later: the API cannot be
// asked what a day looked like at 22:49 once the day has closed.
async function fetchRainbetDayBaseline(apiKey, startMs) {
  const day  = ymd(startMs);
  const data = await fetchRainbetRange(apiKey, day, day);
  const out  = {};
  for (const r of ((data && data.rankings) || [])) {
    if (r.uid != null) out[`id:${r.uid}`] = r.wagered || 0;
  }
  return out;
}

// Apply the parts of a WenBot period that Rainbet can't express itself: the
// start-day baseline above, manual exclusions (removed users), then re-rank.
//
// `dayBaselines` is deliberately a NEW field rather than the shared `baselines`.
// That one is captured from whatever window was live at roll time, which for
// Gambulls is a monthly total and correct, but for Rainbet is the OLD period's
// range and meaningless against the new one — Cherubxm's read $22,914 against a
// raw $1,306, so subtracting it would have produced large negatives. A separate
// field means a board only changes once a correct baseline exists for it, and
// every board without one behaves exactly as it does today.
function applyRainbetExclusions(data, period) {
  const excluded  = new Set((period?.excluded || []).map(String));
  const dayBase   = (period && period.active && period.dayBaselines) || null;
  if (!data || (excluded.size === 0 && !dayBase)) return data;
  const rankings = data.rankings
    .filter((r) => !excluded.has(String(r.uid)) && !excluded.has((r.username || "").toLowerCase()))
    // Clamped at zero: Rainbet can restate a day slightly, and a negative wager
    // is never the honest answer.
    .map((r) => dayBase
      ? { ...r, wagered: Math.max(0, (r.wagered || 0) - (dayBase[`id:${r.uid}`] || 0)) }
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
  fetchRainbetRange,
  fetchRainbetForPeriod,
  fetchRainbetDayBaseline,
  applyRainbetExclusions,
  monthToDateRange,
  clampRange,
  ymd,
};
