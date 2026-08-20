# WenBot — Backlog

Running backlog. Deferred items, oldest first. Re-read at the start of new
working sessions, and add to it rather than keeping things in your head.

Started 2026-05-29, last touched 2026-08-16.

---

## 1. Netlify usage alerter

**What:** Scheduled Netlify function that runs daily, calls Netlify's API for current account usage, and posts to a Discord webhook when any metric crosses 70% of the tier limit.

**Effort:** ~30 min

**Why:** Catches us before we hit overage on function invocations, edge invocations, or bandwidth. Avoids surprise bills as we scale.

**Implementation sketch:**

- New `netlify/functions/usage-watcher.js` with `export const config = { schedule: "@daily" }`.
- Calls `GET https://api.netlify.com/api/v1/accounts/{accountId}/usage` with `Authorization: Bearer ${NETLIFY_API_TOKEN}`.
- Thresholds configured per-metric (defaults: 70% / 90%).
- Posts to `DISCORD_USAGE_WEBHOOK` (separate from any existing notify webhooks).

**Prereqs:**

- `NETLIFY_API_TOKEN` (personal access token from User settings → OAuth applications)
- `DISCORD_USAGE_WEBHOOK` (Discord channel webhook URL)

---

## 2. Firestore-backed custom-domain self-serve

**Adding a domain by hand today means FOUR places, and missing one fails quietly:**

1. `HOST_TO_SLUG` + `SLUG_TO_PAGE` in `netlify/edge-functions/custom-domain.js`
2. The Netlify site's domain aliases (needed for the TLS certificate)
3. `ALLOWED_RETURN_HOSTS` in `netlify/functions/kick-session-mint.js` - miss this and the
   portal loads perfectly but Kick sign-in dead-ends on "returnOrigin not allowed"
4. DNS at the registrar

Caught on tiltbros.com 2026-08-17: 1, 2 and 4 were done and the site looked fine until a
viewer tried to sign in. Whatever replaces this should read one list.

**What:** Replace the hardcoded `HOST_TO_SLUG` map in `netlify/edge-functions/custom-domain.js` with a Firestore-backed lookup so streamers can register their own domain without a code change. Add a "Custom Domain" section to the dashboard Settings that walks them through it.

**Effort:** ~1 day

**Why:** Today, every new custom domain (SKSlots, future clients) requires editing the hardcoded map + a code push. Won't scale past ~5–10 clients.

**Implementation sketch:**

- New Firestore collection: `custom_domains/{host}` → `{ streamerSlug, streamerUid, verifyToken, verifiedAt, createdAt }`.
- Edge function reads from there on cache miss; in-memory cache with short TTL (~60s) so hot domains don't hit Firestore on every request.
- Dashboard UI:
  - Streamer enters their domain.
  - System generates a TXT record they add at their registrar (e.g. `wenbot-verify=abc123`).
  - "Verify" button polls DNS; once TXT confirmed, marks `verifiedAt` + activates the mapping.
- Walk them through DNS setup (matches what we did manually for SKSlots: A record + CNAME).

**Prereq for:** Cloudflare for SaaS migration (item 3).

---

## 3. Cloudflare for SaaS migration

**What:** Move the custom-domain edge layer from Netlify aliases to Cloudflare for SaaS. Port `custom-domain.js` logic to a Cloudflare Worker. Integrate Cloudflare's Custom Hostnames API so streamers' domains are registered programmatically (replacing the manual "add alias in Netlify" step).

**Effort:** ~1 day (assuming the Firestore-backed lookup from item 2 is already done)

**Why:** Netlify domain aliases don't scale economically past ~100 (Enterprise pricing kicks in). Cloudflare for SaaS is purpose-built for this exact pattern and costs ~$0.10/hostname dropping to $0.01 above 100 — far cheaper at scale.

**Trigger:** ~100 paying clients on custom domains. Below that, Netlify aliases are fine.

**What stays on Netlify:** Everything else. wenbot.gg itself, dashboard, portal.html, all 36+ functions, Firestore — none of that moves. Cloudflare just sits in front of streamers' branded domains and forwards to wenbot.gg as origin.

**Sketch:**

- Cloudflare Worker = current edge function logic + slug lookup.
- Streamers point their CNAME at `cf.wenbot.gg` (a Cloudflare-managed subdomain we own) instead of `wenbot.netlify.app`.
- Cloudflare API auto-registers each new hostname + provisions SSL via SNI.
- Worker calls Cloudflare KV (or our existing Firestore via fetch) for the host→slug map.

---

## 4. Rotate the Firebase service account key

**What:** Issue a new private key for `firebase-adminsdk-fbsvc@logictools`, update `FIREBASE_PRIVATE_KEY` everywhere, then delete the old key.

