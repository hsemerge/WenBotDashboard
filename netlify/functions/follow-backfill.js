// POST /api/follow-backfill
// Fills in follow dates for viewers who followed BEFORE WenBot joined a channel.
//
// The only place `following_since` is exposed is the unofficial endpoint
//   GET https://kick.com/api/v2/channels/{channel}/users/{username}
// which Cloudflare 403s from Lambda and from Railway. Netlify's EDGE runtime
// (Deno) is not blocked, so this Lambda resolves each viewer through our own
// /api/kick-user edge function rather than calling Kick directly. Verified
// 2026-07-30: edge returns 200 with `following_since` across multiple channels.
//
// This is BACKFILL ONLY. The live source of truth stays the official
// `channel.followed` webhook, which the bot already consumes. Without this,
// followage can only ever see follows that happened after WenBot joined a
// channel — so every newly onboarded streamer would start from zero forever,
// which defeats the feature.
//
// Two actions:
//   { action: "list", uid? }  -> { channel, usernames: [...] }  viewers still
//                                missing a follow date (the work list)
//   { action: "fetch", uid?, usernames: [...] }  (max 40 per call)
//                             -> resolves each via our own /api/kick-user EDGE
//                                endpoint and writes the results
//
// The browser only ORCHESTRATES — it sends usernames and gets counts back. It
// never supplies follow dates, so a client can't forge them.
// Auth: Firebase ID token (streamer, or an account delegated to manage them)

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");

const MAX_BATCH = 40;   // usernames resolved per invocation (Lambda timeout headroom)
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

  // ── action: fetch — resolve a batch server-side, then write ────────────────
  if (body.action !== "fetch") return res(400, { error: "Unknown action" });

  const wanted = Array.isArray(body.usernames) ? body.usernames : null;
  if (!wanted || !wanted.length) return res(400, { error: "Missing usernames" });
  if (wanted.length > MAX_BATCH) return res(400, { error: `Max ${MAX_BATCH} usernames per request` });

  const streamerSnap = await db.collection("streamers").doc(uid).get();
  const channel = streamerSnap.exists ? (streamerSnap.data().kickChannel || "") : "";
  if (!channel) return res(400, { error: "Streamer has no kickChannel" });

  // Resolve through our OWN edge endpoint. It has to be the edge one: this Lambda
  // cannot reach kick.com/api/v2 directly (403 from every datacenter IP), which is
  // exactly why the old Lambda kick-user went dead. The edge runtime can.
  const origin = process.env.PUBLIC_BASE_URL || `https://${event.headers.host || "wenbot.gg"}`;
  const entries = [];
  let unreachable = 0;

  async function resolveOne(username) {
    const u = `${origin}/api/kick-user?channel=${encodeURIComponent(channel)}&user=${encodeURIComponent(username)}`;
    try {
      const r = await fetch(u, { headers: { Accept: "application/json" } });
      if (r.status === 404) { entries.push({ username, followingSince: null }); return; } // definitively not a follower
      if (!r.ok) { unreachable++; return; }
      const d = await r.json();
      entries.push({ username, followingSince: d.followingSince || null });
    } catch { unreachable++; }
  }

  // Modest concurrency: polite to Kick and comfortably inside the Lambda timeout
  // for a batch this size.
  const CONCURRENCY = 5;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
    while (cursor < wanted.length) {
      const name = String(wanted[cursor++] || "").trim().toLowerCase();
      if (name) await resolveOne(name);
    }
  }));

  if (!entries.length) {
    return res(200, { ok: true, written: 0, unchanged: 0, skipped: 0, misses: 0, unreachable });
  }

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

    return res(200, { ok: true, written, unchanged, skipped, misses, unreachable });
  } catch (err) {
    console.error("[follow-backfill] error:", err.message);
    return res(500, { error: "Backfill failed" });
  }
};
