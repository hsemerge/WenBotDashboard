// GET /api/admin-alerts  (admin only)
//
// The operational alerts the bot already writes to `admin_alerts` — bot boot
// results, stuck channels, failed go-live announcements. They fire once into
// Discord and were then invisible, so a streamer whose go-live posts have been
// failing for a week finds out by complaining. This surfaces them.
//
// Alerts are GROUPED by their key (which is "<type>:<streamerUid>" for the
// per-channel ones) so twelve repeats of the same broken channel read as one
// problem with a count and a first/last seen — a list of individual events is
// noise, a list of unresolved problems is a to-do list.
//
//   GET ?limit=300  → { groups: [...], recent: [...], stats: {...} }

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin }        = require("./_lib/admin");

// A "good" alert of the same family clears the bad ones before it — a channel
// that booted fine after being stuck is no longer a problem.
const CLEARS = { "boot-ok": ["boot-partial", "boot-fail"] };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET")     return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_alerts", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  const limit = Math.min(500, Math.max(20, parseInt(event.queryStringParameters?.limit, 10) || 300));
  const snap = await db.collection("admin_alerts").orderBy("at", "desc").limit(limit).get();

  const all = snap.docs.map((d) => {
    const a = d.data();
    const key  = String(a.key || "unknown");
    const type = key.split(":")[0];
    const uid  = key.includes(":") ? key.slice(type.length + 1) : null;
    return {
      id: d.id, key, type, uid,
      level:  a.level || "info",
      title:  a.title || key,
      detail: a.detail || null,
      fields: a.fields || null,
      at:     typeof a.at === "number" ? a.at : (a.at && a.at.toMillis ? a.at.toMillis() : null),
    };
  });

  // Group by key: one row per ongoing problem, not per occurrence.
  const map = new Map();
  for (const a of all) {
    const g = map.get(a.key);
    if (!g) {
      map.set(a.key, { key: a.key, type: a.type, uid: a.uid, level: a.level, title: a.title,
                       detail: a.detail, fields: a.fields, count: 1, lastAt: a.at, firstAt: a.at });
    } else {
      g.count++;
      if (a.at && (!g.firstAt || a.at < g.firstAt)) g.firstAt = a.at;
      // Keep the newest occurrence's wording — the error may have changed.
      if (a.at && a.at > g.lastAt) { g.lastAt = a.at; g.level = a.level; g.title = a.title; g.detail = a.detail; g.fields = a.fields; }
    }
  }
  let groups = [...map.values()];

  // Resolve: a later "good" alert of a clearing type wipes earlier bad ones.
  const newestGood = {};
  for (const a of all) if (a.level === "good") newestGood[a.type] = Math.max(newestGood[a.type] || 0, a.at || 0);
  groups.forEach((g) => {
    g.resolved = false;
    for (const [goodType, clears] of Object.entries(CLEARS)) {
      if (clears.includes(g.type) && (newestGood[goodType] || 0) > (g.lastAt || 0)) g.resolved = true;
    }
  });

  // Attach the channel name so a uid-keyed alert reads as a person.
  const uids = [...new Set(groups.map((g) => g.uid).filter(Boolean))];
  if (uids.length) {
    await Promise.all(uids.map(async (uid) => {
      try {
        const d = await db.collection("streamers").doc(uid).get();
        if (d.exists) {
          const ch = d.data().kickChannel || null;
          groups.forEach((g) => { if (g.uid === uid) g.channel = ch; });
        }
      } catch { /* name is a nicety */ }
    }));
  }

  // Open problems first, then most recent.
  const rank = { error: 0, warn: 1, info: 2, good: 3 };
  groups.sort((a, b) =>
    (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0) ||
    (rank[a.level] ?? 9) - (rank[b.level] ?? 9) ||
    (b.lastAt || 0) - (a.lastAt || 0));

  const open = groups.filter((g) => !g.resolved && (g.level === "error" || g.level === "warn"));
  const stats = {
    openProblems:  open.length,
    errors:        open.filter((g) => g.level === "error").length,
    warnings:      open.filter((g) => g.level === "warn").length,
    channels:      new Set(open.map((g) => g.uid).filter(Boolean)).size,
    lastBoot:      Math.max(0, ...all.filter((a) => a.type === "boot-ok").map((a) => a.at || 0)) || null,
    lastBootTitle: (all.find((a) => a.type === "boot-ok") || {}).title || null,
    scanned:       all.length,
  };

  return res(200, { groups, stats, recent: all.slice(0, 40) });
};