**Effort:** ~15 min

**Why:** Routine hygiene rather than a known compromise. This one key is admin access to the whole database, it has never been rotated, and on 2026-08-16 it was printed in plain text into a local terminal and session transcript while wiring up local dev. Contained to one machine, so not urgent, but it should not be the key that runs forever.

**Steps:**

- Google Cloud Console, IAM & Admin, Service Accounts, `firebase-adminsdk-fbsvc@logictools`.
- Keys, Add key, Create new key, JSON. Keep the download.
- `netlify env:set FIREBASE_PRIVATE_KEY` with the new value. **Pipe it, never pass it as a visible argument** - the CLI echoes the value back, which is exactly how it got printed in the first place.
- Update `C:\Users\cscog\.wenbot-secrets\wenbot-firebase.env` and `wenbot-service-account.json`.
- WenBotServer on Railway uses the same service account, so update it there too or the bot loses Firestore.
- Redeploy both, confirm the dashboard and the bot still read and write, then delete the old key in the console.

**Careful:** deleting the old key before both hosts are on the new one takes the whole product down. New key everywhere first, verify, then delete.

---

## 5. Local dev cannot reach Firestore

**What:** `netlify dev` starts without database credentials, so every function 500s locally on `Service account object must contain a string "private_key" property`.

**Effort:** ~30 min

**Why:** Blocks previewing anything that reads data (portals, dashboard) on localhost, which is how we avoid spending Netlify build credits on preview deploys.

**Cause (confirmed 2026-08-16):** Netlify only passes env vars to local functions when the name already exists in the *site* env, and it blanks values it treats as secret. `FIREBASE_PRIVATE_KEY` is marked secret, so it arrives empty and a `.env` override does not help. A long-running dev server had captured the real value before it was marked secret; restarting that server lost it for good.

**Options:**

- Add a non-secret `FIREBASE_SERVICE_ACCOUNT_B64` to the Netlify site env. `_lib/firebase.js` already accepts it (base64 or raw JSON, with the individual vars winning when present), so no other change is needed. Downside: the service account then sits in Netlify as a normal variable.
- Or run functions through a local harness that sets the env itself, and keep `netlify dev` for static serving only.

---

## Viewer renames orphan points - phases 2 and 3

**Phase 1 is DONE (19 Aug 2026):** every viewer write now stamps `kickUserId` on
the doc when chat has shown us the numeric id. Nothing reads it, nothing is
re-keyed, and it rides existing writes so it costs no extra Firestore writes.

**Why:** viewer records are keyed by lowercase Kick username
(`viewers/{name}`, `wenpoints/{name}`, `verified_users/{name}_{casino}`), so a
viewer who renames on Kick starts again at zero and the old balance is orphaned,
not deleted. Streamer renames are already handled (`previousChannels`); viewers
never were.

**Phase 2 - dual read.** Look a viewer up by `kickUserId`, fall back to the name.
Do NOT start until coverage is real: measure what fraction of active viewer docs
carry `kickUserId` first, because until then the id path is all cost and no
benefit, and a query per lookup adds reads (see the 17M-reads incident).

**Phase 3 - id canonical.** Only once coverage is high. A rename then becomes a
MERGE of two existing records, reviewed rather than automatic.

**Never** move or delete documents to re-key them. 3,400 viewer records and
15.4M channel points across 28 streamers; a bad migration is unrecoverable.

**Snapshot taken before any of this:**
`C:\Users\cscog\.wenbot-backups\points-snapshot-2026-08-19T13-56-13-612Z.json`
plus a copy in `gs://logictools.firebasestorage.app/backups/` - 3,400 records,
15,467,309 channel points, 1,090 WenPoints ledgers, 33,308 WP.

---

## 6. Clash.gg prize units - RESOLVED (18 Aug 2026)

**Answer:** every money figure on both Clash endpoints is in GEM CENTS, hundredths
of a gem. Verified field by field against Clash's own display of the same race:
`topPlayers[].wagered` 13008.006 -> 130.08, `rewards[].amount` 50000 -> 500.00,
summary `wagered` 562483 -> 5,624.83. All three now divide by 100 in
`netlify/functions/_lib/clash.js`, so what we show equals what Clash shows.

The gem icon on the portal was the right call: these are gems, not dollars, so
`BOARD_UNITS` needs no change.

---

## 7. Multi-casino verification

**Status:** working as of 2026-08-16. What is left is polish, not plumbing.

