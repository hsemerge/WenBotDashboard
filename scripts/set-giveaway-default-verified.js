// One-off admin tool: turn on a per-streamer default so "Casino Verified" comes
// up ON for every NEW giveaway a streamer runs — so someone who always wants it
// (e.g. Meg) stops having to remember. They can still untick it for a specific
// round from the dashboard; the next new giveaway defaults back on.
//
// It sets giveawayDefaultCasinoVerified (the sticky default the dashboard reads
// at idle, restore block ~dashboard.html:8261) and, so the requirement is correct
// immediately rather than only on the next started round, giveawayVerifiedCasino.
//
// USAGE (dry run prints the plan and writes NOTHING):
//   node scripts/set-giveaway-default-verified.js <kickChannel>
//   node scripts/set-giveaway-default-verified.js <kickChannel> --apply
//   node scripts/set-giveaway-default-verified.js <kickChannel> --off --apply   (turn the default back off)
//
// EXAMPLE:
//   node scripts/set-giveaway-default-verified.js meggambles --apply
//
// SAFE TO RE-RUN: merge-writes only the two fields above; --off clears just the
// default flag. Resolves the streamer by channel (incl. former slugs) via the
// shared helper, so there is no uid to hardcode.
//
// Auth: same as scripts/setup-gamba-streamer.js — the base64 service account
// (FIREBASE_SERVICE_ACCOUNT_BASE64 / _B64) or the individual FIREBASE_* vars.

const path  = require("path");
const admin = require("firebase-admin");
const { findStreamerByChannel } = require(path.join(__dirname, "..", "netlify", "functions", "_lib", "streamer"));

const argv    = process.argv.slice(2);
const flags   = new Set(argv.filter((a) => a.startsWith("--")));
const posargs = argv.filter((a) => !a.startsWith("--"));
const APPLY   = flags.has("--apply");
const OFF     = flags.has("--off");
const [channel] = posargs;

if (!channel) {
  console.error("Usage: node scripts/set-giveaway-default-verified.js <kickChannel> [--apply] [--off]");
  process.exit(1);
}

function getDb() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (b64) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) });
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        }),
      });
    } else {
      console.error("No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY.");
      process.exit(1);
    }
  }
  return admin.firestore();
}

(async () => {
  const db  = getDb();
  const doc = await findStreamerByChannel(db, channel);
  if (!doc) { console.error(`No streamer found for channel "${channel}".`); process.exit(1); }
  const cur = doc.data();

  const update = OFF
    ? { giveawayDefaultCasinoVerified: false }
    : { giveawayDefaultCasinoVerified: true, giveawayVerifiedCasino: true };

  console.log(`Streamer: ${cur.kickChannel || channel}  (uid ${doc.id})`);
  console.log(`  current giveawayDefaultCasinoVerified: ${cur.giveawayDefaultCasinoVerified === true}`);
  console.log(`  current giveawayVerifiedCasino:        ${cur.giveawayVerifiedCasino === true}`);
  console.log(`  will ${OFF ? "CLEAR the default" : "set"}: ${JSON.stringify(update)}`);

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply to save."); process.exit(0); }
  await db.collection("streamers").doc(doc.id).set(update, { merge: true });
  console.log(`\n✅ Applied to ${doc.id}.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
