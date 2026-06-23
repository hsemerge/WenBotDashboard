# WenBot Companion (browser extension)

A Chrome/Edge extension that lets a streamer add bonus-hunt slots to **WenBot**
straight from their casino, with a live hunt HUD — without alt-tabbing to the
dashboard.

**Compliance:** the content script only *reads the game title* to pre-fill the
slot name. It never reads your balance/account, never touches bet controls, and
never automates anything. Everything sent to WenBot is confirmed by you.

---

## What it does

- **Live hunt HUD** — a draggable panel on the casino page showing your real WenBot
  hunt: bonus count, **break-even X**, and running P/L (polls `bonus-hunt-data`).
- **Add to Hunt** — type/confirm the slot (autocomplete from WenBot's 4,000+ slot
  catalog) + bet size → it's appended to your live hunt instantly (shows on your
  overlay, portal, and Guess-the-Balance).
- **Game auto-detect** — best-effort pre-fill of the slot you're on.

---

## Install (unpacked — for testing)

1. Open **`chrome://extensions`** (or **`edge://extensions`**).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** → select this **`wenbot-extension`** folder.
4. The **WenBot Companion** icon appears in the toolbar. Pin it.

> Edge is the same flow at `edge://extensions`. Works in any Chromium browser.

---

## Connect it

**Full mode (add bonuses):**
1. Click the toolbar icon → **Get a code** (opens `wenbot.gg/extension-connect.html`).
2. Sign in to WenBot if asked → copy the 6-character code.
3. Back in the popup, paste the code → **Connect**.

**Read-only mode (just the HUD):** enter your Kick channel in the popup → **Watch**.

---

## Test it

- Go to a supported casino (Stake, Shuffle, Roobet, Rainbet, Gamdom, Razed,
  Chips, Degen, Thrill) → the panel appears bottom-right (drag it anywhere; the
  "—" collapses it to a pill).
- Start a bonus hunt in your WenBot dashboard (set a start cost). The HUD should
  show it within ~15s.
- Type a slot, enter a bet, **Add to Hunt** → it appears in your dashboard hunt.

### What works before vs after the backend deploy
- **Reads (HUD, autocomplete, detection):** work immediately against `wenbot.gg`.
- **Pairing + Add to Hunt:** need the new functions deployed
  (`extension-pair-create`, `extension-pair`, `ext-bonus-hunt`) + the
  `extension-connect.html` page. Until then, use **Watch** (read-only) to demo.

---

## Add more casinos

Edit two files, then reload the extension:
- `manifest.json` → add the site to `content_scripts[0].matches`.
- `config.js` → add a `SITES` entry (`host` regex + best-effort `detect` selectors).

## Icons (optional)

No icons are bundled yet (Chrome shows a default). Drop `icon16.png`, `icon48.png`,
`icon128.png` into `icons/` and add an `"icons"` + `action.default_icon` block to
`manifest.json` when you want branding.

## Packaging for the Web Store (later)

`chrome://extensions` → **Pack extension** → select this folder → produces a
`.crx` + key. For public listing you'd zip the folder and upload to the Chrome
Web Store / Edge Add-ons dashboard (one-time dev account fee applies).