Viewers pick a casino with chips on `verify.html` when the streamer runs more than one board, and the progress card lists each additional board as an optional row. Records are stored per provider (`<kickKey>_<provider>`), so linking a second casino adds a record rather than replacing the first. Clash.gg is checked against `detailed-summary/v2`, which lists every referred user with recorded play.

**Still worth doing:**

- `!verify` / `/verify` could name the casinos on offer rather than sending a bare link.
- Per-casino Discord roles. `discordConfig.verify.roleId` is one role for the channel, so "Degen Verified" cannot differ from "Clash Verified".
- Someone who signed up under a code but has never wagered does not appear in any affiliate API (true of Rainbet and Clash alike), so they verify as not-under-code until they play. Worth a clearer message than the current one.
- The picker only lists casinos with an enabled board. A streamer who takes a board down loses the ability for viewers to verify against that casino, which may not be what "disable this board" should mean.

---

## 8. Wrong-Kick-account recovery (half built, parked)

**Status:** backend done and inert, UI not wired. Nothing calls it, so production is unaffected.

**The problem:** Kick's OAuth never asks which account to use, so a viewer with an alt signed in gets verified as the alt without ever choosing. "Not you?" clears our session and immediately re-asks Kick, which silently returns the same account, so there is no way to switch from our page. If they already verified a casino on the alt, re-verifying on their main hits "already linked to another Kick account, contact a mod" - the uniqueness rule that stops giveaway multi-accounting cannot tell an accident from abuse.

**Done, uncommitted and unreachable:**

- `_lib/discord-role.js` gains `revokeVerifiedRole()`.
- `netlify/functions/verify-unlink.js`: a viewer releases their OWN verification for one casino. Authorisation is possession of the Kick token, so there is no path to release anyone else's claim. Revokes the Discord role so nobody can walk one casino account through several Kick accounts collecting roles. Only drops the Discord link when it was their LAST verification for that streamer, because Meg's viewers hold several. Refused while a giveaway is running: entries are banked at join time and not re-checked at the draw, so a mid-round switch would put two entries from one casino account in the pool. Audit-logged.
- `netlify.toml` redirect for `/api/verify-unlink`.

**Left to do:**

- "Verifying as <kick name>" beside the submit button, so a wrong account is obvious before it is committed.
- Make "Not you?" work: send `prompt=login` ON THE SWITCH PATH ONLY (`initiateKickAuth` is shared with streamer and admin sign-in, do not change those), then compare the returned account with the rejected one and only explain the kick.com logout step when it demonstrably failed.
- An unlink button on the verify page, behind a confirmation: it revokes a Discord role and should not be one stray tap away on a phone.
- Reword the 409 to point at self-service without naming the other Kick account, which would leak which account owns a casino name.

**Related, not covered:** the draw should re-check that a winner is still verified. That closes the mid-giveaway hole properly and also covers a mod removing someone mid-round. Lives in WenBotServer.

---

## 9. Giveaway winners can go missing from portals

**What:** Two gaps between drawing a giveaway winner and that winner appearing on a portal.

**Effort:** ~1 hr

**Why:** A streamer who draws in chat gets an empty Giveaways section and no reason why.

- **Chat draws are never recorded.** `!winner` in WenBotServer removes the winner from the pool, blocks them from re-entering and bumps `communityStats.winnersDrawn`, but writes no `winners_log` entry. Only the dashboard draw calls `_writeWinnerLog({ type: 'giveaway', ... })`. The comment in giveaway.js states the split, so it looks deliberate, but it means chat-drawn winners exist nowhere a portal can read. Fix is in the bot: write the same record both paths write.
- **The portal's window is mixed-type.** portal-data reads the 30 newest `winners_log` docs of ANY type, then filters to giveaways in JS. A channel with a busy raffle can fill all 30 with raffle draws and silently show no giveaway winners. Ask for giveaways specifically instead.

**Not urgent for TiltBros:** confirmed 2026-08-16 that they will not use `!winner`, and their log is currently all raffle draws.

---

## 10. Storage rules let any streamer write anywhere

**What:** The catch-all in `storage.rules` is `match /{allPaths=**} { allow read, write: if request.auth != null; }`. Any signed-in streamer can write to any path in the bucket, including another streamer's folder.

**Effort:** ~1 hr, mostly auditing

**Why:** Nothing exploits it today and every write goes through the dashboard, which only ever builds paths under the signed-in uid. But the rule is the only thing standing between a modified client and someone else's artwork, and it is doing no work that a scoped rule would not do better.

**Why it is not already fixed:** scoping it needs every existing upload path audited first. `store-images/<uid>/...` and `bounty-images/<uid>/...` are known and safe to scope. `portal/...` is in use (3.5MB across the bucket) and its shape has not been traced. Tightening blindly would break uploads with a permission error that looks like a bug in the dashboard rather than a rules change.

