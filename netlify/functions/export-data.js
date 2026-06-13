// POST /api/export-data
// GDPR-style data export: gathers the user's data under streamers/{uid}/* into
// one JSON file. Auth: Firebase ID token in Authorization header.
// Rate-limited to 5 exports per hour per IP.
//
// SECURITY MODEL — ALLOWLIST (fail-closed). We export only fields/subcollections
// explicitly listed here. Anything new added to the data model in the future is
// EXCLUDED by default and won't leak into an export until someone deliberately
// adds it below. This prevents accidental exposure of secrets (API keys, OAuth
// tokens) added later. To include a new field, add it to PROFILE_FIELDS or
// SUBCOLLECTION_FIELDS — and consider whether it's safe to hand to the user.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

// Top-level streamer-doc fields safe to export. (Intentionally omits Kick OAuth
// tokens and any future secret fields — allowlist, not denylist.)
const PROFILE_FIELDS = [
  "displayName", "kickChannel", "kickAvatar", "bio", "socials",
  "activeProvider", "currencyName", "plan", "portalEnabled", "leaderboardEnabled",
  "themeColor", "portal", "whiteLabel",
  "pointsPerMinute", "pointsOnEntry", "firstVerifyBonus",
  "dailyBonus", "subMultiplier", "followBonus",
  "minMessageLength", "activityWindowSec",
  "giveawayType", "giveawayKeyword", "giveawayMinWager", "giveawayDuration",
  "giveawaySubOnly", "giveawayVerifiedCasino", "giveawayVerifiedDiscord",
  "giveawayOverlayStyle",
  "leaderboardPeriod", "wagerRaffle",
  "discordConfig", // note: filtered below to drop any nested secrets
  "createdAt", "updatedAt",
];

// discordConfig is mostly safe (guild/channel/role IDs, verify settings) but
// could gain a secret later — allowlist its keys too.
const DISCORD_CONFIG_FIELDS = [
  "guildId", "guildName", "giveawayChannelId", "announcementChannelId",
  "giveallAuthorId", "verify",
];

// Per-subcollection field allowlists. A subcollection NOT listed here is fully
// excluded. A field not listed for a listed subcollection is dropped. `null`
// means "all fields are safe to include" (use sparingly, only for clearly
// non-sensitive collections).
//
// Deliberately EXCLUDED (not present as keys): providers (casino API keys!),
// discord_verify_tokens (short-lived secrets), _cache, _rate_limits, bot_locks,
// bot_status, system — none belong in a user export.
const SUBCOLLECTION_FIELDS = {
  viewers:            null, // username + points + lastSeen — safe
  store_items:        null,
  store_redemptions:  null,
  raffle_history:     null,
  leaderboard_periods:null,
  bonus_hunt:         null,
  bonus_battles:      null,
  tournaments:        null,
  slot_requests:      null,
  giveaway_state:     null,
  audit_logs:         null,
  // PII-bearing but user-owned — include only non-secret identity fields:
  verified_users: ["kickName", "provider", "providerUsername", "verifiedAt", "discordVerified", "firstVerifyAwarded"],
  discord_links:  ["kickUsername", "discordUsername", "guildId", "guildVerified", "linkedAt"],
};

function pickFields(obj, allow) {
  if (allow === null) return obj;
  const out = {};
  for (const k of allow) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "export", 5, 3600))) {
    return res(429, { error: "Export limit reached. Please wait an hour before trying again." });
  }

  const authHeader = event.headers["authorization"] || "";
  const idToken    = authHeader.replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let uid, email;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid   = decoded.uid;
    email = decoded.email || null;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  try {
    const streamerRef  = db.collection("streamers").doc(uid);
    const profileSnap  = await streamerRef.get();
    if (!profileSnap.exists) return res(404, { error: "Account not found" });

    // Profile: keep ONLY allowlisted fields (fail-closed).
    const raw     = profileSnap.data();
    const profile = pickFields(raw, PROFILE_FIELDS);
    if (profile.discordConfig) {
      profile.discordConfig = pickFields(profile.discordConfig, DISCORD_CONFIG_FIELDS);
    }

    // Subcollections: only those named in SUBCOLLECTION_FIELDS, each filtered to
    // its allowed fields. Anything not listed is excluded entirely.
    const data = {};
    for (const subId of Object.keys(SUBCOLLECTION_FIELDS)) {
      const allow = SUBCOLLECTION_FIELDS[subId];
      const snap  = await streamerRef.collection(subId).get();
      if (snap.empty) continue;
      data[subId] = snap.docs.map(d => ({ id: d.id, ...pickFields(d.data(), allow) }));
    }

    const exportPayload = {
      exportedAt:  new Date().toISOString(),
      account:     { uid, email },
      profile,
      collections: data,
      _note: "This export includes only your non-sensitive account data. Secrets (casino API keys, OAuth tokens) are never exported.",
    };

    return res(200, exportPayload);
  } catch (err) {
    console.error("[export-data] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
