// POST /api/admin-erase-viewer   (admin only)
// Body: { kickUsername, dryRun?: true }
//
// Fulfils a viewer's erasure request. A viewer has no account, so their data is
// scattered across EVERY streamer they ever interacted with plus a couple of
// top-level collections. Doing this by hand in the console is slow and easy to
// get wrong, which is the gap between what the privacy policy promises and what
// we could actually deliver.
//
// DRY RUN BY DEFAULT IS DELIBERATE: pass dryRun:false to actually delete.
// The report is identical either way, so an operator can see exactly what would
// go before committing to it.
//
// Scope note: this erases the viewer's PERSONAL records. It deliberately does
// NOT touch aggregate counters (communityStats, raffleTickets totals) — those
// hold no identifier, and rewriting a streamer's historical totals to service
// someone else's request would corrupt their data.

const { getDb, admin }                = require("./_lib/firebase");
const { res, checkRateLimit }         = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

// Per-streamer subcollections keyed by the viewer. `byDocId` means the doc id
// IS the lowercased username; otherwise we query the named field.
const PER_STREAMER = [
  { name: "viewers",           byDocId: true },
  { name: "kick_profiles",     byDocId: true },
  { name: "mod_strikes",       byDocId: true },
  { name: "verified_users",    field: "kickName_lower" },
  { name: "discord_links",     field: "kickUsername_lower" },
  { name: "mod_actions",       field: "kickName" },
  { name: "winners_log",       field: "kickKey" },
  { name: "store_redemptions", field: "kickUsername" },
  { name: "slot_requests",     field: "kickUsername" },
  { name: "raffle_entries",    field: "kickUsername" },
];

// Top-level, not under any streamer.
const TOP_LEVEL = [{ collection: "wenpoints", byDocId: true }];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"] || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_erase", 10, 60))) {
    return res(429, { error: "Too many requests" });
  }

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const kickUsername = String(body.kickUsername || "").replace(/^@/, "").trim();
  if (!kickUsername) return res(400, { error: "Missing kickUsername" });
  const key = kickUsername.toLowerCase();

  // Default to a dry run so a mistyped username can't destroy the wrong
  // person's records. Only an explicit false commits.
  const dryRun = body.dryRun !== false;

  try {
    const report = { kickUsername: key, dryRun, streamers: {}, topLevel: {}, total: 0 };
    const deletions = [];   // { ref } collected first, deleted after

    const streamers = await db.collection("streamers").get();
    for (const s of streamers.docs) {
      const found = {};
      for (const spec of PER_STREAMER) {
        const col = s.ref.collection(spec.name);
        let docs = [];
        if (spec.byDocId) {
          const d = await col.doc(key).get();
          if (d.exists) docs = [d];
        } else {
          // Field values aren't consistently lowercased across older records,
          // so try the raw key and the original casing.
          const seen = new Set();
          for (const val of [key, kickUsername]) {
            const q = await col.where(spec.field, "==", val).limit(500).get();
            q.docs.forEach((d) => { if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); } });
          }
        }
        if (!docs.length) continue;
        found[spec.name] = docs.length;
        report.total += docs.length;
        docs.forEach((d) => deletions.push(d.ref));
      }
      if (Object.keys(found).length) {
        report.streamers[s.data().kickChannel || s.id] = found;
      }
    }

    for (const spec of TOP_LEVEL) {
      const d = await db.collection(spec.collection).doc(key).get();
      if (!d.exists) continue;
      report.topLevel[spec.collection] = 1;
      report.total += 1;
      deletions.push(d.ref);
    }

    if (!dryRun && deletions.length) {
      for (let i = 0; i < deletions.length; i += 400) {
        const batch = db.batch();
        deletions.slice(i, i + 400).forEach((ref) => batch.delete(ref));
        await batch.commit();
      }
    }

    // Log the request itself either way — proof the request was handled, and
    // when. The log records the username and counts, never the erased content.
    await logAdminAudit(db, adminUser.uid, dryRun ? "viewer_erase_preview" : "viewer_erase", {
      kickUsername: key,
      recordsFound: report.total,
      streamersAffected: Object.keys(report.streamers).length,
    });

    return res(200, {
      ok: true,
      ...report,
      message: dryRun
        ? `Dry run: ${report.total} record(s) across ${Object.keys(report.streamers).length} streamer(s). Re-send with dryRun:false to erase.`
        : `Erased ${report.total} record(s) across ${Object.keys(report.streamers).length} streamer(s).`,
    });
  } catch (err) {
    console.error("[admin-erase-viewer]", err.message);
    return res(500, { error: "Internal server error" });
  }
};
