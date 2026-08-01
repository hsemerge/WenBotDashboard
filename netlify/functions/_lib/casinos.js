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
  duelbits:   "Duelbits",
  rollbit:    "Rollbit",
  chipsgg:    "Chips.gg",
  // Deliberately NOT in the browser copy (/js/casinos.js). That list populates the
  // dashboard's primary-casino picker, and CSGOBig is only supported as an
  // ADDITIONAL board (no verification or affiliate-matching flow behind it) — so
  // offering it there would let a streamer pick a provider half the app can't
  // serve. It lives here so leaderboard-live will accept casino=csgobig.
  csgobig:    "CSGOBig",
};

module.exports = { CASINO_NAMES };
