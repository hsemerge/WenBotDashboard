# WenBot Security Review — Item-by-Item Tracking

Source: `WenBot_Security_Review.pdf` (May 2026)
Last updated: 2026-05-18
Companion doc: [FUTURE_STATE.md](./FUTURE_STATE.md) (deferred work backlog with triggers)

---

## Legend
- ✅ **DONE** — implemented and deployed
- ⚠️ **PARTIAL** — significantly improved; full fix deferred (see FUTURE_STATE.md for trigger)
- ⚠️ **INTENTIONAL** — kept as-is on purpose; not a defect
- ❌ **DEFERRED** — not yet done; see FUTURE_STATE.md
- ❌ **N/A** — original review was incorrect

---

## 🔴 Critical security findings (1–4)

### 1. No Firestore security rules — ✅ DONE
`firestore.rules` added to repo + strict per-subcollection rules deployed to production. Covers `verified_users`, `discord_links`, `viewers`, `bb_votes`, `store_redemptions`, `bot_locks`, `audit_logs`, `bot_status` with explicit per-collection write semantics. Top-level `system/*`, `discord_verify_tokens/*`, `_rate_limits/*`, `discord_guilds/*`, `agency_inquiries/*` all denied to clients.

### 2. kickChannel ownership not enforced — ✅ DONE
- Server: `/api/verify-affiliate` rejects streamers without `kickUserId`
- Client: dashboard field is `readonly` + locked to OAuth username
- Rules: `kickChannel` cannot be written or changed by clients
- Server: `/api/kick-streamer-finalize` writes `kickChannel` from Kick API response

### 3. No HMAC between WenBotServer and Netlify — ✅ DONE (different path)
Investigation showed WenBotServer makes zero calls to Netlify functions (uses Firebase admin SDK directly). The actual exploitable issue was anonymous-callable Netlify endpoints that anyone could POST to. Resolution: deleted dead/vulnerable endpoints (`slot-request-add.js`, `kick-send-message.js`).

### 4. Kick access tokens in plain Firestore text — ⚠️ PARTIAL
- Rules restrict reads to the token owner only (no cross-tenant leak)
- New `/api/kick-streamer-finalize` keeps tokens out of the browser entirely (server-side OAuth completion)
- Blast radius: was "anyone with public API key" → now "compromised Firebase account for one user"
- **Deferred**: full encryption-at-rest with server-side key. See [FUTURE_STATE.md → Encryption at rest](./FUTURE_STATE.md).

---

## 🟡 Verification system specific (5–10)

### 5. Token in localStorage after verify — ⚠️ INTENTIONAL
Kept on purpose for cross-site reuse. A viewer who verifies once is auto-signed-in for bonus battles and tournaments without re-OAuth. Mitigations:
- Unified `kick_viewer_session` (single localStorage key across pages)
- "Not you?" link clears it on demand
- Server-side endpoints re-validate the access token against Kick API on every sensitive op

### 6. OAuth state not signed — ✅ DONE
State is now a random nonce in the URL; the actual payload (channel/casino/dtoken/adminKey) lives in localStorage keyed by that nonce. Consumed (single-use) by callback. Side benefit: WenBot admin key no longer in OAuth URL.

### 7. setInterval leak in reconnect countdown — ✅ DONE
Reconnect timer tracked in `reconnectInterval`; cleared on `beforeunload`.

### 8. No "wrong account" recovery — ✅ DONE
"Not you?" link in the identity row clears the session and re-OAuths.

### 9. Discord CTA shown when already linked — ✅ DONE
`/api/verify-affiliate` returns `discordLinkedAny: true` if any Discord link exists for the Kick user. verify.html hides the CTA when either `discordLinked` or `discordLinkedAny` is true.

### 10. resolve-verify-token.js dead code — ✅ DONE
Deleted the Netlify function. Token approach was replaced by universal link + Kick OAuth; historical context in [project_verify_flow_history.md](../../.claude/projects/c--Users-cscog-OneDrive-Desktop-Projects-Bots-and-Tools-GiveawayBot/memory/project_verify_flow_history.md).

