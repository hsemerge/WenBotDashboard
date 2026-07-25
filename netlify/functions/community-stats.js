// GET /api/community-stats
// The Community Pulse: site-wide WenBot numbers for the community page and
// homepage counters. The bot server maintains community/stats (rebuilt from
// streamer docs every ~15 min); this endpoint adds the static facts (casinos
// supported, widget count) and caches for 5 min per instance — so the whole
// world reading these numbers costs ~1 Firestore read per 5 minutes.

const { getDb } = require("./_lib/firebase");
const { res: _res } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

// Static platform facts (update when the product grows)
const CASINOS_SUPPORTED = 15; // the Active Platform list in Settings
const WIDGETS_OFFERED   = 12; // overlay pages: bankroll, deposits, withdrawals, giveaway, spinner, wheel, winner, chat, bonus hunt, slot requests, request spinner, tournament

let _cache = null, _cacheAt = 0;
const TTL_MS = 5 * 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  try {
    if (_cache && Date.now() - _cacheAt < TTL_MS) return res(200, _cache);
    const doc = await getDb().collection("community").doc("stats").get();
    const d = doc.exists ? doc.data() : {};
    _cache = {
      streamers:      d.streamers || 0,
      hoursStreamed:  d.hoursStreamed || 0,
      sessions:       d.sessions || 0,
      giveawaysRun:   d.giveawaysRun || 0,
      winnersDrawn:   d.winnersDrawn || 0,
      huntsRun:       d.huntsRun || 0,
      tournamentsRun: d.tournamentsRun || 0,
      gtbRun:         d.gtbRun || 0,
      commandsUsed:   d.commandsUsed || 0,
      winsShared:     d.winsShared || 0,
      casinosSupported: CASINOS_SUPPORTED,
      widgetsOffered:   WIDGETS_OFFERED,
      updatedAt:      d.updatedAt || null,
    };
    _cacheAt = Date.now();
    return res(200, _cache);
  } catch (err) {
    console.error("[community-stats]", err.message);
    return res(500, { error: "Failed to load stats" });
  }
};
