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
  // No affiliate API, so verification is honour-system: the viewer's name is
  // stored but never matched against a race. Deliberately NOT in API_CASINOS.
  gamba:      "Gamba",
  duelbits:   "Duelbits",
  rollbit:    "Rollbit",
  chipsgg:    "Chips.gg",
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
const API_CASINOS = new Set(["gambulls", "rainbet", "duelbits", "clash"]);

module.exports = { CASINO_NAMES, API_CASINOS };
