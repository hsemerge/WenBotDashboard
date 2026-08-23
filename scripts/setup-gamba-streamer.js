// One-off setup: point a streamer's WenBot account at a Gamba race.
//
// Sets activeProvider = "gamba" and writes the race link to providers/gamba so
// the leaderboard, portal, /lb and verification all light up — the same thing
// the dashboard's Channel & Casino Setup does, but scriptable for wiring a
// streamer up for them.
//
// USAGE (dry run prints the plan and touches nothing):
//   node scripts/setup-gamba-streamer.js <kickChannel> <raceLinkOrId>
//   node scripts/setup-gamba-streamer.js <kickChannel> <raceLinkOrId> --apply
//
// EXAMPLE:
//   node scripts/setup-gamba-streamer.js pnutstv \
//     https://gamba.com/promotions/exclusive-leaderboards/17326 --apply
//
// Flags:
//   --apply              actually write (default is a dry run)
//   --no-require-casino  set casinoRequired=false (viewers may verify Kick-only)
//
// SAFE TO RE-RUN: it overwrites only activeProvider + the providers/gamba doc,
// and it validates the race link resolves on Gamba BEFORE writing anything, so a
// typo'd id fails loudly instead of saving a board that stays empty.
//
// Auth: same as scripts/migrate-leaderboards.js — either the base64 service
// account (FIREBASE_SERVICE_ACCOUNT_BASE64, e.g. `railway run node ...`) or the
// individual FIREBASE_* vars the Netlify functions use.

const path  = require("path");
const admin = require("firebase-admin");
const { findStreamerByChannel } = require(path.join(__dirname, "..", "netlify", "functions", "_lib", "streamer"));
const { fetchGambaRace, parseRaceId } = require(path.join(__dirname, "..", "netlify", "functions", "_lib", "gamba"));

const argv    = process.argv.slice(2);
const flags   = new Set(argv.filter((a) => a.startsWith("--")));
const posargs = argv.filter((a) => !a.startsWith("--"));
const APPLY   = flags.has("--apply");
const [channel, raceLink] = posargs;

if (!channel || !raceLink) {
  console.error("Usage: node scripts/setup-gamba-streamer.js <kickChannel> <raceLinkOrId> [--apply] [--no-require-casino]");
  process.exit(1);
}

function getDb() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
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
  const raceId = parseRaceId(raceLink);
  if (!raceId) { console.error(`Couldn't find a race id in "${raceLink}".`); process.exit(1); }

  // Validate the race resolves before writing, so a bad link fails here.
  console.log(`Checking Gamba race ${raceId} …`);
  const race = await fetchGambaRace(raceLink);
  if (!race) { console.error("That Gamba race didn't resolve (bad id, or Gamba unreachable). Nothing written."); process.exit(1); }
  console.log(`  ✓ "${race.raceName}" — sponsor ${race.sponsor || "?"}, ${race.totalUsers} entrants, prize pool ${race.prizePool} ${race.currency || ""}`);

  const db   = getDb();
  const doc  = await findStreamerByChannel(db, channel);
  if (!doc) { console.error(`No WenBot streamer found for channel "${channel}".`); process.exit(1); }
  const data = doc.data() || {};
  const casinoRequired = !flags.has("--no-require-casino");

  console.log("");
  console.log(`Streamer:        ${data.kickChannel || channel}  (uid ${doc.id})`);
  console.log(`activeProvider:  ${data.activeProvider || "(none)"}  ->  gamba`);
  console.log(`providers/gamba: referralCode = ${raceLink}`);
  console.log(`casinoRequired:  ${casinoRequired}`);
  console.log("");

  if (!APPLY) {
    console.log("DRY RUN — nothing written. Re-run with --apply to save.");
    process.exit(0);
  }

  await doc.ref.set({ activeProvider: "gamba", casinoRequired }, { merge: true });
  await doc.ref.collection("providers").doc("gamba").set(
    { referralCode: raceLink, enabled: true, updatedAt: Date.now() },
    { merge: true }
  );

  console.log("✓ Done. Gamba is now this streamer's casino and the leaderboard/verification are live.");
  process.exit(0);
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
