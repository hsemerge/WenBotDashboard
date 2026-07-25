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
    const db = getDb();
    const [doc, winsSnap] = await Promise.all([
      db.collection("community").doc("stats").get(),
      // Recent Big Wins for the public community page — display fields only.
      db.collection("community").doc("wins").collection("posts")
        .orderBy("ts", "desc").limit(6).get().catch(() => null),
    ]);
    const d = doc.exists ? doc.data() : {};
    const recentWins = [];
    if (winsSnap) winsSnap.forEach((w) => {
      const x = w.data();
      recentWins.push({
        name: x.name || x.channel || "creator", channel: x.channel || "",
        avatarUrl: x.avatarUrl || null,
        slot: x.slot || "", amount: x.amount || "", multi: x.multi || "",
        ts: x.ts && x.ts.toMillis ? x.ts.toMillis() : (Number(x.ts) || null),
      });
    });
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
      recentWins,
      updatedAt:      d.updatedAt || null,
    };
    _cacheAt = Date.now();
    return res(200, _cache);
  } catch (err) {
    console.error("[community-stats]", err.message);
    return res(500, { error: "Failed to load stats" });
  }
};
