// POST /api/raffle-ops
// Server-side raffle ticket mutations. Replaces the old dashboard client code
// that downloaded EVERY ticket doc into the browser (a 60-80k-ticket raffle
// froze the page for 15-30s per click and billed 80k reads each time).
//
// Body: { uid, action, itemId, username? }
//   remove_ticket   — take ONE ticket from a viewer (post-draw "remove winner ticket")
//   remove_entrant  — take ALL of a viewer's tickets for the item
//   clear_item      — empty the item's draw pool (paged; call until done:true)
//   migrate_item    — compact legacy one-doc-per-ticket storage into coalesced
//                     qty docs (paged; call until done:true). Also (re)builds
//                     the raffleTickets counter on the item doc.
//
// All queries are field-filtered server-side (admin SDK) and deletes go through
// BulkWriter. Paged actions process a bounded chunk per invocation so they fit
// a function timeout; the dashboard loops until done.
//
// Auth: Firebase ID token; owner-self or delegatedFor (mods) — same model as
// raffle-detail.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { logAudit }            = require("./_lib/audit");
const { ticketRef, bustRaffleCaches } = require("./_lib/raffle");

const PAGE = 2000; // docs processed per invocation for paged actions

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "raffle_ops", 120, 60))) return res(429, { error: "Too many requests" });

  const idToken = (event.headers.authorization || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid token" }); }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = String(body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) return res(403, { error: "Not authorized for that account" });

  const action   = String(body.action || "");
  const itemId   = String(body.itemId || "").trim();
  const username = String(body.username || "").replace(/^@/, "").trim();
  if (!itemId) return res(400, { error: "Missing itemId" });

  const redemptions = db.collection("streamers").doc(uid).collection("store_redemptions");
  const itemDocRef  = db.collection("streamers").doc(uid).collection("store_items").doc(itemId);
  const poolQuery   = () => redemptions.where("itemId", "==", itemId).where("status", "==", "raffle_entry");
  const bumpCounter = (n) => itemDocRef.set({ raffleTickets: admin.firestore.FieldValue.increment(n) }, { merge: true }).catch(() => {});

  try {
    // ── remove_ticket / remove_entrant ──────────────────────────────────────
    if (action === "remove_ticket" || action === "remove_entrant") {
      if (!username) return res(400, { error: "Missing username" });
      const key = username.toLowerCase();
      let removed = 0;

      // 1) Coalesced doc first — the common case after migration.
      const tRef  = ticketRef(db, uid, itemId, key);
      const tSnap = await tRef.get();
      if (tSnap.exists) {
        const q = tSnap.data().qty || 1;
        if (action === "remove_ticket") {
          if (q > 1) await tRef.update({ qty: admin.firestore.FieldValue.increment(-1) });
          else       await tRef.delete();
          removed = 1;
        } else {
          await tRef.delete();
          removed = q;
        }
      }

      // 2) Legacy per-ticket docs (either username field variant).
      if (removed === 0 || action === "remove_entrant") {
        const want = action === "remove_ticket" ? Math.max(0, 1 - removed) : Infinity;
        if (want > 0) {
          const writer = db.bulkWriter();
          for (const field of ["kickUsernameKey", "kickUsername"]) {
            const val = field === "kickUsernameKey" ? key : username;
            let snap = await poolQuery().where(field, "==", val)
              .limit(want === Infinity ? PAGE : want).get();
            for (const d of snap.docs) {
              if (d.id === tRef.id) continue; // coalesced doc handled above
              writer.delete(d.ref);
              removed++;
              const dq = d.data().qty;
              if (dq && dq > 1) removed += dq - 1;
              if (action === "remove_ticket" && removed >= 1) break;
            }
            if (action === "remove_ticket" && removed >= 1) break;
          }
          await writer.close();
        }
      }

      if (removed > 0) {
        bumpCounter(-removed);
        await bustRaffleCaches(db, uid, itemId);
        logAudit(uid, action === "remove_ticket" ? "raffle_ticket_removed" : "raffle_entrant_removed",
          { kickUsername: username, itemId, count: removed, actingUid: decoded.uid });
      }
      return res(200, { ok: true, removed });
    }

    // ── clear_item (paged) ──────────────────────────────────────────────────
    if (action === "clear_item") {
      const snap = await poolQuery().limit(PAGE).select("qty").get();
      let removed = 0;
      const writer = db.bulkWriter();
      snap.docs.forEach((d) => { writer.delete(d.ref); removed += d.data().qty || 1; });
      await writer.close();
      const done = snap.size < PAGE;
      if (done) {
        await itemDocRef.set({ raffleTickets: 0 }, { merge: true }).catch(() => {});
        await bustRaffleCaches(db, uid, itemId);
      } else {
        bumpCounter(-removed);
      }
      return res(200, { ok: true, removed, done });
    }

    // ── migrate_item (paged) — compact legacy docs into coalesced qty docs ──
    // Pages by document id with a cursor so coalesced docs (which stay put)
    // can never stall progress; the dashboard passes `after` back each call.
    if (action === "migrate_item") {
      let q = poolQuery().orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
      const after = String(body.after || "");
      if (after) q = q.startAfter(after);
      const snap = await q.get();
      const tally = {}; // key -> { username, tickets, points, lastTs }
      const writer = db.bulkWriter();
      let legacy = 0;

      snap.docs.forEach((d) => {
        const x = d.data();
        if (typeof x.qty === "number") return; // already coalesced
        legacy++;
        const uname = x.kickUsername || x.kickUsernameKey || "unknown";
        const key   = String(x.kickUsernameKey || uname).toLowerCase();
        if (!tally[key]) tally[key] = { username: uname, tickets: 0, points: 0, lastTs: 0 };
        tally[key].tickets++;
        tally[key].points += x.pointsSpent || 0;
        const ts = x.redeemedAt && x.redeemedAt.toMillis ? x.redeemedAt.toMillis() : (Number(x.redeemedAt) || 0);
        if (ts > tally[key].lastTs) tally[key].lastTs = ts;
        writer.delete(d.ref);
      });
      await writer.close();

      let migrated = 0;
      const writes = [];
      for (const key of Object.keys(tally)) {
        const t = tally[key];
        migrated += t.tickets;
        writes.push(ticketRef(db, uid, itemId, key).set({
          itemId, kickUsername: t.username, kickUsernameKey: key,
          status: "raffle_entry",
          qty:         admin.firestore.FieldValue.increment(t.tickets),
          pointsSpent: admin.firestore.FieldValue.increment(t.points),
          redeemedAt:  t.lastTs ? new Date(t.lastTs) : new Date(),
          source: "migrated",
        }, { merge: true }));
      }
      await Promise.all(writes);
      if (migrated > 0) bumpCounter(migrated); // legacy docs never counted toward raffleTickets

      const done   = snap.size < PAGE;
      const cursor = snap.size ? snap.docs[snap.size - 1].id : null;
      if (done) await bustRaffleCaches(db, uid, itemId);
      return res(200, { ok: true, migrated, done, after: cursor });
    }

    return res(400, { error: "Unknown action" });
  } catch (err) {
    console.error("[raffle-ops]", err.message);
    return res(500, { error: "Operation failed" });
  }
};
