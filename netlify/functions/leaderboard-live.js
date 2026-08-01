// GET /api/leaderboard-live?channel=xxx&casino=xxx
// Proxies the casino's leaderboard API using the streamer's stored API key

const { getDb }            = require("./_lib/firebase");
const { res: _res }        = require("./_lib/http");
const { CASINO_NAMES }     = require("./_lib/casinos");
const { normalizeGambulls, applyPeriod } = require("./_lib/leaderboard");
const { fetchDegenRace }   = require("./_lib/degen");
const { normalizeBoard, boardWindow, sortBoards } = require("./_lib/leaderboards");
const { fetchRainbetRange, fetchRainbetForPeriod, applyRainbetExclusions } = require("./_lib/rainbet");
const res = (s, b) => _res(s, b, "*");

async function fetchGambulls(apiKey) {
  const resp = await fetch(
    "https://api.gambulls.com/api/public/streamer/leaderboard?type=monthly&limit=100",
    { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.success || !data.responseObject?.rankings) return null;
  return {
    totalWagered: data.responseObject.totalWagered || 0,
    totalUsers: data.responseObject.totalUsers || 0,
    rankings: normalizeGambulls(data.responseObject),
  };
}

// Custom date-range lookup (Gambulls v1.3 /date-range) — the right tool for a
// streamer's CUSTOM periods (e.g. a 3-day window). Returns everyone who wagered
// between from/to (YYYY-MM-DD), ranked, computed on demand.
async function fetchGambullsDateRange(apiKey, from, to) {
  const url = `https://api.gambulls.com/api/public/streamer/leaderboard/date-range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`;
  const resp = await fetch(url, { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.success || !data.responseObject?.rankings) return null;
  return {
    period:       data.responseObject.period,
    totalWagered: data.responseObject.totalWagered || 0,
    totalUsers:   data.responseObject.totalUsers || 0,
    rankings:     normalizeGambulls(data.responseObject),
  };
}

// Historical period lookup (Gambulls v1.3 `period=`). Returns that finished
// period's standings directly — no baselines/carryover (it's a snapshot in time).
async function fetchGambullsPeriod(apiKey, type, period) {
  const t = ["daily", "weekly", "monthly"].includes(type) ? type : "monthly";
  const url = `https://api.gambulls.com/api/public/streamer/leaderboard?type=${t}&period=${encodeURIComponent(period)}&limit=100`;
  const resp = await fetch(url, { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.success || !data.responseObject?.rankings) return null;
  return {
    period:       data.responseObject.period,
    totalWagered: data.responseObject.totalWagered || 0,
    totalUsers:   data.responseObject.totalUsers || 0,
    rankings:     normalizeGambulls(data.responseObject),
  };
}

// Short-TTL Firestore cache for the RAW (unbaselined) casino standings. Without
// this, every viewer's 60s portal refresh hits Gambulls with the streamer's API
// key — which at scale can rate-limit/ban that key and break their board. We cache
// the raw fetch per channel and re-apply the period per request, so correctness is
// unchanged. On a fetch failure we serve the last cached copy (even if stale)
// rather than 502. (`_cache` is admin-SDK only; clients can't read it.)
const LB_CACHE_TTL_MS = 45 * 1000;
async function getCachedStandings(db, channelKey, provider, apiKey) {
  const ref = db.collection("_cache").doc(`lb_${channelKey}_${provider}`);
  let cached = null;
  try {
    const doc = await ref.get();
    if (doc.exists) {
      cached = doc.data();
      if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < LB_CACHE_TTL_MS) {
        return cached.data; // fresh enough
      }
    }
  } catch { /* cache read failure → fall through to a live fetch */ }

  const fresh = await fetchGambulls(apiKey);
  if (fresh) {
    try { await ref.set({ cachedAt: Date.now(), data: fresh }); } catch {}
    return fresh;
  }
  // Live fetch failed — serve the last good copy if we have one.
  return cached && cached.data ? cached.data : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const { channel, casino } = event.queryStringParameters || {};
  if (!channel) return res(400, { error: "Missing channel" });

  try {
    const db = getDb();
    const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const streamerDoc = snap.docs[0];
    const streamerData = streamerDoc.data();

    // Casino from the query param, else the streamer's actual choice. Never
    // assume Gambulls — if none is set there's no leaderboard to show.
    const provider = (casino || streamerData.activeProvider || "").toLowerCase();
    if (!provider || !CASINO_NAMES[provider]) return res(400, { error: "This channel hasn't set a casino yet." });

    // Period/countdown config for the public page (set from the dashboard).
    const period = streamerData.leaderboardPeriod || null;

    // For public viewers, check leaderboard is enabled; internal=1 bypasses (dashboard)
    const isInternal = event.queryStringParameters?.internal === "1";
    if (!isInternal && !streamerData.leaderboardEnabled) {
      return res(403, { error: "This streamer's leaderboard is not publicly enabled." });
    }

    // Degen: keyless public race API (referral code in the URL). Passthrough —
    // the race period + per-rank prizes come from Degen, no WenBot baselines.
    if (provider === "degen") {
      const provDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("degen").get();
      const code = provDoc.exists ? (provDoc.data().referralCode || provDoc.data().apiKey) : null;
      if (!code) return res(400, { error: "Streamer hasn't configured their Degen referral code yet." });
      const race = await fetchDegenRace(code);
      if (!race) return res(502, { error: "Failed to fetch from Degen API." });
      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider], period,
        degen: { raceName: race.raceName, startAt: race.startAt, endAt: race.endAt, prizePool: race.prizePool, fiat: race.fiat, active: race.active },
        rankings: race.rankings.map((r) => ({ rank: r.rank, username: r.username, wagered: r.wagered, avatarUrl: r.avatarUrl, prize: r.prize })),
        totalWagered: race.totalWagered, totalUsers: race.totalUsers,
      });
    }

    // CSGOBig: served STRICTLY from the cache portal-data fills — this branch
    // never calls CSGOBig itself.
    //
    // Their rate limit is keyed per REFERRAL CODE, not per IP, so every consumer
    // of a streamer's code shares one quota, and the block appears to re-arm on
    // each rejected attempt. A second independent fetcher would double the upstream
    // attempts and could starve the quota indefinitely, blanking the public board.
    // portal-data stays the sole refresher; /lb and the dashboard read what it
    // already fetched, keyed on the same race window.
    if (provider === "csgobig") {
      const bSnap = await db.collection("streamers").doc(streamerDoc.id).collection("leaderboards").get();
      const board = sortBoards(bSnap.docs.map((d) => normalizeBoard(d.data(), d.id)))
        .find((b) => b.provider === "csgobig");
      const code = board && board.credential && board.credential.refCode;
      if (!code) return res(400, { error: "Streamer hasn't configured their CSGOBig referral code yet." });

      const win = boardWindow(board) || {};
      const from = win.from || null, to = win.to || null;
      const prizes = Array.isArray(board.prizes) ? board.prizes : [];
      const prizeFor = (rank) => (Number(prizes[rank - 1]) > 0 ? Number(prizes[rank - 1]) : 0);

      let cached = null;
      try {
        const c = await db.collection("_cache").doc(`csgobig_${code}_${from}-${to}`).get();
        if (c.exists) cached = c.data().data || null;
      } catch {}

      const rankings = (cached?.rankings || []).map((r) => ({
        rank: r.rank, username: r.username, wagered: r.wagered, avatarUrl: r.avatarUrl, prize: prizeFor(r.rank),
      }));
      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider] || "CSGOBig",
        period: { active: board.period.active, startAt: from, endAt: to },
        rankings,
        totalWagered: cached?.totalWagered || 0,
        totalUsers:   cached?.totalUsers   || 0,
        // Tells a caller the difference between "race has no wagers" and "we haven't
        // fetched this window yet", which otherwise look identical.
        pending: !cached,
      });
    }

    // Rainbet: key + arbitrary date range. The range IS the period, so there are
    // no baselines/carryover — we ask Rainbet for the period's exact dates and
    // only apply WenBot's manual exclusions on top. Cached per channel+range so
    // a busy portal can't hammer the streamer's key.
    if (provider === "rainbet") {
      const provDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("rainbet").get();
      const apiKey = provDoc.exists ? (provDoc.data().apiKey || "") : "";
      if (!apiKey) return res(400, { error: "Streamer hasn't configured their Rainbet API key yet." });

      const fromParam = (event.queryStringParameters?.from || "").trim();
      const toParam   = (event.queryStringParameters?.to   || "").trim();
      const histRange = fromParam && toParam;

      const cacheRef = db.collection("_cache")
        .doc(`lb_${channel.toLowerCase()}_rainbet_${histRange ? `${fromParam}_${toParam}` : "live"}`);
      let data = null, cached = null;
      try {
        const doc = await cacheRef.get();
        if (doc.exists) {
          cached = doc.data();
          if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < LB_CACHE_TTL_MS) data = cached.data;
        }
      } catch { /* fall through to a live fetch */ }

      if (!data) {
        data = histRange
          ? await fetchRainbetRange(apiKey, fromParam, toParam)
          : await fetchRainbetForPeriod(apiKey, period);
        if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
        else if (cached?.data) data = cached.data;   // serve stale rather than fail
      }
      if (!data) return res(502, { error: "Failed to fetch from Rainbet API." });

      if (histRange) {
        return res(200, {
          success: true, casino: provider, casinoName: CASINO_NAMES[provider], historical: true,
          period: { from: data.from, to: data.to },
          rankings: data.rankings, totalWagered: data.totalWagered, totalUsers: data.totalUsers,
        });
      }
      // raw=1 skips exclusions (wager raffle applies its own logic).
      const out = event.queryStringParameters?.raw === "1" ? data : applyRainbetExclusions(data, period);
      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider], period,
        rankings: out.rankings, totalWagered: out.totalWagered, totalUsers: out.totalUsers,
        rangeFrom: data.from, rangeTo: data.to, casinoUpdatedAt: data.cacheUpdatedAt || null,
      });
    }

    // Only Gambulls has live API support right now
    if (provider === "gambulls") {
      const providerDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("gambulls").get();
      if (!providerDoc.exists) return res(400, { error: "Streamer hasn't configured their Gambulls API yet." });

      const { apiKey } = providerDoc.data();

      // Custom date-range view — used by the dashboard's "past period" dropdown,
      // which queries each finished period by its real start/end dates (works for
      // custom-length periods, e.g. a 3-day one). Uncached, no period math.
      const fromParam = (event.queryStringParameters?.from || "").trim();
      const toParam   = (event.queryStringParameters?.to   || "").trim();
      if (fromParam && toParam) {
        const dr = await fetchGambullsDateRange(apiKey, fromParam, toParam);
        if (!dr) return res(502, { error: "Couldn't load that date range from Gambulls." });
        return res(200, {
          success: true, casino: provider, casinoName: CASINO_NAMES[provider], historical: true,
          period: dr.period, rankings: dr.rankings, totalWagered: dr.totalWagered, totalUsers: dr.totalUsers,
        });
      }

      // Calendar-period view (Gambulls `period=YYYY-MM` etc.) — kept for completeness.
      const histPeriod = (event.queryStringParameters?.period || "").trim();
      if (histPeriod) {
        const histType = event.queryStringParameters?.ptype || "monthly";
        const hist = await fetchGambullsPeriod(apiKey, histType, histPeriod);
        if (!hist) return res(502, { error: "Couldn't load that period from Gambulls." });
        return res(200, {
          success: true, casino: provider, casinoName: CASINO_NAMES[provider], historical: true,
          period: hist.period, rankings: hist.rankings, totalWagered: hist.totalWagered, totalUsers: hist.totalUsers,
        });
      }

      const data = await getCachedStandings(db, channel.toLowerCase(), provider, apiKey);
      if (!data) return res(502, { error: "Failed to fetch from Gambulls API." });

      // raw=1 returns the unbaselined monthly totals (used by the wager raffle,
      // which applies its own separate baselines).
      const raw = event.queryStringParameters?.raw === "1";
      const out = raw ? data : applyPeriod(data, period);
      return res(200, { success: true, casino: provider, casinoName: CASINO_NAMES[provider], period, ...out });
    }

    // Honor-system casinos: return empty leaderboard (no API)
    return res(200, { success: true, casino: provider, casinoName: CASINO_NAMES[provider], period, totalWagered: 0, totalUsers: 0, rankings: [] });

  } catch (err) {
    console.error("[leaderboard-live] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
