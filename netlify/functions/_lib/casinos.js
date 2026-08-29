// Shared casino metadata for Netlify functions.
// Browser-side has a separate copy at /js/casinos.js so it can be loaded
// via <script src>. WenBotServer (separate repo) maintains its own copy.

const CASINO_NAMES = {
  gambulls:   "Gambulls",
  degen:      "Degen",
  stake:      "Stake",
  rainbet:    "Rainbet",
  thrill:     "Thrill",
  winna:      "Winna",
  shuffle:    "Shuffle",
  duel:       "Duel",
  roobet:     "Roobet",
  bcgame:     "BC.Game",
  "500casino":"500 Casino",
  gamdom:     "Gamdom",
  // Live LEADERBOARD and race-based VERIFICATION (see _lib/gamba.js): no private
  // affiliate API, so under-code is decided by matching the viewer's name against
  // the public race, the same best-effort way as Degen/CSGOBig. In API_CASINOS.
  gamba:      "Gamba",
  duelbits:   "Duelbits",
  rollbit:    "Rollbit",
  chipsgg:    "Chips.gg",
  // Affilka affiliate-stats API (see _lib/hypebet.js): a POST to get-stats
  // returns every referred player's wager for a date range, so the live board
  // AND under-code verification both work. Real usernames + avatars, but the API
  // returns no user id, so matching is username-only (no masking). The datacenter
  // 403 that once kept this honour-system is gone — Lambda reaches it now (probed
  // Aug 2026). In API_CASINOS.
  hypebet:    "Hype.bet",
  // Creator-leaderboard API (github.com/winovo-io/Creator-Leaderboard-API):
  // one keyed endpoint returns every referred player with their cumulative
  // wager, so both the board and under-code verification work. In API_CASINOS.
  winovo:     "Winovo",
  // ETHbet streamer API (see _lib/ethbet.js): one API key tied to a single
  // pre-configured board. Like Gamba it has no full referral list — only the
  // board's standings — so under-code verification matches the viewer's name
  // against the board (best-effort, top players only). In API_CASINOS.
  ethbet:     "ETHbet",
  // Deliberately NOT in the browser copy (/js/casinos.js). That list populates the
  // dashboard's primary-casino picker, and CSGOBig is only supported as an
  // ADDITIONAL board (no verification or affiliate-matching flow behind it) — so
  // offering it there would let a streamer pick a provider half the app can't
  // serve. It lives here so leaderboard-live will accept casino=csgobig.
  csgobig:    "CSGOBig",
  // Same story as CSGOBig: supported as an ADDITIONAL board, so it stays out of
  // the browser copy that feeds the primary-casino picker. Its affiliate API can
  // answer "is this viewer under the code", so unlike CSGOBig it IS in
  // API_CASINOS below.
  clash:      "Clash.gg",
};

// Casinos whose affiliate API lookupAffiliate() can actually query, i.e. the ones
// where "is this viewer under the code" is answerable live rather than on the
// honour system.
//
// This lived as a private `const API_CASINOS` copy inside verify-affiliate,
// recheck-verified and link-verified. Duelbits was added to the lookup itself but
// to none of those three sets, so every Duelbits viewer fell through to the
// honour-system branch: verification never ran the check, told them they were not
// under the code, and saved them as Standard. Only the bulk "Re-check all"
// endpoint (which branches on the provider by hand) ever confirmed them, which is
// why an entire channel would flip green the moment someone pressed it.
//
// One copy, imported everywhere, so adding the next casino can't half-land.
// NOTE: portal-data.js keeps a separate local set of the same name — that one
// gates a hardcoded Gambulls board fetch, not affiliate lookups. Don't merge them.
//
// Clash.gg checks against detailed-summary/v2, which lists every referred user
// with recorded play, NOT the leaderboard endpoint (that one returns only a
// race's top players, so absence from it would say nothing about the code).
//
// Gamba is race-based: unlike the others it has no full referral list, only the
// current race's competitors, so its check is "is this name in the race" — the
// same best-effort match Degen/CSGOBig use. It's in this set (not a separate
// verify-affiliate branch like those two) because its logic lives inside
// lookupAffiliate, so every caller picks it up through the one dispatch.
const API_CASINOS = new Set(["gambulls", "rainbet", "duelbits", "clash", "gamba", "winovo", "hypebet", "ethbet"]);

// Of the API casinos, the ones whose "is this viewer under the code" answer comes
// from a LEADERBOARD rather than a referral list.
//
// Gamba and ETHbet expose no per-user endpoint and no full list of referred
// players — only the current board's standings, which is the top handful of
// wagerers. So a miss means "not among the ranked players", NOT "not under the
// code": someone genuinely under the code who hasn't wagered much simply isn't
// on the board.
//
// This distinction has to reach the UI. Reporting a board miss as "not confirmed
// under the code" reads as an accusation, and viewers push back on it — rightly,
// because they usually ARE under the code. Winovo and Hype.bet return every
// referred player, so for those a miss really does mean not under the code.
const BOARD_MATCHED_CASINOS = new Set(["gamba", "ethbet"]);

module.exports = { CASINO_NAMES, API_CASINOS, BOARD_MATCHED_CASINOS };
