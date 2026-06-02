// GET /api/admin-slots          (admin only) — slot catalog health
// GET /api/admin-slots?refresh=1 (admin only) — force a live re-fetch from Stake
//
// Reuses the existing slots-catalog endpoint (live Stake fetch → Firestore cache →
// static fallback) and reports health: total, how many are missing thumbnails
// (the "missing slots" to regenerate), provider breakdown, and the source/age of
// the data. ?refresh=1 triggers the live re-fetch (often 403s behind Stake's
// Cloudflare; the static catalog is the reliable base, and the pull-slots →
// ingest-slots script is the full regeneration path).

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_slots", 15, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  const refresh = (event.queryStringParameters || {}).refresh === "1";
  const host = event.headers.host;
  const url  = `https://${host}/.netlify/functions/slots-catalog${refresh ? "?refresh=1" : ""}`;

  let cat;
  try { cat = await (await fetch(url)).json(); }
  catch (e) { return res(502, { error: "Catalog fetch failed: " + e.message }); }

  const slots   = cat.slots || [];
  const missing = slots.filter((s) => !s.thumbnailUrl && !s.thumbnail);
  const missingByProvider = {};
  missing.forEach((s) => { const p = s.provider || "Unknown"; missingByProvider[p] = (missingByProvider[p] || 0) + 1; });

  if (refresh) {
    logAdminAudit(db, adminUser.uid, "slots_refresh", { source: cat.source, total: slots.length, missing: missing.length });
  }

  return res(200, {
    total:            slots.length,
    withThumbnail:    slots.length - missing.length,
    missingThumbnail: missing.length,
    providers:        new Set(slots.map((s) => s.provider)).size,
    source:           cat.source || null,
    cachedAt:         cat.cachedAt || null,
    missingByProvider,
    missing:          missing.slice(0, 300).map((s) => ({ id: s.id, name: s.name, provider: s.provider || null })),
  });
};
