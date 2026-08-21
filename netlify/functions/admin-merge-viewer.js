// POST /api/admin-merge-viewer  (admin only)
// Migrate a VIEWER's data from an old Kick username to a new one across EVERY
// channel they appear in — for viewers who lost their Kick account or renamed.
// This never touches streamer accounts; only per-channel viewer data:
//   • viewers/{key}            → points (summed) + all other fields
//   • kick_profiles            → moved
//   • mod_strikes              → moved
//   • viewer_history           → moved (the mod trail follows the merged name)
//   • verified_users           → re-keyed to the new name (keeps under-code status)
//   • store_redemptions        → tickets MOVED to the right doc id, purchases relabelled
//   • slot_requests            → relabelled
//   • winners_log              → relabelled (keeps their lifetime win count)
//   • tournament_entries       → relabelled
//   • gtb guesses              → moved
//   • discord_links            → re-pointed (case-insensitive)
//   • wenpoints                → community balance summed (top-level, once)
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

// Every per-channel place a viewer's data is filed, and how it is keyed.
// `byDocId` means the document id IS the lowercased Kick name; otherwise the
// named field holds it.
//
// Field names verified against live documents rather than copied from the erase
// tool, whose map has two that would silently match nothing:
// discord_links.kickUsername_lower does not exist (the field is display-case
// `kickUsername`), and store_redemptions.kickUsername is display-case too, so an
// equality match on a lowercased key never fires. Both are handled correctly
// here - the lowercase twin `kickUsernameKey` for redemptions, and a
// case-insensitive scan for discord_links.
const VIEWER_DATA = [
  { name: "viewers",            byDocId: true },
  { name: "kick_profiles",      byDocId: true },
  { name: "mod_strikes",        byDocId: true },
  { name: "viewer_history",     byDocId: true },
  { name: "verified_users",     field: "kickName_lower" },
  { name: "winners_log",        field: "kickKey" },
  { name: "store_redemptions",  field: "kickUsernameKey" },
  { name: "slot_requests",      field: "kickUsernameKey" },
  { name: "tournament_entries", field: "kickUsernameKey" },
];

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

      const [vOld, vNew, verifiedSnap] = await Promise.all([
        base.collection("viewers").doc(fromKey).get(),
        base.collection("viewers").doc(toKey).get(),
        base.collection("verified_users").where("kickName_lower", "==", fromKey).get(),
      ]);

      // Count every collection the migration will touch, so the preview says
      // what will actually move rather than a subset of it.
      const found = {};
      for (const c of VIEWER_DATA) {
        if (c.name === "viewers" || c.name === "verified_users") continue;
        const n = c.byDocId
          ? ((await base.collection(c.name).doc(fromKey).get()).exists ? 1 : 0)
          : (await base.collection(c.name).where(c.field, "==", fromKey).count().get()).data().count || 0;
        if (n) found[c.name] = n;
      }
      const fromPoints  = vOld.exists ? Number(vOld.data().points || 0) : 0;
      const redemCount  = found.store_redemptions || 0;
      const touchedHere = Object.keys(found).length;
      if (!vOld.exists && verifiedSnap.empty && touchedHere === 0) continue; // viewer not on this channel

      const info = {
        uid: sDoc.id,
        channel: channelName,
        fromPoints,
        toPointsExisting: vNew.exists ? Number(vNew.data().points || 0) : 0,
        verified: verifiedSnap.docs.map((d) => d.data().provider || "?"),
        redemptions: redemCount, // raffle tickets + purchases
        records: found,
      };

      if (commit) {
        await migrateChannel(db, base, { fromKey, toKey, fromName, toName, vOld, vNew });
        info.migrated = true;
      }
      channels.push(info);
    }

    // WenPoints is one top-level ledger per viewer, so it moves once rather
    // than per channel.
    let wenpoints = null;
    if (commit) {
      wenpoints = await mergeWenPoints(db, fromKey, toKey);
    } else {
      const wpFrom = await db.collection("wenpoints").doc(fromKey).get();
      if (wpFrom.exists) wenpoints = { balance: Number(wpFrom.data().balance) || 0, lifetime: Number(wpFrom.data().lifetime) || 0 };
    }

    if (commit) {
      logAdminAudit(db, adminUser.uid, "merge_viewer", {
        wenpoints,
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
      wenpoints,
      channels,
    });
  } catch (e) {
    console.error("[admin-merge-viewer] error:", e.message);
    return res(500, { error: "Migration failed: " + e.message });
  }
};

