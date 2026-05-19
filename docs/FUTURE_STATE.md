# WenBot — Deferred Work & Future State

Items intentionally deferred from the security/architecture reviews (May 2026).
Each has a trigger ("do this when…") so we know when to revisit.

Last updated: 2026-05-18

---

## 🟡 Security hardening — defer until needed

### Encryption at rest for Kick OAuth tokens
**Current state**: Streamer's `kickAccessToken` / `kickRefreshToken` are stored in plain
text under `streamers/{uid}` in Firestore. Firestore rules restrict reads to the owner
only, AND tokens never enter the browser (server-side OAuth finalize). Blast radius
is "compromised Firebase account" rather than "anyone with API key."

**What full mitigation looks like**:
- Add an `ENCRYPTION_KEY` env var (32-byte random)
- Encrypt tokens with AES-256-GCM before writing
- Helper module `_lib/crypto.js` with `encrypt(plain)` / `decrypt(cipher)`
- WenBotServer also needs the key (it reads streamer tokens to make Kick API calls)

**Trigger**: Major customer demands it, compliance audit, or a serious phishing campaign
targeting WenBot streamer accounts.

**Effort**: ~2 hours.

---

### HMAC between WenBotServer and Netlify functions
**Current state**: Not needed — WenBotServer doesn't call any Netlify functions.
Audit confirmed only Kick/Discord APIs and direct admin SDK Firestore writes.

**Trigger**: If we ever add a bot → Netlify call (e.g., for sending email or queueing
heavy work), introduce HMAC at that point. Shared secret `WENBOT_HMAC_SECRET`,
sign with `hmac.sha256(timestamp + body, secret)`, validate timestamp window of ±5min.

**Effort**: ~30 min when added.

---

### Per-tenant rate limiting
**Current state**: Rate limits are per-IP, not per-streamer. Streamers behind shared
NAT/proxy could theoretically share quota.

**Trigger**: When we hit a real abuse pattern OR offer enterprise SLAs that require
per-tenant guarantees.

**Effort**: ~1 hour. Change `checkRateLimit` key from `ip` to `uid` for authenticated
endpoints; keep per-IP for public ones.

---

## 🟡 Stability / quality — defer until pain

### Move `getChannelInfo` to official Kick API
**Current state**: Uses unofficial `kick.com/api/v2/channels/{slug}` for chatroom
lookup at bot startup. Now handles 429s and logs failures explicitly, but if Kick
breaks the unofficial endpoint, bot startup breaks too.

**What full mitigation looks like**:
- Use `api.kick.com/public/v1/channels?slug=...` with WenBot's own OAuth token
- Fall back to unofficial if no token
- Test that the official response has the chatroom_id we need

**Trigger**: When the unofficial endpoint returns 4xx/5xx persistently or Kick
announces deprecation.

**Effort**: ~1 hour (response shape verification + token handling).

---

### Dashboard.html splitting (6000+ lines)
**Current state**: All dashboard logic in one file. Hard to navigate, hard to test,
hard to onboard collaborators. Lots of global state and cross-function references.

**What a split looks like**:
- `js/dashboard/giveaway.js`
- `js/dashboard/raffles.js`
- `js/dashboard/store.js`
- `js/dashboard/verified.js`
- `js/dashboard/gtb.js`
- `js/dashboard/bonus-hunt.js`
- `js/dashboard/bonus-battle.js`
- `js/dashboard/tournament.js`
- `js/dashboard/activity.js`
- `js/dashboard/settings.js`
- Load via `<script type="module">` (ES modules)
- Move shared state (`profile`, `userPlan`, listeners) to a central state module

**Trigger**: When we want to onboard another contributor, OR when bugs caused by
cross-feature interactions become common.

**Effort**: 4-6 hours. Should be done in a dedicated session with a test plan
("verify giveaway start/end, redemption fulfill, raffle draw, etc. still work").

---

### Automated test suite
**Current state**: Zero tests. For a SaaS handling Stripe + user data, this is the
biggest single quality gap.

**What's worth starting with**:
- **Framework**: Vitest (fast, modern, similar to Jest)
- **Coverage targets**: integration tests on the critical Netlify functions
  - `verify-affiliate.js` — both Kick OAuth and Discord-link flows
  - `stripe-webhook.js` — checkout.session.completed, subscription.deleted
  - `tournament-enter.js` — entry cost deduction, full bracket, already entered
  - `bb-vote.js` — vote with insufficient points, double vote, valid vote
  - `kick-streamer-finalize.js` — OAuth code exchange + Kick API response
- **Mocking**:
  - Firestore: use firebase-admin emulator OR mock the admin SDK
  - Kick API: mock fetch
  - Stripe: mock signature verification + event payloads
- **CI**: GitHub Actions on every push/PR

**Trigger**: After the next "regression caught only in production" incident, OR
when we want confidence to refactor `dashboard.html` (Item above).

