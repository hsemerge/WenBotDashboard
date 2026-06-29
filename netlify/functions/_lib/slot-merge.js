// Shared slot-catalog merge — the same safe rules as scripts/ingest-slots.js,
// as a pure function so the admin bookmarklet upload (/api/admin-slots-ingest)
// behaves identically:
//   - APPEND only genuinely-new slots (matched by normalized name).
//   - Only FILL EMPTY thumbnails on existing slots — NEVER overwrite a manual /
//     self-hosted image.
//   - Skip live-casino / table / originals on NEW adds (existing rows untouched).
//   - Idempotent: re-running adds nothing already present.

function norm(s) {
  return String(s || "").toLowerCase().replace(/[’'´`]/g, "'").replace(/[—–-]/g, " ")
    .replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

const PROVIDER_MAP = {
  "pragmatic play": "Pragmatic Play", "pragmatic": "Pragmatic Play",
  "hacksaw gaming": "Hacksaw Gaming", "hacksaw": "Hacksaw Gaming",
  "nolimit city": "Nolimit City", "nolimit": "Nolimit City", "nlc": "Nolimit City",
  "play'n go": "Play'n GO", "playngo": "Play'n GO", "play n go": "Play'n GO",
  "relax gaming": "Relax Gaming", "relax": "Relax Gaming",
  "bgaming": "BGaming", "softswiss": "BGaming",
  "elk studios": "ELK Studios", "elk": "ELK Studios",
  "big time gaming": "Big Time Gaming", "btg": "Big Time Gaming", "bigtimegaming": "Big Time Gaming",
  "red tiger": "Red Tiger", "redtiger": "Red Tiger",
  "netent": "NetEnt", "extendednetent": "NetEnt",
  "thunderkick": "Thunderkick", "quickspin": "Quickspin",
  "avatarux": "AvatarUX", "booming games": "Booming Games", "booming": "Booming Games",
  "blueprint gaming": "Blueprint Gaming", "blueprint": "Blueprint Gaming",
  "push gaming": "Push Gaming", "push": "Push Gaming",
  "pg soft": "PG Soft", "pgsoft": "PG Soft",
  "3 oaks gaming": "3 Oaks Gaming", "3oaks": "3 Oaks Gaming",
  "wazdan": "Wazdan", "endorphina": "Endorphina", "yggdrasil": "Yggdrasil",
  "playson": "Playson", "spribe": "Spribe",
};
const ID_PREFIX = {
  "Pragmatic Play": "pp", "Hacksaw Gaming": "hs", "Nolimit City": "nlc",
  "Play'n GO": "png", "Relax Gaming": "relax", "BGaming": "bg", "ELK Studios": "elk",
  "Big Time Gaming": "btg", "Red Tiger": "rt", "NetEnt": "ne", "Thunderkick": "tk",
  "Quickspin": "qs", "AvatarUX": "avu", "Booming Games": "boom", "Blueprint Gaming": "bp",
  "Push Gaming": "push", "PG Soft": "pg", "3 Oaks Gaming": "3oaks", "Wazdan": "waz",
  "Endorphina": "endo", "Yggdrasil": "ygg", "Playson": "plsn", "Spribe": "spribe",
};

function mapProvider(pull) {
  const raw = (pull.provider || "").trim();
  const mapped = PROVIDER_MAP[raw.toLowerCase()];
  if (mapped) return mapped;
  const prefix = (pull.slug || "").split("-").slice(0, 2).join("-");
  return PROVIDER_MAP[prefix.replace(/-/g, " ")] || raw || prefix || "Unknown";
}

function isNonSlot(name, slug) {
  const s = (slug || "").toLowerCase();
  if (/[-/]live[-/]/.test(s)) return true;
  if (/-(plinko|mines|limbo|chicken|dice|keno|hilo|hi-lo|crash|spaceman|aviator)$/.test(s)) return true;
  const n = " " + String(name).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim() + " ";
  const TABLE = ["roulette", "baccarat", "blackjack", "sic bo", "sic bac", "mega wheel",
    "mega ball", "craps", "andar bahar", "teen patti", "fan tan", "crazy time", "dream catcher", "bingo"];
  return TABLE.some((t) => n.includes(" " + t + " "));
}

function deriveGameId(slug, provider) {
  let s = slug || "";
  const pfx = provider.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (s.startsWith(pfx + "-")) s = s.slice(pfx.length + 1);
  else s = s.replace(/^[a-z0-9]+-/, "");
  return s.replace(/-/g, "_");
}

// catalogSlots: current catalog array (mutated copy returned). pull: array of
// { name, slug, thumbnailUrl, provider } from the Stake browser pull.
function mergeSlots(catalogSlots, pull) {
  const slots = catalogSlots.map((s) => ({ ...s })); // shallow copy — never mutate caller's
  const byName = new Map(slots.map((s) => [norm(s.name), s]));
  const existingIds = new Set(slots.map((s) => s.id));

  let added = 0, backfilled = 0, skipped = 0;
  const newList = [], backfillList = [];

  for (const g of Array.isArray(pull) ? pull : []) {
    if (!g || !g.name || !g.thumbnailUrl) { skipped++; continue; }
    const key = norm(g.name);
    const existing = byName.get(key);

    if (existing) {
      if (!existing.thumbnailUrl) { existing.thumbnailUrl = g.thumbnailUrl; backfilled++; backfillList.push(existing.name); }
      else skipped++;
      continue;
    }

    if (isNonSlot(g.name, g.slug)) { skipped++; continue; }

    const provider = mapProvider(g);
    const gameId = deriveGameId(g.slug, provider);
    const pfx = ID_PREFIX[provider] || provider.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 4) || "x";
    let id = `${pfx}_${gameId}`;
    let n = 2; while (existingIds.has(id)) id = `${pfx}_${gameId}_${n++}`;
    existingIds.add(id);

    const entry = { id, name: g.name, provider, gameId, bonusBuy: false, maxWin: null, exclusive: null, thumbnailUrl: g.thumbnailUrl };
    slots.push(entry);
    byName.set(key, entry);
    added++; newList.push(`${g.name} [${provider}]`);
  }

  return { slots, added, backfilled, skipped, newList, backfillList };
}

module.exports = { mergeSlots, norm };
