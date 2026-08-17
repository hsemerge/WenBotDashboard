// GET /api/portal-data?channel=USERNAME
// Public aggregator powering the streamer portal page.
// Returns ONLY the data the streamer's plan unlocks (Pro = +Store, Elite = +Leaderboard).
// Carefully curated — never exposes verified user lists, OAuth tokens, internal config.

const { getDb }              = require("./_lib/firebase");
const { CASINO_NAMES }       = require("./_lib/casinos");
const { lookupAffiliate }    = require("./_lib/affiliate");
const { normalizeGambulls, applyPeriod } = require("./_lib/leaderboard");
const { fetchDegenRace }     = require("./_lib/degen");
const { fetchRainbetForPeriod, fetchRainbetRange, applyRainbetExclusions, ymd: rbYmd } = require("./_lib/rainbet");
const { fetchCsgobigRace }   = require("./_lib/csgobig");
const { fetchDuelbitsForPeriod, applyDuelbitsPeriod } = require("./_lib/duelbits");
const { normalizeBoard, boardWindow, sortBoards } = require("./_lib/leaderboards");
const { fetchClashBoard } = require("./_lib/clash");

// NOT the shared API_CASINOS from _lib/casinos. This one gates a hardcoded
// Gambulls board fetch below, so adding a casino here would send that provider to
// api.gambulls.com. Every other provider has its own branch above. Named local on
// purpose so nobody "fixes" it by importing the shared set.
const GAMBULLS_BOARD_ONLY = new Set(["gambulls"]);

// Tier ranking. Anything >= the required tier sees the feature.
const TIER_RANK = { starter: 0, pro: 1, elite: 2, agency: 3 };
function tierOf(plan) {
  return TIER_RANK[plan] ?? 0;
}

// Owner channels — granted agency tier server-side regardless of Firestore plan.
// Mirrors the OWNER_CHANNELS list in dashboard.html so the dashboard and the
// public portal agree on what's unlocked. Keep in sync with that list.
const OWNER_CHANNELS = new Set(["emergeonkick"]);

// White-label streamers — full agency-tier features + portal branding overrides,
// granted manually (a comp), the same way HOST_TO_SLUG seeds custom domains.
// A code-seeded preset gets a client live immediately; a Firestore
// `whiteLabel:true` flag or the agency plan also unlocks it; and `profile.portal`
// (set later from the dashboard) overrides the preset field-by-field.
// CSGOBig races run on a day-of-month cycle (e.g. 16th → 16th), not calendar
// months. Returns the window CONTAINING `now`, plus the one before it.
//
// The end is the last millisecond before the next cycle day, so consecutive races
// never overlap and no wager can land in two races. Date.UTC normalises month
// overflow/underflow, so December → January and month 0 → previous December both
// work without special cases.
function csgobigCycleWindow(cycleDay, now) {
  const d   = new Date(now);
  const y   = d.getUTCFullYear();
  const m   = d.getUTCMonth();
  // Before the cycle day means we're still in the race that began LAST month.
  const sm  = d.getUTCDate() >= cycleDay ? m : m - 1;
  const from = Date.UTC(y, sm,     cycleDay, 0, 0, 0);
  const to   = Date.UTC(y, sm + 1, cycleDay, 0, 0, 0) - 1;
  const prevFrom = Date.UTC(y, sm - 1, cycleDay, 0, 0, 0);
  return { from, to, prevFrom, prevTo: from - 1 };
}

