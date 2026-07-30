// POST /api/follow-backfill
// Stores follow dates that the DASHBOARD BROWSER collected from Kick.
//
// Why the browser and not the server: the only place `following_since` is exposed
// is the unofficial endpoint
//   GET https://kick.com/api/v2/channels/{channel}/users/{username}
// which Cloudflare hard-403s from every datacenter IP (verified from Railway AND
// Netlify/AWS — a nonexistent channel id returns byte-identical output, so the
// block lands at the edge before routing). It answers fine from a residential
// connection, needs no auth, and reflects CORS
// (`access-control-allow-origin: https://wenbot.gg`), so the streamer's own
// browser can read it and hand us the result.
//
// This is BACKFILL ONLY. The live source of truth stays the official
// `channel.followed` webhook, which the bot already consumes. Without this,
// followage can only ever see follows that happened after WenBot joined a
// channel — so every newly onboarded streamer would start from zero forever,
// which defeats the feature.
//
// Two actions, so the whole flow needs one function and one redirect:
//   { action: "list", uid? }    -> { channel, usernames: [...] }  viewers still
//                                  missing a follow date (the browser's work list)
//   { action: "save", uid?, entries: [{ username, followingSince }] }  (max 200)
// Auth: Firebase ID token (streamer, or an account delegated to manage them)

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

const MAX_ENTRIES = 200;
// Kick launched in 2022; anything earlier (or in the future) is a bad payload.
const MIN_FOLLOW_MS = Date.parse("2022-01-01T00:00:00Z");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  // A full backfill is chunked, so allow a decent burst but stop runaway loops.
  if (!(await checkRateLimit(db, ip, "followbackfill", 60, 60))) {
    return res(429, { error: "Too many backfill requests" });
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  // Operate on the MANAGED streamer, not the caller's own account.
  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = (body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) {
    return res(403, { error: "Not authorized for that account" });
  }

  const viewersCol = db.collection("streamers").doc(uid).collection("viewers");

  // ── action: list — hand the browser its work list ──────────────────────────
  if (body.action === "list") {
    try {
      const streamer = await db.collection("streamers").doc(uid).get();
      const channel  = streamer.exists ? (streamer.data().kickChannel || "") : "";
      if (!channel) return res(400, { error: "Streamer has no kickChannel" });
      // Whole collection, then filter in memory: followedAt is absent (not null)
      // on un-backfilled docs, and Firestore can't query for a missing field.
      const snap = await viewersCol.get();
      const usernames = [];
      snap.forEach((d) => {
        const v = d.data();
        if (v.followedAt) return;              // already known
        if (v.followBackfillMiss) return;      // asked before, Kick had no follow
        usernames.push(d.id);
      });
      return res(200, { ok: true, channel, usernames: usernames.slice(0, 1000), total: usernames.length });
    } catch (err) {
      console.error("[follow-backfill] list error:", err.message);
      return res(500, { error: "Could not list viewers" });
    }
  }

  const entries = Array.isArray(body.entries) ? body.entries : null;
  if (!entries || !entries.length) return res(400, { error: "Missing entries" });
  if (entries.length > MAX_ENTRIES) return res(400, { error: `Max ${MAX_ENTRIES} entries per request` });

  const now = Date.now();
  let written = 0, skipped = 0, unchanged = 0;

  let misses = 0;
  try {
    const viewers = viewersCol;
    // Read first so we only write real changes — a no-op backfill shouldn't cost
    // 400 writes every time the page is opened.
    const prepared = [];
    const notFollowing = [];
    for (const e of entries) {
      const username = String(e && e.username || "").trim().toLowerCase();
      if (!username) { skipped++; continue; }
      const raw = e && e.followingSince;
      // Explicit null = Kick answered and said this viewer doesn't follow. Record
      // that so we don't re-query them on every future pass.
      if (raw === null) { notFollowing.push(username); continue; }
      if (!raw) { skipped++; continue; }
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms) || ms < MIN_FOLLOW_MS || ms > now + 60_000) { skipped++; continue; }
      prepared.push({ username, ms });
    }

    if (notFollowing.length) {
      let mb = db.batch();
      notFollowing.forEach((u, i) => {
        mb.set(viewers.doc(u), { followBackfillMiss: true }, { merge: true });
        misses++;
      });
      await mb.commit();
    }

    if (!prepared.length) {
      await db.collection("streamers").doc(uid).set({ followBackfillAt: now }, { merge: true });
      return res(200, { ok: true, written: 0, skipped, unchanged: 0, misses });
    }

    const snaps = await db.getAll(...prepared.map((p) => viewers.doc(p.username)));

    let batch = db.batch();
    let inBatch = 0;
    for (let i = 0; i < prepared.length; i++) {
      const { username, ms } = prepared[i];
      const snap = snaps[i];
      const cur  = snap.exists ? snap.data() : null;
      // Kick's `following_since` is the authoritative CURRENT follow date, so it
      // wins over our webhook stamp when they differ. They agree in practice —
      // spot-checked two channels where the webhook value matched Kick exactly —
      // so a mismatch means a re-follow we didn't observe. Skip sub-minute drift
      // to avoid pointless writes.
      if (cur && cur.followedAt && Math.abs(cur.followedAt - ms) < 60_000) { unchanged++; continue; }
      batch.set(viewers.doc(username), {
        followedAt:       ms,
        followedAtSource: "backfill",   // vs the webhook's own writes — keep them distinguishable
        isFollower:       true,
        lastSeen:         cur && cur.lastSeen ? cur.lastSeen : ms,
      }, { merge: true });
      written++;
      if (++inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
    }
    if (inBatch) await batch.commit();

    // Stamp the channel so the dashboard only auto-runs a full pass once.
    await db.collection("streamers").doc(uid).set({
      followBackfillAt: now,
      followBackfillCount: admin.firestore.FieldValue.increment(written),
    }, { merge: true });

    return res(200, { ok: true, written, unchanged, skipped, misses });
  } catch (err) {
    console.error("[follow-backfill] error:", err.message);
    return res(500, { error: "Backfill failed" });
  }
};