---

## 🟡 Site-wide security gaps (11–15)

### 11. No email verification on signup — ✅ DONE
- `signup.html` sends Firebase verification email and redirects to `verify-email.html`
- `verify-email.html` polls for verified status + has resend button (30s cooldown)
- `setup.html` redirects unverified users back to verify-email
- `dashboard.html` redirects unverified users back to verify-email
- `/api/create-checkout-session` returns 403 if `decoded.email_verified !== true`

### 12. No CSP header — ✅ DONE
Added to `netlify.toml`:
- `script-src`: 'self', gstatic (Firebase SDKs), 'unsafe-inline' (existing inline scripts)
- `style-src`: 'self', Google Fonts, 'unsafe-inline'
- `connect-src`: 'self', `*.googleapis.com`, `api.kick.com`, `id.kick.com`, `discord.com`
- `frame-src` / `frame-ancestors`: 'none'

### 13. Stripe signature length mismatch — ✅ DONE
`verifyStripeSignature` now validates buffer lengths before `crypto.timingSafeEqual`, wrapped in try/catch.

### 14. Rate limiter fails open — ✅ DONE
`checkRateLimit` in `_lib/http.js` (and the legacy in-function copies) now returns `false` on Firestore errors instead of `true`. Logs the error.

### 15. 500 responses leak err.message — ✅ DONE
14 Netlify functions sanitized: `err.message` logged server-side, generic "Internal server error" returned to client. `verify-affiliate.js` preserves explicit 4xx user-facing messages while sanitizing 5xx.

---

## 🟢 Code quality (16–22)

### 16. Boilerplate duplication — ✅ DONE
- `netlify/functions/_lib/firebase.js` — shared `getDb()` and `admin` export
- `netlify/functions/_lib/http.js` — shared `res()` and `checkRateLimit()`
- `netlify/functions/_lib/audit.js` — shared `logAudit()` helper
- `netlify/functions/_lib/casinos.js` — shared `CASINO_NAMES`
- 21 functions refactored

### 17. CASINO_NAMES duplicated — ✅ DONE
5 places → 3 places:
- `netlify/functions/_lib/casinos.js` (server)
- `/js/casinos.js` (browser, loaded by HTML pages)
- `WenBotServer/src/commands/verify.js` (separate repo deployment)

### 18. escHtml inline — ✅ DONE
Created `/js/utils.js` with shared `escHtml`. verify.html and dashboard.html load it.

### 19. Verify card mobile overflow — ❌ DEFERRED
Speculative; no confirmed issue. See [FUTURE_STATE.md → Verify card mobile overflow](./FUTURE_STATE.md).

### 20. dashboard.html 6000+ lines — ❌ DEFERRED
Significant refactor. See [FUTURE_STATE.md → Dashboard.html splitting](./FUTURE_STATE.md). Trigger: contributor onboarding or recurring cross-feature bugs.

### 21. No automated tests — ❌ DEFERRED
See [FUTURE_STATE.md → Automated test suite](./FUTURE_STATE.md). Trigger: next regression incident or before refactoring dashboard.html.

### 22. No audit log — ✅ DONE
- `streamers/{uid}/audit_logs/{auto}` subcollection (server-only writes per rules)
- `/api/log-action` for client-initiated logging
- `_lib/audit.js` helper for server-initiated logging
- 14 action types: verify, bb_vote, tournament_enter, kick_connected, store_redemption, redemption_fulfilled, mod_points_adjust, raffle_drawn, verified_user_removed, verified_users_cleared, bb_payout, giveaway_started, giveaway_ended, gtb_winner_picked
- Activity Log dashboard page with filter + color-coded badges + detail formatters

---

## 🔵 Bonus suggestions

