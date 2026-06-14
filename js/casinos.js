// Shared casino metadata for browser pages.
// Loaded via <script src="/js/casinos.js"> — defines CASINO_NAMES as a global.
// Server-side has a separate copy at netlify/functions/_lib/casinos.js.

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
};

// How each casino's leaderboard is onboarded. Different casinos expose their
// affiliate data differently — most via an API key, Degen via a referral code.
// `field` is the providers/<casino> doc field the value saves to; the backend
// leaderboard fetchers read exactly that. Casinos NOT listed here have no
// leaderboard integration yet (the UI tells the streamer so).
const CASINO_CREDENTIALS = {
  gambulls: {
    field:       "apiKey",
    label:       "Gambulls Streamer API Key",
    placeholder: "sk_...",
    hint:        "Found in your Gambulls Streamer Dashboard → API Settings. Powers your live leaderboard.",
  },
  degen: {
    // Degen calls it a "streamer code"; we still store it under referralCode
    // (the backend Degen fetchers read that field).
    field:       "referralCode",
    label:       "Degen Streamer Code",
    placeholder: "e.g. meg",
    hint:        "Your Degen streamer code — this powers your race leaderboard.",
  },
};
