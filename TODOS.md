# WenBot — Backlog

Deferred items captured 2026-05-29. Re-read at the start of new working sessions.

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

## Notes

- The hardcoded `HOST_TO_SLUG` in `netlify/edge-functions/custom-domain.js` currently has just `skslots.co.uk` + `www.skslots.co.uk` → `skslots`. New clients in the meantime: add an entry, push, done. But that's the workaround until item 2 lands.

- Watch the Netlify usage dashboard manually until item 1 is built. The big cost driver to watch first is **function invocations** (OBS overlay polling endpoints are the heaviest — `/api/overlay-data`, `/api/bb-state`, etc., polled every 1.5s by every active stream).
