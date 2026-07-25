// POST /api/wenpoints-spend
// Body: { kickUsername, accessToken, action: "buy"|"equip", kind: "theme"|"flair", id }
// The WenBot store, phase 1: cosmetic passport themes and name flair bought
// with WenPoints. Purchases run in a transaction on the viewer's global
// ledger (balance check + deduct + grant atomically). Cosmetics only — by
// design, WenPoints can never buy odds or advantage in any streamer's
// giveaway.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { getKickUser }         = require("./_lib/kick");

const CATALOG = {
  theme: {
    gold:    { name: "Gold Passport",    price: 150 },
    royal:   { name: "Royal Purple",     price: 150 },
    emerald: { name: "Emerald",          price: 150 },
    blood:   { name: "Blood Diamond",    price: 250 },
  },
  flair: {
    lucky:   { name: "🍀 Lucky",           price: 50 },
    degen:   { name: "🔥 Certified Degen", price: 100 },
    roller:  { name: "🎲 High Roller",     price: 100 },
    diamond: { name: "💎 Diamond Hands",   price: 150 },
  },
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const kickUsername = String(body.kickUsername || "").trim();
  const accessToken  = String(body.accessToken || "").trim();
  const action = String(body.action || "");
  const kind   = String(body.kind || "");
  const id     = String(body.id || "");
  if (!kickUsername || !accessToken) return res(400, { error: "Missing sign-in" });
  if (!["buy", "equip", "unequip"].includes(action) || !CATALOG[kind]) return res(400, { error: "Bad request" });
  if (action !== "unequip" && !CATALOG[kind][id]) return res(400, { error: "Unknown item" });
  const userKey = kickUsername.toLowerCase();

  try {
    const kickLookup = await getKickUser(accessToken);
    if (kickLookup.error) return res(kickLookup.status, { error: kickLookup.error });
    if (kickLookup.user.name.toLowerCase() !== userKey) {
      return res(401, { error: "Identity mismatch — please sign in again" });
    }

    const db = getDb();
    if (!(await checkRateLimit(db, userKey, "wp_spend", 20, 60))) {
      return res(429, { error: "Too many requests" });
    }

    const ref = db.collection("wenpoints").doc(userKey);
    const out = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const d = doc.exists ? doc.data() : {};
      const owned    = d.owned    || { theme: [], flair: [] };
      const equipped = d.equipped || {};
      const balance  = d.balance  || 0;

      if (action === "buy") {
        const item = CATALOG[kind][id];
        if ((owned[kind] || []).includes(id)) throw { code: 409, msg: "You already own that" };
        if (balance < item.price) throw { code: 402, msg: `Not enough WenPoints — ${item.price} needed, you have ${balance}` };
        owned[kind] = [...(owned[kind] || []), id];
        equipped[kind] = id; // auto-equip on purchase
        tx.set(ref, {
          kickUsernameKey: userKey,
          balance: admin.firestore.FieldValue.increment(-item.price),
          owned, equipped, updatedAt: Date.now(),
        }, { merge: true });
        return { balance: balance - item.price, owned, equipped };
      }
      if (action === "equip") {
        if (!(owned[kind] || []).includes(id)) throw { code: 403, msg: "You don't own that yet" };
        equipped[kind] = id;
      } else {
        delete equipped[kind];
      }
      tx.set(ref, { equipped, updatedAt: Date.now() }, { merge: true });
      return { balance, owned, equipped };
    });

    return res(200, { ok: true, ...out, catalog: CATALOG });
  } catch (err) {
    if (err && err.code && err.msg) return res(err.code, { error: err.msg });
    console.error("[wenpoints-spend]", err.message);
    return res(500, { error: "Purchase failed" });
  }
};
