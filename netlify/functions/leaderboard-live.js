// GET /api/leaderboard-live?channel=xxx&casino=xxx
// Proxies the casino's leaderboard API using the streamer's stored API key

const { getDb }            = require("./_lib/firebase");
const { res: _res }        = require("./_lib/http");
const { CASINO_NAMES }     = require("./_lib/casinos");
const { normalizeGambulls, applyPeriod } = require("./_lib/leaderboard");
const { findStreamerByChannel } = require("./_lib/streamer");
const { fetchDegenRace }   = require("./_lib/degen");
const { normalizeBoard, boardWindow, sortBoards } = require("./_lib/leaderboards");
const { fetchRainbetRange, fetchRainbetForPeriod, applyRainbetExclusions } = require("./_lib/rainbet");
const { fetchHypebetRange, fetchHypebetForPeriod, applyHypebetExclusions } = require("./_lib/hypebet");
const { fetchDuelbits, fetchDuelbitsForPeriod, fetchDuelbitsDayBaseline, applyDuelbitsPeriod, ymdNext } = require("./_lib/duelbits");
const { fetchClashBoard } = require("./_lib/clash");
const { fetchGambaRace }  = require("./_lib/gamba");
const { fetchEthbetBoard } = require("./_lib/ethbet");
const { fetchWinovoBoard } = require("./_lib/winovo");
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
// Clash build their leaderboard response on request and asked us not to hammer it.
const CLASH_CACHE_TTL_MS = 5 * 60 * 1000;
// Gamba is an unofficial call to the race API their own page uses, so one shared
// fetch per channel per interval serves every viewer. The interval only gates
// that external fetch + a single cache write (the per-poll reads are the same at
// any TTL), so 5 min keeps the board feeling live at negligible cost and still
// well clear of Gamba's WAF however busy the portal gets.
const GAMBA_CACHE_TTL_MS = 5 * 60 * 1000;
// Hype.bet enforces a 5-MINUTE per-key cooldown, so the cache MUST outlast it or
// back-to-back portal loads earn a RATE_LIMIT_EXCEEDED. 6 min keeps every real
// fetch comfortably past the cooldown boundary.
const HYPEBET_CACHE_TTL_MS = 6 * 60 * 1000;
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
    const snapDoc = await findStreamerByChannel(db, channel);
    if (!snapDoc) return res(404, { error: "Channel not found" });

    const streamerDoc = snapDoc;
    const streamerData = streamerDoc.data();

    // Casino from the query param, else the streamer's actual choice. Never
    // assume Gambulls — if none is set there's no leaderboard to show.
    const provider = (casino || streamerData.activeProvider || "").toLowerCase();
    if (!provider || !CASINO_NAMES[provider]) return res(400, { error: "This channel hasn't set a casino yet." });

    // Period/countdown config for the public page (set from the dashboard).
    //
    // leaderboardPeriod describes the PRIMARY casino and nothing else. Applying
    // it to an additional board is not merely imprecise — applyPeriod SEEDS its
    // result from the period's carryover, so the primary's banked players and
    // their primary wagers get injected into the other casino's board, and any
    // name that appears on both has the two added together.
    //
    // SKSlots asked for Winovo and got 29 Gambulls players at Gambulls amounts:
    // his real Winovo race was 5 players and $513, but the response came back
    // $28,518 with Bowenmango at $9,313 — his Gambulls figure. The masked
    // Gambulls names were even overwritten by the unmasked Winovo ones where
    // keys collided, so it read as a clean Winovo board.
    //
    // portal-data has always resolved this per board (see periodOfBoard). This
    // brings the endpoint the DASHBOARD reads into line with it.
    let period = streamerData.leaderboardPeriod || null;
    if (provider !== String(streamerData.activeProvider || "").toLowerCase()) {
      try {
        const bSnap = await db.collection("streamers").doc(streamerDoc.id).collection("leaderboards").get();
        const brd = sortBoards(bSnap.docs.map((d) => normalizeBoard(d.data(), d.id)))
          .find((x) => x.provider === provider);
        if (brd) {
          const win = boardWindow(brd);
          period = {
            active:       brd.period.active,
            duration:     brd.period.duration,
            autoRenew:    brd.period.autoRenew,
            startAt:      win ? win.from : brd.period.startAt,
            endAt:        win ? win.to   : brd.period.endAt,
            baselines:    brd.baselines,
            dayBaselines: brd.dayBaselines,
            carryover:    brd.carryover,
            liveSnapshot: brd.liveSnapshot,
            excluded:     brd.excluded,
            anchorMonth:  brd.anchorMonth,
            carryMonth:   brd.carryMonth,
          };
        } else {
          // No board configured for this casino means nothing describes its
          // window. Raw totals are wrong, but they are honestly wrong — the
          // primary's carryover would be another casino's money.
          period = null;
        }
      } catch (e) {
        console.warn("[leaderboard-live] board period lookup failed:", e.message);
        period = null;
      }
    }

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

    // Clash.gg: bearer token + a start date, so the range IS the period and there
    // are no baselines or carryover, same as Rainbet.
    //
    // The token is a secret, so it lives in the server-only providers/ subcollection
    // rather than on the board doc next to the public referral codes. The board doc
    // still owns the period and the prize table.
    if (provider === "clash") {
      const bSnap = await db.collection("streamers").doc(streamerDoc.id).collection("leaderboards").get();
      const board = sortBoards(bSnap.docs.map((d) => normalizeBoard(d.data(), d.id)))
        .find((b) => b.provider === "clash");
      if (!board) return res(400, { error: "Streamer hasn't set up a Clash.gg board yet." });

      // The token can arrive two ways: providers/clash (where every other API
      // credential lives) or on the board doc itself, which is what the board
      // editor writes. Accept both, or configuring it the obvious way through the
      // dashboard would save a token nothing ever reads.
      const provDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("clash").get();
      const token = (provDoc.exists ? (provDoc.data().token || provDoc.data().apiToken || "") : "")
        || (board.credential && (board.credential.apiToken || board.credential.token)) || "";
      if (!token) return res(400, { error: "Streamer hasn't configured their Clash.gg API token yet." });

      // Clash generate this response on demand and asked us to cache it, so the
      // window is 5 minutes rather than the 45s the other providers use. One
      // document per channel, because the race identifies itself.
      const cacheRef = db.collection("_cache").doc(`lb_${channel.toLowerCase()}_clash`);
      let data = null, cached = null;
      try {
        const doc = await cacheRef.get();
        if (doc.exists) {
          cached = doc.data();
          if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < CLASH_CACHE_TTL_MS) data = cached.data;
        }
      } catch { /* fall through to a live fetch */ }

      if (!data) {
        data = await fetchClashBoard(token, board.credential && board.credential.leaderboardId);
        if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
        else if (cached?.data) data = cached.data;   // serve stale rather than blank the board
      }
      if (!data) return res(502, { error: "Failed to fetch from Clash.gg API." });

      // Period and prizes come from Clash, because that is what Clash is actually
      // running and paying. A prize ladder set on the WenBot board still wins, so
      // a streamer topping the pot up out of their own pocket can say so.
      const own    = Array.isArray(board.prizes) && board.prizes.length ? board.prizes : null;
      const prizes = own || data.prizes || [];
      const prizeFor = (rank) => (Number(prizes[rank - 1]) > 0 ? Number(prizes[rank - 1]) : 0);

      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider] || "Clash.gg",
        period: { active: data.status === "LIVE", startAt: data.startAt, endAt: data.endAt },
        raceName: data.name || null,
        rankings: data.rankings.map((r) => ({
          rank: r.rank, username: r.username, wagered: r.wagered,
          avatarUrl: r.avatarUrl, prize: prizeFor(r.rank),
        })),
        totalWagered: data.totalWagered,
        totalUsers:   data.totalUsers,
      });
    }

    // Winovo: one keyed endpoint returning every referred player's CUMULATIVE
    // wager (no date range exists), so the period is expressed the Gambulls way
    // — applyPeriod subtracts the baseline taken when the race started. Winovo's
    // own /api/creator/clear would also "reset" the board, but it zeroes the
    // casino's numbers for everyone irreversibly, so WenBot never calls it.
    if (provider === "winovo") {
      const provDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("winovo").get();
      let apiKey = provDoc.exists ? (provDoc.data().apiKey || "") : "";
      if (!apiKey) {
        // Only the PRIMARY casino is guaranteed a providers/ doc; an extra board
        // keeps its key on the board document (that is what the editor writes).
        const bSnap = await db.collection("streamers").doc(streamerDoc.id).collection("leaderboards").get();
        const board = sortBoards(bSnap.docs.map((d) => normalizeBoard(d.data(), d.id)))
          .find((b) => b.provider === "winovo");
        apiKey = (board && board.credential && (board.credential.apiKey || board.credential.refCode)) || "";
      }
      if (!apiKey) return res(400, { error: "Streamer hasn't configured their Winovo API key yet." });

      const cacheRef = db.collection("_cache").doc(`lb_${channel.toLowerCase()}_winovo`);
      let data = null, cached = null;
      try {
        const doc = await cacheRef.get();
        if (doc.exists) {
          cached = doc.data();
          if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < LB_CACHE_TTL_MS) data = cached.data;
        }
      } catch { /* fall through to a live fetch */ }

      // Serving a stale copy is right for a VIEWER — a board that keeps showing
      // last-known standings beats one that goes blank. It is wrong for the
      // scheduler, which re-baselines from this response: baselining off an old
      // snapshot silently moves wager from the race that just ended into the next
      // one. So the staleness is reported rather than hidden, and the caller
      // decides. Without this the response is a 200 that looks perfectly fresh.
      let servedStale = false;
      if (!data) {
        data = await fetchWinovoBoard(apiKey);
        if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
        else if (cached?.data) { data = cached.data; servedStale = true; }
      }
      if (!data) return res(502, { error: "Failed to fetch from Winovo." });

      // raw=1 returns the unbaselined totals (the wager raffle applies its own).
      const raw = event.queryStringParameters?.raw === "1";
      const out = raw ? data : applyPeriod(data, period);
      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider] || "Winovo", period,
        rankings: out.rankings, totalWagered: out.totalWagered, totalUsers: out.totalUsers,
        // Only present when the live call failed and this is a cached copy.
        ...(servedStale ? { stale: true, cachedAt: cached?.cachedAt || null } : {}),
      });
    }

    // Gamba: an unofficial public race API (no key/login). The race id is in the
    // streamer's leaderboard URL and is not a secret, so it lives on the board doc
    // like a referral code rather than in providers/. The race owns its window and
    // prize ladder, so — like Degen/Clash — there are no baselines or carryover.
    if (provider === "gamba") {
      const bSnap = await db.collection("streamers").doc(streamerDoc.id).collection("leaderboards").get();
      const board = sortBoards(bSnap.docs.map((d) => normalizeBoard(d.data(), d.id)))
        .find((b) => b.provider === "gamba");
      // The race id can arrive on the board credential (what the board editor
      // writes) or in providers/gamba, and either a bare id or the full URL.
      const provDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("gamba").get();
      const raceId = (board && board.credential && (board.credential.refCode || board.credential.raceId || board.credential.leaderboardId))
        || (provDoc.exists ? (provDoc.data().referralCode || provDoc.data().raceId) : null);
      if (!raceId) return res(400, { error: "Streamer hasn't set up their Gamba race link yet." });

      // One document per channel; the race identifies itself. Long TTL (see const).
      const cacheRef = db.collection("_cache").doc(`lb_${channel.toLowerCase()}_gamba`);
      let data = null, cached = null;
      try {
        const doc = await cacheRef.get();
        if (doc.exists) {
          cached = doc.data();
          if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < GAMBA_CACHE_TTL_MS) data = cached.data;
        }
      } catch { /* fall through to a live fetch */ }

      if (!data) {
        data = await fetchGambaRace(raceId);
        if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
        else if (cached?.data) data = cached.data;   // serve stale rather than blank the board
      }
      if (!data) return res(502, { error: "Failed to fetch from Gamba." });

      // Prizes come from the race, but a ladder set on the WenBot board still wins
      // so a streamer topping the pot from their own pocket can say so.
      const own    = Array.isArray(board?.prizes) && board.prizes.length ? board.prizes : null;
      const prizes = own || data.prizes || [];
      const prizeFor = (rank) => (Number(prizes[rank - 1]) > 0 ? Number(prizes[rank - 1]) : 0);

      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider] || "Gamba",
        period: { active: data.active, startAt: data.startAt, endAt: data.endAt },
        raceName: data.raceName || null,
        rankings: data.rankings.map((r) => ({
          rank: r.rank, username: r.username, wagered: r.wagered,
          avatarUrl: r.avatarUrl, prize: prizeFor(r.rank),
        })),
        totalWagered: data.totalWagered,
        totalUsers:   data.totalUsers,
      });
    }

    // ETHbet: one API key tied to a single pre-configured board (its own window
    // and prize ladder). One authenticated GET returns standings — no date params
    // — so, like Gamba, the board owns its window and there are no baselines or
    // carryover. Cached briefly per channel to respect ETHbet's per-IP rate limit.
    if (provider === "ethbet") {
      const bSnap = await db.collection("streamers").doc(streamerDoc.id).collection("leaderboards").get();
      const board = sortBoards(bSnap.docs.map((d) => normalizeBoard(d.data(), d.id)))
        .find((b) => b.provider === "ethbet");
      const provDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("ethbet").get();
      const apiKey = (provDoc.exists ? (provDoc.data().apiKey || "") : "")
        || (board && board.credential && board.credential.apiKey) || "";
      if (!apiKey) return res(400, { error: "Streamer hasn't configured their ETHbet API key yet." });

      // One document per channel; the key identifies the board. Live-board TTL.
      const cacheRef = db.collection("_cache").doc(`lb_${channel.toLowerCase()}_ethbet`);
      let data = null, cached = null;
      try {
        const doc = await cacheRef.get();
        if (doc.exists) {
          cached = doc.data();
          if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < LB_CACHE_TTL_MS) data = cached.data;
        }
      } catch { /* fall through to a live fetch */ }

      if (!data) {
        data = await fetchEthbetBoard(apiKey);
        if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
        else if (cached?.data) data = cached.data;   // serve stale rather than blank the board
      }
      if (!data) return res(502, { error: "Failed to fetch from ETHbet." });

      // A prize ladder set on the WenBot board still wins over the board's own.
      const own    = Array.isArray(board?.prizes) && board.prizes.length ? board.prizes : null;
      const prizes = own || data.prizes || [];
      const prizeFor = (rank) => (Number(prizes[rank - 1]) > 0 ? Number(prizes[rank - 1]) : 0);

      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider] || "ETHbet",
        period: { active: data.active, startAt: data.startAt, endAt: data.endAt },
        raceName: data.raceName || null,
        rankings: data.rankings.map((r) => ({
          rank: r.rank, username: r.username, wagered: r.wagered,
          avatarUrl: r.avatarUrl, prize: prizeFor(r.rank),
        })),
        totalWagered: data.totalWagered,
        totalUsers:   data.totalUsers,
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

    // Hype.bet (Affilka): key + arbitrary date range, same shape as Rainbet — the
    // range IS the period, so no baselines/carryover; only WenBot's manual
    // exclusions apply on top. Cached 6 min per channel+range to respect the
    // provider's 5-minute per-key cooldown.
    // ── Thrill ───────────────────────────────────────────────────────────────
    // Queried by date range, so the response already belongs to the race window —
    // no baselines or carryover, same shape as Rainbet and Hype.bet.
    //
    // Two things make it unlike the others. Its credential is a SESSION COOKIE the
    // streamer copies from their browser, so it expires and has to be replaced;
    // and Thrill caps calls at ONE EVERY TWO MINUTES, warning that going over gets
    // access revoked. The cache TTL below is therefore a hard floor, not a tuning
    // knob — lowering it risks the streamer's access, not just a slow page.
    if (provider === "thrill") {
      const { fetchThrillBoard, ThrillAuthError } = require("./_lib/thrill");
      // Board first (that is where the extra-board editor writes it), then
      // providers/ for a streamer running Thrill as their primary casino.
      let token = "";
      try {
        const bSnap = await db.collection("streamers").doc(streamerDoc.id).collection("leaderboards").get();
        const brd = sortBoards(bSnap.docs.map((d) => normalizeBoard(d.data(), d.id))).find((x) => x.provider === "thrill");
        token = (brd && brd.credential && (brd.credential.apiKey || brd.credential.token)) || "";
      } catch { /* fall through to providers/ */ }
      if (!token) {
        const pd = await db.collection("streamers").doc(streamerDoc.id).collection("providers").doc("thrill").get();
        token = pd.exists ? (pd.data().apiKey || pd.data().token || "") : "";
      }
      if (!token) return res(400, { error: "Streamer hasn't connected their Thrill account yet." });

      const win = (period && period.startAt && period.endAt)
        ? { from: period.startAt, to: period.endAt }
        : { from: Date.now() - 30 * 86400000, to: Date.now() };

      const cacheRef = db.collection("_cache")
        .doc(`lb_${channel.toLowerCase()}_thrill_${win.from}-${win.to}`);
      let data = null, cached = null;
      try {
        const doc = await cacheRef.get();
        if (doc.exists) {
          cached = doc.data();
          // 3 minutes, comfortably outside Thrill's 2-minute floor.
          if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < 3 * 60 * 1000) data = cached.data;
        }
      } catch { /* fall through to a live fetch */ }

      if (!data) {
        try {
          data = await fetchThrillBoard(token, win.from, win.to);
        } catch (e) {
          if (e instanceof ThrillAuthError || e.authFailed) {
            // Say what actually happened. "No data" would send the streamer
            // hunting a wager problem when the fix is to paste a new cookie.
            return res(401, { error: "Your Thrill session has expired — reconnect Thrill in your dashboard.", needsReconnect: true });
          }
          throw e;
        }
        if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
        else if (cached?.data) data = cached.data;   // serve stale rather than fail
      }
      if (!data) return res(502, { error: "Failed to fetch from Thrill." });

      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider] || "Thrill", period,
        rankings: data.rankings, totalWagered: data.totalWagered, totalUsers: data.totalUsers,
      });
    }

    if (provider === "hypebet") {
      const provDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("hypebet").get();
      const apiKey = provDoc.exists ? (provDoc.data().apiKey || "") : "";
      if (!apiKey) return res(400, { error: "Streamer hasn't configured their Hype.bet API key yet." });

      const fromParam = (event.queryStringParameters?.from || "").trim();
      const toParam   = (event.queryStringParameters?.to   || "").trim();
      const histRange = fromParam && toParam;

      const cacheRef = db.collection("_cache")
        .doc(`lb_${channel.toLowerCase()}_hypebet_${histRange ? `${fromParam}_${toParam}` : "live"}`);
      let data = null, cached = null;
      try {
        const doc = await cacheRef.get();
        if (doc.exists) {
          cached = doc.data();
          if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < HYPEBET_CACHE_TTL_MS) data = cached.data;
        }
      } catch { /* fall through to a live fetch */ }

      if (!data) {
        data = histRange
          ? await fetchHypebetRange(apiKey, fromParam, toParam)
          : await fetchHypebetForPeriod(apiKey, period);
        if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
        else if (cached?.data) data = cached.data;   // serve stale rather than fail
      }
      if (!data) return res(502, { error: "Failed to fetch from Hype.bet API." });

      if (histRange) {
        return res(200, {
          success: true, casino: provider, casinoName: CASINO_NAMES[provider], historical: true,
          period: { from: data.from, to: data.to },
          rankings: data.rankings, totalWagered: data.totalWagered, totalUsers: data.totalUsers,
        });
      }
      const out = event.queryStringParameters?.raw === "1" ? data : applyHypebetExclusions(data, period);
      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider], period,
        rankings: out.rankings, totalWagered: out.totalWagered, totalUsers: out.totalUsers,
        rangeFrom: data.from, rangeTo: data.to, casinoUpdatedAt: data.cacheUpdatedAt || null,
      });
    }

    if (provider === "duelbits") {
      const provDoc = await db.collection("streamers").doc(streamerDoc.id)
        .collection("providers").doc("duelbits").get();
      const cred = provDoc.exists ? provDoc.data() : {};
      if (!cred.affiliateId || !cred.password) {
        return res(400, { error: "Streamer hasn't configured their Duelbits API yet." });
      }

      // Explicit date range, used by the dashboard when it captures a start-day
      // baseline and by the past-period view. `to` is INCLUSIVE here, matching
      // every other provider, and translated on the way out because Duelbits'
      // own endDate is exclusive. Uncached: these are one-off lookups, not the
      // live board.
      const dFrom = (event.queryStringParameters?.from || "").trim();
      const dTo   = (event.queryStringParameters?.to   || "").trim();
      if (dFrom && dTo) {
        const ranged = await fetchDuelbits(cred.affiliateId, cred.password, dFrom, ymdNext(Date.parse(dTo + "T00:00:00Z")));
        if (!ranged) return res(502, { error: "Failed to fetch from Duelbits API." });
        return res(200, {
          success: true, casino: provider, casinoName: CASINO_NAMES[provider], period,
          rankings: ranged.rankings, totalWagered: ranged.totalWagered, totalUsers: ranged.totalUsers,
          weighted: true, totalVolume: ranged.totalVolume,
          casinoUpdatedAt: ranged.cacheUpdatedAt || null,
        });
      }

      // The live board. Cached per channel + period start.
      const cacheRef = db.collection("_cache").doc(`lb_${channel.toLowerCase()}_duelbits_${(period && period.startAt) || "cycle"}`);
      let data = null, cached = null;
      try {
        const doc = await cacheRef.get();
        if (doc.exists) {
          cached = doc.data();
          if (cached.data && cached.cachedAt && (Date.now() - cached.cachedAt) < LB_CACHE_TTL_MS) data = cached.data;
        }
      } catch { /* fall through to a live fetch */ }

      if (!data) {
        data = await fetchDuelbitsForPeriod(cred.affiliateId, cred.password, period && period.active ? period : null);
        if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
        else if (cached?.data) data = cached.data;   // serve stale rather than fail
      }
      if (!data) return res(502, { error: "Failed to fetch from Duelbits API." });

      // Applied AFTER the cache read, never before the write, so what is stored
      // stays the raw casino response and a later change of baseline does not
      // need the cache busting.
      if (event.queryStringParameters?.raw !== "1") data = applyDuelbitsPeriod(data, period);

      return res(200, {
        success: true, casino: provider, casinoName: CASINO_NAMES[provider], period,
        rankings: data.rankings, totalWagered: data.totalWagered, totalUsers: data.totalUsers,
        // Flagged so the portal can label the column honestly: this board ranks
        // on weighted points, not raw volume, and the two disagree.
        weighted: true, totalVolume: data.totalVolume,
        casinoUpdatedAt: data.cacheUpdatedAt || null,
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
