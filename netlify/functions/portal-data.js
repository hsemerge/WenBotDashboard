// GET /api/portal-data?channel=USERNAME
// Public aggregator powering the streamer portal page.
// Returns ONLY the data the streamer's plan unlocks (Pro = +Store, Elite = +Leaderboard).
// Carefully curated — never exposes verified user lists, OAuth tokens, internal config.

const { getDb }              = require("./_lib/firebase");
const { CASINO_NAMES }       = require("./_lib/casinos");
const { lookupAffiliate }    = require("./_lib/affiliate");
const { normalizeGambulls, applyPeriod } = require("./_lib/leaderboard");
const { fetchDegenRace }     = require("./_lib/degen");
const { fetchCsgobigRace }   = require("./_lib/csgobig");

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

  // Irish Queen of the Slots — Degen race (keyless, referral code in the URL).
  // provider + degenReferralCode here mean she needs NO Firestore provider doc.
  irishqueenoftheslots: {
    provider:          "degen",
    degenReferralCode: "meg",
    // Second (switchable) leaderboard: CSGOBig partner API, keyless (ref code in URL).
    // Window defaults to the current calendar month; set csgobigFrom/csgobigTo (ms) to
    // pin a fixed race window instead.
    csgobigRefCode:    "MEG74637HDKOCUR8464",
    theme: {
      accent:     "#c43bff",
      accent2:    "#ff4fd8",
      accentGlow: "rgba(196,59,255,0.30)",
      gold:       "#ffd84d",
      bg:         "#0b0613",
      bgCard:     "#19102e",
      border:     "#3a2a5c",
    },
    logoUrl: "/portals/irishqueenoftheslots/assets/logo.jpg",
    hero: {
      tagline:   "Slots. Wins. Vibes. Queen Energy. 💜",
      // title omitted — the page markup renders it with a visible crown emoji
      // (a gradient-clipped emoji in JS-set text would go invisible).
      cadence:   "Monthly",
      code:      "Meg",
      ctaLabel:  "Play on Degen — code Meg",
      ctaHref:   "https://degen.com/?ref=Meg",
    },
    links: [
      { label: "Degen",   href: "https://degen.com/?ref=Meg", icon: "🎰" },
      { label: "YouTube", href: "https://youtube.com/@irishqueenoftheslots", icon: "▶️" },
      { label: "VIP",     href: "https://vipfoundme.com/", icon: "👑" },
      { label: "Kick",    href: "https://kick.com/irishqueenoftheslots", icon: "💜" },
    ],
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
    const presetMain = PORTAL_PRESETS[channel] || {};
    // White-label override = owner, a seeded preset, a manual Firestore flag, or
    // the agency plan. These get full agency-tier FEATURES (every section) +
    // branding, regardless of what they pay — used for comps like SKSlots.
    const whiteLabel = isOwner
      || PORTAL_PRESETS[channel] != null
      || profile.whiteLabel === true
      || tierOf(profile.plan) >= TIER_RANK.agency;
    const plan = (isOwner || whiteLabel) ? "agency" : (profile.plan || "starter");
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
      return res(404, { error: "Portal not available on this plan" });
    }

    // A white-label preset's provider wins (these are comped, code-configured
    // clients); otherwise the streamer's dashboard choice. Never assume Gambulls —
    // if none is set, leave it empty so the portal simply shows no casino section.
    const provider = (presetMain.provider || profile.activeProvider || "").toLowerCase();

    // Public-safe streamer info. Anything sensitive is NOT included here.
    const publicProfile = {
      displayName: profile.displayName || profile.kickChannel,
      kickChannel: profile.kickChannel,
      bio:         profile.bio || null,
      logoUrl:     profile.kickAvatar || null,
      provider,
      providerName: provider ? (CASINO_NAMES[provider] || provider) : null,
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
    if (tier >= TIER_RANK.pro) {
      const [itemsSnap, winnersSnap, gwSnap] = await Promise.all([
        db.collection("streamers").doc(uid).collection("store_items")
          .where("enabled", "==", true).get(),
        db.collection("streamers").doc(uid).collection("raffle_history")
          .orderBy("drawnAt", "desc").limit(20).get(),
        // Giveaway draw winners (separate store). orderBy on the single drawnAt
        // field is auto-indexed; filter to giveaway type in JS.
        db.collection("streamers").doc(uid).collection("winners_log")
          .orderBy("drawnAt", "desc").limit(30).get(),
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
        return { winner: w.winner, mode: w.mode, itemName: w.itemName || null, drawnAt: w.drawnAt };
      });
      giveawayWinners = gwSnap.docs
        .map(d => d.data())
        .filter(w => (w.type || "giveaway") === "giveaway")
        .slice(0, 20)
        .map(w => ({ winner: w.username, drawnAt: w.drawnAt }));
    }

    // Elite+ features: live leaderboard, bonus battle / tournament state
    let leaderboard = null;
    let leaderboard2 = null; // secondary switchable board (e.g. CSGOBig)
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
            }
          } catch (err) {
            console.warn("[portal-data] degen fetch failed:", err.message);
          }
        }
      }
      // Live leaderboard via the streamer's stored casino API key (server-side only)
      else if (API_CASINOS.has(provider)) {
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
      if (presetMain.csgobigRefCode) {
        const now  = new Date();
        const from = presetMain.csgobigFrom || Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0);
        const to   = presetMain.csgobigTo   || Date.now();
        // Race END for the countdown = end of the calendar month (last ms), which
        // is distinct from `to` (the up-to-now query window for current standings).
        const raceEnd = presetMain.csgobigTo || (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0) - 1);
        // Base (empty) board — keeps the switch visible regardless of the fetch.
        leaderboard2 = {
          key: "csgobig", label: "CSGOBig", casinoName: "CSGOBig", period: "Monthly Race",
          startAt: from, endAt: raceEnd, rankings: [], totalUsers: 0, totalWagered: 0,
        };
        try {
          const key = `csgobig_${presetMain.csgobigRefCode}_${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
          const cacheRef = db.collection("_cache").doc(key);
          let cb = null;
          // 20-min TTL: CSGOBig's rate limit is keyed PER REF CODE (not per IP), so
          // every consumer of her code shares one quota — poll as gently as possible.
          try { const c = await cacheRef.get(); if (c.exists && c.data().data && (Date.now() - c.data().cachedAt) < 20 * 60 * 1000) cb = c.data().data; } catch {}
          if (!cb) {
            const race = await fetchCsgobigRace(presetMain.csgobigRefCode, from, to);
            if (race) { cb = race; try { await cacheRef.set({ cachedAt: Date.now(), data: race }); } catch {} }
            else { try { const c = await cacheRef.get(); if (c.exists && c.data().data) cb = c.data().data; } catch {} } // serve stale
          }
          if (cb) {
            leaderboard2.rankings     = (cb.rankings || []).map((r) => ({ rank: r.rank, name: r.username, wagerAmount: r.wagered, avatarUrl: r.avatarUrl, prize: 0 }));
            leaderboard2.totalUsers   = cb.totalUsers;
            leaderboard2.totalWagered = cb.totalWagered;
          }
        } catch (err) { console.warn("[portal-data] csgobig fetch failed:", err.message); }
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

    const payload = {
      streamer:    publicProfile,
      // White-label branding (theme, logo, hero, footer credit). Null for
      // standard streamers, so the portal keeps its default look.
      portal:      buildPortalConfig(channel, profile, canBrand),
      active,
      leaderboard,
      leaderboard2,
      leaderboardPeriods,
      // Countdown config set from the dashboard (weekly / bi-weekly / monthly).
      // Distinct from leaderboard.period (a string label) to avoid collision.
      leaderboardTimer: profile.leaderboardPeriod || null,
      store,
      pastWinners,
      giveawayWinners,
      // Used by the page to know what to render (and what to lock)
      features: {
        leaderboard: tier >= TIER_RANK.elite,
        store:       tier >= TIER_RANK.pro,
        raffles:     tier >= TIER_RANK.pro,
        battle:      tier >= TIER_RANK.elite,
        tournament:  tier >= TIER_RANK.elite,
      },
    };
    try { await cacheRef.set({ cachedAt: Date.now(), data: payload }); } catch { /* cache write failed — non-fatal */ }
    return res(200, payload);

  } catch (err) {
    console.error("[portal-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
