// Privacy-preserving "connection fingerprint" for abuse clustering.
//
// We deliberately never store or show a raw IP. Instead we keep a salted HMAC of
// it and a short human label derived from that hash. Two accounts that verified
// from the same IP get the SAME hash and the SAME label; the label reveals
// nothing about the IP itself (you cannot geolocate or reverse "amber-4F2C"),
// and the salt is a server secret so the hash cannot be rainbow-tabled against
// the ~4-billion IPv4 space.
//
// Matching is ALWAYS on the full hash, never the label — the label is display
// only, so a rare label collision between two different IPs can never cause a
// false cluster. It just has to be short enough for a mod to eyeball.
//
// Reads FINGERPRINT_SALT from the environment. With no salt set, fingerprint()
// returns null and the whole feature is simply inert (nothing stored, nothing
// flagged) rather than storing a reversible bare hash.

const crypto = require("crypto");

const SALT = process.env.FINGERPRINT_SALT || "";

// 16 neutral color-ish words = 4 bits from the first hash nibble. Neutral on
// purpose: the label is an identifier, not a judgement.
const WORDS = [
  "amber", "azure", "coral", "ivory", "jade",  "onyx",  "pearl", "ruby",
  "slate", "teal",  "umber", "iris",  "cobalt", "olive", "rust",  "sage",
];

// x-forwarded-for can be "client, proxy, proxy"; take the first hop, trim, and
// unwrap an IPv4-mapped IPv6 address so the same client hashes consistently
// whichever form Kick/Netlify hand us.
function normalizeIp(raw) {
  const first = String(raw || "").split(",")[0].trim();
  return first.replace(/^::ffff:/i, "");
}

/**
 * @returns {{hash:string, label:string}|null}
 *   hash  — full salted HMAC-SHA256 hex (what we MATCH on)
 *   label — word + 4 hex chars, e.g. "amber-4F2C" (what we SHOW; ~1M space)
 *   null  — no usable IP, or no salt configured (feature inert)
 */
function fingerprint(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip || ip.toLowerCase() === "unknown" || !SALT) return null;
  const h = crypto.createHmac("sha256", SALT).update(ip).digest("hex");
  const word  = WORDS[parseInt(h[0], 16)];
  const label = `${word}-${h.slice(1, 5).toUpperCase()}`;
  return { hash: h, label };
}

module.exports = { fingerprint, normalizeIp };