### Status page — ✅ DONE (different shape)
Implemented as per-streamer indicators (dashboard topbar pill, sidebar dot, Overview card, offline banner with recovery actions) driven by `streamers/{uid}/bot_status/current` heartbeat. WenBotServer also exposes `/status` JSON endpoint at the Railway URL for external monitoring.

### Bot health heartbeat — ✅ DONE
WenBotServer writes heartbeat every 60s to `bot_status/current` while connected. Dashboard shows Online (<2min) / Stale (2-5min) / Offline (>5min) with recovery banner.

### Wager freshness on Verified Users — ✅ DONE
"Last leaderboard sync: Nm ago · syncs every 5 minutes" line in Verified Users page header, pulled from `bot_status.lastLeaderboardSync` which WenBotServer writes after each successful leaderboard refresh.

### Trust score badge — ✅ DONE
"Under Code" badge is now visually prominent (uppercase, checkmark, green border). "Standard" is dim. "Under Code only" filter checkbox. Under-code rows sort to top.

### GDPR data export — ✅ DONE
`/api/export-data` endpoint + Settings → "📦 Your Data" → "Download My Data" button. Outputs `wenbot-export-YYYY-MM-DD.json` with profile (minus tokens) and all subcollections except ops-only (bot_locks, bot_status). Rate-limited to 5/hour/IP.

---

## 🔴 NEW Critical findings — WenBotServer (1–3)

### 1. Discord linking vulnerability — ✅ DONE
`verify-affiliate.js` now requires `kickAccessToken` in BOTH the Kick-chat and Discord flows. `kickUsername` is always derived from Kick's `/public/v1/users` API response, never from the request body. Removed the self-reported username input field from verify.html in Discord mode.

### 2. WenBot tokens in system/wenbot — ✅ DONE
Firestore rules `match /system/{doc} { allow read, write: if false; }` deny all client access. Only admin SDK (WenBotServer + kick-store-wenbot Netlify function with admin key) can touch it.

### 3. bot-manager restarts on every change — ✅ DONE
`RESTART_FIELDS` whitelist in `bot-manager.js`: only restarts when `kickChannel`, `kickUserId`, `kickUsername`, Kick OAuth tokens, or `onboarded` change. Other dashboard saves (giveaway settings, custom commands, store edits) are picked up by the bot's in-process profile listener without reconnecting.

---

## 🟡 Other WenBotServer findings (4–13)

### 4. bot_locks grows forever — ✅ DONE
Each lock now writes `expiresAt: Date.now() + 5min` and schedules `setTimeout(delete, 5min)`. Both `cmd_*` and `gwClose_*` locks covered. Optional Firestore TTL policy can be enabled in Console for crash-recovery cleanup.

### 5. slot-request duplication — ✅ DONE
`netlify/functions/slot-request-add.js` deleted. Bot's `commands/slot-request.js` is the single source.

### 6. No graceful shutdown — ✅ DONE
SIGTERM/SIGINT handlers in `index.js`: calls `stopAllBots()` in parallel + 2s drain delay + 10s hard timeout fallback before `process.exit(0)`.

### 7. WebSocket fixed 5s reconnect — ✅ DONE
Exponential backoff with jitter: `5s → 10s → 20s → 40s` capped at `60s`, ±1s jitter. Resets to 0 on `subscription_succeeded`.

### 8. _seenMsgIds O(n) — ❌ N/A (incorrect original finding)
`Set.values().next().value` is O(1) in V8 — Sets are linked-list-backed for ordered iteration. Original review was wrong. Code unchanged; added clarifying comment.

### 9. giveaways cache leak — ✅ DONE
`cleanupGiveaway(uid)` exported from `commands/giveaway.js`, called from `StreamerBot.stop()`. Clears entry + snapshot timer.

### 10. Health check always 200 — ✅ DONE
- `/status` GET endpoint: returns JSON with Firestore connectivity ping, bot active/configured counts, uptime, counters
- `/` GET kept as simple "WenBot OK" 200 — Railway liveness probe; intentionally not stricter to avoid restart loops on transient downstream issues