**Note:** `bounty-images` already shows the target shape - owner-scoped, 5MB cap, `image/*` only. Copy that once the other prefixes are traced.

**Also:** these rules lived ONLY in the Firebase console until 2026-08-17. They are in the repo now (`storage.rules`, wired into `firebase.json`) and deploy with `firebase deploy --only storage`. The CLI has LogicTools access, so this no longer needs the console.

---

## Notes

- The hardcoded `HOST_TO_SLUG` in `netlify/edge-functions/custom-domain.js` currently has just `skslots.co.uk` + `www.skslots.co.uk` → `skslots`. New clients in the meantime: add an entry, push, done. But that's the workaround until item 2 lands.

- Watch the Netlify usage dashboard manually until item 1 is built. The big cost driver to watch first is **function invocations** (OBS overlay polling endpoints are the heaviest — `/api/overlay-data`, `/api/bb-state`, etc., polled every 1.5s by every active stream).

- **WenBotServer: honour Discord event routing for chat-driven GTB.** `discordConfig.routes` and the event catalogue now live in `netlify/functions/_lib/discord-events.js` (browser copy at `js/discord-events.js`), and the dashboard fires `gtb_open` / `gtb_winner`. The chat paths — `!gtb start` and `!gtb winner <actual>` — run in WenBotServer, so those two do NOT post to Discord yet. Fix = copy `resolveDiscordRoute` into WenBotServer and call it wherever the bot handles those commands. Same applies to any future event type: three copies of the catalogue must stay in step.

- **WenBotServer: confirm live giveaway eligibility flags are re-read per entry.** The dashboard now lets `giveawayVerifiedCasino` / `giveawayVerifiedDiscord` / `giveawayVerifiedBoard` / `giveawaySubOnly` / `giveawayFollowerOnly` be flipped mid-giveaway (written to the streamer profile by `gwSaveLiveEligibility`). Retroactive grading of already-collected entries is handled dashboard-side at draw time. Two things to verify in the bot: (1) the entry gate reads those profile fields per entry rather than snapshotting them at giveaway start — if it caches, a mid-run flip won't gate new entries; (2) the Followers Only winner re-check reads the flag live, which is what makes that rule retroactive (the dashboard cannot grade it — entries carry no follow flag). Optional improvement: have the bot stamp `isFollower` on snapshot entries, which would let the dashboard grey out non-followers the same way it does unverified entrants.

- **WenBotServer: route the `!winner` chat command through the verifiable draw.** IMPORTANT — the dashboard now draws server-side against a committed seed (`_lib/giveaway-draw-core.js` → `performDraw`) and publishes a proof at `/verify-draw`. The bot's own `!winner` command still picks a winner its own way, so a streamer who draws from chat gets an unverifiable result under a feature that promises the opposite, and the nonce sequence gets a hole. Fix: have the bot call `/api/giveaway-draw` (or port `performDraw`) instead of picking locally. Until then, tell streamers to draw from the dashboard if they want the proof.
- **Deploy the Firestore rules for the new collections.** `giveaway_fairness/{uid}`, `streamers/{uid}/giveaway_draws/{drawId}` and `share_links/{tokenHash}` are all `allow read, write: if false`. The seed rule is load-bearing: until it deploys, a streamer could read their own seed before drawing and the commitment proves nothing. Needs the logictools Google account — this machine's firebase CLI only has DailyTracker.
- **Trivia runs only while the dashboard tab is open.** Answers are read from Kick's public chat socket in the browser rather than through the bot. That was the trade that let it ship without bot-side work, and it is fine for an attended on-stream game, but moving detection into WenBotServer later would let `!trivia` run unattended and survive a closed laptop.
- **Share links: consider an audit-log entry per action.** `/api/share` records `uses`/`lastUsedAt`/`lastAction` on the link document, but actions taken through a link do not appear in the streamer's Activity Log. Worth adding if links get used for anything more consequential than the slot queue.

- **Remaining audit findings from the verifiable-draw review (medium/low).** Blockers and highs are fixed; these are not:
  - `/api/share` records `uses`/`lastUsedAt` on the link doc but writes nothing to the streamer's Activity Log, so a draw run through a share link leaves no audit trail where the streamer looks for one.
  - The claim-window auto-reroll now refuses when the bot heartbeat is stale, but it still cannot tell "winner replied in DMs" from "winner said nothing in chat" — chat is the only signal.
  - Trivia scores and the asked-question list live in memory only; a reload loses the session scoreboard.
  - `giveaway_draws` proofs are never pruned. One doc per draw per streamer, forever. Fine for now, worth a retention sweep if draw volume grows.
