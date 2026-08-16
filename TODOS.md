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

## 6. Clash.gg prize units

**What:** Confirm what Clash's `rewards[].amount` actually denominates, and label it correctly on the portal.

**Effort:** ~5 min once confirmed

**Why:** Her race pays 70,000 for first. The portal renders Clash amounts as a gem plus the number, because printing `$70,000` would assert a currency Clash never stated. If those are dollars, or a coin with a known conversion, the label and possibly the formatting are wrong on a public page.

**Where:** `BOARD_UNITS` in `portals/meggambles/index.html`.

---

## 7. Multi-casino verification

**What:** Let a viewer choose which casino they are verifying for, and teach the affiliate lookup about Clash.

**Effort:** ~half a day

**Why:** Meg runs four sites. Verification records are already stored per provider (`<kickKey>_<provider>`), and `verify-affiliate` already accepts a `casino` and validates it against her primary casino plus every enabled board. The gap is the front end: `verify.html` resolves exactly one casino, from `?casino=` or the streamer's primary, so a viewer can only ever verify for one of her four.

**What is left:**

- A chooser on `verify.html` when the streamer has more than one enabled board. One casino should stay a straight-through flow with no extra step. The streamer's boards are already in `portal-data` under `boards`, so no new endpoint is needed.
- `!verify` / `/verify` should link to it and say which casinos are on offer.
- Per-casino Discord roles, if she wants "Degen Verified" separate from "Clash Verified". Today `discordConfig.verify.roleId` is a single role for the channel.
- A Clash branch in `lookupAffiliate` (see below) so Clash verifications are checked rather than taken on trust.

**Clash caveat:** `clash.gg` is deliberately NOT in `API_CASINOS`. Its affiliate endpoint only returns the CURRENT race's top players, so absence from that list does not mean "not under the code" - anyone who has not out-wagered the leaders is missing from it. Adding Clash to that set without handling the distinction would fail genuine affiliates at verification. Either find an endpoint that lists all referred users, or treat a miss as unproven rather than as a rejection.

---

## Notes

- The hardcoded `HOST_TO_SLUG` in `netlify/edge-functions/custom-domain.js` currently has just `skslots.co.uk` + `www.skslots.co.uk` → `skslots`. New clients in the meantime: add an entry, push, done. But that's the workaround until item 2 lands.

- Watch the Netlify usage dashboard manually until item 1 is built. The big cost driver to watch first is **function invocations** (OBS overlay polling endpoints are the heaviest — `/api/overlay-data`, `/api/bb-state`, etc., polled every 1.5s by every active stream).
