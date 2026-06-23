// WenBot Companion — shared config.
// Loaded as a classic script in every context (service worker via importScripts,
// content script via manifest order, popup via <script src>). It must not use
// ES-module syntax. It publishes WENBOT_CONFIG onto whatever global exists.
(function (root) {
  const WENBOT_CONFIG = {
    // WenBot API + assets (the live site).
    API_BASE:  "https://wenbot.gg/api",
    SLOTS_URL: "https://wenbot.gg/data/slots.json",
    // Where the streamer gets their pairing code (opened from the popup).
    CONNECT_URL: "https://wenbot.gg/extension-connect.html",

    // How often the HUD re-polls the live hunt (ms).
    POLL_MS: 15000,
    // slots.json is large + static — cache it this long (ms).
    SLOTS_TTL_MS: 24 * 60 * 60 * 1000,

    // Supported casinos. `match` is the manifest content-script match; `detect`
    // is a best-effort list of CSS selectors whose text is the current game's
    // title (first hit wins). Detection only ever READS the title — never the
    // account, balance, or bet controls. If detection misses, the streamer just
    // picks the game from the autocomplete; nothing breaks.
    SITES: [
      { key: "stake",   host: /(^|\.)stake\.(com|us|bet|games)$/, detect: ['[data-testid="game-title"]', ".game-title", 'h1[class*="title"]'] },
      { key: "shuffle", host: /(^|\.)shuffle\.com$/,             detect: ['[class*="GameTitle"]', "h1"] },
      { key: "roobet",  host: /(^|\.)roobet\.com$/,              detect: ['[class*="gameTitle"]', "h1"] },
      { key: "rainbet", host: /(^|\.)rainbet\.com$/,             detect: ['[class*="title"]', "h1"] },
      { key: "gamdom",  host: /(^|\.)gamdom\.com$/,              detect: ['[class*="game-name"]', "h1"] },
      { key: "razed",   host: /(^|\.)razed\.com$/,               detect: ['[class*="title"]', "h1"] },
      { key: "chips",   host: /(^|\.)chips\.gg$/,                detect: ['[class*="title"]', "h1"] },
      { key: "degen",   host: /(^|\.)degen\.com$/,               detect: ['[class*="title"]', "h1"] },
      { key: "thrill",  host: /(^|\.)thrill\.com$/,              detect: ['[class*="title"]', "h1"] },
    ],
  };

  root.WENBOT_CONFIG = WENBOT_CONFIG;
})(typeof self !== "undefined" ? self : this);