// Migrate one channel's viewer data. Old viewer doc is preserved + flagged.
async function migrateChannel(db, base, { fromKey, toKey, fromName, toName, vOld, vNew }) {
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

  // 2) other doc-id-keyed records — move wholesale.
  for (const col of ["kick_profiles", "mod_strikes"]) {
    const src = await base.collection(col).doc(fromKey).get();
    if (!src.exists) continue;
    await base.collection(col).doc(toKey).set(src.data(), { merge: true });
    await src.ref.delete();
  }

  // 3) verified_users — re-key to the new name (keeps under-code / leaderboard).
  const verifiedSnap = await base.collection("verified_users").where("kickName_lower", "==", fromKey).get();
  for (const vd of verifiedSnap.docs) {
    const data = vd.data();
    const provider = data.provider || "unknown";
    await base.collection("verified_users").doc(`${toKey}_${provider}`).set(
      { ...data, kickName: toName, kickName_lower: toKey }, { merge: true });
    await vd.ref.delete();
  }

  // 4) store_redemptions — purchases relabelled, raffle TICKETS MOVED.
  //
  // A ticket is one coalesced doc per person per raffle, filed at the id
  // `t_{itemId}_{key}` with a qty, so the name lives in the DOCUMENT ID and not
  // only in a field. Relabelling the field alone left the doc parked under the
  // dead name while claiming to belong to the new one, and every ticket lookup
  // goes BY ID. The damage was not theoretical: "remove one ticket" looks up
  // t_{itemId}_{newName}, misses, falls through to a legacy branch that deletes
  // the WHOLE document, and destroys every ticket that viewer holds for that
  // raffle while reporting it removed one. So tickets are moved, and quantities
  // summed when the new name already holds some for the same raffle.
  const redem = await base.collection("store_redemptions").where("kickUsernameKey", "==", fromKey).get();
  let batch = db.batch(), pending = 0;
  const flush = async (n) => { pending += n; if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; } };
  for (const rd of redem.docs) {
    const d = rd.data();
    const isTicket = d.itemId && rd.id === `t_${d.itemId}_${fromKey}`;
    if (!isTicket) {
      batch.update(rd.ref, { kickUsernameKey: toKey, kickUsername: toName });
      await flush(1);
      continue;
    }
    const destRef = base.collection("store_redemptions").doc(`t_${d.itemId}_${toKey}`);
    const dest    = await destRef.get();
    const qty     = Number(d.qty) || 1;
    if (dest.exists) batch.update(destRef, { qty: admin.firestore.FieldValue.increment(qty), kickUsername: toName });
    else             batch.set(destRef, { ...d, qty, kickUsernameKey: toKey, kickUsername: toName });
    batch.delete(rd.ref);
    await flush(2);
  }
  if (pending > 0) await batch.commit();
  // The item's raffleTickets counter is untouched on purpose: tickets moved,
  // none were created or destroyed, so the total is unchanged.

  // 5) name-stamped records. Not balances, but a rename otherwise loses a
  //    viewer's tournament entries and their lifetime win count (the Creators
  //    passport counts wins by name).
  for (const col of ["slot_requests", "winners_log", "tournament_entries"]) {
    const field = col === "winners_log" ? "kickKey" : "kickUsernameKey";
    const snap  = await base.collection(col).where(field, "==", fromKey).get();
    let b = db.batch(), n = 0;
    for (const d of snap.docs) {
      const patch = { [field]: toKey };
      if ("kickUsername" in d.data()) patch.kickUsername = toName;
      if ("username" in d.data())     patch.username     = toName;
      b.update(d.ref, patch);
      if (++n === 400) { await b.commit(); b = db.batch(); n = 0; }
    }
    if (n > 0) await b.commit();
  }

  // 6) GTB guesses — one doc per viewer per round, keyed by name.
  const sessions = await base.collection("gtb_sessions").get();
  for (const sess of sessions.docs) {
    const g = await sess.ref.collection("guesses").doc(fromKey).get();
    if (!g.exists) continue;
    await sess.ref.collection("guesses").doc(toKey).set(g.data(), { merge: true });
    await g.ref.delete();
  }

  // 7) discord_links — keyed by Discord id, with the Kick name in DISPLAY case,
  //    so an equality match on a lowercased key finds nothing. Small collection;
  //    scan and compare case-insensitively rather than guess the casing.
  const dl = await base.collection("discord_links").get();
  for (const d of dl.docs) {
    if (lc(d.data().kickUsername) !== fromKey) continue;
    await d.ref.update({ kickUsername: toName });
  }
}

// WenPoints is the community-wide currency: one top-level ledger per viewer,
// NOT per channel, so this runs once for the whole merge rather than inside the
// channel loop. It postdates the original merge tool, which is why a merge used
// to report success while leaving a real spendable balance under the dead name.
async function mergeWenPoints(db, fromKey, toKey) {
  const col = db.collection("wenpoints");
  const [from, to] = await Promise.all([col.doc(fromKey).get(), col.doc(toKey).get()]);
  if (!from.exists) return null;
  const f = from.data(), t = to.exists ? to.data() : {};
  const moved = { balance: Number(f.balance) || 0, lifetime: Number(f.lifetime) || 0 };
  await col.doc(toKey).set({
    ...f, ...t,
    kickUsernameKey: toKey,
    balance:  (Number(t.balance)  || 0) + moved.balance,
    lifetime: (Number(t.lifetime) || 0) + moved.lifetime,
    updatedAt: Date.now(),
  }, { merge: true });
  // Zeroed and flagged, not deleted, so the merge is reversible.
  await from.ref.set({
    balance: 0, lifetime: 0,
    migratedTo: toKey, migratedAt: Date.now(),
    migratedBalance: moved.balance, migratedLifetime: moved.lifetime,
  }, { merge: true });
  return moved;
}
