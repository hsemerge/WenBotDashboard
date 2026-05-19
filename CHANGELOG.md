# WenBot Changelog

All notable changes to WenBot will be documented here.
Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — breaking changes to data shape, API contracts, or user flows
- **MINOR** — backward-compatible new features
- **PATCH** — backward-compatible bug fixes and small polish

When you bump the version, update both this file AND the `<span id="appVersionNumber">` in `dashboard.html`.

---

## [1.0.0] — 2026-05-19

First documented stable release. This consolidates a large security/architecture hardening pass and feature work into a single named milestone.

### Security

- **Firestore security rules** added to repo at [firestore.rules](firestore.rules) and deployed with strict per-subcollection scoping:
  - `verified_users`, `discord_links`, `bb_votes`, `bot_locks`, `audit_logs`, `bot_status` — server-only writes (admin SDK)
  - `viewers`, `store_redemptions` — controlled client writes
  - `system/*`, `discord_verify_tokens/*`, `_rate_limits/*`, `agency_inquiries/*` — admin-only
  - Billing fields (`plan`, `stripe*`) blocked from self-modification on both create and update
  - Kick OAuth fields (`kickUserId`, `kickAccessToken`, etc.) server-only
- **Email verification gates dashboard, setup, and Stripe checkout** (`firebase.auth().createUserWithEmailAndPassword` → verification email → poll until verified). New page: [verify-email.html](verify-email.html).
- **Discord linking vulnerability fixed** — Kick OAuth is now required for both Kick-chat and Discord verify flows. `kickUsername` always derived from Kick API, never accepted from the request body. Closes an actively exploitable vector for stealing points.
- **Server-side Kick OAuth finalize** — new `/api/kick-streamer-finalize` exchanges the auth code on the server and writes tokens via admin SDK. Kick access/refresh tokens never enter the browser for streamer connections.
- **kickChannel ownership enforced** — tied to authenticated `kickUserId`, server rejects mismatches, client field locked, rules block client writes. Prevents channel hijacking.
- **OAuth state hardening** — random nonce in URL + payload in localStorage (single-use). WenBot admin key no longer leaks into the OAuth URL/browser history.
- **CSP header** in `netlify.toml` restricts `script-src`/`connect-src`/`frame-src` to expected origins (Firebase, Kick, Discord).
- **Stripe signature length check + try/catch** prevents `timingSafeEqual` from throwing on malformed signatures.
- **Rate limiter fails CLOSED** on Firestore errors (was fail-open) — prevents abuse during Firestore slowdowns.
- **500 error responses sanitized** across all Netlify functions — `err.message` logged server-side, generic "Internal server error" returned to client.
- **Discord webhook is single-source** at Railway — Netlify-side `discord-interaction.js` and `discord-process-background.js` deleted as dead duplicates.
- **Agency form hardened** — HTML-escapes user input before email, validates email format, rate-limited (3/hr/IP), trims field lengths.
- **Dead/insecure endpoints removed**: `kick-send-message.js` (anonymous chat spam), `slot-request-add.js` (anonymous slot pollution), `resolve-verify-token.js` (dead since universal-link migration), `js/app.js` (legacy).

### Added

- **Activity Log** dashboard page (`📜 Activity Log` in sidebar) with 15+ action types, color-coded badges, filter by action, real-time updates. Captures verifications, store redemptions, fulfillments, points adjustments, raffles, BB votes, BB payouts, tournament entries, Kick connections, giveaway start/end, verified user removals, status updates.
- **`audit_logs` subcollection** at `streamers/{uid}/audit_logs/{auto}`. Server-only writes via `_lib/audit.js` helper. Client-driven actions logged via new `/api/log-action` endpoint with whitelist of allowed action names.
- **Bot health monitoring**:
  - WenBotServer writes heartbeat to `streamers/{uid}/bot_status/current` every 60s
  - Dashboard shows live status in three places: topbar pill (every page), sidebar bottom (every page), Overview stat card
  - Offline banner appears on Overview with concrete recovery steps when bot is offline >5min
  - `/status` endpoint on WenBotServer exposes Firestore connectivity, bot counts, and counters
- **GDPR-style data export** — Settings → "Download My Data" → JSON file with profile (minus tokens) + all subcollections. Rate-limited 5/hr/IP.
- **Verified Users improvements**:
  - "Under Code" badge made visually prominent (uppercase, checkmark, bold green border)
  - "Under Code only" filter checkbox
  - "↻ Re-check" button per row — re-runs affiliate lookup, updates status
  - "Last leaderboard sync: Nm ago" freshness line
  - Multi-leaderboard search (all_time + monthly) when looking up affiliate status
