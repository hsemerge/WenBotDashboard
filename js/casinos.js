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
  gamba:      "Gamba",
  duelbits:   "Duelbits",
  rollbit:    "Rollbit",
  chipsgg:    "Chips.gg",
  hypebet:    "Hype.bet",
  // Display name only. The casino PICKER is hardcoded <option> markup, not built
  // from this map, so listing csgobig here cannot make it selectable as a primary
  // casino — it only stops second-board rows rendering as lowercase "csgobig".
  csgobig:    "CSGOBig",
  clash:      "Clash.gg",
};

// How each casino's leaderboard is onboarded. Different casinos expose their
// affiliate data differently — most via an API key, Degen via a referral code.
// `field` is the providers/<casino> doc field the value saves to; the backend
// leaderboard fetchers read exactly that. Casinos NOT listed here have no
// leaderboard integration yet (the UI tells the streamer so).
// Most casinos onboard with ONE secret. Duelbits needs two (an affiliate id
// that also forms part of the URL, plus a password), so `field2` is optional
// extra metadata rather than a second shape — everything that reads `field`
// keeps working untouched, and only the entry form checks for `field2`.
const CASINO_CREDENTIALS = {
  duelbits: {
    field:        "affiliateId",
    label:        "Duelbits Affiliate ID",
    placeholder:  "e.g. 0f8c1a2b-3d4e-5f60-7a89-bcdef0123456",
    hint:         "Both values come from your Duelbits affiliate manager. Your leaderboard ranks on Duelbits' weighted points, the same as your Duelbits page.",
    field2:       "password",
    label2:       "Duelbits API Password",
    placeholder2: "paste your API password",
  },
  rainbet: {
    field:       "apiKey",
    label:       "Rainbet Affiliate API Key",
    placeholder: "e.g. Md93...",
    hint:        "From your Rainbet affiliate dashboard (API access). Powers your live leaderboard, verification and wager giveaways.",
  },
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
  gamba: {
    // The race is public and keyless — the "credential" is just the race's page
    // link (or its id). Stored under referralCode like Degen; the backend Gamba
    // fetcher pulls the number out of whatever's saved, URL or bare id.
    field:       "referralCode",
    label:       "Gamba Race Link or ID",
    placeholder: "https://gamba.com/promotions/exclusive-leaderboards/…",
    hint:        "Paste your Gamba exclusive-leaderboard link (or just its number). The race is public, so no API key is needed.",
  },
};
