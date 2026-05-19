# WenBot UAT Test Plan — May 2026 Security/Reliability Batch

This covers everything shipped today. Work through the flows in order — most
later flows assume earlier ones work (e.g., you need to be signed in for
dashboard tests).

**Before testing**: open DevTools (F12) on every page and watch the Console.
Any red errors are a fail even if the page looks fine — especially anything
starting with `Refused to ...` (CSP violation) or `permission_denied`
(Firestore rules misconfigured).

---

## A. New streamer signup → email verify → setup → Kick OAuth

### A1. Sign up with a fresh email
- [ ] Open `/signup.html`
- [ ] Pick any plan (Starter is fastest to test)
- [ ] Enter a fresh email + password
- [ ] Click "Create Account"
- **Expected**: redirected to `/verify-email.html` showing your email
- **Check console**: no errors

### A2. Email verification page
- [ ] Check your inbox (incl. spam) for a Firebase verification email
- [ ] Click the link in the email
- [ ] Return to the `/verify-email.html` tab
- **Expected**: auto-detected within ~4 seconds → redirects to `/setup.html`
- [ ] Try the "Resend Email" button before verifying — should work then show 30s cooldown

### A3. Setup without Kick OAuth
- [ ] Without connecting Kick, click "Complete Setup"
- **Expected**: error message "Please click 'Connect with Kick' first — required for security"

