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

// TEMPORARY TEST PRICING, scoped to named accounts.
//
//   WENPOINTS_BOX_TEST = emergeonkick        (comma-separate for several)
//
// Per-USER rather than a global on/off switch on purpose. /community is public, so
// a global switch would let any signed-in viewer who wandered past buy the whole
// collection for pocket change — and because a 10 WP box can return a 250 voucher,
// they'd mint WenPoints while doing it. Neither unwinds cleanly: badges are
// granted permanently and balances would need hand-editing.
//
// Still remove the variable when finished. This bounds the blast radius; it isn't
// a reason to leave it on.
const TEST_USERS = new Set(
  String(process.env.WENPOINTS_BOX_TEST || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);
const isTester = (kickUsername) => TEST_USERS.has(String(kickUsername || "").toLowerCase());

const TEST_PRICES = { bronze: 10, silver: 25, wenbot: 50 };

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

/** The price THIS viewer pays. Everyone but a named tester pays the real one. */
const priceFor = (tierId, kickUsername) =>
  (isTester(kickUsername) ? TEST_PRICES[tierId] : TIERS[tierId].price);

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

  // GET returns the tier list so the page renders prices from HERE rather than
  // keeping its own copy. They had already drifted apart once — the client
  // advertised 2,500/5,000 while this charged 2,000/3,500 — and a price that
  // lies to the buyer is the worst kind of bug in a paid feature.
  if (event.httpMethod === "GET") {
    // ?kick= only affects the price SHOWN. The POST below re-derives it from the
    // verified token, so spoofing this changes a label and nothing else.
    const who = (event.queryStringParameters || {}).kick || "";
    return res(200, {
      tiers: Object.entries(TIERS).map(([id, t]) => ({
        id, name: t.name, price: priceFor(id, who),
        blurb: t.elite ? "Best odds • only tier with WenBot & GG"
             : id === "silver" ? "Better odds, bigger vouchers" : "Badges, vouchers",
      })),
    });
  }

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
      // Derived from the username the Kick token resolved to, not from anything
      // the client sent.
      const cost = priceFor(tierId, lookup.user.name);
      if (balance < cost) {
        throw { code: 402, msg: `Not enough WenPoints — ${cost} needed, you have ${balance}` };
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

      const delta = refund - cost;
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
      price: priceFor(tierId, lookup.user.name),
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
