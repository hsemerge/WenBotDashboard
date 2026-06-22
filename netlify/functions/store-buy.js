// POST /api/store-buy
// Body: { channel, kickUsername, accessToken, itemId }
// Web "click to buy" — the portal-store equivalent of the Kick `!buy` command
// and the Discord `/buy`. Verifies the viewer's Kick identity (same as bb-vote /
// tournament-enter), then atomically deducts points and records the redemption.
//
// Mirrors the purchase logic in WenBotServer discord-webhook.js handleBuy:
//  - raffle items → status "raffle_entry"; others → "pending"
//  - decrements stock when tracked
//  - writes to store_redemptions with source "web"
// The point deduction + stock + redemption happen in ONE Firestore transaction so
// a viewer can't overspend by racing concurrent buys.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { logAudit }            = require("./_lib/audit");
const { getKickUser }         = require("./_lib/kick");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return res(400, { error: "Invalid JSON" }); }

  const { channel, kickUsername, accessToken, itemId } = body;
  if (!channel || !kickUsername || !accessToken || !itemId) {
    return res(400, { error: "Missing required fields" });
  }

  const channelKey = channel.toLowerCase().trim();
  const userKey    = kickUsername.toLowerCase().trim();

  try {
    // 1. Verify identity with Kick API (token must belong to the claimed user).
    const kickLookup = await getKickUser(accessToken);
    if (kickLookup.error) return res(kickLookup.status, { error: kickLookup.error });
    const kickUser = kickLookup.user;
    if (kickUser.name.toLowerCase() !== userKey) {
      return res(401, { error: "Identity mismatch — please log in again" });
    }

    const db = getDb();

    // Per-user rate limit (keyed on the verified Kick identity, not IP — so
    // viewers sharing an IP never block each other). Anti-spam only; the atomic
    // transaction below already prevents overspend.
    if (!(await checkRateLimit(db, userKey, "store_buy", 30, 60))) {
      return res(429, { error: "Too many requests — please slow down a moment." });
    }

    // 2. Find streamer.
    const streamerSnap = await db.collection("streamers").where("kickChannel", "==", channelKey).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });
    const uid     = streamerSnap.docs[0].id;
    const profile = streamerSnap.docs[0].data();
    const currency = profile.currencyName || "points";

    // Requested quantity (raffle multi-ticket). Clamped 1..100; non-raffle items
    // are forced to 1 inside the transaction (multi-buy is a raffle feature).
    const reqQty = Math.max(1, Math.min(parseInt(body.quantity, 10) || 1, 100));

    const itemRef   = db.collection("streamers").doc(uid).collection("store_items").doc(itemId);
    const viewerRef = db.collection("streamers").doc(uid).collection("viewers").doc(userKey);
    const redeemCol = db.collection("streamers").doc(uid).collection("store_redemptions");

    // 3. Atomic purchase — re-read item + balance inside the transaction so the
    //    point check and deduction can't race another concurrent buy.
    let result;
    try {
      result = await db.runTransaction(async (tx) => {
        const [itemDoc, viewerDoc] = await Promise.all([tx.get(itemRef), tx.get(viewerRef)]);
        if (!itemDoc.exists || itemDoc.data().enabled !== true) {
          throw { code: 404, msg: "That item isn't available." };
        }
        const item  = itemDoc.data();
        const price = item.price || 0;
        const isRaffleItem = item.isRaffleItem === true;
        const qty = isRaffleItem ? reqQty : 1; // multi-buy only applies to raffle tickets

        const tracked = item.stock !== undefined && item.stock !== null;
        if (tracked && item.stock < qty) {
          throw { code: 409, msg: item.stock <= 0 ? `${item.name} is out of stock.` : `Only ${item.stock} left for ${item.name}.` };
        }

        const totalCost = price * qty;
        const balance   = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;
        if (balance < totalCost) {
          throw { code: 402, msg: `Not enough ${currency}. You have ${balance.toLocaleString()}, need ${totalCost.toLocaleString()}${qty > 1 ? ` for ${qty} tickets` : ""}.` };
        }

        const status = isRaffleItem ? "raffle_entry" : "pending";

        tx.set(viewerRef, { points: admin.firestore.FieldValue.increment(-totalCost) }, { merge: true });
        if (tracked) tx.update(itemRef, { stock: admin.firestore.FieldValue.increment(-qty) });
        // One redemption doc per ticket — keeps tickets = doc count, so the draw,
        // dashboard counts, and portal "you have N" all work unchanged.
        for (let i = 0; i < qty; i++) {
          tx.set(redeemCol.doc(), {
            kickUsername,
            kickUsernameKey: userKey,
            itemId,
            itemName:    item.name,
            pointsSpent: price,
            redeemedAt:  admin.firestore.Timestamp.now(),
            status,
            source:      "web",
          });
        }

        return { item, price, qty, isRaffleItem, totalCost, newBalance: balance - totalCost };
      });
    } catch (txErr) {
      if (txErr && txErr.code && txErr.msg) return res(txErr.code, { error: txErr.msg });
      throw txErr;
    }

    logAudit(uid, result.isRaffleItem ? "raffle_entry" : "store_redemption", {
      source: "web", kickUsername, itemName: result.item.name, pointsSpent: result.totalCost, quantity: result.qty,
    });

    return res(200, {
      success:      true,
      isRaffleItem: result.isRaffleItem,
      quantity:     result.qty,
      newBalance:   result.newBalance,
      message: result.isRaffleItem
        ? (result.qty > 1
            ? `You bought ${result.qty} tickets for the ${result.item.name} raffle! Good luck.`
            : `You entered the ${result.item.name} raffle! The streamer draws the winner.`)
        : `You redeemed ${result.item.name}! The streamer will fulfill it shortly.`,
    });

  } catch (err) {
    console.error("[store-buy] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