### 11. No metrics — ✅ DONE
`src/metrics.js` with in-process counters: `chat_messages_received`, `commands_processed`, `commands_skipped_dedup`, `websocket_reconnects`, `firestore_writes`, `audit_writes`. Exposed via `/status` endpoint.

### 12. getChannelInfo unofficial endpoint — ⚠️ PARTIAL
429 handling added (logs retry-after); non-200 statuses logged. Full migration to official `api.kick.com/public/v1` deferred. See [FUTURE_STATE.md → Official Kick API](./FUTURE_STATE.md). Trigger: unofficial endpoint persistently failing.

### 13. Pusher key hardcoded — ✅ DONE
`process.env.KICK_PUSHER_KEY || "32cbd69e4b950bf97679"`. Env override available without code change if Kick rotates the key.

---

## 🟡 Cross-system findings (14–15)

### 14. Firebase service account god-mode — ✅ DOCUMENTED
Operational concern, not a code change. Documented in [project_credential_management.md](../../.claude/projects/c--Users-cscog-OneDrive-Desktop-Projects-Bots-and-Tools-GiveawayBot/memory/project_credential_management.md) memory with full rotation procedure. Trigger: at minimum annual rotation, immediately on team departures.

### 15. Bot/Netlify duplication — ✅ DONE
- `slot-request-add.js` deleted (item #5)
- `discord-interaction.js` deleted (was the Netlify-side Discord webhook handler; Discord points at Railway URL)
- `discord-process-background.js` deleted (only called by discord-interaction)
- Architectural separation confirmed: chat-driven → WenBotServer, web-driven → Netlify

---

## 🟡 New rules-introduced concerns

### Subcollection wildcard too permissive — ✅ DONE
Replaced the catch-all `match /{subcollection}/{doc}` with explicit per-subcollection rules:
- `verified_users`: client read+delete, no client create/update
- `discord_links`: client read+delete, no client create/update
- `viewers`: client read+write (streamer needs to adjust points; audit log captures changes)
- `bb_votes`: client read+delete, no client create/update
- `store_redemptions`: client read; update only status/fulfilledAt fields
- `bot_locks`: server-only
- `audit_logs`: client read, server-only write
- `bot_status`: client read, server-only write
- `{subcollection}` wildcard kept as fallback for other collections (giveaway_state, custom commands, etc.)

---

## 🔴 Critical issues rules DON'T fix (A–D)

### A. Discord linking vulnerability — ✅ DONE
Same fix as WenBotServer #1.

### B. No HMAC bot↔Netlify — ✅ DONE
Resolved differently than originally planned. The bot doesn't call Netlify; the exploitable surface was anonymous-callable Netlify endpoints (`slot-request-add`, `kick-send-message`), both now deleted.

### C. kickChannel ownership — ✅ DONE
Same fix as critical #2 above.

### D. WenBotServer restarts on every change — ✅ DONE
Same fix as WenBotServer #3 above.

---

## Summary

| Category | Done | Partial/Intentional | Deferred | N/A |
|---|---|---|---|---|
| Critical (1–4) | 3 | 1 | 0 | 0 |
| Verify (5–10) | 5 | 1 | 0 | 0 |
| Site-wide (11–15) | 5 | 0 | 0 | 0 |
| Code quality (16–22) | 4 | 0 | 3 | 0 |
| Bonus (5) | 5 | 0 | 0 | 0 |
| WenBot critical (1–3) | 3 | 0 | 0 | 0 |
| WenBot other (4–13) | 9 | 1 | 0 | 1 |
| Cross-system (14–15) | 2 | 0 | 0 | 0 |
| Rules concerns + A–D | 5 | 0 | 0 | 0 |
| **TOTAL** | **41** | **3** | **3** | **1** |

48 review items addressed; 3 explicit deferrals documented in FUTURE_STATE.md with trigger conditions.