### A4. Connect Kick OAuth (streamer flow)
- [ ] Click "Connect with Kick"
- [ ] Complete Kick OAuth on Kick's site
- **Expected**: redirected back to `/setup.html?kick=connected` showing your Kick username
- **Check Firebase Console** → Firestore → `streamers/{yourUid}`: should see `kickUserId`, `kickUsername`, `kickAccessToken`, `kickRefreshToken`, `kickChannel` all populated **by server** (you didn't type them)

### A5. Complete setup → dashboard
- [ ] Fill in display name + casino, click Complete Setup
- **Expected**: lands on dashboard
- **Check**: `kickChannel` field on the Settings page is `readonly` (greyed out)

---

## B. Existing streamer dashboard load

### B1. Dashboard loads cleanly
- [ ] Open dashboard
- **Expected**: Overview page shows, no console errors
- **Check console for**: `Refused to load/connect/execute` (CSP issues), `permission_denied` (rules issues)

### B2. Bot Status indicators
Once WenBotServer is connected (could take up to ~60s after Railway deploys):
- [ ] **Topbar pill** (header next to channel pill): "Bot: Online" with green dot
- [ ] **Sidebar bottom**: green dot + "Online" + your channel name
- [ ] **Overview stat card** (top-left grid): "Bot Status: Online" in green

If bot is genuinely offline:
- [ ] All three should show "Offline" with red dot
- [ ] Offline warning banner should appear at top of Overview with recovery steps

### B3. Real-time listeners work
- [ ] Navigate to Verified Users page → loads users with **bold green "✓ Under Code"** badges and dim "Standard" badges
- [ ] Try the "Under Code only" checkbox → table filters correctly
- [ ] "Last leaderboard sync: Nm ago" line is visible (or "sync pending" if bot hasn't synced yet)
- [ ] Navigate to Store → Pending Redemptions section loads (live)
- [ ] Navigate to Raffles → History list loads (live)

---

## C. Viewer verify flow — Kick OAuth (universal link)

### C1. Open a verify link
- [ ] As a **viewer** (different account or incognito), type `!verify` in your Kick chat where WenBot is modded
- [ ] WenBot should respond with a link like `https://wenbot.gg/verify.html?channel=...&casino=...`
- [ ] Click the link
- **Expected**: page shows "Sign in with Kick to continue" — **the casino form is hidden**

### C2. Connect with Kick
- [ ] Click "🟢 Connect with Kick"
- [ ] Complete Kick OAuth
- **Expected**: redirected back to verify page with green ✓ next to your Kick username, casino form now visible

### C3. Submit casino username
- [ ] Enter your casino username, click Verify
- **Expected**: success screen showing "@yourKick has been linked to your_casino_name"
- **Check Firestore** → `streamers/{streamerUid}/verified_users/{yourKick_provider}`: should have `apiVerified`, `underAffiliate`, `verifiedAt` fields

### C4. "Not you?" link works
- [ ] On a fresh verify link, after Connect with Kick, click "Not you?"
- **Expected**: session cleared, OAuth flow re-triggered

### C5. Activity Log captures the verification
- [ ] As the streamer, open Activity Log
- **Expected**: new entry "Verification — @yourKick verified your_casino on Casino [Under Code]" with current timestamp

---

## D. Viewer verify flow — Discord linking

### D1. Discord /register
- [ ] In a Discord server where WenBot is configured, type `/register`
- **Expected**: WenBot DMs/replies with a link `verify.html?channel=...&casino=...&dtoken=...`
- [ ] Click the link

### D2. Discord flow requires Kick OAuth too
- [ ] You should see the same "Sign in with Kick to continue" gate (NOT a kickUsername input field)
- [ ] Complete Kick OAuth → form appears
- [ ] Submit casino username
- **Expected**: success screen says "Discord linked!" + "/points and /buy in the server"
- **Check Firestore** → `streamers/{uid}/discord_links/{discordUserId}`: should have your kickUsername set from the OAuth Kick API (not from a form input)

### D3. /points works in Discord after linking
- [ ] In Discord, type `/points`
- **Expected**: shows your point balance for that Kick account

---

## E. Cross-page Kick session reuse

### E1. After verifying, hit a bonus battle link
- [ ] After completing C or D, navigate to `bonus-battle.html?channel=YOUR_STREAMER`
- **Expected**: auto-signed in (no OAuth prompt) showing your Kick username

### E2. Hit a tournament link
- [ ] Navigate to `tournament.html?channel=YOUR_STREAMER`
- **Expected**: same — auto-signed in

### E3. localStorage check
- [ ] DevTools → Application → Local Storage → wenbot.gg
- **Expected**: ONE entry called `kick_viewer_session` (NOT separate `verify_kick_session` / `bb_viewer_session`)

---

## F. Streamer mod points adjustment + audit log

### F1. Add points to a viewer
- [ ] As streamer, dashboard → Points → click "+" next to a viewer
- [ ] Enter a positive number, OK
- **Expected**: flash "Added X points to @viewer"; their balance increases in the leaderboard

### F2. Remove points
- [ ] Click "+" again, enter a NEGATIVE number (e.g., -50)
- **Expected**: flash "Removed 50 points to @viewer"

### F3. Activity Log captures both
- [ ] Open Activity Log
- **Expected**: two entries — "Points Adjusted: Adjusted @viewer by +X pts" / "by -50 pts"

### F4. Failure case — rules block forbidden field writes
- [ ] DevTools console → try to write to streamer's `kickChannel` field:
  ```js
  firebase.firestore().collection('streamers').doc(firebase.auth().currentUser.uid)
    .update({ kickChannel: 'hijacked' })
  ```
- **Expected**: `permission_denied` error in console (rules block this)

---

## G. Store redemption fulfillment + audit

### G1. Have a viewer redeem something
- [ ] As viewer in Kick chat: `!buy ItemName` (or `!redeem ItemName`)
- **Expected**: WenBot confirms; points deducted; pending redemption appears in dashboard

### G2. Activity Log captures the chat redemption
- [ ] As streamer, Activity Log
- **Expected**: "Store Redemption — @viewer redeemed ItemName for X pts [Kick]"

### G3. Mark fulfilled
- [ ] Dashboard → Store → Pending Redemptions → click "✓ Fulfill"
- **Expected**: redemption disappears from pending; flash "Marked as fulfilled!"

### G4. Activity Log captures the fulfillment
- [ ] Activity Log
- **Expected**: "Redemption Done — Marked ItemName for @viewer as fulfilled"

### G5. Discord redemption (if /buy is configured)
- [ ] In Discord: `/buy item:ItemName`
- **Expected**: confirmation; Activity Log entry "Store Redemption ... [Discord]"

---

## H. Raffle draw + audit

### H1. Run a raffle
- [ ] Dashboard → Raffles → start a period, get entries (or use test entries), draw a winner
- **Expected**: wheel spins, winner displayed

### H2. Activity Log + History
- [ ] Raffles → History list (real-time): new entry should appear immediately
- [ ] Activity Log: "Raffle Drawn — Drew raffle: Winner won — X entrants, Y tickets"

---

## I. Verified user removal + audit

### I1. Remove a verified user
- [ ] Verified Users page → click "Remove" on any entry
- **Expected**: row disappears immediately (real-time listener)

### I2. Activity Log
- [ ] Activity Log: "Verified Removed — Removed verified entry kickKey_provider"

---

## J. Stripe checkout (paid plan flow)

### J1. New signup with paid plan
- [ ] Sign up fresh with a Pro plan selection
- [ ] Complete email verify, get to Setup
- [ ] Complete setup
- **Expected**: redirected to Stripe Checkout
- [ ] Complete payment with Stripe test card `4242 4242 4242 4242`
- **Expected**: returned to dashboard, plan shown as "Pro"

### J2. Unverified email cannot reach Stripe
- [ ] Try to call `/api/create-checkout-session` from an unverified account (or open dashboard before verifying)
- **Expected**: 403 "Please verify your email before subscribing"

### J3. Stripe webhook signature still validates
- This is hard to test manually; if you see `stripeSubscriptionActive: true` set on your streamer doc after payment, it worked.

---

## K. Data export (GDPR)

### K1. Download My Data
- [ ] Dashboard → Settings → scroll to "📦 Your Data"
- [ ] Click "📥 Download My Data"
- **Expected**: file downloads as `wenbot-export-2026-MM-DD.json`
- [ ] Open the JSON file
- **Verify**:
  - Has `profile` with most fields
  - Does NOT contain `kickAccessToken`, `kickRefreshToken`, `kickTokenExpiresAt`
  - `collections` contains all your subcollections (verified_users, viewers, raffle_history, audit_logs, etc.)
  - Does NOT contain `bot_locks` or `bot_status`

---

## L. Agency contact form

### L1. Submit an inquiry
- [ ] On `signup.html`, select Agency plan
- [ ] Fill in name, email, project details, submit
- **Expected**: success message
- **Check Firestore** → `agency_inquiries`: new doc with submission

### L2. Email validation
- [ ] Try submitting with email "notanemail"
- **Expected**: 400 error "Please enter a valid email address"

### L3. (Optional) Email actually sent
- Only if `RESEND_API_KEY` is configured: check sales@logicplaystudios.com inbox

---

## M. CSP smoke test

For every page you visited above, scan the DevTools Console for entries like:
- `Refused to load the script ...`
- `Refused to connect to ...`
- `Refused to apply inline style ...`
- `Content Security Policy directive ...`

**Any of these = fail**. Note which page + which directive, and we'll loosen the CSP for that specific case.

Pages especially worth checking:
- [ ] index.html (landing)
- [ ] signup.html
- [ ] verify-email.html
- [ ] setup.html
- [ ] dashboard.html (every nav tab)
- [ ] verify.html (in both Kick and Discord modes)
- [ ] bonus-battle.html
- [ ] tournament.html

---

## N. WenBotServer (Railway) backend checks

### N1. Bot heartbeat
- [ ] Have your streamer doc open in Firestore Console
- [ ] Navigate to `streamers/{uid}/bot_status/current`
- **Expected**: doc exists with `heartbeat` field updated within the last 60-120 seconds
- [ ] Also expect `lastLeaderboardSync` to update every ~5 min if your casino has API verification

### N2. Bot status endpoint (optional, requires raw URL access)
- [ ] curl or browser-visit: `https://wenbot-production.up.railway.app/status`
- **Expected**: JSON response with `firestore.connected: true`, `bots.active`, `counters`, `uptime_sec`

### N3. bot_locks self-cleanup (optional)
- [ ] After running ~10 chat commands, check `streamers/{uid}/bot_locks`
- **Expected**: docs there now will be **gone within 5 minutes** (auto-deleted)
- Each doc should have an `expiresAt` field

### N4. Graceful shutdown (only verifiable on next Railway deploy)
- [ ] When you next deploy WenBotServer, Railway logs should show:
  - `[Shutdown] SIGTERM received — stopping N bot(s)...`
  - `[Shutdown] All bots stopped. Exiting cleanly.`
- No "Process exited unexpectedly" or in-flight error messages

### N5. WebSocket reconnect backoff (only triggers on Pusher outage — can't force, just monitor)
- [ ] If you ever see Railway logs say "WebSocket closed — reconnecting in Ns" with **increasing** N values (5, 10, 20, 40, 60), that's the new exponential backoff working

---

## O. Activity Log UI

### O1. All action types should display correctly
- [ ] Filter dropdown shows three groups: Points & Store / Engagement / Admin
- [ ] Each filter option shows only matching rows when selected
- [ ] Each row has: timestamp, colored badge, human-readable details
- [ ] Real-time updates: open Activity Log + in another tab do an action — new row should appear within ~1 second without refresh

---

## Common failure modes

If any test fails, capture:
1. **Screenshot** of the page + DevTools Console
2. **The exact error** (red text in console, or in a flash message)
3. **What you were doing** when it failed

Then we can diagnose.

The most likely failure modes for this batch:
- **CSP blocking something**: needs that domain added to `connect-src` or that pattern allowed
- **Firestore rules blocking a write**: needs the rule loosened, OR the write needs to go through a server endpoint
- **Bot Status stays at "Not connected"**: Railway deploy hasn't picked up the new heartbeat code yet, OR WenBotServer can't reach Firestore
- **Audit Log entries not appearing**: `/api/log-action` or the WenBotServer audit module isn't firing; check Netlify/Railway logs for errors
