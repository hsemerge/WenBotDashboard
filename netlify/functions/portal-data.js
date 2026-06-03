// GET /api/portal-data?channel=USERNAME
// Public aggregator powering the streamer portal page.
// Returns ONLY the data the streamer's plan unlocks (Pro = +Store, Elite = +Leaderboard).
// Carefully curated — never exposes verified user lists, OAuth tokens, internal config.

const { getDb }              = require("./_lib/firebase");
const { CASINO_NAMES }       = require("./_lib/casinos");
const { lookupAffiliate }    = require("./_lib/affiliate");
const { normalizeGambulls, applyPeriod } = require("./_lib/leaderboard");

const API_CASINOS = new Set(["gambulls"]);

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
      prize:     "$200",
      cadence:   "Weekly",                 // weekly LB, not monthly
      code:      "SKSlots",                // affiliate code shown in the hero
      ctaLabel:  "Play on Gambulls — code SKSlots",
      ctaHref:   "https://gambulls.com/?ref=SKSlots",
    },
    // Prize per leaderboard rank — shown next to the leaders currently in line
    // to win them (index 0 = 1st place). $200 weekly pool.
    prizes: ["$85", "$50", "$35", "$20", "$10"],
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
            { wager: "$1,000",  reward: "$5"  },
            { wager: "$2,500",  reward: "$10" },
            { wager: "$5,000",  reward: "$15" },
            { wager: "$7,500",  reward: "$20" },
            { wager: "$10,000", reward: "$25" },
            { wager: "$15,000", reward: "$30" },
            { wager: "$20,000", reward: "$50" },
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
          type: "prizes", title: "Weekly Leaderboard", subtitle: "$200 prize pool",
          places: [
            { place: "1st", amount: "$85" },
            { place: "2nd", amount: "$50" },
            { place: "3rd", amount: "$35" },
            { place: "4th", amount: "$20" },
            { place: "5th", amount: "$10" },
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
};

