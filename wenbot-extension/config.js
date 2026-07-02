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

    // Supported casinos.
    //  detect    — CSS selectors whose text is the current game's title (first hit
    //              wins). Read-only; never touches account/balance/bet controls.
    //  anchorSel — the stable element the docked panel is inserted AFTER, so it sits
    //              embedded right below the slot (bonushunt.gg-style). Prefer
    //              data-testid/id over hashed classes so it survives redesigns.
    //  gameSel   — the game iframe/canvas, used only to measure position when FLOATING.
    // A site with no anchorSel simply floats (the panel still works everywhere).
    SITES: [
      { key: "stake",   host: /(^|\.)stake\.(com|us|bet|games)$/,
        anchorSel: '[data-testid="game-active"]',
        gameSel:   '[data-testid="game-active"] iframe, [data-testid="game-active"] canvas',
        detect: ['[class*="game-meta"] h1', '[class*="title-wrap"] h1', '[data-testid="game-title"]', 'h1[class*="ds-heading"]'] },
      { key: "shuffle", host: /(^|\.)shuffle\.com$/,             detect: ['[class*="GameTitle"]', "h1"] },
      { key: "gambulls", host: /(^|\.)gambulls\.com$/,
        anchorSel: '.responsive-container',
        gameSel:   '.responsive-container iframe, .responsive-container canvas',
        detect: ['h1.font-bold', '[class*="game-title"]', 'main h1', 'h1'] },
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
