# WenBot — Deferred Work & Future State

Items intentionally deferred from the security/architecture reviews (May 2026).
Each has a trigger ("do this when…") so we know when to revisit.

Last updated: 2026-07-30

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

### ~~Move `getChannelInfo` to official Kick API~~ — RESOLVED DIFFERENTLY (Jul 30 2026)
The official API **does not expose a chatroom id at all** (verified against
`/public/v1/channels` with both an app token and the broadcaster's own user token
— no `chatroom` field in any response), so this migration was impossible as
written. The unofficial endpoint is now hard-403 from every datacenter IP, which
broke first connect for every new signup.

Shipped instead: **webhook chat mode**. When the chatroom resolve fails but
`kickUserId` is known, the bot subscribes to the official `chat.message.sent`
event, which is keyed on `broadcaster_user_id` and needs no chatroom id.
Pusher-mode bots are untouched. See `streamer-bot.js` (`chatMode`) and
`kick-events.js`. Remaining exposure is that Pusher itself is unofficial — see
the full migration item below.

---

### ~~Follow-date backfill for `!followage`~~ — UN-TABLED AND SHIPPED (Jul 30 2026)
Reinstated the same day it was tabled, on a better architecture. **Netlify's EDGE
runtime (Deno) is not blocked by Kick's WAF** — Lambda and Railway both 403, edge
returns 200. So the backfill is now ordinary server-side work: `follow-backfill`
resolves each viewer through our own `/api/kick-user` **edge** function instead of
having the streamer's browser call Kick. The browser only sends usernames and gets
counts, so client-supplied dates (and the forgery caveat) are gone.

**Hard-won rule: anything touching `kick.com/api/v2` MUST be a Netlify edge
function.** `netlify/functions/kick-user.js` was a Lambda, silently started 403ing
when Kick began blocking datacenter IPs, and sat orphaned with zero callers while
the dashboard's viewer profile card quietly did nothing. Don't move it back.

The ToS reasoning below is kept because it still applies — it's the same v2
surface either way, and the decision to proceed was a judgement call, not a
finding that the concern evaporated. Note the correction on "Program Materials".

<details><summary>Original tabling rationale (kept for the record)</summary>
**Current state**: `!followage` works but is thin. It can only see follows that
happened *after* WenBot joined a channel, because the official `channel.followed`
webhook is forward-only with no history. This is a permanent ceiling, not a
warm-up: every newly onboarded streamer starts from zero followage forever.

**What was built and then parked**: branch `followage-backfill` in BOTH repos
(GiveawayBot `9323ba3`, WenBotServer `8ffa32f`). Complete and tested — a
dashboard button that fetches `following_since` from
`kick.com/api/v2/channels/{channel}/users/{username}` **in the streamer's own
browser** (that endpoint is 403 from datacenter IPs but fine from residential,
needs no auth, isn't rate limited, and reflects CORS for `https://wenbot.gg` —
all verified directly), then posts results to `/api/follow-backfill`.

**Why it's tabled**: the Kick Developer Agreement (dev.kick.com/terms-of-service)
says *"you will not access undocumented Program Materials … without Kick's prior
written permission"* and prohibits circumventing "controls that limit use", with
a stated penalty of permanent API suspension at Kick's sole discretion. WenBot's
whole product depends on that API access, so the risk/reward on a vanity stat is
bad. Kick also closed issue #389 (which asked for exactly this data officially)
on 2026-07-29 with *"This will not be done."*

**Trigger to revisit — any ONE of**:
1. Kick grants written permission for the v2 read (the agreement contemplates
   this; ask via dev Discord / developer platform team, NOT GitHub).
2. Issue #104 ships **with a `followed_at`/`following_since` timestamp** — note
   its current proposed schema is `{id, name}` only, which would NOT be enough.
   A follower LIST with timestamps solves backfill completely and is the shape
   Kick has actually roadmapped.
3. Kick ships any per-user follow lookup (unlikely — that's the #389 shape).

**Useful pattern for the re-ask**: Kick keeps *list* endpoints alive (#104, #87
both open and "on our roadmap") and killed the *per-user profile lookup* (#389).
When #370 asked a per-user question they redirected it into #104 rather than
rejecting it. So ask for a field on the list, never for a per-user endpoint.

**Correction on the ToS reading**: "Program Materials" is defined in the agreement
as things "made available under this Agreement … pursuant to the program you
participate in" — i.e. defined by how you received it, not by who owns it.
`kick.com/api/v2` is the website's own backend and was never made available under
the developer program, so the "no accessing undocumented Program Materials" clause
probably does not reach it. Counter-argument: the phrase "undocumented Program
Materials" becomes near-meaningless under that narrow reading, which is weak
evidence the narrow reading is wrong. Genuinely unresolved from the text. The main
`kick.com/terms-of-service` (which would govern site use) could not be retrieved —
it 403s automated fetchers; read it in a browser if this ever matters.

**Also note**: edge working is probably a gap in Kick's bot classification, not a
sanctioned path. Keep usage to one-time backfills per channel. Continuous polling
of every viewer is what would ever get noticed.

</details>

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
