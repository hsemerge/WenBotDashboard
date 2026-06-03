# Security TODO — deferred hardening (#2 and #4)

These two audit findings were intentionally deferred because each is a **coordinated,
multi-part change** that can break existing behavior if not done in lockstep. Do them
one at a time, test, then deploy. (The rest of the audit — #1 Discord-link, the
bespoke-domain routing leak, #3 caching, #5 rate limits, #6 constant-time compares,
#7 overlay escaping — are DONE and deployed.)

---

## #2 — Gate the `internal=1` / `raw=1` flags on `/api/leaderboard-live`

**Problem:** Anyone can append `?internal=1` to bypass the `leaderboardEnabled` privacy
gate, and `?raw=1` returns unbaselined totals + provider user IDs. The flags are
unauthenticated.

**Why it's deferred (blast radius — 6 callers, two repos):**
- `dashboard.html` (client) — 4 calls: live-LB view, "Start leaderboard period"
  baseline capture, wager-raffle baselines. Clients **cannot** hold a shared secret.
- `WenBotServer` (server) — the `/lb` Discord command + the scheduler's
  carryover/finalize/re-baseline. These **can** hold a secret env var.

**Safe implementation:**
1. Add env `INTERNAL_API_SECRET` on **both** Netlify and Railway.
2. In `leaderboard-live.js`, allow `internal`/`raw` only if EITHER:
   - header `x-internal-secret` matches `INTERNAL_API_SECRET` (server callers), OR
   - a valid Firebase ID token whose uid is owner/mod of that channel (dashboard).
   (During rollout, keep accepting requests if the env isn't set yet, so nothing
   breaks before the env + callers are updated — then tighten.)
3. Update `WenBotServer` (`leaderboard-scheduler.js`, `discord-webhook.js`) to send
   `x-internal-secret`.
4. Update the 4 `dashboard.html` calls to send `Authorization: Bearer <firebase token>`.
5. **Deploy order:** WenBotServer (sending the secret) + dashboard first, then tighten
   the function.
6. **Test:** scheduler carryover + period finalize, `/lb`, dashboard "start leaderboard
   period", wager-raffle baselines, and the public leaderboard page.

---

## #4 — Make the casino `apiKey` server-only (not client-readable / mod-readable)

**Problem:** `dashboard.html` reads `providers.apiKey` to pre-fill the Settings field,
and the Firestore catch-all lets owner **and delegated mods** read the `providers`
subcollection. So the key sits in the browser DOM, is readable by mods, and is
exfiltratable via any dashboard XSS. (Limited blast radius — it's a read-only casino
leaderboard key — but still a credential.)

**Server readers are unaffected** (leaderboard-live, portal-data, recheck-verified,
verify-affiliate, WenBotServer all use the admin SDK).

**Safe implementation (lockstep):**
1. New authed function `set-provider-key` (Firebase token → writes
   `providers/{provider}.apiKey` via admin SDK).
2. Firestore rules: add explicit `match /providers/{doc}` → `read: false, write: false`
   (server-only). Re-publish rules.
3. `dashboard.html`: stop pre-filling the key value; show "configured ✓ · ••••last4".
   Change save to call `set-provider-key` instead of a client Firestore write.
4. **Test:** save a new key, confirm leaderboard still loads (server reads it), confirm
   a mod can no longer read it, confirm the field no longer exposes the value.

---

_Generated during the 2026-06 security audit. #8 (public `/status`, viewer refresh
tokens in localStorage, referral fraud) was reviewed and accepted as-is._
