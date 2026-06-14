// GET /api/entrant-wager?username=<kickUsername>
// On-demand wager lookup for a single giveaway entrant, shown on the dashboard's
// viewer card so a streamer can SEE a user's wagering when deciding who to reward.
// The giveaway DRAW stays equal-odds/unweighted — this is informational only.
//
// Auth: Firebase ID token (streamer). Scoped to the caller's own account/provider.
// Per-provider behaviour:
//   - Gambulls: true last-7-days + last-30-days wager (date-range endpoint).
//   - Degen:    current-race wager IF the user is in Degen's published top 20;
//               otherwise unavailable (Degen exposes nothing below top 20).
//   - Others:   unavailable (no per-user wager API).

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { normalizeGambulls }   = require("./_lib/leaderboard");
const { fetchDegenRace, degenNameMatch } = require("./_lib/degen");
const { CASINO_NAMES }        = require("./_lib/casinos");

function ymd(d) { return d.toISOString().slice(0, 10); }

async function gambullsDateRange(apiKey, from, to) {
  const url = `https://api.gambulls.com/api/public/streamer/leaderboard/date-range?from=${from}&to=${to}&limit=100`;
  const r = await fetch(url, { headers: { "x-streamer-api-key": apiKey, "Accept": "application/json" } });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d.success || !d.responseObject?.rankings) return null;
  return normalizeGambulls(d.responseObject); // [{ username, wagered, uid, ... }]
}

// Find a user's wager in a normalized rankings list. Matches by casino UID first
// (masking-proof), then exact name, then a masked-name match (e.g. "Bo***o").
function matchWager(list, pUser, pUid) {
  if (!Array.isArray(list)) return null;
  const m = list.find(x =>
    (pUid && x.uid && String(x.uid) === String(pUid)) ||
    String(x.username || "").toLowerCase() === pUser ||
    degenNameMatch(pUser, x.username)
  );
  return m ? (m.wagered || 0) : null;
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
    const provider     = (sdoc.data().activeProvider || "gambulls").toLowerCase();
    const providerName = CASINO_NAMES[provider] || provider;

    // Resolve the entrant's casino identity + under-code status.
    let pUser = username, pUid = null, underCode = false;
    try {
      const vq = await db.collection("streamers").doc(uid).collection("verified_users")
        .where("kickName", "==", username).limit(1).get();
      if (!vq.empty) {
        const v = vq.docs[0].data();
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
      const now = new Date();
      const to  = ymd(now);
      const d7  = new Date(now); d7.setUTCDate(d7.getUTCDate() - 7);
      const d30 = new Date(now); d30.setUTCDate(d30.getUTCDate() - 30);
      const [r7, r30] = await Promise.all([
        gambullsDateRange(apiKey, ymd(d7), to),
        gambullsDateRange(apiKey, ymd(d30), to),
      ]);
      const w7  = matchWager(r7,  pUser, pUid);
      const w30 = matchWager(r30, pUser, pUid);
      const available = w7 != null || w30 != null;
      return res(200, {
        ...base, available,
        wager7d:  w7  != null ? w7  : 0,
        wager30d: w30 != null ? w30 : 0,
        reason: available ? null : "No wager under your code in the last 30 days.",
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
