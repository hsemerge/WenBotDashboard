// GET/POST /api/admin-domains  (admin only; writes are owner-only)
//
// Custom domains for streamer portals (skslots.co.uk → /skslots). The mapping
// lives in the `custom_domains` collection so it can be managed from the portal
// instead of hand-editing netlify/edge-functions/custom-domain.js and shipping a
// code change to onboard an Agency customer.
//
// WHY THE EDGE FUNCTION STILL READS A BAKED MAP: custom-domain.js is registered
// `path: "/*"`, so it runs on EVERY request to the whole site. A Firestore or
// API lookup in that hot path would tax every page load for everyone to serve a
// handful of domains. Instead scripts/bake-domains.js reads this collection at
// BUILD time and writes the map into the edge function — admin-managed, with
// zero runtime cost. Adding a domain therefore needs a deploy to take effect,
// which the UI says plainly.
//
//   GET                        → { domains: [...], baked: [...] }
//   POST {action:'add',    host, slug, page?}
//   POST {action:'remove', host}
//   POST {action:'update', host, fields:{slug?, page?, enabled?}}

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
// Hostnames only — no scheme, no path, no wildcards. Anything else is a typo
// that would silently never match a real request.
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_domains", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  const col = db.collection("custom_domains");

  if (event.httpMethod === "GET") {
    const snap = await col.orderBy("host").get();
    return res(200, { domains: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  }

  // Changing which hostname serves which streamer's portal is a routing change
  // for the whole site — owner-only.
  if (adminUser.role !== "owner") return res(403, { error: "Managing domains is owner-only." });

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const action = String(body.action || "").trim();
  const host   = clean(body.host, 120).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  if (action === "add") {
    const slug = clean(body.slug, 60).toLowerCase();
    if (!HOST_RE.test(host)) return res(400, { error: "Enter a bare hostname, e.g. megrewards.com (no https://, no trailing path)." });
    if (!slug) return res(400, { error: "Which streamer should this domain serve? Enter their WenBot channel slug." });
    const existing = await col.doc(host).get();
    if (existing.exists) return res(409, { error: `${host} is already mapped to ${existing.data().slug}.` });
    const doc = {
      host, slug,
      page:      clean(body.page, 200) || null,   // bespoke portal path, if any
      enabled:   true,
      createdAt: Date.now(),
      createdBy: adminUser.email || adminUser.uid,
    };
    await col.doc(host).set(doc);
    logAdminAudit(db, adminUser.uid, "domain_add", { host, slug });
    return res(200, { ok: true, host, needsDeploy: true });
  }

  if (!host) return res(400, { error: "Missing host" });
  const ref  = col.doc(host);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "That domain isn't mapped." });

  if (action === "remove") {
    await ref.delete();
    logAdminAudit(db, adminUser.uid, "domain_remove", { host, slug: snap.data().slug });
    return res(200, { ok: true, needsDeploy: true });
  }

  if (action === "update") {
    const f = body.fields || {};
    const update = { updatedAt: Date.now() };
    if (f.slug    !== undefined) { const s = clean(f.slug, 60).toLowerCase(); if (s) update.slug = s; }
    if (f.page    !== undefined) update.page    = clean(f.page, 200) || null;
    if (f.enabled !== undefined) update.enabled = !!f.enabled;
    await ref.set(update, { merge: true });
    logAdminAudit(db, adminUser.uid, "domain_update", { host, ...update });
    return res(200, { ok: true, needsDeploy: true });
  }

  return res(400, { error: "Invalid action" });
};
