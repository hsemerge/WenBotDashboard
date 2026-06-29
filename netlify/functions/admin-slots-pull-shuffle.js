// GET /api/admin-slots-pull-shuffle   (admin only)
// Server-side pull of Shuffle's public game catalog → merge into the live catalog.
// Unlike Stake, Shuffle's catalog (a public JSON asset) is NOT Cloudflare-blocked,
// so this is a one-click dashboard button — no bookmarklet needed. Captures Shuffle
// EXCLUSIVES (games not on Stake) and fills some missing thumbnails.
//
// Same safe merge as the rest: append-new + fill-empty-only. Filters out Shuffle
// originals (Dice/Mines/etc.) and live-casino providers so only real slots land.

const { getDb }                              = require("./_lib/firebase");
const { res, checkRateLimit }                = require("./_lib/http");
const { requireAdmin, logAdminAudit }        = require("./_lib/admin");
const { mergeSlots, packSlots, unpackDoc }   = require("./_lib/slot-merge");
const path = require("path");
const fs   = require("fs");

const SHUFFLE_URL = "https://shuffle.com/main-api/bp-storage/public-assets/games/games.json";
const IMG = (key) => `https://shuffle-com.imgix.net/${key}?auto=format&width=400`;
// Live-casino / non-slot providers to skip (Shuffle carries a lot of live tables).
const LIVE_PROV = /(^|\s)(live|evolution|ezugi|authentic gaming|atmosfera|betgames|vivo|skywind live|absolute live|pragmatic play live|live ?g24|on ?air)(\s|$)/i;

function loadStatic() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "../../data/slots.json"), "utf8")).slots || []; }
  catch { return []; }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET")     return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "shuffle_pull", 4, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  // Fetch Shuffle's public catalog (server-side is fine — no Cloudflare block).
  let games;
  try {
    const r = await fetch(SHUFFLE_URL, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return res(502, { error: "Shuffle fetch HTTP " + r.status });
    games = await r.json();
  } catch (e) { return res(502, { error: "Shuffle fetch failed: " + e.message }); }
  if (!Array.isArray(games)) return res(502, { error: "Unexpected Shuffle response" });

  // Normalize → pull shape; drop Shuffle originals, live-casino, and imageless.
  let originals = 0, live = 0;
  const pull = [];
  for (const g of games) {
    if (!g || !g.name || !g.image || !g.image.key) continue;
    const provName = (g.provider && g.provider.name) || "";
    const provId   = g.provider && g.provider.id;
    if (provId === "original" || String(g.slug || "").startsWith("originals/")) { originals++; continue; }
    if (LIVE_PROV.test(provName)) { live++; continue; }
    pull.push({ name: g.name, slug: g.slug || g.name, thumbnailUrl: IMG(g.image.key), provider: provName });
  }
  if (!pull.length) return res(502, { error: "No slots parsed from Shuffle" });

  // Current catalog: live cache if present, else bundled static base.
  const cacheRef = db.collection("_cache").doc("slots_catalog_all");
  let current = [];
  try { const c = await cacheRef.get(); if (c.exists) current = unpackDoc(c.data()); } catch {}
  if (!current.length) current = loadStatic();
  if (!current.length) return res(500, { error: "No base catalog available" });

  const { slots, added, backfilled, skipped, newList } = mergeSlots(current, pull);

  try { await cacheRef.set({ gz: packSlots(slots), count: slots.length, cachedAt: Date.now() }); }
  catch (e) { return res(500, { error: "Catalog write failed: " + e.message }); }

  logAdminAudit(db, adminUser.uid, "slots_pull_shuffle", { parsed: pull.length, added, backfilled, total: slots.length });
  return res(200, {
    ok: true, source: "shuffle",
    parsed: pull.length, skippedOriginals: originals, skippedLive: live,
    added, backfilled, skipped, total: slots.length,
    newSlots: newList.slice(0, 100),
  });
};
