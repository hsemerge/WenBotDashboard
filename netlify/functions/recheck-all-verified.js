// POST /api/recheck-all-verified
// Bulk re-check of ALL of a streamer's verified users against the CURRENT
// Gambulls board, in a single pass: fetch the board ONCE, then match every
// verified user (UID fast-path → name fallback) and self-heal stale UIDs. This
// is the one-click recovery for when Gambulls rotates/regenerates user IDs and
// multiple "Under Code" users silently drop off at once.
//
// UPGRADE-ONLY: the board only shows current-window wagerers, so a "not found"
// must NOT downgrade anyone — we only flip TRUE + heal the UID when matched.
//
// Body: {}    (uses the caller's own streamer account)
// Auth: Firebase ID token

const { getDb, admin }                 = require("./_lib/firebase");
const { res, checkRateLimit }          = require("./_lib/http");
const { CASINO_NAMES }                 = require("./_lib/casinos");
const { findMatch, fetchGambulls, uidOf } = require("./_lib/affiliate");
const { fetchDegenRace, degenNameMatch }  = require("./_lib/degen");
const { logAudit }                     = require("./_lib/audit");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  // Heavy-ish op (one board fetch + a full verified scan) → cap to a few/min/IP.
  if (!(await checkRateLimit(db, ip, "recheckall", 6, 60))) {
    return res(429, { error: "Too many bulk rechecks — wait a moment." });
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  // Operate on the MANAGED streamer (impersonation-safe) — mods/admins manage other
  // accounts via delegatedFor. Without this, "Re-check all" ran on the caller's own
  // account, not the streamer they're managing.
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = (body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) return res(403, { error: "Not authorized for that account" });

  try {
    // Use the streamer's actual casino. Re-check works for casinos we can match a
    // user against a live board: Gambulls (per-user API + UIDs) and Degen (public
    // race, masked-name match — no UID). The board/race is fetched ONCE either way.
    const streamerDoc = await db.collection("streamers").doc(uid).get();
    const provider = (streamerDoc.exists ? (streamerDoc.data().activeProvider || "") : "").toLowerCase();
    if (!provider) return res(400, { error: "No casino is set for this channel — set one in Settings first." });
    if (provider !== "gambulls" && provider !== "degen") {
      return res(400, { error: `Re-check isn't available for ${CASINO_NAMES[provider] || provider} yet — it has no wager lookup.` });
    }
    const providerDoc = await db.collection("streamers").doc(uid)
      .collection("providers").doc(provider).get();

    // Build a single matcher(v) → { wagerAmount, uid|null } | null from one live fetch.
    let matchFor;
    if (provider === "gambulls") {
      if (!providerDoc.exists || !providerDoc.data().apiKey) return res(400, { error: `${CASINO_NAMES[provider]} API isn't configured.` });
      const board = await fetchGambulls(providerDoc.data().apiKey, "monthly");
      if (board.error || !Array.isArray(board.rankings)) return res(502, { error: "Couldn't reach the Gambulls leaderboard right now." });
      matchFor = (v) => {
        const target = (v.providerUsername_lower || v.providerUsername || "").toLowerCase().trim();
        const { match } = findMatch(board.rankings, target, v.providerUid || null);
        return match ? { wagerAmount: match.wagerAmount || 0, uid: uidOf(match) } : null;
      };
    } else { // degen — masked-name match against the live race (no per-user UID)
      const code = providerDoc.exists ? (providerDoc.data().referralCode || providerDoc.data().apiKey) : null;
      if (!code) return res(400, { error: "Degen referral code isn't configured." });
      const race = await fetchDegenRace(code);
      if (!race || !Array.isArray(race.rankings)) return res(502, { error: "Couldn't reach the Degen race right now." });
      matchFor = (v) => {
        const claimed = (v.providerUsername || v.providerUsername_lower || "").trim();
        if (!claimed) return null;
        const fits = race.rankings.filter((r) => r.username && r.username !== "Anonymous" && degenNameMatch(claimed, r.username));
        if (!fits.length) return null;           // anonymous/inactive/no-fit → upgrade-only: leave as-is
        fits.sort((a, b) => b.wagered - a.wagered);
        return { wagerAmount: fits[0].wagered || 0, uid: null };
      };
    }

    const vSnap = await db.collection("streamers").doc(uid)
      .collection("verified_users").where("provider", "==", provider).get();

    let rechecked = 0, healed = 0, upgraded = 0;
    const now = Date.now();
    // Chunk writes under the 500-op batch cap.
    let batch = db.batch(), ops = 0;
    const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

    for (const doc of vSnap.docs) {
      const v = doc.data();
      rechecked++;
      const m = matchFor(v);
      if (!m) continue; // upgrade-only: leave non-matches untouched

      const update = {
        apiVerified:       true,
        underAffiliate:    true,
        wagerAmount:       m.wagerAmount || 0,
        wagerLastSyncedAt: now,
        lastRecheckAt:     now,
      };
      if (m.uid && m.uid !== v.providerUid) { update.providerUid = m.uid; healed++; }
      if (!v.underAffiliate) upgraded++;
      batch.update(doc.ref, update);
      if (++ops >= 400) await flush();
    }
    await flush();

    logAudit(uid, "verified_recheck_all", { rechecked, healed, upgraded });
    return res(200, { success: true, rechecked, healed, upgraded });
  } catch (err) {
    console.error("[recheck-all-verified] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