const PORTAL_PRESETS = {
  skslots: {
    theme: {
      accent:     "#a855f7",  // SK chip purple / bull logo
      accent2:    "#3fbdf5",  // cyan top of the chip
      accentGlow: "rgba(168,85,247,0.28)",
      gold:       "#f5c518",  // metallic gold "SK"
      bg:         "#08070d",
      bgCard:     "#13111c",
      border:     "#2a2440",
    },
    // Served from the repo (same-origin → allowed by the portal CSP). A logo the
    // streamer uploads via the dashboard (profile.portal.logoUrl) overrides this.
    logoUrl: "/img/sklotstransparent.png",
    hero: {
      tagline:   "Live leaderboards, giveaways & rewards",
      title:     "WEEKLY WAGER RACE",
      prize:     "$250",
      cadence:   "Weekly",                 // weekly LB, not monthly
      code:      "SKSlots",                // affiliate code shown in the hero
      ctaLabel:  "Play on Gambulls — code SKSlots",
      ctaHref:   "https://gambulls.com/?ref=SKSlots",
    },
    // Prize per leaderboard rank — shown next to the leaders currently in line
    // to win them (index 0 = 1st place). $250 weekly pool. NOTE: this is only a
    // FALLBACK — when the dashboard's Leaderboard Prizes are set they override this,
    // and the Wager Rewards "Weekly Leaderboard" tiles below auto-track that list.
    prizes: ["$100", "$65", "$45", "$25", "$15"],
    // Extra nav links shown on the bespoke portal (beyond the auto socials).
    links: [
      { label: "Gambulls", href: "https://gambulls.com/?ref=SKSlots", icon: "🎰" },
      { label: "Discord",  href: "https://discord.gg/SKSlots", icon: "💬" },
      { label: "Socials",  href: "https://linktr.ee/skslots", icon: "🌐" },
    ],
    // Extra standalone pages this portal links to (rendered as nav + routed).
    pages: [
      { id: "rewards", label: "Wager Rewards" },
    ],
    // Wager Rewards page content (rendered by the bespoke page's section engine).
    rewards: {
      intro: "Earn rewards as you wager under code SKSlots on Gambulls. The more you play, the more you unlock.",
      sections: [
        {
          type: "bonus", title: "Sign-Up Bonus", reward: "$10",
          bullets: [
            "Deposit $20 & wager $250",
            "Discord account must be older than 6 months",
            "Must be following the stream",
            "48 hour confirmation period from the casino",
          ],
        },
        {
          type: "tiers", title: "Wager Rewards",
          columns: ["Wager", "Reward"],
          tiers: [
            { wager: "$500",    reward: "$3"  },
            { wager: "$1,000",  reward: "$5"  },
            { wager: "$2,500",  reward: "$10" },
            { wager: "$5,000",  reward: "$15" },
            { wager: "$10,000", reward: "$20" },
            { wager: "$15,000", reward: "$25" },
            { wager: "$20,000", reward: "SKSlots VIP Access (open a ticket for details)" },
          ],
          note: "Not valid on Blackjack or Baccarat this applies to live & originals. Low-risk originals are recommended.",
        },
        {
          type: "list", title: "Getting Started",
          bullets: [
            "Min deposit: $20",
            "Wager $200 to unlock rewards, tips & bonus",
          ],
        },
        {
          type: "cards", title: "Casino Rewards",
          subtitle: "Provided by Gambulls",
          cards: [
            { title: "First Deposit",  bullets: ["10% loss-back (up to $100 on $1,000 deposit)", "1× wager", "Note: withdrawing forfeits the loss-back"] },
            { title: "Second Deposit", bullets: ["10% bonus (up to $100 on $1,000 deposit)", "1× wager"] },
            { title: "Third Deposit",  bullets: ["100% rakeback boost for 5 days"] },
            { title: "VIP Invite",     bullets: ["Invite-only — for players wagering $50,000+/month (case by case) and/or transferring VIP from another casino", "Unlocks VIP status in the community + extra challenges & wager benefits", "Gambulls-run, not SKSlots — open a ticket for a personalised plan. SKSlots can help with VIP transfer"] },
          ],
        },
        {
          // NOTE: subtitle + places are auto-synced to the live prize list in
          // buildPortalConfig — these static values are only a no-dashboard fallback.
          type: "prizes", title: "Weekly Leaderboard", subtitle: "$250 prize pool",
          places: [
            { place: "1st", amount: "$100" },
            { place: "2nd", amount: "$65" },
            { place: "3rd", amount: "$45" },
            { place: "4th", amount: "$25" },
            { place: "5th", amount: "$15" },
          ],
        },
        {
          type: "list", title: "Extras",
          bullets: [
            "Daily stream giveaways",
            "Social giveaways",
            "Sunday raffle (based on activity)",
            "Random Gambulls promotions",
          ],
        },
      ],
      footnote: "All rewards are subject to owner approval. Anyone seen abusing these will be removed from the community.",
    },
    brandCredit: true,
  },

  // MegRewards (formerly Irish Queen of the Slots) — Degen race, keyless with
  // the referral code in the URL. Preset key stays on the old slug: it resolves
  // through previousChannels, and renaming the key would break her asset paths.
  // provider + degenReferralCode here mean she needs NO Firestore provider doc.
  meggambles: {
    provider:          "degen",
    degenReferralCode: "meg",
    // Second (switchable) leaderboard: CSGOBig partner API, keyless (ref code in URL).
    // Her race runs 16th → 16th, NOT calendar months. Leaving these unset made the
    // board reset on 1 Aug and archive premature "July winners" for a race that was
    // still running. Roll these forward at the end of each race.
    csgobigRefCode:    "MEG74637HDKOCUR8464",
    // Races run 16th → 16th (UTC) and roll on their own, so there's nothing to
    // update each month. csgobigFrom/csgobigTo still override this if a one-off
    // window is ever needed.
    csgobigCycleDay:   16,
    // Monthly CSGOBig prize ladder, in COINS, rank-indexed (1st → 13th; 5,000 total).
    csgobigPrizes:     [2000, 1000, 500, 400, 300, 250, 200, 150, 100, 50, 25, 15, 10],
    theme: {
      accent:     "#c43bff",
      accent2:    "#ff4fd8",
      accentGlow: "rgba(196,59,255,0.30)",
      gold:       "#ffd84d",
      bg:         "#0b0613",
      bgCard:     "#19102e",
      border:     "#3a2a5c",
    },
    logoUrl: "/portals/meggambles/assets/logo.jpg",
    hero: {
      tagline:   "Slots. Wins. Vibes. Big Energy. 💜",
      // title omitted — the page markup renders it with a visible crown emoji
      // (a gradient-clipped emoji in JS-set text would go invisible).
      cadence:   "Monthly",
      code:      "Meg",
      ctaLabel:  "Play on Degen — code Meg",
      ctaHref:   "https://degen.com/?ref=Meg",
    },
    links: [
      { label: "Degen",   href: "https://degen.com/?ref=Meg", icon: "🎰" },
      { label: "VIP",     href: "https://vipfoundme.com/", icon: "👑" },
      { label: "Kick",    href: "https://kick.com/meggambles", icon: "💜" },
    ],
    brandCredit: true,
  },

  // ── TILTBROS (Agency / bespoke) ──────────────────────────────────────────
  // Duelbits affiliate hub. Everything below is CONTENT, not logic — the live
  // leaderboard, raffle tickets, winners and giveaway history all come from the
  // shared /api/portal-data response the bespoke page already fetches.
  thetiltbros: {
    // Pulled from the brand art: the night skyline, the red LED mask, and the
    // lizard. RED and GREEN share the page as a genuine pair, which is the duo
    // itself, over a neutral navy-black rather than the old green-tinted base.
    //
    // NOTE: this preset OVERRIDES the stylesheet at runtime, so it is the real
    // source of truth for this portal's colours. Editing the CSS alone changes
    // nothing once the API responds.
    //
    // No yellow. It was the loudest thing on the page and appears nowhere in
    // their artwork.
    theme: {
      accent:     "#ff2e3c",  // the mask red — CTAs, headings, active nav
      accent2:    "#ff6b52",  // warm ember, gradients only
      accentGlow: "rgba(255,46,60,0.26)",
      // `gold` is the legacy key name for the money slot; the value is the
      // lizard green so prize figures read as money, not as a warning.
      gold:       "#3fd06a",
      money:      "#3fd06a",
      red:        "#ff2e3c",
      bg:         "#05070d",
      bgCard:     "#0d1119",
      border:     "#1e2532",
    },
    logoUrl: null,            // set once a logo file is added to /img/
    hero: {
      tagline:  "Wager under code TILTBROS. Get paid every month.",
      title:    "MONTHLY WAGER RACE",
      cadence:  "Monthly",
      code:     "TILTBROS",
      ctaLabel: "Play on Duelbits with code TILTBROS",
      ctaHref:  "https://duelbits.com/?a=tiltbros",
    },
    // FALLBACK ONLY — the dashboard's Leaderboard Prizes override this the
    // moment they're set, and buildPortalConfig derives the hero pool from the
    // same list so the headline can never drift from the payouts.
    prizes: ["$1,500", "$1,000", "$750", "$500", "$400", "$300", "$200", "$150", "$120", "$80"],
    links: [
      { label: "Duelbits", href: "https://duelbits.com/?a=tiltbros", icon: "🎰" },
      { label: "Discord",  href: "https://discord.com/invite/thetiltbros", icon: "💬" },
      { label: "Kick",     href: "https://kick.com/thetiltbros", icon: "💚" },
    ],
    pages: [
      { id: "raffles",   label: "Raffles" },
      { id: "giveaways", label: "Giveaways" },
      { id: "bonuses",   label: "Bonuses" },
      { id: "bounties",  label: "Bounties" },
      { id: "faq",       label: "FAQ" },
    ],
    rewards: {
      intro: "Every dollar wagered under code TILTBROS on Duelbits works for you: race payouts, raffle tickets and milestone rewards all come off the same wager.",
      sections: [
        {
          type: "prizes", title: "Monthly Leaderboard", subtitle: "Top 10 get paid",
          places: [],   // filled from the live prize list by buildPortalConfig
        },
        {
          type: "tiers", title: "Monthly Wager Rewards",
          columns: ["Wagered", "Reward"],
          tiers: [
            { wager: "$5,000",   reward: "$25"  },
            { wager: "$10,000",  reward: "$60"  },
            { wager: "$25,000",  reward: "$150" },
            { wager: "$50,000",  reward: "$325" },
            { wager: "$100,000", reward: "$700" },
            { wager: "$250,000", reward: "TiltBros VIP (open a ticket)" },
          ],
          note: "Milestones reset at the start of each month. Claim by opening a ticket in Discord once you hit a tier.",
        },
        {
          type: "list", title: "Getting Started",
          bullets: [
            "Sign up on Duelbits using code TILTBROS",
            "Type !verify in Kick chat to link your casino account",
            "Wager, and the leaderboard, raffle tickets and milestones all track automatically",
          ],
        },
      ],
    },
    // Bespoke-page-only content (see the `content` passthrough in
    // buildPortalConfig). None of this is used by the standard portal.
    content: {
      raffles: {
        headline: "Weekly Wager Raffle",
        blurb:    "Every 1,000 wagered under code TILTBROS earns you one ticket. More wager, more tickets, better odds.",
        drawLine: "Drawn live on Kick every Monday",
        // Short form for the rotating banner overlay, where the full blurb
        // wouldn't fit on a lower third.
        prizeShort: "50/50 $200 buy",
        winnersPerDraw: 3,
        steps: [
          { icon: "🎰", title: "Wager on Duelbits", text: "Play under code TILTBROS. Every 1,000 wagered = 1 ticket." },
          { icon: "🎟️", title: "Tickets stack up",  text: "Tickets are counted automatically. Nothing to claim or enter." },
          { icon: "📺", title: "Drawn live",         text: "Three winners pulled live on stream every Monday." },
        ],
      },
      // "Support the code" promo panel at the top of the Bonuses view. The
      // browser mock-up is drawn in CSS by the page (themeable, crisp on
      // retina, and the cursor animates) — promoImage only fills the artwork
      // panel beside the form, and the panel falls back to a gradient when it's
      // null, so nothing looks broken until artwork is supplied.
      promo: {
        kicker:     "Bonuses",
        headline:   "Support the code",
        blurb:      "Play under code TILTBROS on Duelbits and claim your monthly wager rewards through the TiltBros Discord.",
        dealLabel:  "Exclusive deal",
        dealTitle:  "Duelbits × TiltBros",
        dealText:   "Every bet under code TILTBROS counts. Your weighted wager total unlocks milestone rewards every month.",
        offerLabel: "Main offer",
        offerTitle: "Monthly Wager Rewards",
        code:       "TILTBROS",
        ctaLabel:   "Claim bonus",
        ctaHref:    "https://duelbits.com/?a=tiltbros",
        howHref:    "https://discord.com/invite/thetiltbros",
        howLabel:   "How to claim?",
        // The real Duelbits sign-up modal with TiltBros' details filled in.
        // When set, the page frames it in browser chrome and overlays the
        // animated cursor on the Register button; when null it falls back to
        // the CSS-drawn mock-up so the panel never looks broken.
        promoImage: "/img/duelbits-register.png",
      },
      giveaways: {
        blurb: "Giveaways run live on stream, and most need no wager at all. Winners are logged here automatically as they're drawn.",
        // No per-winner prize VALUE is stored anywhere (winners_log records who
        // and when, not how much), so a lifetime total can't be computed from
        // data. Set it here by hand, or leave null and the tile is hidden —
        // never show a fabricated number.
        totalGivenAway: null,
        sinceLabel:     null,
      },
      bounties: {
        blurb: "Hit a bounty on stream and the payout is yours. Bounties are called out live and paid the same day.",
        items: [
          { icon: "🎯", title: "Slot Bounty",   text: "Land the listed multiplier on the called slot." },
          { icon: "💥", title: "Max Win",       text: "Hit a max win on any bonus bought on stream." },
          { icon: "🔥", title: "Community Goal", text: "Chat-wide targets. Everyone in chat gets paid when it lands." },
        ],
        note: "Bounties change often. Current ones are announced on stream and pinned in Discord.",
      },
      // Extra slides for the rotating banner overlay (/overlay-banner.html).
      // The prize-pool, live-standings, countdown and raffle slides are built
      // from live data automatically — these are the hand-written extras.
      banner: {
        slides: [
          { kicker: "Join the community", big: "DISCORD",  sub: "Ticket support · bonus drops · raffle pings", left: "💬", right: "🔔", style: "plain" },
          { kicker: "Wager rewards",      big: "MILESTONES", sub: "Hit a tier, open a ticket, get paid",        left: "🎯", right: "💸", style: "plain" },
        ],
      },
      // Top scrolling strip (/overlay-banner.html?layout=marquee). Order here is
      // the order it scrolls. `kind: "site"` gets the highlighted pill, "code"
      // the gold treatment; everything else is a plain icon + label.
      marquee: {
        website: "TILTBROS.COM",
        // iconUrl wins over the built-in glyphs. Files live in /img/ (same
        // origin, so the overlay CSP allows them). The X mark is still the
        // lettermark — drop an x-logo.png in /img/ and add its iconUrl here.
        items: [
          { icon: "kick",    iconUrl: "/img/kick-logo.png",    text: "kick.com/thetiltbros" },
          { icon: "x",       text: "@Mrnoface7420" },
          { icon: "site",    iconUrl: "/img/tiltbros-logo.png", text: "TILTBROS.COM", kind: "site" },
          { icon: "discord", iconUrl: "/img/discord-logo.png", text: "discord.gg/thetiltbros" },
          { icon: "x",       text: "@DonTheLizard" },
          { icon: "code",    text: "JOIN CODE TILTBROS", kind: "code" },
        ],
      },
      responsible: "18+ only. Gamble responsibly, and never wager more than you can afford to lose.",
      // FAQ accordion. Answers restate the mechanics that live elsewhere on the
      // page, so a player never has to hunt — keep them in sync with the raffle
      // rules and prize list above if those change.
      faq: {
        kicker:   "FAQ",
        headline: "Frequently asked questions",
        blurb:    "Quick answers before you ask in chat.",
        items: [
          {
            q: "What bonuses are available?",
            a: "Players under code TILTBROS on Duelbits get Monthly Wager Rewards, claimed by opening a ticket in Discord. The monthly leaderboard runs alongside it. Full details are on the Bonuses page.",
          },
          {
            q: "How does the leaderboard work?",
            a: "Wager on Duelbits under code TILTBROS and your volume ranks you automatically. The top 10 get paid, and the board resets each month so every race starts level.",
          },
          {
            q: "How do raffles work?",
            a: "Wagering under code TILTBROS earns points, and every 1,000 points is one raffle ticket, counted automatically from the leaderboard, with nothing to enter. Three winners are drawn live on the Kick stream every Monday.",
          },
          {
            q: "How do I link my casino account?",
            a: "Type !verify in the Kick chat and follow the link. That ties your Duelbits account to your Kick name so wager-based rewards and raffle tickets track to you.",
          },
          {
            q: "When do payouts land?",
            a: "Leaderboard prizes are paid once the month closes and the final board is confirmed. Raffle and bounty wins are paid the same day they're drawn. Open a Discord ticket if anything is missing.",
          },
        ],
      },
      // "Stay in touch" — explicit list, because the channel fronts several
      // accounts across platforms that streamer.socials can't represent.
      socialsSection: {
        kicker:   "Socials",
        headline: "Stay in touch",
        blurb:    "Raffle calls, bonus drops and going-live pings land here first.",
        items: [
          { handle: "thetiltbros",   platform: "Kick",        icon: "K",  href: "https://kick.com/thetiltbros" },
          { handle: "@donthelizard", platform: "X / Twitter", icon: "𝕏",  href: "https://x.com/donthelizard" },
          { handle: "@mrnoface7420", platform: "X / Twitter", icon: "𝕏",  href: "https://x.com/mrnoface7420" },
          { handle: "thetiltbros",   platform: "Discord",     icon: "💬", href: "https://discord.com/invite/thetiltbros" },
        ],
      },
      // Footer. Quick Links are generated from the nav, so they can't drift out
      // of sync with the sections that actually exist. Partners and Socials are
      // listed explicitly because a channel can front several accounts (two X
      // handles here) that no auto-derivation would get right.
      footer: {
        disclaimer: "We take no responsibility for losses incurred on any casino or betting site linked or promoted here. You alone are responsible for your bets. 18+ only. Play responsibly.",
        partners: [
          { label: "Duelbits", href: "https://duelbits.com/?a=tiltbros" },
        ],
        socials: [
          { label: "Kick",         href: "https://kick.com/thetiltbros" },
          { label: "Donny on X",   href: "https://x.com/donthelizard" },
          { label: "NoFace on X",  href: "https://x.com/mrnoface7420" },
          { label: "Discord",      href: "https://discord.com/invite/thetiltbros" },
        ],
        bottomNote: "Play under code TILTBROS. Gamble aware.",
      },
    },
    brandCredit: true,
  },
};

