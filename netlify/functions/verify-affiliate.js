// POST /api/verify-affiliate
// Body: { channel, kickUsername, affiliateUsername, casino }
// Verifies a viewer's casino account.
// Kick-chat flow: saves a pending_confirmation and returns a confirm code — bot finalizes on !confirm.
// Discord flow: saves directly to verified_users (Discord OAuth already proves identity).

const { getDb, admin }         = require("./_lib/firebase");
const { res, checkRateLimit }  = require("./_lib/http");
const { CASINO_NAMES }         = require("./_lib/casinos");
const { logAudit }             = require("./_lib/audit");
const { lookupAffiliate }      = require("./_lib/affiliate");
const crypto                   = require("crypto");

// Casinos with live API verification
const API_CASINOS = new Set(["gambulls"]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "verify", 10, 60))) {
    return res(429, { error: "Too many requests. Please wait a moment and try again." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, kickAccessToken, dtoken, affiliateUsername, casino } = body;
  if (!channel || !kickAccessToken || !affiliateUsername) {
    return res(400, { error: "Missing required fields" });
  }

  const provider = (casino || "gambulls").toLowerCase();
  if (!CASINO_NAMES[provider]) {
    return res(400, { error: "Unsupported casino." });
  }

  try {
    const snap = await db.collection("streamers").where("kickChannel", "==", channel.toLowerCase()).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });

    const streamerDoc  = snap.docs[0];
    const streamerUid  = streamerDoc.id;
    const streamerData = streamerDoc.data();

    // Reject streamers who haven't completed Kick OAuth — prevents channel-name hijacking
    if (!streamerData.kickUserId) {
      return res(400, { error: "This streamer hasn't finished setting up their channel yet." });
    }

    // Kick identity proven via OAuth access token — same path for chat-initiated and Discord-initiated
    const kickApiResp = await fetch("https://api.kick.com/public/v1/users", {
      headers: { "Authorization": `Bearer ${kickAccessToken}` },
    });
    if (!kickApiResp.ok) throw Object.assign(new Error("Could not verify your Kick identity. Please try again."), { status: 401 });
    const kickApiData = await kickApiResp.json();
    const kickApiUser = kickApiData.data?.[0];
    if (!kickApiUser) throw Object.assign(new Error("Could not verify your Kick identity."), { status: 401 });
    const kickUsername = kickApiUser.name;

    // If a Discord verification token was provided, consume it and link Discord identity
    let discordUserId   = null;
    let discordUsername = null;
    if (dtoken) {
      const dtokenRef = db.collection("discord_verify_tokens").doc(dtoken);
      await db.runTransaction(async (txn) => {
        const dtokenDoc = await txn.get(dtokenRef);
        if (!dtokenDoc.exists)          throw Object.assign(new Error("Invalid or expired Discord link. Use /register in Discord to get a new one."), { status: 404 });
        const td = dtokenDoc.data();
        if (td.used)                    throw Object.assign(new Error("This Discord link has already been used."), { status: 410 });
        if (Date.now() > td.expiresAt)  throw Object.assign(new Error("This Discord link has expired. Use /register in Discord to get a new one."), { status: 410 });
        discordUserId   = td.discordUserId;
        discordUsername = td.discordUsername;
        txn.update(dtokenRef, { used: true });
      });
    }

    const kickKey      = kickUsername.toLowerCase();
    const affiliateKey = affiliateUsername.toLowerCase();

    // Check the active casino matches what the streamer is currently streaming at
    const activeProvider = streamerData.activeProvider || "gambulls";
    if (provider !== activeProvider) {
      const activeName = CASINO_NAMES[activeProvider] || activeProvider;
      return res(400, { error: `This streamer is currently streaming at ${activeName}. Please verify your ${activeName} username instead.` });
    }

    // Check if this casino username is already claimed by a different Kick account
    const claimSnap = await db.collection("streamers").doc(streamerUid)
      .collection("verified_users")
      .where("providerUsername_lower", "==", affiliateKey)
      .where("provider", "==", provider)
      .limit(1).get();

    if (!claimSnap.empty && claimSnap.docs[0].id !== kickKey) {
      return res(409, { error: `"${affiliateUsername}" is already linked to another Kick account. Contact a mod if this is an error.` });
    }

    let resultUsername  = affiliateUsername;
    let underAffiliate  = false;
    let wagerAmount     = 0;

    if (API_CASINOS.has(provider)) {
      // Full API verification against streamer's leaderboard
      const providerDoc = await db.collection("streamers").doc(streamerUid)
        .collection("providers").doc(provider).get();
      if (!providerDoc.exists) {
        return res(400, { error: `This streamer hasn't configured their ${CASINO_NAMES[provider]} API yet.` });
      }
      const { apiKey } = providerDoc.data();
      const result = await lookupAffiliate(provider, apiKey, affiliateUsername);
      if (result) {
        resultUsername = result.username;
        underAffiliate = true;
        wagerAmount    = result.wagerAmount || 0;
      }
      // Not found on leaderboard = not under affiliate code, but still save as verified
    } else {
      // Honor-system casino — no API check, username taken at face value
      underAffiliate = false;
    }

    const batch = db.batch();
    const newDocRef = db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(`${kickKey}_${provider}`);
    batch.set(newDocRef, {
      kickName:               kickUsername,
      providerUsername:       resultUsername,
      providerUsername_lower: affiliateKey,
      provider,
      apiVerified:            API_CASINOS.has(provider) && underAffiliate,
      underAffiliate,
      wagerAmount,
      wagerLastSyncedAt:      API_CASINOS.has(provider) ? Date.now() : null,
      verifiedAt:             Date.now(),
    });
    // Clean up legacy docs that used just kickKey as doc ID (no _provider suffix)
    const legacyRef = db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(kickKey);
    const legacySnap = await legacyRef.get();
    if (legacySnap.exists) batch.delete(legacyRef);
    await batch.commit();

    // Discord-initiated flow: also save the discord_link
    if (discordUserId) {
      await db.collection("streamers").doc(streamerUid)
        .collection("discord_links").doc(discordUserId).set({
          kickUsername,
          discordUsername,
          linkedAt: Date.now(),
        });
    }

    // First-time verify bonus — idempotent via firstVerifyBonusAt on the viewer doc.
    // We use a Firestore atomic increment so we don't clobber any in-flight
    // points changes from WenBotServer's cache. firstVerifyBonusAt prevents
    // re-crediting on subsequent re-verifies (e.g. casino switch).
    let verifyBonusAwarded = 0;
    const bonus = parseInt(streamerData.firstVerifyBonus || 0, 10);
    if (bonus > 0) {
      try {
        const viewerRef  = db.collection("streamers").doc(streamerUid)
          .collection("viewers").doc(kickKey);
        const viewerSnap = await viewerRef.get();
        const already    = viewerSnap.exists && viewerSnap.data().firstVerifyBonusAt;
        if (!already) {
          await viewerRef.set({
            points:             admin.firestore.FieldValue.increment(bonus),
            firstVerifyBonusAt: Date.now(),
          }, { merge: true });
          verifyBonusAwarded = bonus;
          logAudit(streamerUid, "first_verify_bonus", { kickUsername, bonus });
        }
      } catch (err) {
        console.warn("[verify-affiliate] first-verify bonus failed:", err.message);
      }
    }

    // Check whether this Kick user already has any Discord link on this streamer
    // (so the success screen doesn't keep prompting "Connect Discord" forever).
    let hasExistingDiscordLink = !!discordUserId;
    if (!hasExistingDiscordLink) {
      const existingLink = await db.collection("streamers").doc(streamerUid)
        .collection("discord_links")
        .where("kickUsername", "==", kickUsername)
        .limit(1).get();
      hasExistingDiscordLink = !existingLink.empty;
    }

    // Audit log — best-effort, never blocks the response
    logAudit(streamerUid, "verify", {
      kickUsername,
      providerUsername: resultUsername,
      provider,
      underAffiliate,
      discordLinked: !!discordUserId,
    });

    return res(200, {
      success:           true,
      kickUsername,
      affiliateUsername: resultUsername,
      provider,
      casinoName:        CASINO_NAMES[provider],
      apiVerified:       API_CASINOS.has(provider) && underAffiliate,
      underAffiliate,
      discordLinked:     !!discordUserId,
      discordLinkedAny:  hasExistingDiscordLink,
      discordUsername:   discordUsername || null,
      verifyBonusAwarded,
    });

  } catch (err) {
    // 4xx errors (throw Object.assign(new Error(msg), {status:...})) carry safe user-facing messages.
    // 5xx errors are unexpected — sanitize and log.
    if (err.status && err.status < 500) {
      return res(err.status, { error: err.message });
    }
    console.error("[verify-affiliate] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
