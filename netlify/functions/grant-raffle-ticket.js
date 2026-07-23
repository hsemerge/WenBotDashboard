// POST /api/grant-raffle-ticket
// Streamer grants a viewer FREE raffle ticket(s) from the viewer control card —
// the "send the giveaway winner to another giveaway" flow. Optionally creates a
// brand-new raffle item first.
//
// Runs server-side because firestore.rules (correctly) forbid clients creating
// store_redemptions — that rule blocks forged purchases. A grant is different:
// it's the streamer's own act, pointsSpent is forced to 0, and status is forced
// to raffle_entry, so nothing spendable or fulfillable can be forged through it.
//
// Auth: Firebase ID token; owner-self or the delegatedFor custom claim (mods),
// same model as entrant-wager.
//
// Body JSON: { uid, username, qty, itemId?, createName? }
//   - itemId:     grant into this existing raffle item
//   - createName: create a new raffle item with this name, then grant into it

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { logAudit }            = require("./_lib/audit");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "grant_raffle", 30, 60))) {
    return res(429, { error: "Too many requests" });
  }

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = String(body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) {
    return res(403, { error: "Not authorized for that account" });
  }

  const username = String(body.username || "").replace(/^@/, "").trim();
  if (!username) return res(400, { error: "Missing username" });
  const qty = Math.max(1, Math.min(parseInt(body.qty, 10) || 1, 50));

  try {
    const itemsCol = db.collection("streamers").doc(uid).collection("store_items");
    let itemId, itemName;

    const createName = String(body.createName || "").trim().slice(0, 60);
    if (createName) {
      // New raffle item — price defaults to 1,000 pts; the streamer can edit it
      // on the Store page before (or without ever) letting viewers buy in.
      const ref = itemsCol.doc();
      await ref.set({
        name: createName, description: "", price: 1000, stock: null, imageUrl: "",
        isRaffleItem: true, enabled: true, createdAt: Date.now(),
      });
      itemId = ref.id; itemName = createName;
    } else {
      itemId = String(body.itemId || "").trim();
      if (!itemId) return res(400, { error: "Missing itemId or createName" });
      const doc = await itemsCol.doc(itemId).get();
      if (!doc.exists || !doc.data().isRaffleItem) return res(404, { error: "Raffle item not found" });
      itemName = doc.data().name || "Raffle";
    }

    // One redemption doc per ticket (tickets = doc count), matching the bot's
    // !buy shape so the Raffles page treats grants like any bought ticket.
    const redeemCol = db.collection("streamers").doc(uid).collection("store_redemptions");
    const batch = db.batch();
    for (let i = 0; i < qty; i++) {
      batch.set(redeemCol.doc(), {
        itemId, itemName,
        kickUsername:    username,
        kickUsernameKey: username.toLowerCase(),
        pointsSpent:     0,
        redeemedAt:      new Date(),
        status:          "raffle_entry",
        source:          "giveaway_grant",
        grantedBy:       decoded.uid,
      });
    }
    await batch.commit();

    // Activity Log entry — same audit trail as bot-side ticket buys.
    await logAudit(uid, "raffle_ticket_granted", {
      kickUsername: username,
      itemName,
      quantity:  qty,
      newRaffle: !!createName,
      grantedBy: decoded.uid === uid ? "owner" : "mod",
    });

    return res(200, { ok: true, itemId, itemName, qty });
  } catch (err) {
    console.error("[grant-raffle-ticket]", err.message);
    return res(500, { error: "Grant failed" });
  }
};
