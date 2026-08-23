// GET /api/wenball-loadout?users=alice,bob,carol   (max 25 names per call)
// -> 200 { loadouts: { alice: { ball, hat, trail, badge, flair, theme }, ... } }
//
// Dresses WenBall racers in their WenPoints cosmetics. Public, read-only,
// CORS * — it only exposes what a viewer already chose to show on their
// community passport. The game batches joiners and falls back to defaults on
// any error, so this endpoint can never break a race.
//
// Data source is the existing global WenPoints ledger (wenpoints/<kickKey>):
//   equipped.theme / equipped.flair / equipped.badge — sold today
//   equipped.ball  / equipped.hat   / equipped.trail — reserved for a future
//     Game Wardrobe (wenpoints-spend.js CATALOG entries); until then they come
//     back empty and the game maps an equipped passport theme onto the shell.

const { getDb } = require("./_lib/firebase");

const MAX_USERS = 25;
const NAME_RE = /^[a-z0-9_-]{1,32}$/;

function res(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // Equip changes land within a minute; per-race lookups stay cheap.
      "Cache-Control": "public, max-age=60",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET") return res(405, { error: "GET only" });

  const raw = String(event.queryStringParameters?.users || "");
  const users = [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => NAME_RE.test(s)))]
    .slice(0, MAX_USERS);
  if (!users.length) return res(400, { error: "Usage: ?users=a,b,c" });

  try {
    const db = getDb();
    const refs = users.map((u) => db.collection("wenpoints").doc(u));
    const docs = await db.getAll(...refs);
    const loadouts = {};
    docs.forEach((doc, i) => {
      const eq = (doc.exists && doc.data().equipped) || {};
      loadouts[users[i]] = {
        theme: eq.theme || "",
        flair: eq.flair || "",
        badge: eq.badge || "",
        ball:  eq.ball  || "",
        hat:   eq.hat   || "",
        trail: eq.trail || "",
      };
    });
    return res(200, { loadouts });
  } catch (err) {
    console.error("[wenball-loadout]", err.message);
    return res(500, { error: "Lookup failed" });
  }
};