// Resolve a preset across a streamer's current slug and every slug they have
// previously used. Keyed lookups break silently on a rename: the branding just
// disappears and nobody connects it to the name change weeks earlier.
function presetFor(channel, profile) {
  const tried = [
    channel,
    profile && profile.kickChannel,
    ...((profile && Array.isArray(profile.previousChannels)) ? profile.previousChannels : []),
  ];
  for (const key of tried) {
    if (!key) continue;
    const hit = PORTAL_PRESETS[String(key).toLowerCase()];
    if (hit) return hit;
  }
  return null;
}

// Themed-portal branding (palette/logo/hero/bg). Emitted for Elite+ (the full
// theme is an Elite perk) OR any white-label override (owner/preset/flag). Null
// otherwise, so Starter/Pro portals keep the default look.
// Shallow merge, keyed by section name: a stored section replaces the preset's
// section of the same name, and every other preset section survives untouched.
function mergeContent(presetContent, stored) {
  if (!presetContent && !stored) return null;
  return { ...(presetContent || {}), ...(stored || {}) };
}

// Rewards are {intro, sections[]}. Sections are matched on title so a streamer
// editing one ladder does not delete the others: a stored section replaces the
// preset section with the same title, and anything new is appended.
function mergeRewards(presetRewards, stored) {
  if (!presetRewards && !stored) return null;
  if (!presetRewards) return stored;
  if (!stored) return presetRewards;

  const key = (sec) => String((sec && sec.title) || "").trim().toLowerCase();
  const storedSections = Array.isArray(stored.sections) ? stored.sections : [];
  const byTitle = new Map(storedSections.map((sec) => [key(sec), sec]));

  const merged = (presetRewards.sections || []).map((sec) => byTitle.get(key(sec)) || sec);
  const usedTitles = new Set((presetRewards.sections || []).map(key));
  storedSections.forEach((sec) => { if (!usedTitles.has(key(sec))) merged.push(sec); });

  return {
    intro:    stored.intro    || presetRewards.intro    || "",
    footnote: stored.footnote || presetRewards.footnote || "",
    sections: merged,
  };
}

function buildPortalConfig(channel, profile, canBrand) {
  if (!canBrand) return null;
  // Presets are keyed by slug, so a rename would otherwise silently strip a
  // white-label client's branding. Try the current slug and every former one.
  const preset = presetFor(channel, profile) || {};
  const p      = profile.portal || {};
  // Prizes are set once in the dashboard (numeric per rank). When present they
  // drive the custom board too — formatted as "$N" strings the board renders
  // directly. Until a streamer sets them, the preset/override stands unchanged.
  const lbPrizes = Array.isArray(profile.leaderboardPrizes) ? profile.leaderboardPrizes : null;
  const dashPrizes = (lbPrizes && lbPrizes.length)
    ? lbPrizes.map((n) => (Number(n) > 0 ? "$" + Number(n).toLocaleString() : ""))
    : null;
  const prizes  = dashPrizes || p.prizes || preset.prizes || [];
  const hero    = { ...(preset.hero || {}), ...(p.hero || {}) };
  let   rewards = p.rewards  || preset.rewards || null;

  // ONE source of truth: the (dashboard-set) prize list drives BOTH the live
  // leaderboard badges AND the Wager Rewards "Weekly Leaderboard" tiles + its pool
  // subtitle + the hero headline — so a single dashboard change updates everything and
  // they can never drift apart. Clone rewards first; never mutate the shared preset.
  const list = prizes.filter(Boolean);
  const pool = list.reduce((s, v) => s + (parseFloat(String(v).replace(/[^0-9.]/g, "")) || 0), 0);
  if (pool > 0) {
    hero.prize = "$" + pool.toLocaleString();
    if (rewards && Array.isArray(rewards.sections)) {
      const ORD = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];
      rewards = {
        ...rewards,
        sections: rewards.sections.map((sec) =>
          sec && sec.type === "prizes"
            ? { ...sec,
                subtitle: "$" + pool.toLocaleString() + " prize pool",
                places:   list.map((amt, i) => ({ place: ORD[i] || `${i + 1}th`, amount: amt })) }
            : sec
        ),
      };
    }
  }

  return {
    theme:       { ...(preset.theme || {}), ...(p.theme || {}) },
    logoUrl:     p.logoUrl   || preset.logoUrl   || null,
    bannerUrl:   p.bannerUrl || preset.bannerUrl || null,
    bgImage:     p.bgImage   || preset.bgImage   || null,
    hero,
    prizes,
    links:       p.links     || preset.links     || [],
    pages:       p.pages     || preset.pages     || [],
    rewards,
    // Free-form presentational config for bespoke pages (raffle rules, bounty
    // lists, historical stats...). Deliberately un-shaped: every field above had
    // to be whitelisted here before a bespoke page could read it, which meant
    // editing this function for each new agency client. Anything a bespoke page
    // needs and the standard portal doesn't goes in here instead.
    // Stored content overrides the preset SECTION BY SECTION, never wholesale.
    //
    // This was `p.content || preset.content`, so the moment anything was written
    // to portal.content the entire preset stopped applying. Setting one figure on
    // TheTiltBros' giveaways tile emptied their FAQ, raffles, bounties, banner,
    // marquee, footer and socials copy in a single write, because all of it lived
    // in the preset and the preset was now being skipped.
    content:     mergeContent(preset.content, p.content),
    rewards:     mergeRewards(preset.rewards, p.rewards),
    brandCredit: p.brandCredit ?? preset.brandCredit ?? true,
  };
}