- **Real-time listeners** for Verified Users, Store Redemptions, Raffle History, and Bonus Hunt History — no more manual refresh required.
- **Unified `kick_viewer_session`** — single localStorage key shared across verify, bonus battle, and tournament pages. Viewers OAuth once, reused everywhere.
- **"Not you?" recovery link** on verify.html.
- **Auto-reconnect countdown** when session expires on verify.html.
- **Bot status `/status` endpoint** on WenBotServer with JSON health response.
- **Metrics** module (`src/metrics.js` on WenBotServer) with in-process counters: chat messages, commands processed, dedup hits, websocket reconnects.

### Changed

- **Verify flow uses a universal link** instead of per-user one-time tokens. `!verify` in Kick chat now posts a static link; identity is proven entirely via Kick OAuth on the verify page.
- **`bot-manager.js` restart logic** restricted to a whitelist of Kick-connection fields. Routine dashboard saves (giveaway settings, custom commands, store edits) no longer cause WebSocket reconnects.
- **WebSocket reconnect** uses exponential backoff with jitter (5s → 10s → 20s → 40s → 60s) instead of fixed 5s. Prevents thundering-herd reconnects during Pusher outages.
- **`bot_locks` self-cleanup** — locks now schedule their own deletion 5 minutes after creation, with `expiresAt` field for optional Firestore TTL policy.
- **Graceful shutdown** on SIGTERM/SIGINT — WenBotServer stops all bots in parallel + 2s drain before `process.exit(0)`. Cleanly closes WebSockets and drains in-flight Firestore writes during Railway deploys.
- **Per-streamer Firebase admin init** consolidated into shared `_lib/firebase.js`. Same pattern, less boilerplate.
- **Shared casino constants** at `netlify/functions/_lib/casinos.js` (server) and `js/casinos.js` (browser). Reduced 5 duplicated definitions to 3 (server, browser, WenBotServer separate repo).
- **`getChannelInfo` 429 handling** — explicit logging of rate limits instead of silent null return.
- **Pusher key** moved to `KICK_PUSHER_KEY` env var with public fallback default.
- **Kick OAuth redirect URI** standardized to `https://wenbot.gg/auth/kick/callback.html`. Fixes a cross-origin localStorage issue that was breaking the verify flow.
- **"Clear All" button removed** from Verified Users page — was too close to filter checkbox, accidental click risk.

### Fixed

- **Streamer self-entry blocked** from their own code giveaway (`!join` from the channel owner no longer counts).
- **SteezySol-style false negatives** — users not in the current monthly top 200 leaderboard were incorrectly marked as "Standard" instead of "Under Code". Multi-leaderboard search (all_time + monthly, limit 500) plus the new ↻ Re-check button fix this.
- **Verified users outside top-100 leaderboard** were silently blocked from code giveaways. Now allowed (leaderboard is for weighting only).
- **Stale package-lock.json** in WenBotServer was causing Railway `npm ci` to fail. Removed from git, added to `.gitignore`.
- **`bonus-hunt-data` fulfillment loop** — fulfilled redemptions no longer require manual page refresh to disappear.
- **Bot offline banner false-positive flash** on dashboard load — now shows neutral "Checking…" state until the heartbeat listener delivers actual data.

### Removed

- `netlify/functions/kick-send-message.js` — anonymous-callable chat spam endpoint.
- `netlify/functions/slot-request-add.js` — duplicated bot logic, anonymous abuse vector.
- `netlify/functions/resolve-verify-token.js` — dead since the verify flow moved to universal links.
- `netlify/functions/discord-interaction.js` and `discord-process-background.js` — superseded by WenBotServer/Railway-side handler.
- `js/app.js` — legacy dashboard code from before WenBotServer was split out.
- Stale Netlify redirect entries for the deleted functions.

---

## Versioning notes

When bumping versions:

1. **PATCH** (`1.0.x`): bug fixes, copy tweaks, single-file changes
2. **MINOR** (`1.x.0`): new features, new dashboard pages, new endpoints — no breaking changes
3. **MAJOR** (`x.0.0`): breaking changes to data shape, API contracts, viewer flows, OAuth scopes, or anything that requires user re-action

Update in two places:
- This file — add a new `## [X.Y.Z] — YYYY-MM-DD` section at the top with Security/Added/Changed/Fixed/Removed sections
- [dashboard.html](dashboard.html) — bump the `<span id="appVersionNumber">` text
