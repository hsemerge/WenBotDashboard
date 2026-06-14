// GET /api/entrant-wager?username=<kickUsername>
// On-demand wager lookup for a single giveaway entrant, shown on the dashboard's
// viewer card so a streamer can SEE a user's wagering when deciding who to reward.
// The giveaway DRAW stays equal-odds/unweighted — this is informational only.
//
// Auth: Firebase ID token (streamer). Scoped to the caller's own account/provider.
// Per-provider behaviour:
//   - Gambulls: this-week + this-month wager from the streamer's OWN referrals
//     (real names + UIDs, complete incl. inactive — same source as under-code,
//     so matching is reliable). Public leaderboard is NOT used (it masks names
//     and is capped/top-N).
//   - Degen:    current-race wager IF the user is in Degen's published top 20;
//               otherwise unavailable (Degen exposes nothing below top 20).
//   - Others:   unavailable (no per-user wager API).

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { fetchDegenRace, degenNameMatch } = require("./_lib/degen");
const { CASINO_NAMES }        = require("./_lib/casinos");

// Find a user's wager in the streamer's Gambulls referral list for a period
// (weekly ≈ this week, monthly ≈ this month). Matches by casino UID first
// (masking-proof), then exact name, then masked-name fallback. Paginates with
// early-exit. Returns the wager (number) or null if not found.
async function findReferralWager(apiKey, type, pUser, pUid) {
  for (let page = 1; page <= 6; page++) {
    const url = `https://api.gambulls.com/api/public/streamer/referrals?type=${type}&includeInactive=true&pageSize=500&page=${page}`;
    const r = await fetch(url, { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } });
    if (!r.ok) return null;
    const ro = (await r.json()).responseObject || {};
    for (const it of (ro.items || [])) {
      const uid  = it.user?.id != null ? String(it.user.id) : null;
      const name = String(it.user?.name || "").toLowerCase();
      if ((pUid && uid && uid === String(pUid)) || (name && name === pUser) || degenNameMatch(pUser, it.user?.name || "")) {
        return it.wagerAmount || 0;
      }
    }
    if (page >= (ro.totalPages || 1)) break;
  }
  return null;
}

// Case-insensitive lookup of the entrant's verified-user record (Firestore
// queries are case-sensitive; kickName is stored with original casing).
async function findVerified(db, uid, usernameLower) {
  const vs = await db.collection("streamers").doc(uid).collection("verified_users").get();
  return vs.docs.map(d => d.data()).find(x => String(x.kickName || "").toLowerCase() === usernameLower) || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "entrant_wager", 60, 60))) {
    return res(429, { error: "Too many requests" });
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });
  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch { return res(401, { error: "Invalid auth token" }); }

  const username = (event.queryStringParameters?.username || "").replace(/^@/, "").trim().toLowerCase();
  if (!username) return res(400, { error: "Missing username" });

  try {
    const sdoc = await db.collection("streamers").doc(uid).get();
    if (!sdoc.exists) return res(404, { error: "Streamer not found" });
    // Never assume a casino — if none is set, say so rather than querying the wrong one.
    const provider = (sdoc.data().activeProvider || "").toLowerCase();
    if (!provider) return res(200, { provider: null, providerName: null, available: false, reason: "No casino is set for this channel yet." });
    const providerName = CASINO_NAMES[provider] || provider;

    // Resolve the entrant's casino identity + under-code status (case-insensitive).
    let pUser = username, pUid = null, underCode = false;
    try {
      const v = await findVerified(db, uid, username);
      if (v) {
        if (v.providerUsername) pUser = String(v.providerUsername).toLowerCase();
        if (v.providerUid)      pUid  = v.providerUid;
        underCode = !!v.underAffiliate;
      }
    } catch { /* non-fatal */ }

    const base = { provider, providerName, supportsWindows: provider === "gambulls", underCode };

    const provDoc = await db.collection("streamers").doc(uid).collection("providers").doc(provider).get();
    const cfg = provDoc.exists ? provDoc.data() : {};

    if (provider === "gambulls") {
      const apiKey = cfg.apiKey;
      if (!apiKey) return res(200, { ...base, available: false, reason: "Gambulls API key not configured." });
      const [w7, w30] = await Promise.all([
        findReferralWager(apiKey, "weekly",  pUser, pUid),
        findReferralWager(apiKey, "monthly", pUser, pUid),
      ]);
      const available = w7 != null || w30 != null;
      return res(200, {
        ...base, available,
        wager7d:  w7  != null ? w7  : 0,
        wager30d: w30 != null ? w30 : 0,
        reason: available ? null : "Not found under your code.",
      });
    }

    if (provider === "degen") {
      const code = cfg.referralCode || cfg.apiKey;
      if (!code) return res(200, { ...base, available: false, reason: "Degen referral code not configured." });
      const race = await fetchDegenRace(code);
      if (!race) return res(200, { ...base, available: false, reason: "Couldn't reach Degen right now — try again." });
      const m = race.rankings.find(r =>
        (pUid && r.uid && String(r.uid) === String(pUid)) ||
        String(r.username || "").toLowerCase() === pUser ||
        degenNameMatch(pUser, r.username)
      );
      if (!m) return res(200, { ...base, available: false, reason: "Outside Degen's published top 20 — Degen doesn't expose wager below that." });
      const end = race.endAt ? new Date(race.endAt) : null;
      const raceLabel = end && !isNaN(end.getTime())
        ? `current race · ends ${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
        : "current race";
      return res(200, { ...base, available: true, currentWager: m.wagered || 0, raceLabel });
    }

    return res(200, { ...base, available: false, reason: `${providerName} doesn't expose per-user wager data.` });
  } catch (err) {
    console.error("[entrant-wager] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
