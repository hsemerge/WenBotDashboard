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

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");
const { logAudit }     = require("./_lib/audit");

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
    const kickResp = await fetch("https://api.kick.com/public/v1/users", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!kickResp.ok) return res(401, { error: "Could not verify Kick identity — please log in again" });
    const kickData = await kickResp.json();
    const kickUser = kickData.data?.[0];
    if (!kickUser || kickUser.name.toLowerCase() !== userKey) {
      return res(401, { error: "Identity mismatch — please log in again" });
    }

    const db = getDb();

    // 2. Find streamer.
    const streamerSnap = await db.collection("streamers").where("kickChannel", "==", channelKey).limit(1).get();
    if (streamerSnap.empty) return res(404, { error: "Channel not found" });
    const uid     = streamerSnap.docs[0].id;
    const profile = streamerSnap.docs[0].data();
    const currency = profile.currencyName || "points";

    const itemRef   = db.collection("streamers").doc(uid).collection("store_items").doc(itemId);
    const viewerRef = db.collection("streamers").doc(uid).collection("viewers").doc(userKey);
    const redeemRef = db.collection("streamers").doc(uid).collection("store_redemptions").doc();

    // 3. Atomic purchase — re-read item + balance inside the transaction so the
    //    point check and deduction can't race another concurrent buy.
    let result;
    try {
      result = await db.runTransaction(async (tx) => {
        const [itemDoc, viewerDoc] = await Promise.all([tx.get(itemRef), tx.get(viewerRef)]);
        if (!itemDoc.exists || itemDoc.data().enabled !== true) {
          throw { code: 404, msg: "That item isn't available." };
        }
        const item = itemDoc.data();
        const price = item.price || 0;

        const tracked = item.stock !== undefined && item.stock !== null;
        if (tracked && item.stock <= 0) throw { code: 409, msg: `${item.name} is out of stock.` };

        const balance = viewerDoc.exists ? (viewerDoc.data().points || 0) : 0;
        if (balance < price) {
          throw { code: 402, msg: `Not enough ${currency}. You have ${balance.toLocaleString()}, need ${price.toLocaleString()}.` };
        }

        const isRaffleItem = item.isRaffleItem === true;
        const status = isRaffleItem ? "raffle_entry" : "pending";

        tx.set(viewerRef, { points: admin.firestore.FieldValue.increment(-price) }, { merge: true });
        if (tracked) tx.update(itemRef, { stock: admin.firestore.FieldValue.increment(-1) });
        tx.set(redeemRef, {
          kickUsername,
          kickUsernameKey: userKey,
          itemId,
          itemName:    item.name,
          pointsSpent: price,
          redeemedAt:  admin.firestore.Timestamp.now(),
          status,
          source:      "web",
        });

        return { item, price, isRaffleItem, newBalance: balance - price };
      });
    } catch (txErr) {
      if (txErr && txErr.code && txErr.msg) return res(txErr.code, { error: txErr.msg });
      throw txErr;
    }

    logAudit(uid, result.isRaffleItem ? "raffle_entry" : "store_redemption", {
      source: "web", kickUsername, itemName: result.item.name, pointsSpent: result.price,
    });

    return res(200, {
      success:     true,
      isRaffleItem: result.isRaffleItem,
      newBalance:  result.newBalance,
      message: result.isRaffleItem
        ? `You entered the ${result.item.name} raffle! The streamer draws the winner.`
        : `You redeemed ${result.item.name}! The streamer will fulfill it shortly.`,
    });

  } catch (err) {
    console.error("[store-buy] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
