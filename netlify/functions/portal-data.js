// GET /api/portal-data?channel=USERNAME
// Public aggregator powering the streamer portal page.
// Returns ONLY the data the streamer's plan unlocks (Pro = +Store, Elite = +Leaderboard).
// Carefully curated — never exposes verified user lists, OAuth tokens, internal config.

const { getDb }              = require("./_lib/firebase");
const { CASINO_NAMES }       = require("./_lib/casinos");
const { lookupAffiliate }    = require("./_lib/affiliate");

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

    const isOwner = OWNER_CHANNELS.has(channel);
    const plan = isOwner ? "agency" : (profile.plan || "starter");
    const tier = tierOf(plan);
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
            name:         item.name,
            description:  item.description || null,
            price:        item.price || 0,
            stock:        (item.stock === undefined || item.stock === null) ? null : item.stock,
            isRaffleItem: item.isRaffleItem === true,
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
                leaderboard = {
                  period:       data.responseObject.period,
                  rankings:     data.responseObject.rankings.map((r, i) => ({
                    rank:        i + 1,
                    name:        r.user?.isAnonymous ? "Anonymous" : (r.user?.name || "Unknown"),
                    wagerAmount: r.wagerAmount || 0,
                    avatarUrl:   r.user?.imageUrl || null,
                  })),
                  totalUsers:    data.responseObject.totalUsers || 0,
                  totalWagered:  data.responseObject.totalWagered || 0,
                };
              }
            }
          } catch (err) {
            console.warn("[portal-data] leaderboard fetch failed:", err.message);
          }
        }
      }

      // Past leaderboard periods (same data /api/leaderboard-winners exposes)
      try {
        const periodsSnap = await db.collection("streamers").doc(uid)
          .collection("leaderboard_periods")
          .where("casino", "==", provider)
          .orderBy("endDate", "desc")
          .limit(12)
          .get();
        leaderboardPeriods = periodsSnap.docs.map(d => {
          const p = d.data();
          return {
            period:     p.period || null,
            casinoName: p.casinoName || CASINO_NAMES[provider] || provider,
            winners:    Array.isArray(p.winners) ? p.winners.map(w => ({
              rank:      w.rank,
              username:  w.username,
              wagered:   w.wagered || 0,
              prize:     w.prize || 0,
              avatarUrl: w.avatarUrl || null,
            })) : [],
          };
        });
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
      active,
      leaderboard,
      leaderboardPeriods,
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
