// POST /api/verify-affiliate
// Body: { channel, kickUsername, affiliateUsername, casino, skipCasino? }
// Verifies a viewer's casino account.
// Kick-chat flow: saves a pending_confirmation and returns a confirm code — bot finalizes on !confirm.
// Discord flow: saves directly to verified_users (Discord OAuth already proves identity).
// skipCasino: Kick-only verification (doc `${kickKey}_none`) — allowed only when
// the streamer's casinoRequired flag is false. Works with dtoken (Discord attach).

const { getDb, admin }         = require("./_lib/firebase");
const { res, checkRateLimit }  = require("./_lib/http");
const { CASINO_NAMES, API_CASINOS } = require("./_lib/casinos");
const { logAudit }             = require("./_lib/audit");
const { lookupAffiliate }      = require("./_lib/affiliate");
const { lookupDegen }          = require("./_lib/degen");
const { normalizeBoard, boardWindow } = require("./_lib/leaderboards");
const { getKickUser }          = require("./_lib/kick");
const { saveDiscordLink, stampDiscordVerified, findExistingDiscordLink } = require("./_lib/discord-link");
const crypto                   = require("crypto");

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

  const { channel, kickAccessToken, dtoken, affiliateUsername, casino, skipCasino } = body;
  const skipMode = !!skipCasino && !affiliateUsername;
  if (!channel || !kickAccessToken || (!affiliateUsername && !skipMode)) {
    return res(400, { error: "Missing required fields" });
  }

  // Never assume Gambulls. Validate only if a casino was supplied; otherwise it's
  // derived from the streamer's actual activeProvider once we've loaded them.
  let provider = (casino || "").toLowerCase();
  if (provider && !CASINO_NAMES[provider]) {
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

    // Kick identity proven via OAuth access token — hardened shared lookup turns
    // any Kick-side failure (bad token char, network, timeout, non-JSON) into a
    // clear, retryable message instead of a generic 500.
    const kickLookup = await getKickUser(kickAccessToken);
    if (kickLookup.error) throw Object.assign(new Error(kickLookup.error), { status: kickLookup.status });
    const kickUsername = kickLookup.user.name;

    // If a Discord verification token was provided, consume it and link Discord identity
    let discordUserId   = null;
    let discordUsername = null;
    // The token is VALIDATED here but deliberately NOT consumed yet — see
    // burnDtoken() at the end. Marking it used up-front burned it even when the
    // verification that followed failed (a mistyped casino username, a lookup
    // error), so the retry that should have worked came back "already been
    // used" and the viewer's Discord silently never attached. They then had to
    // link it by hand, which is exactly the step this flow exists to remove.
    let dtokenRef = null;
    if (dtoken) {
      dtokenRef = db.collection("discord_verify_tokens").doc(dtoken);
      const dtokenDoc = await dtokenRef.get();
      if (!dtokenDoc.exists)          throw Object.assign(new Error("Invalid or expired Discord link. Use /verify in Discord to get a new one."), { status: 404 });
      const td = dtokenDoc.data();
      if (td.used)                    throw Object.assign(new Error("This Discord link has already been used."), { status: 410 });
      if (Date.now() > td.expiresAt)  throw Object.assign(new Error("This Discord link has expired. Use /verify in Discord to get a new one."), { status: 410 });
      discordUserId   = td.discordUserId;
      discordUsername = td.discordUsername;
    }
    // Consumed only once the verification it authorises has actually landed.
    const burnDtoken = async () => {
      if (!dtokenRef) return;
      try { await dtokenRef.update({ used: true }); } catch { /* best effort */ }
    };

    const kickKey      = kickUsername.toLowerCase();
    const affiliateKey = (affiliateUsername || "").toLowerCase();

    // ── Kick-only skip path ──────────────────────────────────────────────────
    // Gated on the streamer's casinoRequired flag (Settings → Platform card).
    // Writes a `${kickKey}_none` verified_users doc: counts as verified for
    // tournaments / verified giveaways / the Discord role, but never matches
    // code-based (provider-filtered) eligibility. Discord dtoken (consumed
    // above) still attaches. Adding a real casino later overwrites this.
    if (skipMode) {
      if (streamerData.casinoRequired !== false) {
        return res(400, { error: "This streamer requires a casino account to verify." });
      }
      const skipRef = db.collection("streamers").doc(streamerUid)
        .collection("verified_users").doc(`${kickKey}_none`);
      await skipRef.set({
        kickName:               kickUsername,
        kickName_lower:         kickKey,
        providerUsername:       null,
        providerUsername_lower: null,
        provider:               "none",
        providerUid:            null,
        apiVerified:            false,
        underAffiliate:         false,
        wagerAmount:            0,
        wagerLastSyncedAt:      null,
        casinoSkipped:          true,
        verifiedAt:             Date.now(),
      });

      if (discordUserId) {
        await saveDiscordLink(db, streamerUid, discordUserId, { kickUsername, discordUsername });
      }

      // First-verify bonus applies to Kick-only verifies too (idempotent flag).
      let verifyBonusAwarded = 0;
      const bonus = parseInt(streamerData.firstVerifyBonus || 0, 10);
      if (bonus > 0) {
        try {
          const viewerRef  = db.collection("streamers").doc(streamerUid).collection("viewers").doc(kickKey);
          const viewerSnap = await viewerRef.get();
          if (!(viewerSnap.exists && viewerSnap.data().firstVerifyBonusAt)) {
            await viewerRef.set({
              points:             admin.firestore.FieldValue.increment(bonus),
              firstVerifyBonusAt: Date.now(),
            }, { merge: true });
            verifyBonusAwarded = bonus;
            logAudit(streamerUid, "first_verify_bonus", { kickUsername, bonus });
          }
        } catch (err) { console.warn("[verify-affiliate] first-verify bonus failed:", err.message); }
      }

      // They may have linked Discord on an earlier pass, before this doc existed.
      // The doc we just wrote would carry no flag, so carry it over from the link.
      let hasExistingDiscordLink = !!discordUserId;
      if (!hasExistingDiscordLink) {
        const existing = await findExistingDiscordLink(db, streamerUid, kickUsername);
        hasExistingDiscordLink = !!existing;
        if (existing) {
          await stampDiscordVerified(db, streamerUid, kickUsername, {
            discordUserId:   existing.id,
            discordUsername: existing.discordUsername,
          }).catch(() => {});
        }
      }

      logAudit(streamerUid, "verify", { kickUsername, provider: "none", casinoSkipped: true, discordLinked: !!discordUserId });

      await burnDtoken();
      return res(200, {
        success:            true,
        kickUsername,
        affiliateUsername:  null,
        provider:           "none",
        casinoName:         null,
        casinoSkipped:      true,
        apiVerified:        false,
        underAffiliate:     false,
        discordLinked:      !!discordUserId,
        discordLinkedAny:   hasExistingDiscordLink,
        discordUsername:    discordUsername || null,
        streamerHasDiscord: !!streamerData.discordConfig?.guildId,
        verifyBonusAwarded,
      });
    }

    // Check the active casino matches what the streamer is currently streaming at.
    // Never default — if the streamer hasn't set a casino, verification can't run.
    const activeProvider = (streamerData.activeProvider || "").toLowerCase();
    if (!activeProvider) {
      return res(400, { error: "This streamer hasn't set up a casino yet — verification isn't available until they do." });
    }
    if (!provider) provider = activeProvider; // client omitted casino → use the streamer's actual one

    // Accept any board the streamer actually RUNS, not just the active one. A
    // streamer can run several races at once and a viewer may play the second
    // casino, so rejecting anything but activeProvider made second-board
    // verification impossible — the page offered a Link action the server then
    // refused. Verifications are stored per provider (`<kick>_<provider>`), so a
    // second board adds a record rather than replacing the first.
    const allowed = new Set([activeProvider]);
    try {
      const bSnap = await db.collection("streamers").doc(streamerUid).collection("leaderboards").get();
      bSnap.docs.forEach((d) => {
        const b = d.data() || {};
        if (b.enabled !== false && b.provider) allowed.add(String(b.provider).toLowerCase());
      });
    } catch (e) {
      console.warn("[verify-affiliate] boards lookup failed:", e.message);
    }

    if (!allowed.has(provider)) {
      // Name what they CAN verify, rather than only the active casino — on a
      // multi-board channel that message would have been wrong.
      const names = [...allowed].map((p) => CASINO_NAMES[p] || p);
      const list  = names.length === 1
        ? names[0]
        : names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
      return res(400, { error: `This streamer runs ${list}. Please verify your ${list} username instead.` });
    }

    // Check if this casino username is already claimed by a different Kick account.
    // We compare the EXISTING doc's `kickName` field, not the doc ID — the ID format
    // is `${kickKey}_${provider}` (eg. `triiton_gambulls`), so comparing it directly
    // to `kickKey` (`triiton`) always fails and blocks legitimate re-verifies by the
    // same user. That regression broke the Discord `/register` dtoken path entirely
    // (re-entering the same casino username threw "already linked to another Kick
    // account"). The intent is: same Kick = silent overwrite; different Kick = block.
    const claimSnap = await db.collection("streamers").doc(streamerUid)
      .collection("verified_users")
      .where("providerUsername_lower", "==", affiliateKey)
      .where("provider", "==", provider)
      .limit(1).get();

    if (!claimSnap.empty) {
      const existingKickName = String(claimSnap.docs[0].data().kickName || "").toLowerCase();
      if (existingKickName && existingKickName !== kickKey) {
        return res(409, { error: `"${affiliateUsername}" is already linked to another Kick account. Contact a mod if this is an error.` });
      }
    }

    let resultUsername  = affiliateUsername;
    let underAffiliate  = false;
    let wagerAmount     = 0;
    let providerUid     = null; // stable Gambulls user id — the durable, masking-proof key

    if (API_CASINOS.has(provider)) {
      // Full API verification against streamer's leaderboard
      const providerDoc = await db.collection("streamers").doc(streamerUid)
        .collection("providers").doc(provider).get();
      if (!providerDoc.exists) {
        return res(400, { error: `This streamer hasn't configured their ${CASINO_NAMES[provider]} API yet.` });
      }
      // Pass the race period, exactly as the Re-check paths do. Without it
      // lookupAffiliate can only check Duelbits' own current cycle, which is
      // NARROWER than the streamer's race window. Someone who wagered in the race
      // but not in the live cycle was told at verify time that they aren't under
      // the code, then turned green the moment a Re-check ran with the period in
      // hand. Verify now sees the same two boards the Re-check sees.
      const result = await lookupAffiliate(
        provider, providerDoc.data(), affiliateUsername, null,
        { period: streamerData.leaderboardPeriod || null }
      );
      if (result) {
        // For an exact match, prefer the board's canonical casing. For a MASKED
        // match the board name is anonymized ("Be***x"), so keep the user's
        // claimed name instead of storing the mask.
        resultUsername = result.matchedViaMask ? affiliateUsername : (result.username || affiliateUsername);
        underAffiliate = true;
        wagerAmount    = result.wagerAmount || 0;
        providerUid    = result.uid || null; // capture UID so future checks are UID-based
      }
      // Not found on leaderboard = not under affiliate code, but still save as verified
    } else if (provider === "degen") {
      // Degen has no per-user lookup API, but it DOES expose the affiliate race
      // leaderboard (masked names). Match the claimed username against it to
      // confirm under-code status. Code stored in providers/degen (referral code).
      const provDoc = await db.collection("streamers").doc(streamerUid)
        .collection("providers").doc("degen").get();
      const code = provDoc.exists ? (provDoc.data().referralCode || provDoc.data().apiKey) : null;
      if (code) {
        const m = await lookupDegen(code, affiliateUsername);
        if (m && m.underAffiliate) {
          underAffiliate = true;
          wagerAmount    = m.wagerAmount || 0;
        }
      }
    } else if (provider === "csgobig") {
      // CSGOBig has no per-user lookup, but the race standings carry usernames —
      // same shape as the Degen check. Without this a CSGOBig verification fell
      // through to honor-system and was accepted with no check at all, so a name
      // that had never wagered under the code still came back "verified".
      //
      // Read the CACHED race that portal-data maintains rather than calling
      // CSGOBig here: their rate limit is per REFERRAL CODE and re-arms on every
      // blocked attempt, so a second live caller could starve the quota and blank
      // the public board. portal-data stays the only fetcher.
      try {
        const bSnap = await db.collection("streamers").doc(streamerUid).collection("leaderboards").get();
        const board = bSnap.docs
          .map((d) => normalizeBoard(d.data(), d.id))
          .find((b) => b.provider === "csgobig" && b.enabled !== false);
        const code = board && board.credential && board.credential.refCode;
        const win  = board ? boardWindow(board) : null;
        if (code && win) {
          const c = await db.collection("_cache").doc(`csgobig_${code}_${win.from}-${win.to}`).get();
          const rows = c.exists ? ((c.data().data || {}).rankings || []) : [];
          const claimed = affiliateUsername.trim().toLowerCase();
          const hit = rows.find((r) => String(r.username || "").trim().toLowerCase() === claimed);
          if (hit) {
            resultUsername = hit.username || affiliateUsername;
            underAffiliate = true;
            wagerAmount    = hit.wagered || 0;
          }
        }
        // No cache yet, or no board/code → we genuinely can't check, so the name is
        // saved unverified rather than wrongly marked under-code.
      } catch (e) {
        console.warn("[verify-affiliate] csgobig check failed:", e.message);
      }
    } else {
      // Honor-system casino — no API check, username taken at face value
      underAffiliate = false;
    }

    const batch = db.batch();
    const newDocRef = db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(`${kickKey}_${provider}`);
    batch.set(newDocRef, {
      kickName:               kickUsername,
      // Denormalized lowercase copy so case-insensitive lookups (tournament,
      // giveaway-eligibility, etc.) can match without iterating. Kick's API
      // returns the username in its original case (e.g. "TriitonGM") which
      // doesn't match the lowercased query keys those endpoints use.
      kickName_lower:         kickKey,
      providerUsername:       resultUsername,
      providerUsername_lower: affiliateKey,
      provider,
      providerUid,            // stable Gambulls user id (null until matched) — durable key
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
    // A real casino verify supersedes any earlier Kick-only skip doc (no-op if absent).
    batch.delete(db.collection("streamers").doc(streamerUid)
      .collection("verified_users").doc(`${kickKey}_none`));
    await batch.commit();
    await burnDtoken();

    // Discord-initiated flow: also save the discord_link
    if (discordUserId) {
      await saveDiscordLink(db, streamerUid, discordUserId, { kickUsername, discordUsername });
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
    // Same carry-over as the Kick-only path: a link made before this verification
    // has to be stamped onto the doc we just wrote, or the gate can't see it.
    let hasExistingDiscordLink = !!discordUserId;
    if (!hasExistingDiscordLink) {
      const existing = await findExistingDiscordLink(db, streamerUid, kickUsername);
      hasExistingDiscordLink = !!existing;
      if (existing) {
        await stampDiscordVerified(db, streamerUid, kickUsername, {
          discordUserId:   existing.id,
          discordUsername: existing.discordUsername,
        }).catch(() => {});
      }
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
      streamerHasDiscord: !!streamerData.discordConfig?.guildId,
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