// Themed-portal branding (palette/logo/hero/bg). Emitted for Elite+ (the full
// theme is an Elite perk) OR any white-label override (owner/preset/flag). Null
// otherwise, so Starter/Pro portals keep the default look.
function buildPortalConfig(channel, profile, canBrand) {
  if (!canBrand) return null;
  const preset = PORTAL_PRESETS[channel] || {};
  const p      = profile.portal || {};
  return {
    theme:       { ...(preset.theme || {}), ...(p.theme || {}) },
    logoUrl:     p.logoUrl   || preset.logoUrl   || null,
    bannerUrl:   p.bannerUrl || preset.bannerUrl || null,
    bgImage:     p.bgImage   || preset.bgImage   || null,
    hero:        { ...(preset.hero || {}), ...(p.hero || {}) },
    prizes:      p.prizes    || preset.prizes    || [],
    links:       p.links     || preset.links     || [],
    pages:       p.pages     || preset.pages     || [],
    rewards:     p.rewards   || preset.rewards   || null,
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing ?channel=" });
  if (RESERVED_CHANNELS.has(channel)) {
    return res(404, { error: "Channel not found on WenBot" });
  }

  try {
    const db = getDb();
    const snap = await db.collection("streamers")
      .where("kickChannel", "==", channel).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found on WenBot" });

    const streamer = snap.docs[0];
    const uid      = streamer.id;
    const profile  = streamer.data();

    if (profile.portalEnabled === false) {
      return res(404, { error: "Portal not available" });
    }

    const isOwner    = OWNER_CHANNELS.has(channel);
    // White-label override = owner, a seeded preset, a manual Firestore flag, or
    // the agency plan. These get full agency-tier FEATURES (every section) +
    // branding, regardless of what they pay — used for comps like SKSlots.
    const whiteLabel = isOwner
      || PORTAL_PRESETS[channel] != null
      || profile.whiteLabel === true
      || tierOf(profile.plan) >= TIER_RANK.agency;
    const plan = (isOwner || whiteLabel) ? "agency" : (profile.plan || "starter");
    const tier = tierOf(plan);

    // Themed-portal branding (full palette/logo/hero/bg) is an Elite+ perk, and
    // also unlocked by any white-label override above.
    const canBrand = whiteLabel || tier >= TIER_RANK.elite;

    // Portal is a Pro+ feature. Starter has no public portal at all.
    // (Pro = basic portal: store + raffle winners + giveaway.
    //  Elite = full portal: + live leaderboard + bonus battle/tournament + theme.)
    if (tier < TIER_RANK.pro) {
      return res(404, { error: "Portal not available on this plan" });
    }

    const provider = (profile.activeProvider || "gambulls").toLowerCase();

    // Public-safe streamer info. Anything sensitive is NOT included here.
    const publicProfile = {
      displayName: profile.displayName || profile.kickChannel,
      kickChannel: profile.kickChannel,
      bio:         profile.bio || null,
      logoUrl:     profile.kickAvatar || null,
      provider,
      providerName: CASINO_NAMES[provider] || provider,
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
    if (tier >= TIER_RANK.pro) {
      const [itemsSnap, winnersSnap] = await Promise.all([
        db.collection("streamers").doc(uid).collection("store_items")
          .where("enabled", "==", true).get(),
        db.collection("streamers").doc(uid).collection("raffle_history")
          .orderBy("drawnAt", "desc").limit(20).get(),
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
      pastWinners = winnersSnap.docs.map(d => {
        const w = d.data();
        return { winner: w.winner, mode: w.mode, drawnAt: w.drawnAt };
      });
    }

    // Elite+ features: live leaderboard, bonus battle / tournament state
    let leaderboard = null;
    let leaderboardPeriods = null; // past monthly winners
    if (tier >= TIER_RANK.elite) {
      // Live leaderboard via the streamer's stored casino API key (server-side only)
      if (API_CASINOS.has(provider)) {
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
                const applied = applyPeriod(raw, profile.leaderboardPeriod || null);
                leaderboard = {
                  period:       data.responseObject.period,
                  rankings:     applied.rankings.map((r) => ({
                    rank:        r.rank,
                    name:        r.username,
                    wagerAmount: r.wagered || 0,
                    avatarUrl:   r.avatarUrl || null,
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

      // Past leaderboard periods (same data /api/leaderboard-winners exposes).
      // Filter by casino only (single-field, auto-indexed) and sort/slice in JS —
      // `where(casino==).orderBy(endDate)` needs a composite index that isn't
      // deployed, which would otherwise throw and silently empty Past Winners.
      try {
        const periodsSnap = await db.collection("streamers").doc(uid)
          .collection("leaderboard_periods")
          .where("casino", "==", provider)
          .get();
        leaderboardPeriods = periodsSnap.docs
          .map(d => d.data())
          .sort((a, b) => (b.endDate || 0) - (a.endDate || 0))
          .slice(0, 12)
          .map(p => ({
            period:     p.period || null,
            casinoName: p.casinoName || CASINO_NAMES[provider] || provider,
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

      // Active Bonus Battle and Tournament statuses (no entries, no votes — just status)
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
    }

    return res(200, {
      streamer:    publicProfile,
      // White-label branding (theme, logo, hero, footer credit). Null for
      // standard streamers, so the portal keeps its default look.
      portal:      buildPortalConfig(channel, profile, canBrand),
      active,
      leaderboard,
      leaderboardPeriods,
      // Countdown config set from the dashboard (weekly / bi-weekly / monthly).
      // Distinct from leaderboard.period (a string label) to avoid collision.
      leaderboardTimer: profile.leaderboardPeriod || null,
      store,
      pastWinners,
      // Used by the page to know what to render (and what to lock)
      features: {
        leaderboard: tier >= TIER_RANK.elite,
        store:       tier >= TIER_RANK.pro,
        raffles:     tier >= TIER_RANK.pro,
        battle:      tier >= TIER_RANK.elite,
        tournament:  tier >= TIER_RANK.elite,
      },
    });

  } catch (err) {
    console.error("[portal-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
