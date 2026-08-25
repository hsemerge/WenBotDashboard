// Catalogue of the announcements WenBot can post to Discord — browser copy.
// Loaded via <script src="/js/discord-events.js">; defines DISCORD_EVENTS as a
// global so the dashboard's routing table renders one row per event.
// Server-side has a separate copy at netlify/functions/_lib/discord-events.js,
// which also owns resolveDiscordRoute() — the dashboard only ever writes config.
//
// Keep this list in step with the server copy; a row missing here is simply a
// route the streamer can't see or change, and it stays on by default.

const DISCORD_EVENTS = [
  {
    key:    'giveaway_start',
    label:  'Giveaway started',
    bucket: 'giveaway',
    hint:   'The entry card with the Join button.',
  },
  {
    key:    'giveaway_winner',
    label:  'Giveaway winner',
    bucket: 'giveaway',
    hint:   'The simple public "we have a winner!" card.',
  },
  {
    key:       'giveaway_winner_mod',
    label:     'Giveaway winner — mod log',
    bucket:    null,
    mustRoute: true,
    hint:      'Detailed winner card for staff (alt / bot / shared-connection flags + a Show more button). Posts ONLY to the channel you pick here — never a default channel — so it stays out of viewer channels.',
  },
  {
    key:    'hunt_start',
    label:  'Bonus hunt started',
    bucket: 'announcement',
    hint:   'Start balance and a link to the stream.',
  },
  {
    key:    'gtb_open',
    label:  'GTB opened',
    bucket: 'announcement',
    hint:   'Tells Discord guessing is live while it still counts.',
  },
  {
    key:    'gtb_winner',
    label:  'GTB winner',
    bucket: 'announcement',
    hint:   'The closest guess, posted when you send it to chat.',
  },
  {
    key:    'slot_request',
    label:  'Slot request',
    bucket: 'announcement',
    hint:   'Each slot a viewer asks you to play.',
  },
  {
    key:    'store_redemption',
    label:  'Store redemption',
    bucket: 'announcement',
    hint:   'One line per redemption — the noisiest event here.',
  },
];

// Shown in the "defaults to" column when the row has no channel of its own.
const DISCORD_BUCKET_LABELS = {
  giveaway:     'Giveaway channel',
  announcement: 'Announcements channel',
};
