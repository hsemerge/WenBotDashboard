// In-process TTL cache for the read-heavy PUBLIC overlay endpoints.
//
// The OBS overlays poll their endpoint every 0.3-1.5s per open source, with no
// auth. Each poll otherwise costs a channel-resolve read plus a document read
// (slot-request-data reads up to 50 docs), so a single overlay left open for an
// 8-hour stream can be tens of thousands of Firestore reads on its own. That was
// the platform's #2 read driver.
//
// Netlify keeps a function's container warm between invocations, so a
// module-level Map survives across the frequent polls that land on the same
// instance. On a hit we return the last computed response with ZERO Firestore
// reads. The cache is per-instance and serves data at most `ttlMs` old, which on
// a display overlay is imperceptible (a bankroll total or a bonus-hunt figure a
// couple of seconds behind looks identical on stream).
//
// Deliberately in-process, NOT a Firestore `_cache` doc like portal-data uses: a
// Firestore cache still costs one read per hit, which is the wrong trade when the
// poll interval is sub-second. The endpoints that cache this way pick a TTL short
// enough that latency-sensitive fields (e.g. a giveaway spin trigger) stay fresh.
//
// Date.now() is ordinary here (this is a normal Node runtime, not a workflow
// script), so time-based expiry is fine.

const store = new Map(); // key -> { at, val }

/**
 * Return a cached value for `key` if it is younger than `ttlMs`, otherwise run
 * `produce()`, cache its result, and return it. A throw from `produce()` is NOT
 * cached — the error propagates and the next call retries — so a transient
 * Firestore blip never sticks.
 */
async function memo(key, ttlMs, produce) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && (now - hit.at) < ttlMs) return hit.val;

  const val = await produce();
  store.set(key, { at: now, val });

  // Bound the map on a long-lived warm instance: once it grows past a threshold,
  // drop anything older than a minute. Cheap, and the working set is tiny (one
  // entry per actively-polled channel per endpoint).
  if (store.size > 1000) {
    for (const [k, v] of store) if (now - v.at > 60_000) store.delete(k);
  }
  return val;
}

module.exports = { memo };
