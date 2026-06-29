// POST /api/admin-slots-ingest
// Body: { slots: [ { name, slug, thumbnailUrl, provider }, ... ] }  (a Stake pull)
// Auth: header  X-Ingest-Key: <key>  — the admin-only key shown in the admin panel
//       (the WenBot dashboard's Firebase token can't reach here: this is POSTed
//        cross-origin from stake.com by the bookmarklet, so a shared key is used).
//
// Merges the pull into the live catalog (Firestore _cache/slots_catalog_all) using
// the same safe rules as the offline script: append new slots + fill ONLY empty
// thumbnails, never clobber manual/self-hosted art. slots-catalog serves this cache,
// so the dashboard slot picker updates within minutes — no redeploy.
//
// CORS: full preflight support because the bookmarklet calls from stake.com.

const { getDb }                    = require("./_lib/firebase");
const { timingSafeEq, checkRateLimit } = require("./_lib/http");
const { mergeSlots }               = require("./_lib/slot-merge");

// Only accept thumbnails from CSP-displayable domains. If the ingest key ever
// leaked, this stops junk/hostile image URLs from entering the catalog (those
// entries are dropped → merge skips them as imageless).
const ALLOWED_IMG = ["mediumrare.imgix.net", "cdn.softswiss.net", "cdn.pragmaticplay.net", "cms.pragmaticplay.net", "cloudfront.net", "bucket.gambulls.com"];
const okImg = (u) => { try { const h = new URL(u).hostname.toLowerCase(); return ALLOWED_IMG.some((d) => h === d || h.endsWith("." + d)); } catch { return false; } };
const path = require("path");
const fs   = require("fs");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Key",
  "Content-Type": "application/json",
};
const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

function loadStatic() {
  try {
    const p = path.join(__dirname, "../../data/slots.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).slots || [];
  } catch { return []; }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")    return reply(405, { error: "Method not allowed" });

  const db = getDb();

  // Rate-limit early (also throttles any key-guessing) — a few legit refreshes/min is plenty.
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "slots_ingest", 6, 60))) return reply(429, { error: "Too many requests" });

  // ── Auth via the admin ingest key (stored in Firestore, shown only in admin) ──
  const provided = event.headers["x-ingest-key"] || event.headers["X-Ingest-Key"] || "";
  let stored = null;
  try { const k = await db.collection("_cache").doc("slots_ingest_key").get(); stored = k.exists ? k.data().key : null; }
  catch { return reply(500, { error: "Key store unavailable" }); }
  if (!stored)                       return reply(403, { error: "No ingest key set — open the admin Slots tab once to generate it." });
  if (!timingSafeEq(provided, stored)) return reply(403, { error: "Invalid ingest key" });

  // ── Parse the pull ──────────────────────────────────────────────────────────
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Bad JSON" }); }
  const pull = Array.isArray(body.slots) ? body.slots : (Array.isArray(body) ? body : null);
  if (!pull || !pull.length) return reply(400, { error: "Expected { slots: [...] } with at least one game" });
  if (pull.length > 20000)   return reply(413, { error: "Pull too large" });

  // Drop thumbnails from non-displayable domains — those entries then merge as
  // imageless (and new ones are skipped), so a leaked key can't poison the catalog.
  for (const g of pull) { if (g && g.thumbnailUrl && !okImg(g.thumbnailUrl)) g.thumbnailUrl = null; }

  // ── Current catalog: live cache if present, else bundled static base ─────────
  const cacheRef = db.collection("_cache").doc("slots_catalog_all");
  let current = [];
  try {
    const c = await cacheRef.get();
    if (c.exists && Array.isArray(c.data().slots) && c.data().slots.length) current = c.data().slots;
  } catch { /* fall through */ }
  if (!current.length) current = loadStatic();
  if (!current.length) return reply(500, { error: "No base catalog available" });

  // ── Merge (append-new + fill-empty-only) ────────────────────────────────────
  const { slots, added, backfilled, skipped, newList } = mergeSlots(current, pull);

  // ── Persist to the live cache (slots-catalog serves this) ───────────────────
  try { await cacheRef.set({ slots, cachedAt: Date.now() }); }
  catch (e) { return reply(500, { error: "Catalog write failed: " + e.message }); }

  return reply(200, {
    ok: true,
    pulled:      pull.length,
    added,
    backfilled,
    skipped,
    total:       slots.length,
    newSlots:    newList.slice(0, 100),
    note:        "Dashboard slot picker updates within ~minutes. (The browser extension's offline list updates on the next site deploy.)",
  });
};