**Effort**: 2-3 hours for meaningful starter coverage.

---

### Verify card mobile overflow
**Current state**: `verify.html` card is `max-width: 460px`. Success state with
Discord block hasn't been confirmed to overflow but I flagged it as speculative.

**Trigger**: Actual mobile user reports it broken.

**Effort**: 5 min CSS tweak.

---

## 🟡 Architecture — scale-driven

### Sharded multi-process scaling (Model A → Sharded Model A)
**Current state**: One Railway service runs ALL streamer bots in one Node.js
process. Logical isolation per streamer (each StreamerBot instance) but not
process isolation — a memory leak or unhandled exception in one streamer's
code takes everyone down.

**What sharding looks like**:
- Each Railway service is a "shard" running current bot-manager.js code
- A shard-router (e.g., hash streamer UID mod N) determines which shard owns
  which streamer
- New env var `SHARD_ID=hobby-1` or `SHARD_FILTER=plan=elite`
- bot-manager startup query filtered to assigned streamers only
- No code changes to StreamerBot itself — orchestration-only

**Trigger** (any of):
- ~500+ active streamers (single process memory ceiling)
- Recurring chain-crash incidents where one streamer brings others down
- Elite-tier customers demand isolated SLAs
- Cost analysis shows shards cost ~same as savings from isolation

**Effort**: 1 full session. Migration must be done carefully — Pusher
connections need to drain cleanly before shard reassignment.

**Do NOT migrate to "one process per streamer"** — that's 5-20x the cost
for no real benefit over sharding. See `project_scaling_model.md` memory.

---

### Aggregated chat-earned points logging
**Current state**: Chat-message points earnings (e.g., +1 per message) are
intentionally NOT logged to `audit_logs`. With ~50 msgs/min/streamer, that's
~72k writes/day/streamer — far too noisy.

**What full coverage looks like**:
- Daily aggregate per viewer in `streamers/{uid}/points_earned_daily/{date}_{kickUser}`
- Single document per viewer per day, incremented as messages arrive
- Audit log retains only adjustment/redemption events (current behavior)

**Trigger**: When a streamer asks "where did X's points come from over the last
week?" and the answer needs to break down chat earnings.

**Effort**: ~30 min.

---

## 🔵 Operational / one-time setup (user-side tasks)

### Resend email integration
**Status**: Code is wired up. Submissions to the Agency form save to Firestore
always, but emails to `sales@logicplaystudios.com` only send if `RESEND_API_KEY`
is set in Netlify env vars.

**Setup steps**:
1. Sign up at resend.com (free tier: 3,000 emails/month)
2. Verify the `wenbot.gg` domain in Resend (adds SPF/DKIM DNS records)
3. Add `RESEND_API_KEY` to Netlify environment variables

**Trigger**: Before public launch / before sales team relies on automatic notifications.

---

### Firestore TTL policy on `bot_locks`
**Status**: Optional belt-and-suspenders for the existing in-code setTimeout
cleanup. Without TTL, locks created by instances that later crash never get
cleaned up.

**Setup steps**: Firebase Console → Firestore → Indexes → TTL → Create policy
→ Collection group: `bot_locks`, Field: `expiresAt`.

**Trigger**: Optional. Do it if you notice old `bot_locks` accumulating.

---

### Customize Firebase Auth email template
**Status**: Default verification email is sent from `noreply@<project>.firebaseapp.com`
with generic copy. Higher chance of landing in spam.

**Setup steps**: Firebase Console → Authentication → Templates → Email address
verification → customize subject, body, sender name. Optionally configure custom
sending domain (adds DNS records).

**Trigger**: Before scaling user acquisition (lower friction during signup).

---

### Firebase service account credential rotation
**Status**: See `project_credential_management.md` memory. Rotate at minimum
once a year, immediately on team changes.

**Procedure**:
1. Firebase Console → Project Settings → Service Accounts → Generate new private key
2. Update `FIREBASE_SERVICE_ACCOUNT_BASE64` in Railway (base64-encode the JSON)
3. Update `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`
   in Netlify (extracted from the JSON)
4. Deploy both, verify healthy
5. Delete the old key in Firebase Console

---

## ✅ Reference: items that were proposed but explicitly declined

- **One process per streamer** (Model B) — too expensive (5-20x). See sharded model above.
- **Token approach for verify** (per-user one-time tokens) — superseded by universal
  link + Kick OAuth. Original token logic preserved in git history if ever needed.
- **HMAC bot-to-Netlify** — not needed; bot doesn't call Netlify. Add only if that
  architecture changes.

---

## How to use this document

- When user asks about a deferred item, check the "Trigger" line to know whether
  it's time to do it
- After completing a deferred item, **remove it from this doc** and reflect the
  change in the relevant memory file
- Add new deferrals here as they come up rather than letting them disappear
