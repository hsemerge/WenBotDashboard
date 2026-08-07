// POST /api/wenpoints-box
// Body: { kickUsername, accessToken, tier: "bronze"|"silver"|"wenbot" }
//
// Opens a Mystery Box: spends WenPoints, rolls a prize, grants it — all inside one
// Firestore transaction so a double-click can't pay once and grant twice, or
// deduct without granting.
//
// Prize pool is deliberately narrow for v1: badges, WenPoints vouchers, and
// nothing. The art also covers multipliers, VIP Discord roles and raffle tickets,
// but each of those needs a fulfilment system that doesn't exist yet — granting
// them now would write records nothing can honour.
//
// Badges never duplicate: the roll picks from what the viewer does NOT already
// own, and falls back to a voucher once the set is complete. Paying 1,000 WP for
// a badge you already have is the fastest way to make a collection feel worthless.

const crypto                  = require("crypto");
const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { getKickUser }         = require("./_lib/kick");

// Ids match GiveawayBot/img/mysterybox/badge_<name>.png and the BADGES list on
// the community page. Ordered roughly common -> rare; the brand marks are last.
const BADGES = [
  "moss", "jungle", "verdant", "ember", "rose", "laurel", "circuit", "chrome",
  "amethyst", "emerald", "gold", "obsidian", "spiked", "storm", "glacier", "frostorb",
  "samurai", "knight", "warlord", "mecha", "clockwork", "pharaoh", "hex", "voidflame",
  "demon", "wildfire", "dragon", "valkyrie", "crown", "regal",
  "wenbot", "gg",
];
// The two brand marks are the chase items — only the top tier can roll them.
const ELITE_BADGES = new Set(["wenbot", "gg"]);

// Voucher denominations are fixed by the artwork — 5,10,20,25,50,75,100,250,375,500
// exist and nothing above 500 does. Prices are set against that ceiling so a
// consolation voucher is a real softener rather than a rounding error; a 5,000 WP
// box paying at most 500 back would feel like a scam.
const VOUCHERS = [5, 10, 20, 25, 50, 75, 100, 250, 375, 500];

const TIERS = {
  bronze: { price: 1000, name: "Bronze Chest",
    // weight -> outcome. Vouchers return WenPoints, so a box is never a total
    // write-off, but the expected return sits below the price on purpose.
    table: [ [45, "badge"], [30, "voucher:100"], [15, "voucher:250"], [10, "nothing"] ] },
  silver: { price: 2000, name: "Silver Chest",
    table: [ [55, "badge"], [25, "voucher:250"], [15, "voucher:375"], [5, "nothing"] ] },
  wenbot: { price: 3500, name: "WenBot Chest", elite: true,
    table: [ [70, "badge"], [20, "voucher:375"], [10, "voucher:500"] ] },
};

// crypto RNG, not Math.random — this decides what someone paid for.
function pick(table) {
  const total = table.reduce((s, [w]) => s + w, 0);
  let roll = crypto.randomInt(0, total);
  for (const [w, outcome] of table) {
    if (roll < w) return outcome;
    roll -= w;
  }
  return table[table.length - 1][1];
}

// Fail fast at load if a table references a voucher the art doesn't have — the
// client builds its image path from this amount, so a mismatch is a broken image
// in the one moment the viewer is paying attention.
for (const [id, t] of Object.entries(TIERS)) {
  for (const [, outcome] of t.table) {
    if (!outcome.startsWith("voucher:")) continue;
    const amt = Number(outcome.split(":")[1]);
    if (!VOUCHERS.includes(amt)) throw new Error(`wenpoints-box: ${id} rolls voucher_${amt}, which has no artwork`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "POST only" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { kickUsername, accessToken } = body;
  const tierId = String(body.tier || "");
  const tier   = TIERS[tierId];
  if (!kickUsername || !accessToken || !tier) return res(400, { error: "Bad request" });

  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const db = getDb();
  if (!(await checkRateLimit(db, ip, "wp_box", 20, 60))) {
    return res(429, { error: "Too many attempts. Wait a moment." });
  }

  try {
    // Identity: the Kick token must resolve to the claimed user — same model as
    // wenpoints-spend and store-buy.
    const lookup = await getKickUser(accessToken);
    if (lookup.error) return res(lookup.status, { error: lookup.error });
    if (lookup.user.name.toLowerCase() !== kickUsername.toLowerCase()) {
      return res(401, { error: "Token does not match the claimed user" });
    }

    const userKey = kickUsername.toLowerCase();
    const ref     = db.collection("wenpoints").doc(userKey);

    const result = await db.runTransaction(async (tx) => {
      const snap    = await tx.get(ref);
      const d       = snap.exists ? snap.data() : {};
      const balance = d.balance || 0;
      if (balance < tier.price) {
        throw { code: 402, msg: `Not enough WenPoints — ${tier.price} needed, you have ${balance}` };
      }

      const owned = { ...(d.owned || {}) };
      const have  = new Set(owned.badge || []);

      let outcome = pick(tier.table);

      // Badge rolls draw from what they DON'T own. Once the set is complete the
      // roll degrades to a voucher rather than granting a duplicate.
      let granted = null;
      if (outcome === "badge") {
        const pool = BADGES.filter((b) => !have.has(`badge_${b}`) && (tier.elite || !ELITE_BADGES.has(b)));
        if (pool.length) {
          const badge = pool[crypto.randomInt(0, pool.length)];
          owned.badge = [...(owned.badge || []), `badge_${badge}`];
          granted = { kind: "badge", id: `badge_${badge}`, name: badge };
        } else {
          outcome = "voucher:500";   // collection complete for this tier
        }
      }

      let refund = 0;
      if (outcome.startsWith("voucher:")) {
        refund  = Number(outcome.split(":")[1]) || 0;
        granted = { kind: "voucher", amount: refund };
      } else if (outcome === "nothing") {
        granted = { kind: "nothing" };
      }

      const delta = refund - tier.price;
      tx.set(ref, {
        balance: admin.firestore.FieldValue.increment(delta),
        owned,
        boxesOpened: admin.firestore.FieldValue.increment(1),
        updatedAt: Date.now(),
      }, { merge: true });

      return { granted, balance: balance + delta, owned };
    });

    return res(200, {
      ok: true,
      tier: tierId,
      tierName: tier.name,
      price: tier.price,
      prize: result.granted,
      balance: result.balance,
      owned: result.owned,
    });
  } catch (err) {
    if (err && err.code === 402) return res(402, { error: err.msg });
    console.error("[wenpoints-box] error:", err.message || err);
    return res(500, { error: "Could not open that box right now." });
  }
};
