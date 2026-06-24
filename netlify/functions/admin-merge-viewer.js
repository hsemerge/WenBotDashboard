// POST /api/admin-merge-viewer  (admin only)
// Migrate a VIEWER's data from an old Kick username to a new one across EVERY
// channel they appear in — for viewers who lost their Kick account or renamed.
// This never touches streamer accounts; only per-channel viewer data:
//   • viewers/{key}            → points (summed) + all other fields
//   • verified_users           → re-keyed to the new name (keeps under-code status)
//   • store_redemptions        → raffle tickets + purchases re-attributed
//   • discord_links            → re-pointed (best-effort, exact-name match)
//
// Body: { fromUsername, toUsername, action: "preview" | "commit" }
//   preview → read-only dry run (changes NOTHING), returns what would move
//   commit  → performs the migration; old viewer doc kept + flagged migratedTo
//             (points preserved as migratedPoints) so it's recoverable.
// Audit-logged.

const { getDb, admin }                = require("./_lib/firebase");
const { res, checkRateLimit }         = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

const lc = (s) => String(s || "").toLowerCase().trim();

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_merge_viewer", 20, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const fromName = String(body.fromUsername || "").trim();
  const toName   = String(body.toUsername || "").trim();
  const fromKey  = lc(fromName);
  const toKey    = lc(toName);
  const commit   = body.action === "commit";
  if (!fromKey || !toKey) return res(400, { error: "Both old and new usernames are required." });
  if (fromKey === toKey)  return res(400, { error: "Old and new usernames are the same." });

  try {
    const streamers = await db.collection("streamers").get();
    const channels = [];

    for (const sDoc of streamers.docs) {
      const base = db.collection("streamers").doc(sDoc.id);
      const channelName = sDoc.data().kickChannel || sDoc.id;

      const [vOld, vNew, verifiedSnap, redemAgg] = await Promise.all([
        base.collection("viewers").doc(fromKey).get(),
        base.collection("viewers").doc(toKey).get(),
        base.collection("verified_users").where("kickName_lower", "==", fromKey).get(),
        base.collection("store_redemptions").where("kickUsernameKey", "==", fromKey).count().get(),
      ]);
      const redemCount = redemAgg.data().count || 0;
      const fromPoints = vOld.exists ? Number(vOld.data().points || 0) : 0;
      if (!vOld.exists && verifiedSnap.empty && redemCount === 0) continue; // viewer not on this channel

      const info = {
        uid: sDoc.id,
        channel: channelName,
        fromPoints,
        toPointsExisting: vNew.exists ? Number(vNew.data().points || 0) : 0,
        verified: verifiedSnap.docs.map((d) => d.data().provider || "?"),
        redemptions: redemCount, // raffle tickets + purchases
      };

      if (commit) {
        await migrateChannel(db, base, { fromKey, toKey, fromName, toName, vOld, vNew, verifiedSnap });
        info.migrated = true;
      }
      channels.push(info);
    }

    if (commit) {
      logAdminAudit(db, adminUser.uid, "merge_viewer", {
        fromKey, toKey, channelCount: channels.length,
        channels: channels.map((c) => c.channel),
      });
    }

    return res(200, {
      action: commit ? "commit" : "preview",
      fromUsername: fromName, toUsername: toName, fromKey, toKey,
      channelCount: channels.length,
      totalPoints: channels.reduce((a, c) => a + c.fromPoints, 0),
      totalRedemptions: channels.reduce((a, c) => a + c.redemptions, 0),
      channels,
    });
  } catch (e) {
    console.error("[admin-merge-viewer] error:", e.message);
    return res(500, { error: "Migration failed: " + e.message });
  }
};

// Migrate one channel's viewer data. Old viewer doc is preserved + flagged.
async function migrateChannel(db, base, { fromKey, toKey, fromName, toName, vOld, vNew, verifiedSnap }) {
  // 1) viewer doc — sum points, carry every other field (streak, flags, etc.).
  if (vOld.exists) {
    const oldData = vOld.data();
    const newData = vNew.exists ? vNew.data() : {};
    const merged = { ...oldData, ...newData, points: Number(oldData.points || 0) + Number(newData.points || 0) };
    delete merged.migratedTo; delete merged.migratedAt; delete merged.migratedPoints;
    await base.collection("viewers").doc(toKey).set(merged, { merge: true });
    await vOld.ref.set({
      points: 0,
      migratedTo: toKey,
      migratedAt: Date.now(),
      migratedPoints: Number(oldData.points || 0), // preserved for recovery
    }, { merge: true });
  }

  // 2) verified_users — re-key to the new name (keeps under-code / leaderboard).
  for (const vd of verifiedSnap.docs) {
    const data = vd.data();
    const provider = data.provider || "unknown";
    await base.collection("verified_users").doc(`${toKey}_${provider}`).set(
      { ...data, kickName: toName, kickName_lower: toKey }, { merge: true });
    await vd.ref.delete();
  }

  // 3) store_redemptions — re-attribute raffle tickets + purchases (batched).
  const redem = await base.collection("store_redemptions").where("kickUsernameKey", "==", fromKey).get();
  let batch = db.batch(), pending = 0;
  for (const rd of redem.docs) {
    batch.update(rd.ref, { kickUsernameKey: toKey, kickUsername: toName });
    if (++pending === 400) { await batch.commit(); batch = db.batch(); pending = 0; }
  }
  if (pending > 0) await batch.commit();

  // 4) discord_links — best-effort exact-name re-point.
  const dl = await base.collection("discord_links").where("kickUsername", "==", fromName).get();
  for (const d of dl.docs) await d.ref.update({ kickUsername: toName });
}
