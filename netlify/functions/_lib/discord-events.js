// Shared catalogue of the announcements WenBot can post to a streamer's Discord,
// plus the rule that turns an event into an actual channel id.
//
// Browser-side has a separate copy at /js/discord-events.js so the dashboard can
// build its routing table from the same list. WenBotServer (separate repo) keeps
// its own copy for the events it fires (go-live, chat-driven GTB).
//
// Adding an announcement = one entry here, one in the browser copy, and an embed
// builder in discord-notify.js. No new config field, no migration.

// `bucket` is the channel the event falls back to when the streamer hasn't given
// it a channel of its own — i.e. the two original dropdowns. That keeps every
// config written before routing existed working exactly as it did.
const DISCORD_EVENTS = [
  {
    key:    "giveaway_start",
    label:  "Giveaway started",
    bucket: "giveaway",
    hint:   "The entry card with the Join button.",
  },
  {
    key:    "giveaway_winner",
    label:  "Giveaway winner",
    bucket: "giveaway",
    hint:   "The simple public 'we have a winner!' card.",
  },
  {
    key:       "giveaway_winner_mod",
    label:     "Giveaway winner — mod log",
    bucket:    null,        // NEVER falls back to a shared channel (see mustRoute)
    mustRoute: true,
    hint:      "A detailed winner card for your staff — alt / bot / shared-connection flags plus a Show-more button. Posts ONLY to a channel you pick here (never the giveaway/announcements default), so mod info can't leak to viewers.",
  },
  {
    key:    "hunt_start",
    label:  "Bonus hunt started",
    bucket: "announcement",
    hint:   "Start balance and a link to the stream.",
  },
  {
    key:    "gtb_open",
    label:  "GTB opened",
    bucket: "announcement",
    hint:   "Tells Discord guessing is live while it still counts.",
  },
  {
    key:    "gtb_winner",
    label:  "GTB winner",
    bucket: "announcement",
    hint:   "The closest guess, posted when you send it to chat.",
  },
  {
    key:    "slot_request",
    label:  "Slot request",
    bucket: "announcement",
    hint:   "Each slot a viewer asks you to play.",
  },
  {
    key:    "store_redemption",
    label:  "Store redemption",
    bucket: "announcement",
    hint:   "One line per redemption — the noisiest event here.",
  },
];

// Deliberately NOT in the list: the go-live announcement. It already owns an
// enable toggle, a channel and a ping role on its own card, and having it in two
// places would just let the two disagree.

const DISCORD_EVENT_KEYS = DISCORD_EVENTS.map(e => e.key);

/**
 * Work out whether an event should post, and where.
 *
 * Fallback chain: the event's own channel → its bucket channel → nowhere.
 * An event with no route entry at all is ON — otherwise every streamer who never
 * opens the routing table would silently lose announcements they already had,
 * and every new event type would ship switched off.
 *
 * @param {object} cfg  streamer.discordConfig
 * @param {string} type event key
 * @returns {{ enabled: boolean, channelId: string|null, reason: string|null }}
 */
function resolveDiscordRoute(cfg, type) {
  const ev = DISCORD_EVENTS.find(e => e.key === type);
  if (!ev) return { enabled: false, channelId: null, reason: "Unknown event type" };

  const route = ((cfg && cfg.routes) || {})[type] || {};
  if (route.enabled === false) {
    return { enabled: false, channelId: null, reason: "Turned off for this streamer" };
  }

  // Sensitive events (the mod-log winner) must NEVER fall back to the shared
  // giveaway/announcement channels, or they'd leak mod-only info to viewers — they
  // post ONLY to a channel the streamer explicitly picks for them.
  const bucketId = ev.mustRoute ? null
    : ev.bucket === "giveaway" ? (cfg && cfg.giveawayChannelId)
    : (cfg && cfg.announcementChannelId);

  const channelId = route.channelId || bucketId || null;
  if (!channelId) {
    return {
      enabled: false, channelId: null,
      reason: ev.mustRoute ? "Needs its own channel (no default fallback)" : `No ${ev.bucket} channel configured`,
    };
  }
  return { enabled: true, channelId, reason: null };
}

module.exports = { DISCORD_EVENTS, DISCORD_EVENT_KEYS, resolveDiscordRoute };
