// GET /api/commands-data?channel=USERNAME
//
// The command list a viewer actually has, for the public /commands page and for
// what !commands links to. Channel-aware on purpose: a generic list would lie.
// Streamers rename triggers (Pro+), turn points or games off entirely, rename
// their currency, and disable individual Discord commands — so a list that
// ignored all that would send viewers to commands the bot won't answer.
//
// Without ?channel it returns the defaults, which is what /commands shows when
// someone lands on it with no channel context.
//
// The source of truth for triggers is WenBotServer: buildCmdAliases() in
// streamer-bot.js and GAME_TRIGGERS in commands/games.js. Keep this in step when
// commands are added there.

const { getDb } = require("./_lib/firebase");
const { res: _res } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

// Renameable chat triggers — key must match buildCmdAliases() in the bot.
const RENAMEABLE = {
  pts:     "points",
  pgive:   "give",
  ptop:    "top",
  prank:   "rank",
  request: "request",
  store:   "store",
  buy:     "buy",
};

// { chat, discord, desc, group, needs, mod }
//   chat    — trigger, or an alias key in RENAMEABLE (resolved per channel)
//   discord — slash command, when there is one
//   needs   — feature gate: "points" | "games" | null
//   mod     — moderators only
const CATALOG = [
  // Points
  { alias: "pts",   discord: "points", group: "Points", needs: "points", desc: "Check your {currency} balance" },
  { alias: "ptop",  discord: "top",    group: "Points", needs: "points", desc: "Top {currency} holders" },
  { alias: "prank", discord: "rank",   group: "Points", needs: "points", desc: "Your place on the {currency} leaderboard" },
  { alias: "pgive", discord: "give",   group: "Points", needs: "points", desc: "Give {currency} to someone else", usage: "{cmd} @user 100" },
  { chat: null,     discord: "daily",  group: "Points", needs: "points", desc: "Claim your daily {currency} bonus" },
  { chat: null,     discord: "myraffles", group: "Points", needs: "points", desc: "Your active raffle entries" },
  { chat: null,     discord: "profile",   group: "Points", desc: "Your WenBot profile" },

  // Store
  { alias: "store", discord: "store", group: "Store", needs: "points", desc: "See what you can spend {currency} on" },
  { alias: "buy",   discord: "buy",   group: "Store", needs: "points", desc: "Buy a store item or raffle tickets", usage: "{cmd} <item>" },

  // Leaderboard
  { chat: "!lb", discord: "lb", group: "Leaderboard", desc: "Current wager leaderboard", also: ["!leaderboard"] },
  { chat: null, discord: "plb", group: "Leaderboard", needs: "points", desc: "{currency} leaderboard (top 20)" },

  // Channel
  { chat: "!uptime",    discord: null,        group: "Channel", desc: "How long the stream has been live", also: ["!live"] },
  { chat: "!followage", discord: "followage", group: "Channel", desc: "How long you've followed the channel", also: ["!followed"] },
  { chat: "!verify",    discord: "verify",    group: "Channel", desc: "Link your Kick account to WenBot", also: ["!register"] },
  { chat: "!community", discord: "community", group: "Channel", desc: "The WenBot community hub + your WenPoints", also: ["!wenpoints", "!wenbot"] },

  // Bonus hunt & guessing
  { chat: "!hunt",  discord: "hunt",  group: "Bonus Hunt", desc: "Current bonus hunt status", also: ["!bonushunt"] },
  { chat: "!bb",    discord: null,    group: "Bonus Hunt", desc: "Vote in the live bonus battle", also: ["!battle", "!bonusbattle"] },
  { chat: "!gtb",   discord: "gtb",   group: "Bonus Hunt", desc: "Guess the final balance", usage: "{cmd} 1000", also: ["!guess"] },
  { chat: "!mygtb", discord: "mygtb", group: "Bonus Hunt", desc: "Your current guess" },

  // Slot requests
  { alias: "request", discord: "request", group: "Slots", desc: "Request a slot", usage: "{cmd} <slot name>", also: ["!sr", "!r"] },

  // Tournament
  { chat: "!champion", discord: "champion",   group: "Tournament", desc: "Back a player to win the tournament" },
  { chat: null,        discord: "tournament", group: "Tournament", desc: "Tournament bracket standings" },

  // Games
  { chat: "!games",    discord: "games",    group: "Games", needs: "games", desc: "Which games are switched on here" },
  { chat: "!coinflip", discord: "coinflip", group: "Games", needs: "games", desc: "Call red or blue — 2x payout", usage: "{cmd} red 100" },
  { chat: "!roulette", discord: "roulette", group: "Games", needs: "games", desc: "Red/black 2x, sections 3x, green 14x, exact number 36x", usage: "{cmd} red 100" },
  { chat: "!limbo",    discord: "limbo",    group: "Games", needs: "games", desc: "Pick a target multiplier and try to beat it", usage: "{cmd} 100 2.5" },
  { chat: "!double",   discord: "double",   group: "Games", needs: "games", desc: "Double or nothing — ride the pot or bank it", usage: "{cmd} 100" },
  { chat: "!take",     discord: "take",     group: "Games", needs: "games", desc: "Bank your double-or-nothing pot" },

  // Moderators
  { chat: "!giveaway", discord: null,      group: "Moderators", mod: true, desc: "Start or manage a giveaway" },
  { chat: "!winner",   discord: null,      group: "Moderators", mod: true, desc: "Draw a giveaway winner" },
  { chat: "!so",       discord: null,      group: "Moderators", mod: true, desc: "Shout out another streamer", usage: "{cmd} <name>", also: ["!shoutout"] },
  { chat: "!addpoints", discord: null,     group: "Moderators", mod: true, needs: "points", desc: "Add {currency} to a viewer", usage: "{cmd} <user> 100" },
  { chat: "!setpoints", discord: null,     group: "Moderators", mod: true, needs: "points", desc: "Set a viewer's {currency}", usage: "{cmd} <user> 100" },
  { chat: null,        discord: "giveall", group: "Moderators", mod: true, needs: "points", desc: "Drop {currency} to all active chatters" },
  { chat: null,        discord: "drop",    group: "Moderators", mod: true, needs: "points", desc: "Drop {currency} for viewers to claim" },
  { chat: null,        discord: "lookup",  group: "Moderators", mod: true, desc: "Look up a member" },
];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();

  let profile = null;
  if (channel) {
    try {
      const snap = await getDb().collection("streamers")
        .where("kickChannel", "==", channel).limit(1).get();
      if (!snap.empty) profile = snap.docs[0].data();
    } catch (e) {
      console.warn("[commands-data] lookup failed:", e.message);
    }
  }
  if (channel && !profile) return res(404, { error: "Channel not found on WenBot" });

  const currency   = (profile && profile.currencyName) || "points";
  const aliases    = (profile && profile.commandAliases) || {};
  const games      = (profile && profile.games) || {};
  const dcCommands = (profile && profile.discordConfig && profile.discordConfig.commands) || {};

  // Mirror the bot's gates exactly, or the page promises things that stay silent.
  const pointsOn = !profile || profile.pointsEnabled !== false;
  const gamesOn  = games.enabled === true;
  const gamesKick    = gamesOn && games.kick    !== false;  // Kick defaults on once enabled
  const gamesDiscord = gamesOn && games.discord === true;   // Discord defaults off

  const trigger = (item) => {
    if (item.alias) return "!" + String(aliases[item.alias] || RENAMEABLE[item.alias]).toLowerCase().replace(/^!/, "");
    return item.chat || null;
  };

  const out = [];
  for (const item of CATALOG) {
    if (item.needs === "points" && !pointsOn) continue;

    const chat = trigger(item);
    // Per-game switches, and the two platform switches, are independent.
    const perGame = ["coinflip", "roulette", "limbo", "double"].includes(item.discord)
      ? games[item.discord] !== false : true;

    const showChat    = !!chat    && (item.needs !== "games" || (gamesKick    && perGame));
    const showDiscord = !!item.discord && (item.needs !== "games" || (gamesDiscord && perGame))
      && dcCommands[item.discord] !== false;
    if (!showChat && !showDiscord) continue;

    const fill = (s) => (s || "").replace(/\{currency\}/g, currency).replace(/\{cmd\}/g, chat || "");
    out.push({
      group:   item.group,
      chat:    showChat ? chat : null,
      discord: showDiscord ? "/" + item.discord : null,
      desc:    fill(item.desc),
      usage:   item.usage && showChat ? fill(item.usage) : null,
      also:    showChat && item.also ? item.also : [],
      mod:     !!item.mod,
    });
  }

  return res(200, {
    channel:     channel || null,
    displayName: (profile && (profile.displayName || profile.kickChannel)) || null,
    currency,
    // Lets the page say "games are off here" rather than silently omitting them.
    features: { points: pointsOn, gamesKick, gamesDiscord },
    commands: out,
  });
};
