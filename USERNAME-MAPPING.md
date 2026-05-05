# Gambulls to Kick Username Mapping - Decision Needed

## The Problem

The Gambulls API only returns a casino username and user ID - no Kick username. For example, a user might be **"SlurpyTerpie"** on Gambulls but **"slurpyterps"** on Kick. There's no way to automatically match them.

### Gambulls API Response (per user):
```json
{
  "rank": 1,
  "user": {
    "id": "cmmfq2rl31kgren08z8x9o0tv",
    "name": "SlurpyTerpie",
    "isAnonymous": false,
    "imageUrl": null
  },
  "wagerAmount": 34751.96,
  "currency": "USD"
}
```

No Kick username, no linked accounts, no email - just the Gambulls display name and an internal ID.

---

## Possible Approaches

### Option 1: Manual Mapping (Admin-Managed)
- Admin maintains a list pairing Gambulls usernames to Kick usernames
- Could be a simple JSON file or editable table in the UI
- **Pros:** Full control, no user action needed, accurate
- **Cons:** Doesn't scale, admin has to manually update it, error-prone

### Option 2: Chat Verification Command (Recommended)
- Users type `!verify SlurpyTerpie` in Kick chat to link their Gambulls account
- Bot stores the mapping: `KickUsername -> GambullsUsername`
- After verifying once, users just type `!giveaway` to enter future giveaways
- Mapping persists in localStorage (or a JSON file / database for production)
- **Pros:** Self-service, scales well, users verify themselves, one-time setup
- **Cons:** Users could claim someone else's Gambulls name (could add confirmation step)

### Option 3: Inline Entry with Gambulls Name
- Users type `!giveaway SlurpyTerpie` every time they want to enter
- Bot looks up the Gambulls name on the leaderboard to verify eligibility
- **Pros:** Simple to implement, no persistent storage needed
- **Cons:** Users have to type their Gambulls name every time, easy to typo, anyone could claim any name

---

## Recommendation

**Option 2 (Chat Verification)** is the cleanest approach:

1. User types `!verify MyGambullsName` once in Kick chat
2. Bot checks if that Gambulls name exists on the leaderboard
3. If valid, stores the link: `kick:emergeonkick -> gambulls:SlurpyTerpie`
4. From then on, user just types `!giveaway` and the bot knows who they are
5. Could optionally prevent two Kick accounts from claiming the same Gambulls name

### Storage Options for the Mapping:
- **localStorage** - Simple, but only persists per browser session
- **JSON file on server** - Persistent, works across sessions
- **Netlify Blobs** - Production-ready, already used in FloozyLeaderboard
- **Google Sheets** - Easy for admin to view/edit manually

---

## Current State (as of March 18, 2026)

- Bot UI is built and functional (4-panel layout: Entries, Options, Chat, Winners)
- Kick chat connection works via Pusher WebSocket
- Gambulls API proxy works and returns leaderboard data (179 users under Floozy's code)
- Entry logic works for "Chat Users" mode (anyone can enter)
- "Code Users" mode is blocked on this username mapping issue
- Need to implement chosen approach before "Code Users" mode is functional