// Reserved channel names — these collide with our own routes/pages.
// The catch-all /:streamer rewrite in netlify.toml means a path like /dashboard
// could in theory route to a portal lookup. Static-file precedence usually wins,
// but we still 404 here so the namespace can't be shadowed and so we skip a
// pointless Firestore query.
const RESERVED_CHANNELS = new Set([
  "api", "auth", "admin", "_netlify", "netlify",
  "dashboard", "settings", "billing", "upgrade", "portal",
  "login", "signup", "logout",
  "verify", "verify-email", "verification-system",
  "discord-callback", "discord-verify-callback",
  "store", "leaderboard", "bonus-battle", "tournament",
  "setup", "terms", "privacy", "index",
  "overlay-giveaway", "overlay-slot-requests", "overlay-bonus-hunt",
  "overlay-bonus-battle", "overlay-tournament", "overlay-winner", "overlay-wheel",
]);

function res(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// Exposed for local preview tooling and tests only — the handler below stays
// the real entry point. Lets a preview render the EXACT preset a portal will
// ship with, instead of a hand-copied duplicate that silently drifts from it.
exports._internal = { PORTAL_PRESETS, buildPortalConfig };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing ?channel=" });
  if (RESERVED_CHANNELS.has(channel)) {
    return res(404, { error: "Channel not found on WenBot" });
  }

  try {
    const db = getDb();
    // COST GUARD: portals poll this every 60s; with many open portals each poll
    // was a heavy uncached read. Cache the whole (per-channel, NOT viewer-specific)
    // response so all portals share one computation per TTL. `_cache` is admin-SDK
    // only — clients can't read it.
    const PORTAL_CACHE_TTL_MS = 60 * 1000;
    const cacheRef = db.collection("_cache").doc(`portal_${channel}`);
    try {
      const c = await cacheRef.get();
      if (c.exists && c.data().data && (Date.now() - c.data().cachedAt) < PORTAL_CACHE_TTL_MS) return res(200, c.data().data);
    } catch { /* cache miss → compute fresh */ }

    let snap = await db.collection("streamers")
      .where("kickChannel", "==", channel).limit(1).get();

    // A streamer who renames on Kick keeps every old link, bookmark, custom
    // domain and hardcoded preset key pointing at their PREVIOUS slug. Those
    // would all 404 the moment they changed their name, which is exactly what
    // happened when irishqueenoftheslots became meggambles: the doc corrected
    // itself, and the portal kept asking for a channel that no longer existed.
    //
    // Every slug they have ever had is recorded, so an old address still
    // resolves to the same account instead of dying.
    if (snap.empty) {
      snap = await db.collection("streamers")
        .where("previousChannels", "array-contains", channel).limit(1).get();
    }
    if (snap.empty) return res(404, { error: "Channel not found on WenBot" });

    const streamer = snap.docs[0];
    const uid      = streamer.id;
    const profile  = streamer.data();

    if (profile.portalEnabled === false) {
      return res(404, { error: "Portal not available" });
    }

    // Per-board config from Firestore (streamers/{uid}/leaderboards). Falls back
    // to PORTAL_PRESETS / leaderboardPeriod for anyone not migrated, so this can
    // ship before every reader and the dashboard UI exist.
    let boards = [];
    try {
      const bSnap = await streamer.ref.collection("leaderboards").get();
      boards = sortBoards(bSnap.docs.map((d) => normalizeBoard(d.data(), d.id)));
    } catch (e) { console.warn("[portal-data] boards load failed:", e.message); }
    const boardFor = (provider) => boards.find((b) => b.provider === provider) || null;

    // Present a board in the legacy `leaderboardPeriod` shape so applyPeriod(),
    // fetchRainbetForPeriod() and applyRainbetExclusions() keep working untouched
    // — the board document becomes another way to SOURCE a period, not a second
    // set of period mechanics to maintain.
    //
    // Empty baselines/carryover/exclusions are collapsed back to null on purpose:
    // applyPeriod short-circuits on `!baselines && !carryover && !excluded.size`,
    // and `{}` is truthy, so passing empty objects would push provider-mode boards
    // (the five streamers who follow the casino's own window) down the merge path
    // they skip today.
    const periodOfBoard = (board) => {
      if (!board) return null;
      const win  = boardWindow(board);
      const some = (o) => (o && Object.keys(o).length ? o : null);
      // A provider-mode board with no window and no adjustments IS "no period" —
      // return null rather than an object of nulls, or `leaderboardTimer` flips
      // from null to a truthy object and the portal renders an empty countdown
      // for the streamers who simply follow the casino's own window.
      const bare = !win && !board.period.startAt && !board.period.endAt &&
        !some(board.baselines) && !some(board.dayBaselines) &&
        !some(board.carryover) && !board.excluded.length;
      if (bare) return null;
      return {
        active:    board.period.active,         // a finished race stops applying its baselines
        duration:  board.period.duration,
        autoRenew: board.period.autoRenew,
        startAt:   win ? win.from : board.period.startAt,
        endAt:     win ? win.to   : board.period.endAt,
        baselines:    some(board.baselines),
        dayBaselines: some(board.dayBaselines),
        carryover:    some(board.carryover),
        liveSnapshot: some(board.liveSnapshot),
        excluded:     board.excluded,
        anchorMonth:  board.anchorMonth,
        carryMonth:   board.carryMonth,
      };
    };

    const isOwner    = OWNER_CHANNELS.has(channel);
    const presetMain = presetFor(channel, profile) || {};
    // White-label override = owner, a seeded preset, a manual Firestore flag, or
    // the agency plan. These get full agency-tier FEATURES (every section) +
    // branding, regardless of what they pay — used for comps like SKSlots.
    const whiteLabel = isOwner
      || presetFor(channel, profile) != null
      || profile.whiteLabel === true
      || tierOf(profile.plan) >= TIER_RANK.agency;
    // An expired Elite trial reverts to starter for entitlements. The daily
    // expire-trials sweep flips the stored plan; this guards the window before it runs.
    const _trialEnd = profile.trialEndsAt && profile.trialEndsAt.toMillis
      ? profile.trialEndsAt.toMillis() : Number(profile.trialEndsAt) || 0;
    const trialExpired = profile.planTrial === true && _trialEnd > 0 && _trialEnd <= Date.now();
    const basePlan = trialExpired ? "starter" : (profile.plan || "starter");
    const plan = (isOwner || whiteLabel) ? "agency" : basePlan;
    const tier = tierOf(plan);

    // Portal branding (palette/logo/hero/bg) is an Elite+ perk, also unlocked by
    // any white-label override above (owner / preset / flag / agency). The
    // agency-only "white-label" piece is bespoke portals (custom domain, custom
    // sections, removed WenBot credit) — handled separately, not here.
    const canBrand = whiteLabel || tier >= TIER_RANK.elite;

    // Portal is a Pro+ feature. Starter has no public portal at all.
    // (Pro = basic portal: store + raffle winners + giveaway.
    //  Elite = full portal: + live leaderboard + bonus battle/tournament + theme.)
    if (tier < TIER_RANK.pro) {
      // Portal access ends with the plan, bespoke ones included. What the VIEWER
      // sees should not be a broken page though: they did nothing wrong, they
      // followed a link their streamer gave them, and a dead page reads as the
      // streamer being unreliable rather than as a lapsed subscription.
      //
      // The Kick handle is included so the message can point somewhere useful.
      // Nothing about the plan, the billing or the reason is exposed: that is
      // between the streamer and us, not something to publish to their chat.
      return res(404, {
        error:       "Portal not available on this plan",
        unavailable: true,
        displayName: profile.displayName || profile.kickChannel || null,
        kickChannel: profile.kickChannel || null,
        message:     "This page is currently disabled.",
        contactHint: profile.kickChannel
          ? `Reach out to @${profile.kickChannel} on Kick for details.`
          : "Reach out to the streamer for details.",
      });
    }

    // A white-label preset's provider wins (these are comped, code-configured
    // clients); otherwise the streamer's dashboard choice. Never assume Gambulls —
    // if none is set, leave it empty so the portal simply shows no casino section.
    const provider = (presetMain.provider || profile.activeProvider || "").toLowerCase();
    // The primary board's period, falling back to the streamer doc for anyone the
    // migration hasn't reached. Same value everywhere the old code read
    // profile.leaderboardPeriod, so the two sources can't disagree mid-request.
    const mainPeriod = periodOfBoard(boardFor(provider)) || profile.leaderboardPeriod || null;

    // Public-safe streamer info. Anything sensitive is NOT included here.
    const publicProfile = {
      displayName: profile.displayName || profile.kickChannel,
      kickChannel: profile.kickChannel,
      bio:         profile.bio || null,
      logoUrl:     profile.kickAvatar || null,
      provider,
      providerName: provider ? (CASINO_NAMES[provider] || provider) : null,
      // Verify-page policy: when false the viewer can skip the casino step.
      // Exposed here so verify.html can show the Skip button immediately
      // (verify-status confirms it authoritatively but needs a Kick lookup).
      casinoRequired: profile.casinoRequired !== false,
      currency:    profile.currencyName || "points",
      plan,
      // Theme color only honored for Elite+ — keeps the upsell intact while
      // Starter/Pro see the default brand color.
      themeColor:  tier >= TIER_RANK.elite ? (profile.themeColor || null) : null,
      socials: {
        kick:    `https://kick.com/${encodeURIComponent(profile.kickChannel)}`,
        discord: profile.socials?.discord || null,
        youtube: profile.socials?.youtube || null,
        twitter: profile.socials?.twitter || null,
      },
    };

    // Always-available: active-state banners. Giveaway is a Starter feature.
    const active = {
      giveaway: profile.giveawayActive ? {
        keyword: profile.giveawayKeyword || "!join",
        type:    profile.giveawayType    || "everyone",
      } : null,
      bonusHunt:  null,
      battle:     null,
      tournament: null,
    };

    // Pro+ features
    let store        = null;
    let pastWinners  = null;
    let giveawayWinners = null;
    // Live bounties for the portal's Bounties section. Only ACTIVE ones are
    // public — completed and closed bounties stay in the dashboard and Discord.
    let bounties = null;
    if (tier >= TIER_RANK.pro) {
      const [itemsSnap, winnersSnap, gwSnap, bountySnap] = await Promise.all([
        db.collection("streamers").doc(uid).collection("store_items")
          .where("enabled", "==", true).get(),
        db.collection("streamers").doc(uid).collection("raffle_history")
          .orderBy("drawnAt", "desc").limit(20).get(),
        // Giveaway draw winners (separate store). orderBy on the single drawnAt
        // field is auto-indexed; filter to giveaway type in JS.
        // Read a wider slice than we display: this one query feeds BOTH the
        // giveaway list and the raffle list, and filtering a 30-record window by
        // type let a busy raffle channel show zero giveaways.
        db.collection("streamers").doc(uid).collection("winners_log")
          .orderBy("drawnAt", "desc").limit(80).get(),
        db.collection("streamers").doc(uid).collection("bounties")
          .where("status", "==", "active").limit(20).get(),
      ]);
      store = {
        items: itemsSnap.docs.map(d => {
          const item = d.data();
          return {
            id:           d.id, // needed for web "click to buy" (/api/store-buy)
            name:         item.name,
            description:  item.description || null,
            price:        item.price || 0,
            stock:        (item.stock === undefined || item.stock === null) ? null : item.stock,
            isRaffleItem: item.isRaffleItem === true,
            imageUrl:     item.imageUrl || null,
          };
        }).sort((a, b) => (a.price || 0) - (b.price || 0)),
      };
      // Raffle winners come from raffle_history ONLY.
      //
      // Do NOT merge in winners_log entries of type "raffle": that type is
      // written by the SLOT REQUEST spinner, which records whose slot got played
      // (every row carries a slotName and wager 0). They are not raffle winners,
      // and publishing them as such put 20 slot picks, test spins included, on
      // TheTiltBros' public winners list. A channel with no raffle draws should
      // read as having none.
      pastWinners = winnersSnap.docs.map(d => {
        const w = d.data();
        return { winner: w.winner, mode: w.mode, itemName: w.itemName || null, drawnAt: w.drawnAt };
      });

      bounties = bountySnap.docs
        .map(d => d.data())
        .map(b => ({
          game:      b.game || "",
          objective: b.objective || "",
          prize:     b.prize || "",
          deadline:  b.deadline || null,
          extraRule: b.extraRule || null,
          howTo:     b.howTo || null,
          imageUrl:  b.imageUrl || null,
          createdAt: b.createdAt || null,
        }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      giveawayWinners = gwSnap.docs
        .map(d => d.data())
        .filter(w => (w.type || "giveaway") === "giveaway")
        .slice(0, 20)
        .map(w => ({ winner: w.username, drawnAt: w.drawnAt }));
    }

    // Elite+ features: live leaderboard, bonus battle / tournament state
    let leaderboard = null;
    // Raw, pre-period casino totals, kept for the wager raffle. The raffle counts
    // from its OWN snapshot taken when the streamer started the period, so it must
    // not see the leaderboard's period baselines subtracted first or every total
    // arrives already reduced and tickets read low. Captured from the response we
    // fetch anyway, so this costs no extra call.
    let raffleRaw = null;
    let leaderboard2 = null; // secondary switchable board (e.g. CSGOBig)
    // Every additional board beyond the primary, in display order. leaderboard2 is
    // kept alongside it because Meg's bespoke portal renders that field directly;
    // new portals read `boards` and can show any number.
    let extraBoards = [];
    let leaderboardPeriods = null; // past monthly winners
    if (tier >= TIER_RANK.elite) {
      // Degen passthrough — the live race (period + per-rank prizes) comes straight
      // from Degen's keyless public API (referral code in the URL); no WenBot
      // baselines/periods/prizes apply.
      if (provider === "degen") {
        const provDoc = await db.collection("streamers").doc(uid)
          .collection("providers").doc("degen").get();
        const code = (provDoc.exists ? (provDoc.data().referralCode || provDoc.data().apiKey) : null) || presetMain.degenReferralCode;
        if (code) {
          try {
            const race = await fetchDegenRace(code);
            if (race) {
              leaderboard = {
                period:       race.raceName || "Degen Race",
                casinoName:   "Degen",
                startAt:      race.startAt,
                endAt:        race.endAt,
                prizePool:    race.prizePool,
                fiat:         race.fiat,
                rankings:     race.rankings.map((r) => ({
                  rank:        r.rank,
                  name:        r.username,
                  wagerAmount: r.wagered,
                  avatarUrl:   r.avatarUrl,
                  prize:       r.prize,
                })),
                totalUsers:   race.totalUsers,
                totalWagered: race.totalWagered,
              };
              // Archive finished races into leaderboard_periods (Winners page).
              // Degen's API only serves the CURRENT race, so we keep the last-seen
              // standings in _cache and snapshot them when the race identity flips.
              try {
                const dRef = db.collection("_cache").doc(`degen_race_${code}`);
                const dSnap = await dRef.get();
                const prev = dSnap.exists ? dSnap.data() : null;
                const raceChanged = prev && prev.endAt &&
                  (prev.endAt !== leaderboard.endAt || prev.period !== leaderboard.period);
                if (raceChanged && Array.isArray(prev.rankings) && prev.rankings.length) {
                  await db.collection("streamers").doc(uid).collection("leaderboard_periods")
                    .doc(`degen_${prev.endAt}`).set({
                      casino: "degen", casinoName: "Degen",
                      period:  prev.period || "Degen Race",
                      endDate: prev.endAt,
                      winners: prev.rankings.slice(0, 10).map((r) => ({
                        rank: r.rank, username: r.name, wagered: r.wagerAmount || 0,
                        prize: r.prize || 0, avatarUrl: r.avatarUrl || null,
                      })),
                    }, { merge: true });
                }
                await dRef.set({ period: leaderboard.period, endAt: leaderboard.endAt,
                  rankings: leaderboard.rankings, cachedAt: Date.now() });
              } catch (err) { console.warn("[portal-data] degen archive failed:", err.message); }
            }
          } catch (err) {
            console.warn("[portal-data] degen fetch failed:", err.message);
          }
        }
      }
      // Rainbet: key + date range (the range IS the period, so no baselines /
      // carryover — only manual exclusions apply). Cached 45s per channel so a
      // busy portal can't hammer the streamer's key.
      else if (provider === "rainbet") {
        const provDoc = await db.collection("streamers").doc(uid)
          .collection("providers").doc("rainbet").get();
        const rbKey = provDoc.exists ? (provDoc.data().apiKey || "") : "";
        if (rbKey) {
          try {
            const cacheRef = db.collection("_cache").doc(`lb_${channel}_rainbet_live`);
            let data = null, cachedDoc = null;
            try {
              const c = await cacheRef.get();
              if (c.exists) {
                cachedDoc = c.data();
                if (cachedDoc.data && cachedDoc.cachedAt && (Date.now() - cachedDoc.cachedAt) < 45_000) data = cachedDoc.data;
              }
            } catch {}
            if (!data) {
              data = await fetchRainbetForPeriod(rbKey, mainPeriod);
              if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
              else if (cachedDoc?.data) data = cachedDoc.data;
            }
            if (data) {
              const applied  = applyRainbetExclusions(data, mainPeriod);
              const lbPrizes = Array.isArray(profile.leaderboardPrizes) ? profile.leaderboardPrizes : [];
              leaderboard = {
                period:   { from: data.from, to: data.to },
                rankings: applied.rankings.map((r) => ({
                  rank:        r.rank,
                  name:        r.username,
                  wagerAmount: r.wagered || 0,
                  avatarUrl:   null,
                  prize:       Number(lbPrizes[r.rank - 1]) > 0 ? Number(lbPrizes[r.rank - 1]) : 0,
                })),
                totalUsers:   applied.totalUsers,
                totalWagered: applied.totalWagered,
              };
            }
          } catch (err) {
            console.warn("[portal-data] rainbet fetch failed:", err.message);
          }
        }
      }
      else if (provider === "duelbits") {
        const provDoc = await db.collection("streamers").doc(uid)
          .collection("providers").doc("duelbits").get();
        const cred = provDoc.exists ? provDoc.data() : {};
        if (cred.affiliateId && cred.password) {
          try {
            const cacheRef = db.collection("_cache").doc(`lb_${channel}_duelbits_${(mainPeriod && mainPeriod.startAt) || "cycle"}`);
            let data = null, cachedDoc = null;
            try {
              const c = await cacheRef.get();
              if (c.exists) {
                cachedDoc = c.data();
                if (cachedDoc.data && cachedDoc.cachedAt && (Date.now() - cachedDoc.cachedAt) < 45_000) data = cachedDoc.data;
              }
            } catch {}
            if (!data) {
              data = await fetchDuelbitsForPeriod(cred.affiliateId, cred.password, mainPeriod);
              if (data) { try { await cacheRef.set({ cachedAt: Date.now(), data }); } catch {} }
              else if (cachedDoc?.data) data = cachedDoc.data;
            }
            // After the cache, never before the write: what's stored stays the
            // raw casino response, so changing a baseline doesn't need a bust.
            if (data && Array.isArray(data.rankings)) raffleRaw = data.rankings.slice();
            data = applyDuelbitsPeriod(data, mainPeriod);
            if (data) {
              const lbPrizes = Array.isArray(profile.leaderboardPrizes) ? profile.leaderboardPrizes : [];
              // No baselines/carryover here, unlike Gambulls: Duelbits owns the
              // cycle and exposes no date parameters, so the standings ARE the
              // period. Re-basing them against a WenBot window would silently
              // disagree with the streamer's own Duelbits page.
              leaderboard = {
                period:   null,
                rankings: data.rankings.map((r, i) => ({
                  rank:        r.rank || i + 1,
                  name:        r.username,
                  // The board ranks on weighted points, so that's what a prize
                  // position is decided by. Raw volume rides along for display.
                  wagerAmount: r.wagered || 0,
                  betAmount:   r.betAmount || 0,
                  avatarUrl:   null,
                  prize:       lbPrizes[i] || null,
                })),
                totalUsers:   data.totalUsers,
                totalWagered: data.totalWagered,
                weighted:     true,
                updatedAt:    data.cacheUpdatedAt || null,
              };
            }
          } catch (err) {
            console.warn("[portal-data] duelbits fetch failed:", err.message);
          }
        }
      }
      // Live leaderboard via the streamer's stored casino API key (server-side only)
      else if (GAMBULLS_BOARD_ONLY.has(provider)) {
        const provDoc = await db.collection("streamers").doc(uid)
          .collection("providers").doc(provider).get();
        if (provDoc.exists && provDoc.data().apiKey) {
          try {
            const fetchResp = await fetch(
              `https://api.gambulls.com/api/public/streamer/leaderboard?type=monthly&limit=100`,
              { headers: { "x-streamer-api-key": provDoc.data().apiKey, "Accept": "application/json" } }
            );
            if (fetchResp.ok) {
              const data = await fetchResp.json();
              if (data.success && data.responseObject?.rankings) {
                // Apply the SAME period logic the dashboard/standard portal use
                // (baselines + carryover + exclusions), so a custom-date snapshot
                // carries over seamlessly here. Without this the portal showed
                // raw monthly totals (≈$0 right after a Gambulls month reset).
                const raw = {
                  rankings:     normalizeGambulls(data.responseObject),
                  totalUsers:   data.responseObject.totalUsers || 0,
                  totalWagered: data.responseObject.totalWagered || 0,
                };
                const applied = applyPeriod(raw, mainPeriod);
                const lbPrizes = Array.isArray(profile.leaderboardPrizes) ? profile.leaderboardPrizes : [];
                leaderboard = {
                  period:       data.responseObject.period,
                  rankings:     applied.rankings.map((r) => ({
                    rank:        r.rank,
                    name:        r.username,
                    wagerAmount: r.wagered || 0,
                    avatarUrl:   r.avatarUrl || null,
                    // Prize for this rank from the streamer's dashboard config (0 = unpaid).
                    prize:       Number(lbPrizes[r.rank - 1]) > 0 ? Number(lbPrizes[r.rank - 1]) : 0,
                  })),
                  totalUsers:    applied.totalUsers,
                  totalWagered:  applied.totalWagered,
                };
              }
            }
          } catch (err) {
            console.warn("[portal-data] leaderboard fetch failed:", err.message);
          }
        }
      }

      // Secondary, switchable leaderboard: CSGOBig (keyless partner API; ref code in
      // the preset). Whenever the ref code is configured we ALWAYS expose this board
      // — even empty — so the portal's Degen/CSGOBig switch is permanent and never
      // flickers with API availability. CSGOBig rate-limits hard (~15 min), so cache
      // 10 min in _cache and serve the last good copy on any failure; if there's no
      // data at all the board simply shows "no wager data yet" under a live toggle.
      // Board doc wins; the preset is the fallback until everyone is migrated.
      const cbBoard  = boardFor("csgobig");
      const cbRef    = (cbBoard && cbBoard.credential && cbBoard.credential.refCode) || presetMain.csgobigRefCode;
      const cbLadder = (cbBoard && cbBoard.prizes && cbBoard.prizes.length) ? cbBoard.prizes : presetMain.csgobigPrizes;

      if (cbRef && !(cbBoard && cbBoard.enabled === false)) {
        const now  = new Date();
        // Window from the board's period when it has one, else the preset's
        // cycle/pinned dates, else the calendar month as a last resort.
        const bWin = cbBoard ? boardWindow(cbBoard, Date.now()) : null;
        const cyc  = bWin ? bWin
          : (presetMain.csgobigCycleDay ? csgobigCycleWindow(presetMain.csgobigCycleDay, Date.now()) : null);
        const from = bWin ? bWin.from : (presetMain.csgobigFrom || (cyc ? cyc.from : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)));
        // Clamp to "now": a pinned race END is in the future while the race runs,
        // and CSGOBig returns nothing for a future `to`. The race window still
        // drives the countdown via raceEnd below; this is only the query bound.
        const to   = Math.min(bWin ? bWin.to : (presetMain.csgobigTo || Date.now()), Date.now());
        // Race END for the countdown = end of the calendar month (last ms), which
        // is distinct from `to` (the up-to-now query window for current standings).
        const raceEnd = bWin ? bWin.to : (presetMain.csgobigTo || (cyc ? cyc.to : (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0) - 1)));
        // Rank-indexed prize ladder (coins) from the preset.
        const cbPrizes = Array.isArray(cbLadder) ? cbLadder : [];
        const cbPrizeFor = (rank) => (Number(cbPrizes[rank - 1]) > 0 ? Number(cbPrizes[rank - 1]) : 0);
        // Base (empty) board — keeps the switch visible regardless of the fetch.
        leaderboard2 = {
          key: "csgobig", label: "CSGOBig", casinoName: "CSGOBig", period: "Monthly Race",
          startAt: from, endAt: raceEnd, rankings: [], totalUsers: 0, totalWagered: 0,
          prizePool: cbPrizes.reduce((s, v) => s + (Number(v) || 0), 0), // coins
        };
        try {
          // Key on the RACE WINDOW, not the month. A 16th→16th race spans two
          // calendar months, so a month key split one race across two cache docs
          // — and worse, after pinning a window the old month doc would still be
          // served, showing the wrong totals. Window-keyed means changing the race
          // window naturally invalidates the cache.
          const key = `csgobig_${cbRef}_${from}-${raceEnd}`;
          const cacheRef = db.collection("_cache").doc(key);
          // 20-min TTL: CSGOBig's rate limit is keyed PER REF CODE (not per IP), so
          // every consumer of her code shares one quota. Their 429 penalty appears
          // to RESET on each blocked attempt — so on a stale cache we must not let
          // every page hit retry upstream (that starves the quota forever). One
          // attempt per 16 min, tracked via lastAttemptAt; everyone else gets stale.
          let cb = null, cdoc = null;
          try { const c = await cacheRef.get(); if (c.exists) cdoc = c.data(); } catch {}
          if (cdoc && cdoc.data && (Date.now() - cdoc.cachedAt) < 20 * 60 * 1000) cb = cdoc.data;
          if (!cb) {
            const lastTry = (cdoc && cdoc.lastAttemptAt) || 0;
            if (Date.now() - lastTry > 16 * 60 * 1000) {
              try { await cacheRef.set({ lastAttemptAt: Date.now() }, { merge: true }); } catch {}
              const race = await fetchCsgobigRace(cbRef, from, to);
              if (race) { cb = race; try { await cacheRef.set({ cachedAt: Date.now(), data: race }, { merge: true }); } catch {} }
            }
            if (!cb && cdoc && cdoc.data) cb = cdoc.data; // serve stale
          }
          if (cb) {
            leaderboard2.rankings     = (cb.rankings || []).map((r) => ({ rank: r.rank, name: r.username, wagerAmount: r.wagered, avatarUrl: r.avatarUrl, prize: cbPrizeFor(r.rank) }));
            leaderboard2.totalUsers   = cb.totalUsers;
            leaderboard2.totalWagered = cb.totalWagered;
            leaderboard2.raw0         = cb.raw0 || null; // full field set of the top entry (diagnostics)
          }
        } catch (err) { console.warn("[portal-data] csgobig fetch failed:", err.message); }

        // Archive a race's final standings once it has ACTUALLY ENDED.
        //
        // This used to fire on the calendar-month roll, which declared winners for
        // a race that was still running: on 1 Aug 2026 it published 13 "July
        // Monthly Race" winners with prizes while the real race ran to 16 Aug.
        //
        // With a rolling cycle the window flips ON the cycle day, so the race that
        // just finished is the PREVIOUS window — archiving the current one would
        // never fire. With an explicit From/To we archive that window once it has
        // passed. With neither we don't archive at all: no window means we don't
        // know when the race ends, and guessing is what caused the incident.
        try {
          let aFrom = null, aTo = null;
          if (cyc)                                   { aFrom = cyc.prevFrom; aTo = cyc.prevTo; }
          else if ((bWin || presetMain.csgobigTo) && Date.now() > raceEnd) { aFrom = from; aTo = raceEnd; }

          if (aFrom && aTo && Date.now() > aTo) {
            const aRef  = db.collection("_cache").doc(`csgobig_${cbRef}_${aFrom}-${aTo}`);
            const aSnap = await aRef.get();
            const ad    = aSnap.exists ? aSnap.data() : null;
            if (ad && !ad.archived && ad.data && (ad.data.rankings || []).length) {
              const fmt = (ms) => new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
              await db.collection("streamers").doc(uid).collection("leaderboard_periods")
                .doc(`csgobig_${aFrom}-${aTo}`).set({
                  casino: "csgobig", casinoName: "CSGOBig",
                  period:  `${fmt(aFrom)} – ${fmt(aTo)} Race`,
                  startAt: aFrom,
                  endDate: aTo,
                  winners: ad.data.rankings.slice(0, 13).map((r) => ({
                    rank: r.rank, username: r.username, wagered: r.wagered,
                    prize: cbPrizeFor(r.rank), avatarUrl: r.avatarUrl || null,
                  })),
                }, { merge: true });
              await aRef.set({ archived: true }, { merge: true });
            }
          }
        } catch (err) { console.warn("[portal-data] csgobig archive failed:", err.message); }
      }

      // ── Additional boards, any provider ────────────────────────────────────
      //
      // The block above handles CSGOBig specifically (its cache and archive
      // behaviour are load-bearing and deliberately left alone). This builds every
      // OTHER extra board a streamer has configured, so adding a second race is a
      // dashboard action rather than a code change — which is the whole point of
      // boards being data.
      //
      // Each board is independent: its own credential, window and prize ladder. A
      // failure is contained to that board, so one dead API can't take down the
      // portal or the other races.
      try {
        // Exclude the PRIMARY BOARD by id, not every board on that casino. Filtering
        // by provider silently dropped a second race on the same casino — which is
        // the most ordinary case there is (two Gambulls races on different
        // schedules), and it would have looked like the board simply didn't work.
        const primaryBoard = boardFor(provider);
        const extras = boards.filter((b) =>
          b.provider && b.provider !== "csgobig" && b.id !== (primaryBoard && primaryBoard.id));
        for (const b of extras) {
          const win  = boardWindow(b);
          const from = win ? win.from : (b.period.startAt || null);
          const to   = win ? win.to   : (b.period.endAt   || null);
          const ladder   = Array.isArray(b.prizes) ? b.prizes : [];
          const prizeFor = (rank) => (Number(ladder[rank - 1]) > 0 ? Number(ladder[rank - 1]) : 0);

          const entry = {
            key: b.id, label: b.label || CASINO_NAMES[b.provider] || b.provider,
            casinoName: CASINO_NAMES[b.provider] || b.provider,
            period: "Race", startAt: from, endAt: to,
            rankings: [], totalUsers: 0, totalWagered: 0,
            prizePool: ladder.reduce((s, v) => s + (Number(v) || 0), 0),
          };

          try {
            // Credential on the board wins; otherwise inherit providers/{provider}
            // so a streamer who already configured that casino doesn't re-enter a key.
            let cred = (b.credential && (b.credential.apiKey || b.credential.refCode
              || b.credential.apiToken || b.credential.token)) || null;
            if (!cred) {
              const pd = await db.collection("streamers").doc(uid).collection("providers").doc(b.provider).get();
              if (pd.exists) cred = pd.data().apiKey || pd.data().referralCode || pd.data().token || null;
            }
            if (!cred) { extraBoards.push(entry); continue; } // configured but unusable — still list it

            // Cached per board+window: extra boards are polled by every portal
            // visitor, and none of these APIs should be hit once per page view.
            const ckey = `board_${uid}_${b.id}_${from}-${to}`;
            const cref = db.collection("_cache").doc(ckey);
            let data = null, cdoc = null;
            try { const c = await cref.get(); if (c.exists) cdoc = c.data(); } catch {}
            if (cdoc && cdoc.data && (Date.now() - cdoc.cachedAt) < 5 * 60 * 1000) data = cdoc.data;

            if (!data) {
              if (b.provider === "degen") {
                const race = await fetchDegenRace(cred);
                if (race) data = { rankings: race.rankings.map((r) => ({ rank: r.rank, username: r.username, wagered: r.wagered, avatarUrl: r.avatarUrl })), totalUsers: race.totalUsers, totalWagered: race.totalWagered };
              } else if (b.provider === "rainbet" && from && to) {
                // Rainbet takes YYYY-MM-DD, not milliseconds — passing raw
                // timestamps silently returns nothing.
                const rb = await fetchRainbetRange(cred, rbYmd(from), rbYmd(to));
                if (rb) data = { rankings: (rb.rankings || []).map((r) => ({ rank: r.rank, username: r.username, wagered: r.wagered, avatarUrl: null })), totalUsers: rb.totalUsers, totalWagered: rb.totalWagered };
              } else if (b.provider === "clash") {
                // Clash owns the race: its period and prize ladder come back with
                // the standings, so the board inherits them rather than needing
                // them re-entered here.
                const cg = await fetchClashBoard(cred, b.credential && b.credential.leaderboardId);
                if (cg) data = {
                  rankings: (cg.rankings || []).map((r) => ({ rank: r.rank, username: r.username, wagered: r.wagered, avatarUrl: r.avatarUrl })),
                  totalUsers: cg.totalUsers, totalWagered: cg.totalWagered,
                  startAt: cg.startAt, endAt: cg.endAt, prizes: cg.prizes, raceName: cg.name,
                };
              } else if (b.provider === "gambulls") {
                const resp = await fetch("https://api.gambulls.com/api/public/streamer/leaderboard?type=monthly&limit=100",
                  { headers: { "x-streamer-api-key": cred, "Accept": "application/json" } });
                if (resp.ok) {
                  const j = await resp.json();
                  if (j.success && j.responseObject?.rankings) {
                    const rows = normalizeGambulls(j.responseObject);
                    data = { rankings: rows, totalUsers: j.responseObject.totalUsers || 0, totalWagered: j.responseObject.totalWagered || 0 };
                  }
                }
              }
              if (data) { try { await cref.set({ cachedAt: Date.now(), data }); } catch {} }
              else if (cdoc && cdoc.data) data = cdoc.data;   // serve stale over blank
            }

            if (data) {
              // A provider that owns the race (Clash) reports its own window and
              // ladder; use them unless the streamer set prizes of their own.
              if (data.startAt) entry.startAt = data.startAt;
              if (data.endAt)   entry.endAt   = data.endAt;
              if (data.raceName) entry.raceName = data.raceName;
              const own = ladder.length ? ladder : (Array.isArray(data.prizes) ? data.prizes : []);
              const prizeAt = (rank) => (Number(own[rank - 1]) > 0 ? Number(own[rank - 1]) : 0);
              entry.prizePool = own.reduce((s, v) => s + (Number(v) || 0), 0);

              entry.rankings     = (data.rankings || []).map((r) => ({
                rank: r.rank, name: r.username, wagerAmount: r.wagered || 0,
                avatarUrl: r.avatarUrl || null, prize: prizeAt(r.rank),
              }));
              entry.totalUsers   = data.totalUsers   || 0;
              entry.totalWagered = data.totalWagered || 0;
            }
          } catch (e) {
            console.warn(`[portal-data] extra board ${b.id} failed:`, e.message);
          }
          extraBoards.push(entry);
        }
      } catch (err) { console.warn("[portal-data] extra boards failed:", err.message); }

      // Past leaderboard periods (same data /api/leaderboard-winners exposes).
      // ALL casinos, not just the primary provider — a streamer can run multiple
      // boards (e.g. Meg's Degen + CSGOBig) and every finished period belongs on
      // the Winners page. Sort/slice in JS (no where → no index needed).
      try {
        const periodsSnap = await db.collection("streamers").doc(uid)
          .collection("leaderboard_periods")
          .get();
        leaderboardPeriods = periodsSnap.docs
          .map(d => d.data())
          .sort((a, b) => (b.endDate || 0) - (a.endDate || 0))
          .slice(0, 12)
          .map(p => ({
            period:     p.period || null,
            casino:     p.casino || provider,
            casinoName: p.casinoName || CASINO_NAMES[p.casino || provider] || p.casino || provider,
            winners:    Array.isArray(p.winners) ? p.winners.map(w => ({
              rank:      w.rank,
              username:  w.username,
              wagered:   w.wagered || 0,
              prize:     w.prize || 0,
              avatarUrl: w.avatarUrl || null,
            })) : [],
          }));
      } catch (err) {
        console.warn("[portal-data] leaderboard_periods fetch failed:", err.message);
      }
    } // end Elite-only leaderboard block

    // Active statuses. Bonus hunt is free; bonus battles + tournaments are Pro —
    // populate for any portal (portals are Pro+ anyway) so these "live" chips show.
    const [bhDoc, bbDoc, tnDoc] = await Promise.all([
        db.collection("streamers").doc(uid).collection("bonus_hunt").doc("current").get(),
        db.collection("streamers").doc(uid).collection("bonus_battles").doc("current").get(),
        db.collection("streamers").doc(uid).collection("tournaments").doc("current").get(),
      ]);

      if (bhDoc.exists && bhDoc.data().active) {
        active.bonusHunt = {
          totalCost: bhDoc.data().totalCost || 0,
          slotCount: (bhDoc.data().bonuses || []).length,
        };
      }
      if (bbDoc.exists && bbDoc.data().active) {
        active.battle = {
          matchCount: (bbDoc.data().matches || []).length,
        };
      }
      if (tnDoc.exists && tnDoc.data().active) {
        active.tournament = {
          status:       tnDoc.data().status,
          bracketSize:  tnDoc.data().bracketSize || 0,
          participants: (tnDoc.data().participants || []).length,
        };
      }

    // ── Wager raffle, for viewers ─────────────────────────────────────────────
    // Tickets are DERIVED, never stored: banked progress, plus whatever has been
    // wagered above the snapshot taken when the period started, divided by the
    // threshold. So this is arithmetic on data already in hand rather than
    // anything that needs a background job keeping a counter up to date.
    //
    // Read-only on purpose. The dashboard writes a lastSeen map when a streamer
    // opens the Raffles page, which is fine for one person; doing that here would
    // mean a Firestore write per viewer per page view.
    let wagerRafflePublic = null;
    try {
      const wr = profile.wagerRaffle || {};
      if (wr.periodStart && Array.isArray(raffleRaw) && raffleRaw.length) {
        const threshold = Number(wr.threshold) || 1000;
        const baselines = wr.baselines || {};
        const accrued   = wr.accrued   || {};
        const excluded  = new Set((wr.excluded || []).map((x) => String(x).toLowerCase()));

        // casino username -> Kick name, so entrants read as people rather than
        // masked casino handles.
        const names = {};
        try {
          const vs = await db.collection("streamers").doc(uid).collection("verified_users")
            .where("provider", "==", String(profile.activeProvider || "").toLowerCase()).get();
          vs.forEach((d) => {
            const v = d.data();
            if (v.providerUsername) names[String(v.providerUsername).toLowerCase()] = v.kickName || d.id;
          });
        } catch { /* names are a nicety; ticket counts are the point */ }

        const board = new Map();
        raffleRaw.forEach((r) => board.set(String(r.username || "").toLowerCase(), r));
        // Union with banked holders: someone who earned tickets before a board
        // reset and has not wagered since is absent from the new window, and
        // dropping them here would hide tickets they already hold.
        const keys = new Set([...board.keys(), ...Object.keys(accrued)]);

        const entrants = [];
        keys.forEach((k) => {
          if (!k || excluded.has(k)) return;
          const row     = board.get(k);
          const since   = (accrued[k] || 0) + Math.max(0, ((row && row.wagered) || 0) - (baselines[k] || 0));
          const tickets = Math.floor(since / threshold);
          if (tickets <= 0) return;
          entrants.push({
            name:       names[k] || (row ? row.username : k),
            casinoName: row ? row.username : k,
            wagerSince: since,
            tickets,
          });
        });
        entrants.sort((a, b) => b.tickets - a.tickets || b.wagerSince - a.wagerSince);

        wagerRafflePublic = {
          periodStart:  wr.periodStart,
          threshold,
          // Duelbits ranks on points (volume adjusted for house edge) and tickets
          // are counted off that same figure, so the page can say so honestly.
          weighted:     String(profile.activeProvider || "").toLowerCase() === "duelbits",
          entrants,
          totalTickets: entrants.reduce((n, e) => n + e.tickets, 0),
          totalEntrants: entrants.length,
        };
      }
    } catch (e) {
      console.warn("[portal-data] wager raffle build failed:", e.message);
    }

    const payload = {
      streamer:    publicProfile,
      // White-label branding (theme, logo, hero, footer credit). Null for
      // standard streamers, so the portal keeps its default look.
      portal:      buildPortalConfig(channel, profile, canBrand),
      active,
      leaderboard,
      leaderboard2,
      // leaderboard2 first so the existing bespoke portal and the generic one
      // agree on ordering when a streamer has both a CSGOBig race and others.
      boards: [...(leaderboard2 ? [leaderboard2] : []), ...extraBoards],
      leaderboardPeriods,
      // Countdown config set from the dashboard (weekly / bi-weekly / monthly).
      // Distinct from leaderboard.period (a string label) to avoid collision.
      leaderboardTimer: mainPeriod,
      store,
      pastWinners,
      giveawayWinners,
      bounties,
      wagerRaffle: wagerRafflePublic,
      // Used by the page to know what to render (and what to lock)
      features: {
        leaderboard: tier >= TIER_RANK.elite,
        store:       tier >= TIER_RANK.pro,
        raffles:     tier >= TIER_RANK.pro,
        battle:      tier >= TIER_RANK.pro,
        tournament:  tier >= TIER_RANK.pro,
      },
    };
    try { await cacheRef.set({ cachedAt: Date.now(), data: payload }); } catch { /* cache write failed — non-fatal */ }
    return res(200, payload);

  } catch (err) {
    console.error("[portal-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
