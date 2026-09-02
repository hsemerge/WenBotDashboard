// Scheduled every 2 minutes (see netlify.toml [functions."warm-portal-cache"]).
//
// WHY THIS EXISTS. portal-data caches its whole per-channel payload in
// _cache/portal_<channel> for 150s. Past that the next request in the door pays
// for the full recompute — a dozen Firestore reads plus a live casino call that
// can take 4-6.5s on its own. That request was always a VIEWER, so a portal
// opened on a cold cache sat on "Loading the board..." for the length of the
// recompute. Refreshing on a 2-minute tick keeps the entry inside its own 150s
// TTL, so the slow path is absorbed here instead of by whoever showed up first.
//
// Only channels that already have a cache doc are warmed. That set is written
// by portal-data itself, so it tracks the portals people actually open and
// needs no list to maintain — a channel nobody visits is never warmed, and a
// new one starts being warmed as soon as it has been loaded once.

const { getDb } = require("./_lib/firebase");

// Refresh anything older than this. Comfortably under portal-data's 150s TTL so
// an entry is replaced before it can expire, with room for a late tick.
const STALE_AFTER_MS = 90 * 1000;
// Ceiling per tick. Each warm is a full recompute, and the whole run shares one
// function timeout — better to refresh the oldest few and let the next tick take
// the rest than to run long and have the platform kill the run mid-way.
const MAX_PER_TICK = 12;
// Two at a time: enough to get through the batch, gentle enough that we are not
// the reason a casino's API starts rate-limiting us.
const CONCURRENCY = 2;

exports.handler = async () => {
  const db = getDb();
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base) {
    console.warn("[warm-portal-cache] no site URL in env — nothing to do");
    return { statusCode: 200, body: "no base url" };
  }

  let warmed = 0, skipped = 0, failed = 0;

  try {
    // listDocuments returns refs without reading document bodies, so scanning
    // _cache (which also holds the much larger lb_* and degen_race_* entries)
    // costs nothing beyond the listing itself.
    const refs = await db.collection("_cache").listDocuments();
    const portalRefs = refs.filter((r) => r.id.startsWith("portal_"));

    // Read the timestamps so we only recompute what is actually going stale.
    const due = [];
    for (const ref of portalRefs) {
      let snap;
      try { snap = await ref.get(); } catch { continue; }
      const d = snap.exists ? snap.data() : null;
      if (!d || !d.cachedAt) continue;
      const age = Date.now() - d.cachedAt;
      if (age < STALE_AFTER_MS) { skipped++; continue; }
      due.push({ channel: ref.id.slice("portal_".length), age });
    }

    // Oldest first, so a backlog drains in the order it went stale rather than
    // whatever order the listing happened to return.
    due.sort((a, b) => b.age - a.age);
    const batch = due.slice(0, MAX_PER_TICK);
    if (due.length > batch.length) {
      console.warn(`[warm-portal-cache] ${due.length - batch.length} channel(s) left for the next tick`);
    }

    // _warm busts Netlify's own 60s CDN cache on /api/portal-data. Without it
    // the request is answered at the edge and the Firestore entry this job
    // exists to refresh is never touched.
    const queue = batch.slice();
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const { channel } = queue.shift();
        const url = `${base}/api/portal-data?channel=${encodeURIComponent(channel)}&_warm=${Date.now()}`;
        try {
          const r = await fetch(url, {
            headers: { "Cache-Control": "no-cache" },
            // Longer than the 8s ceiling on a single casino call, so a warm is
            // only abandoned when the whole recompute has genuinely stalled.
            signal: AbortSignal.timeout(20000),
          });
          if (r.ok) { warmed++; } else { failed++; console.warn(`[warm-portal-cache] ${channel}: HTTP ${r.status}`); }
        } catch (e) {
          failed++;
          console.warn(`[warm-portal-cache] ${channel}: ${e.message}`);
        }
      }
    });
    await Promise.all(workers);

    console.log(`[warm-portal-cache] warmed=${warmed} skipped=${skipped} failed=${failed}`);
    return { statusCode: 200, body: JSON.stringify({ warmed, skipped, failed }) };
  } catch (err) {
    console.error("[warm-portal-cache] error:", err.message);
    // A warmer that throws must not look like a broken deploy: the portals keep
    // working off their own cache either way.
    return { statusCode: 200, body: "error" };
  }
};
