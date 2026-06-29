// GET /.netlify/functions/slots-catalog
// GET /.netlify/functions/slots-catalog?provider=pragmatic-play
// GET /.netlify/functions/slots-catalog?refresh=1   (admin: forces re-fetch)
//
// Fetches the full Stake casino game catalog from their public API and caches
// the result in Firestore for CACHE_TTL_MS. Falls back to the bundled
// static /data/slots.json if the upstream call fails.
//
// Response shape:
//   { slots: [...], total: N, source: 'cache'|'live'|'static', cachedAt: epoch }
//
// Each slot:
//   { id, name, provider, thumbnailUrl, bonusBuy, exclusive }

const { getDb }     = require("./_lib/firebase");
const { res }       = require("./_lib/http");
const { unpackDoc } = require("./_lib/slot-merge");
const path          = require("path");
const fs            = require("fs");

const CACHE_DOC     = "_cache/slots_catalog";
const CACHE_TTL_MS  = 6 * 60 * 60 * 1000; // 6 hours

// ── Stake GraphQL query ───────────────────────────────────────────────────────
// Uses Stake's slugKuratorGroup root field (discovered via browser DevTools).
// Paginates via offset/limit in batches of 50.
// NOTE: Stake applies Cloudflare bot-protection to server-side callers —
// this live fetch will usually 403. The static data/slots.json is the
// reliable fallback; the live path updates the cache when it succeeds.

const STAKE_GQL = "https://stake.com/_api/graphql";

const GAMES_QUERY = `
query SlugKuratorGroupGames($slug: String!, $limit: Int!, $offset: Int!) {
  slugKuratorGroup(slug: $slug) {
    groupGamesList(limit: $limit, offset: $offset) {
      name
      slug
      thumbnailUrl
      provider {
        name
        slug
      }
    }
  }
}`;

async function fetchPage(offset) {
  const resp = await fetch(STAKE_GQL, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept":       "application/json",
      "x-language":  "en",
    },
    body: JSON.stringify({
      query: GAMES_QUERY,
      variables: { slug: "slots", limit: 50, offset },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) throw new Error(`Stake API HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data?.slugKuratorGroup?.groupGamesList || null;
}

async function fetchAllGames() {
  const PAGE = 50;
  let offset = 0;
  let all    = [];

  while (true) {
    const page = await fetchPage(offset);
    if (!page || page.length === 0) break;

    all = all.concat(page);
    if (page.length < PAGE) break;
    offset += PAGE;

    // Safety cap
    if (all.length >= 20000) break;
  }

  return all;
}

function normalizeSlot(raw) {
  const provider = raw.provider?.name || "Unknown";
  const img      = raw.thumbnailUrl || raw.thumbnailBackground || null;
  return {
    id:           raw.slug || raw.id,
    name:         raw.name,
    provider,
    thumbnailUrl: img,
    bonusBuy:     false, // Stake API doesn't expose this flag; populated from static list merge
    exclusive:    null,
  };
}

// ── Merge live data with our curated static list (bonus-buy flags, exclusives) ─
function mergeWithStatic(liveSlots, staticSlots) {
  const staticMap = new Map();
  for (const s of staticSlots) {
    const key = s.name.toLowerCase().trim();
    staticMap.set(key, s);
  }

  return liveSlots.map(slot => {
    const key    = slot.name.toLowerCase().trim();
    const curated = staticMap.get(key);
    return {
      ...slot,
      bonusBuy:     curated?.bonusBuy  ?? false,
      exclusive:    curated?.exclusive ?? null,
      gameId:       curated?.gameId    ?? null,
      maxWin:       curated?.maxWin    ?? null,
    };
  });
}

// ── Load bundled static fallback ──────────────────────────────────────────────
function loadStatic() {
  try {
    const p    = path.join(__dirname, "../../data/slots.json");
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return data.slots || [];
  } catch {
    return [];
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET")     return res(405, { error: "Method not allowed" });

  const params      = event.queryStringParameters || {};
  const providerSlug = params.provider || null;
  const forceRefresh = params.refresh === "1";
  const db          = getDb();
  const cacheKey    = providerSlug ? `slots_catalog_${providerSlug}` : "slots_catalog_all";
  const cacheRef    = db.collection("_cache").doc(cacheKey);

  // ── Check Firestore cache ──────────────────────────────────────────────────
  if (!forceRefresh) {
    try {
      const cached = await cacheRef.get();
      if (cached.exists) {
        const d = cached.data();
        if (Date.now() - (d.cachedAt || 0) < CACHE_TTL_MS) {
          const slots = unpackDoc(d);
          if (slots.length) return res(200, { slots, total: slots.length, source: "cache", cachedAt: d.cachedAt });
        }
      }
    } catch (err) {
      console.warn("[slots-catalog] cache read failed:", err.message);
    }
  }

  // ── Fetch live from Stake ──────────────────────────────────────────────────
  const staticSlots = loadStatic();

  try {
    const rawGames = await fetchAllGames();
    const liveSlots = rawGames.map(normalizeSlot);
    const merged    = mergeWithStatic(liveSlots, staticSlots);

    // Write to Firestore cache (best-effort)
    try {
      await cacheRef.set({ slots: merged, cachedAt: Date.now() });
    } catch (err) {
      console.warn("[slots-catalog] cache write failed:", err.message);
    }

    return res(200, {
      slots:    merged,
      total:    merged.length,
      source:   "live",
      cachedAt: Date.now(),
    });

  } catch (err) {
    console.error("[slots-catalog] Stake API failed:", err.message);

    // Prefer the last cached catalog (incl. any admin bookmarklet ingest) over the
    // bundled static list — even if past TTL — so ingested updates persist after the
    // 6h window instead of silently reverting to the shipped file.
    try {
      const allRef = db.collection("_cache").doc("slots_catalog_all");
      const cached = await allRef.get();
      const all = cached.exists ? unpackDoc(cached.data()) : [];
      if (all.length) {
        const f = providerSlug
          ? all.filter(s => s.provider?.toLowerCase().replace(/[^a-z0-9]/g, "-") === providerSlug)
          : all;
        return res(200, { slots: f, total: f.length, source: "cache", cachedAt: cached.data().cachedAt || null });
      }
    } catch (e) { console.warn("[slots-catalog] stale-cache fallback failed:", e.message); }

    // ── Static fallback ────────────────────────────────────────────────────
    const filtered = providerSlug
      ? staticSlots.filter(s => s.provider?.toLowerCase().replace(/[^a-z0-9]/g, "-") === providerSlug)
      : staticSlots;

    return res(200, {
      slots:    filtered,
      total:    filtered.length,
      source:   "static",
      cachedAt: null,
      warning:  "Stake API unavailable — serving static catalog (" + filtered.length + " slots)",
    });
  }
};
