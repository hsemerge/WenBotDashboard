// GET /api/dashboard-state?uid=<streamer>
// Cached, per-streamer snapshot of the dashboard's POLLABLE panels — the pending
// store-redemption queue and the pending slot-request queue. These are the panels
// mods actively watch during a stream, so as live onSnapshot listeners they
// re-read on every write × every open dashboard (streamer + each mod). Serving
// them from a single per-streamer _cache doc (admin-SDK only) means the data is
// computed at most once per TTL and SHARED across that streamer + all their mods,
// so cost scales with the poll interval — not (dashboards × write-rate).
//
// Auth: Firebase ID token; acts on the MANAGED streamer (uid) when the caller is
// the owner or has it in delegatedFor (mods/admins) — same pattern as set-undercode.
//
// READ-ONLY. Rarely-changing panels (audit log, winners, history) are intentionally
// NOT here — they change so seldom that a live listener is cheaper than polling.

const { getDb, admin } = require("./_lib/firebase");
const { res: _res }    = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

const TTL_MS = 12 * 1000;
const LIMIT  = 200; // queues should never approach this; caps a pathological backlog

// Normalize a Firestore Timestamp / number / ISO string → epoch ms (the client
// revives these back into {toMillis,toDate} so the existing render code is unchanged).
function toMs(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  // Initialize the admin app (via getDb) BEFORE admin.auth() — verifyIdToken needs
  // the default app initialized first, or it rejects otherwise-valid tokens.
  const db = getDb();

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = (event.queryStringParameters?.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) return res(403, { error: "Not authorized for that account" });

  const cacheRef = db.collection("_cache").doc(`dashstate_${uid}`);

  // Serve the shared cache if fresh.
  try {
    const c = await cacheRef.get();
    if (c.exists && c.data().data && (Date.now() - c.data().cachedAt) < TTL_MS) {
      return res(200, c.data().data);
    }
  } catch { /* fall through to recompute */ }

  const base = db.collection("streamers").doc(uid);
  const out  = { redemptions: [], slotRequests: [] };

  // Per-panel try/catch — one panel failing must not blank the others.
  try {
    const s = await base.collection("store_redemptions").where("status", "==", "pending").limit(LIMIT).get();
    out.redemptions = s.docs.map((d) => {
      const x = d.data();
      // Spread the whole doc so nothing the render/actions need goes missing;
      // override the fields the UI actually reads (with fallbacks + ms timestamp).
      return {
        ...x,
        id:          d.id,
        kickUsername: x.kickUsername || x.viewer || "",
        itemName:    x.itemName || "",
        pointsSpent: x.pointsSpent || 0,
        source:      x.source || "kick",
        redeemedAt:  toMs(x.redeemedAt),
      };
    });
  } catch (e) { out.redemptionsError = true; console.warn("[dashboard-state] redemptions:", e.message); }

  try {
    const s = await base.collection("slot_requests").where("status", "==", "pending").limit(LIMIT).get();
    out.slotRequests = s.docs.map((d) => {
      const x = d.data();
      // Spread the whole doc (slotName/gameId/thumbnailUrl/avatarUrl/etc. all kept
      // so every render + the "add to hunt" action has what it needs); normalize ts.
      return {
        ...x,
        id:          d.id,
        kickUsername: x.kickUsername || "",
        slotName:    x.slotName || "",
        requestedAt: toMs(x.requestedAt),
        avatarUrl:   x.avatarUrl || null,
      };
    });
  } catch (e) { out.slotRequestsError = true; console.warn("[dashboard-state] slot_requests:", e.message); }

  try { await cacheRef.set({ cachedAt: Date.now(), data: out }); } catch { /* skip cache */ }
  return res(200, out);
};
