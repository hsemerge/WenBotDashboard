/* ============================================================================
 * ingest-slots.js — safely merge a Stake pull into data/slots.json.
 *
 * USAGE:  node scripts/ingest-slots.js [path-to-pull.json]
 *         (defaults to ./slots-pull.json)
 *
 * GUARANTEES (this is the whole point):
 *   - APPENDS only genuinely new slots (matched by normalized name).
 *   - Only FILLS EMPTY thumbnails on existing slots. NEVER overwrites an
 *     existing thumbnailUrl — so your manual fixes and the self-hosted
 *     /img/slots/*.png paths are always preserved.
 *   - Idempotent: re-running adds nothing already present.
 *   - Pass --dry to preview without writing.
 *
 * New slots arrive with bonusBuy=false, maxWin=null, exclusive=null — curate
 * those by hand afterward (the script prints the list to review).
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SLOTS_JSON = path.join(ROOT, 'data', 'slots.json');
const PULL_PATH = process.argv.slice(2).find(a => !a.startsWith('-'))
  || path.join(ROOT, 'slots-pull.json');
const DRY = process.argv.includes('--dry');

function readJson(p) {
  let t = fs.readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return JSON.parse(t);
}
function norm(s) {
  return s.toLowerCase().replace(/[’'´`]/g, "'").replace(/[—–-]/g, ' ')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Stake provider value (lowercased) -> our catalog display name.
// Covers the top providers; anything unmapped falls back to the slug prefix.
const PROVIDER_MAP = {
  'pragmatic play': 'Pragmatic Play', 'pragmatic': 'Pragmatic Play',
  'hacksaw gaming': 'Hacksaw Gaming', 'hacksaw': 'Hacksaw Gaming',
  'nolimit city': 'Nolimit City', 'nolimit': 'Nolimit City', 'nlc': 'Nolimit City',
  "play'n go": "Play'n GO", 'playngo': "Play'n GO", 'play n go': "Play'n GO",
  'relax gaming': 'Relax Gaming', 'relax': 'Relax Gaming',
  'bgaming': 'BGaming', 'softswiss': 'BGaming',
  'elk studios': 'ELK Studios', 'elk': 'ELK Studios',
  'big time gaming': 'Big Time Gaming', 'btg': 'Big Time Gaming', 'bigtimegaming': 'Big Time Gaming',
  'red tiger': 'Red Tiger', 'redtiger': 'Red Tiger',
  'netent': 'NetEnt', 'extendednetent': 'NetEnt',
  'thunderkick': 'Thunderkick', 'quickspin': 'Quickspin',
  'avatarux': 'AvatarUX', 'booming games': 'Booming Games', 'booming': 'Booming Games',
  'blueprint gaming': 'Blueprint Gaming', 'blueprint': 'Blueprint Gaming',
  'push gaming': 'Push Gaming', 'push': 'Push Gaming',
  'pg soft': 'PG Soft', 'pgsoft': 'PG Soft',
  '3 oaks gaming': '3 Oaks Gaming', '3oaks': '3 Oaks Gaming',
  'wazdan': 'Wazdan', 'endorphina': 'Endorphina', 'yggdrasil': 'Yggdrasil',
  'playson': 'Playson', 'spribe': 'Spribe',
};
// provider display name -> short id prefix used in catalog ids
const ID_PREFIX = {
  'Pragmatic Play': 'pp', 'Hacksaw Gaming': 'hs', 'Nolimit City': 'nlc',
  "Play'n GO": 'png', 'Relax Gaming': 'relax', 'BGaming': 'bg', 'ELK Studios': 'elk',
  'Big Time Gaming': 'btg', 'Red Tiger': 'rt', 'NetEnt': 'ne', 'Thunderkick': 'tk',
  'Quickspin': 'qs', 'AvatarUX': 'avu', 'Booming Games': 'boom', 'Blueprint Gaming': 'bp',
  'Push Gaming': 'push', 'PG Soft': 'pg', '3 Oaks Gaming': '3oaks', 'Wazdan': 'waz',
  'Endorphina': 'endo', 'Yggdrasil': 'ygg', 'Playson': 'plsn', 'Spribe': 'spribe',
};

function mapProvider(pull) {
  const raw = (pull.provider || '').trim();
  const mapped = PROVIDER_MAP[raw.toLowerCase()];
  if (mapped) return mapped;
  // fall back to slug prefix (e.g. "pragmatic-play-foo" -> "pragmatic-play")
  const prefix = (pull.slug || '').split('-').slice(0, 2).join('-');
  return PROVIDER_MAP[prefix.replace(/-/g, ' ')] || raw || prefix || 'Unknown';
}
// Detect live-casino / table / originals so they never pollute the slot picker.
// Only gates NEW additions; existing catalog entries are never touched by this.
// (A handful of edge slots like "Bingo Mania" won't auto-add — add by hand if wanted.)
function isNonSlot(name, slug) {
  const s = (slug || '').toLowerCase();
  if (/[-/]live[-/]/.test(s)) return true;                                   // live dealer
  if (/-(plinko|mines|limbo|chicken|dice|keno|hilo|hi-lo|crash|spaceman|aviator)$/.test(s)) return true; // originals
  const n = ' ' + name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const TABLE = ['roulette', 'baccarat', 'blackjack', 'sic bo', 'sic bac', 'mega wheel',
    'mega ball', 'craps', 'andar bahar', 'teen patti', 'fan tan', 'crazy time', 'dream catcher', 'bingo'];
  return TABLE.some(t => n.includes(' ' + t + ' '));
}
function deriveGameId(slug, provider) {
  // strip a leading provider-ish prefix, snake_case the rest
  let s = slug;
  const pfx = provider.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (s.startsWith(pfx + '-')) s = s.slice(pfx.length + 1);
  else s = s.replace(/^[a-z0-9]+-/, ''); // strip first token as a fallback
  return s.replace(/-/g, '_');
}

// ---- load ----
const catalog = readJson(SLOTS_JSON);
let pull;
try { pull = readJson(PULL_PATH); }
catch (e) { console.error(`Could not read pull file: ${PULL_PATH}\n  ${e.message}`); process.exit(1); }

console.log(`Catalog: ${catalog.slots.length} slots  |  Pull: ${pull.length} games  |  ${DRY ? 'DRY RUN' : 'WRITING'}`);

const byName = new Map(catalog.slots.map(s => [norm(s.name), s]));
const existingIds = new Set(catalog.slots.map(s => s.id));

let added = 0, backfilled = 0, skipped = 0;
const newList = [], backfillList = [];

for (const g of pull) {
  if (!g.name || !g.thumbnailUrl) { skipped++; continue; }
  const key = norm(g.name);
  const existing = byName.get(key);

  if (existing) {
    // only fill an empty thumbnail — never overwrite manual/self-hosted art
    if (!existing.thumbnailUrl) {
      if (!DRY) existing.thumbnailUrl = g.thumbnailUrl;
      backfilled++; backfillList.push(existing.name);
    } else {
      skipped++;
    }
    continue;
  }

  // genuinely new — but skip live casino / table / originals
  if (isNonSlot(g.name, g.slug)) { skipped++; continue; }

  const provider = mapProvider(g);
  const gameId = deriveGameId(g.slug, provider);
  const pfx = ID_PREFIX[provider] || provider.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 4) || 'x';
  let id = `${pfx}_${gameId}`;
  let n = 2; while (existingIds.has(id)) id = `${pfx}_${gameId}_${n++}`;
  existingIds.add(id);

  const entry = { id, name: g.name, provider, gameId, bonusBuy: false, maxWin: null, exclusive: null, thumbnailUrl: g.thumbnailUrl };
  if (!DRY) catalog.slots.push(entry);
  byName.set(key, entry);
  added++; newList.push(`${g.name}  [${provider}]`);
}

if (!DRY) fs.writeFileSync(SLOTS_JSON, JSON.stringify(catalog, null, 2));

console.log(`\nAdded:      ${added}`);
console.log(`Backfilled: ${backfilled} (empty thumbnails filled)`);
console.log(`Skipped:    ${skipped} (already present / no image)`);
console.log(`Catalog now: ${catalog.slots.length} slots`);

if (newList.length) {
  console.log(`\n--- NEW slots (review bonusBuy / maxWin / exclusive) ---`);
  newList.forEach(s => console.log('  + ' + s));
}
if (backfillList.length) {
  console.log(`\n--- Backfilled images ---`);
  backfillList.forEach(s => console.log('  ~ ' + s));
}
if (DRY) console.log('\n(DRY RUN — nothing written. Re-run without --dry to apply.)');
