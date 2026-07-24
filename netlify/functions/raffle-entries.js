// GET /api/raffle-entries?channel=xxx[&kick=username]
// Per-raffle entry counts for the portal store. Returns the TOTAL entries for
// every raffle item, plus (when ?kick= is supplied) how many that viewer bought.
//
// PRIMARY (cheap): Firestore count() aggregation per raffle item, filtered by
// BOTH itemId AND status=="raffle_entry". The status filter is essential — it's
// what keeps the count EXACT (excludes fulfilled/old docs from past rounds; that
// omission is what once inflated "Viewer Bonus Buy Battle" to 33 vs the real 8).
// ~1 read per 1,000 entries instead of downloading every ticket doc.
//
// FALLBACK (accurate): if count() ever throws (e.g. a needed index is still
// building), it degrades to the original status-filtered cached scan — so counts
// are always correct and never break.
//
// 100% READ-ONLY: this never writes/edits/deletes a ticket. `_cache` is admin-SDK
// only (clients can't read it). `via` in the response says which path ran.

const { getDb }     = require("./_lib/firebase");
const { res: _res } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

const TOTALS_TTL_MS = 3 * 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  const kick    = (event.queryStringParameters?.kick || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing channel" });

  try {
    const db = getDb();
    const snap = await db.collection("streamers").where("kickChannel", "==", channel).limit(1).get();
    if (snap.empty) return res(404, { error: "Channel not found" });
    const uid = snap.docs[0].id;
    const redemptions = db.collection("streamers").doc(uid).collection("store_redemptions");

    // ── PRIMARY: raffleTickets counter on the item doc (free — it rides the
    //    store_items read we already do). Items without the counter yet (not
    //    migrated / never had a coalesced write) fall back to count(), which is
    //    exact for pure-legacy one-doc-per-ticket storage. ──
    try {
      const itemsSnap = await db.collection("streamers").doc(uid)
        .collection("store_items").where("isRaffleItem", "==", true).get();
      const raffleItemIds = itemsSnap.docs.map((d) => d.id);
      const counterById = {};
      itemsSnap.docs.forEach((d) => {
        const rt = d.data().raffleTickets;
        if (typeof rt === "number") counterById[d.id] = Math.max(0, rt);
      });

      const cacheRef = db.collection("_cache").doc(`raffle_${uid}`);
      let totals = null;
      try {
        const c = await cacheRef.get();
        if (c.exists && c.data().totals && (Date.now() - c.data().cachedAt) < TOTALS_TTL_MS) totals = c.data().totals;
      } catch { /* recompute */ }

      if (!totals) {
        totals = {};
        await Promise.all(raffleItemIds.map(async (id) => {
          if (counterById[id] != null) { totals[id] = counterById[id]; return; }
          const agg = await redemptions
            .where("itemId", "==", id)
            .where("status", "==", "raffle_entry")
            .count().get();
          totals[id] = agg.data().count || 0;
        }));
        try { await cacheRef.set({ cachedAt: Date.now(), totals }); } catch { /* skip cache */ }
      }

      // Viewer's own per-item count: read their coalesced ticket doc (1 read,
      // exact qty) + count() any legacy per-ticket docs (excluded via the
      // coalesced doc's own id being counted once — subtract it back out).
      const mine = {};
      if (kick) {
        try {
          await Promise.all(raffleItemIds.map(async (id) => {
            const [tDoc, agg] = await Promise.all([
              redemptions.doc(`t_${id}_${kick}`).get(),
              redemptions
                .where("kickUsernameKey", "==", kick)
                .where("itemId", "==", id)
                .where("status", "==", "raffle_entry")
                .count().get(),
            ]);
            const qty       = tDoc.exists ? (tDoc.data().qty || 1) : 0;
            const docCount  = agg.data().count || 0;
            const legacyCnt = Math.max(0, docCount - (tDoc.exists ? 1 : 0));
            mine[id] = qty + legacyCnt;
          }));
        } catch (mineErr) {
          console.warn("[raffle-entries] mine lookup failed, capped scan:", mineErr.message);
          const mySnap = await redemptions.where("kickUsernameKey", "==", kick).limit(2000).get();
          mySnap.forEach((d) => {
            const x = d.data();
            if (x.status === "raffle_entry" && x.itemId) mine[x.itemId] = (mine[x.itemId] || 0) + (x.qty || 1);
          });
        }
      }

      const entries = {};
      for (const id of raffleItemIds) entries[id] = { total: totals[id] || 0, mine: mine[id] || 0 };
      return res(200, { success: true, entries, signedIn: !!kick, via: "count" });

    } catch (countErr) {
      // ── FALLBACK: original status-filtered cached scan (always accurate) ──────
      console.warn("[raffle-entries] count() path failed, falling back to scan:", countErr.message);
      const cacheRef = db.collection("_cache").doc(`raffle_scan_${uid}`);
      let agg = null;
      try {
        const c = await cacheRef.get();
        if (c.exists && c.data().agg && (Date.now() - c.data().cachedAt) < 5 * 60 * 1000) agg = c.data().agg;
      } catch { /* recompute */ }

      if (!agg) {
        const redemptionsSnap = await redemptions.where("status", "==", "raffle_entry").get();
        agg = {};
        redemptionsSnap.forEach((doc) => {
          const d = doc.data();
          const id = d.itemId;
          if (!id) return;
          const n = d.qty || 1; // coalesced docs carry qty; legacy docs are 1 each
          if (!agg[id]) agg[id] = { total: 0, users: {} };
          agg[id].total += n;
          const who = (d.kickUsernameKey || d.kickUsername || "").toLowerCase();
          if (who) agg[id].users[who] = (agg[id].users[who] || 0) + n;
        });
        try { await cacheRef.set({ cachedAt: Date.now(), agg }); } catch { /* skip cache */ }
      }

      const entries = {};
      for (const id in agg) entries[id] = { total: agg[id].total, mine: kick ? (agg[id].users[kick] || 0) : 0 };
      return res(200, { success: true, entries, signedIn: !!kick, via: "scan" });
    }

  } catch (err) {
    console.error("[raffle-entries] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
