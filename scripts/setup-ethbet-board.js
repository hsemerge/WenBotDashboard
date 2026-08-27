// One-off admin: wire a streamer up with an ETHbet leaderboard board. This makes
// ETHbet (a) a live leaderboard on their portal and (b) an under-code
// verification option — verify-affiliate treats every ENABLED board's provider as
// verifiable (activeProvider + boards), and ethbet is in API_CASINOS.
//
// It validates the key against the live ETHbet API first (fails loudly on a bad
// key), then writes:
//   streamers/{uid}/leaderboards/ethbet = { provider:"ethbet", enabled, order,
//        label, prizes:[], period:{…current ETHbet window…}, credential:{apiKey} }
//   streamers/{uid}/providers/ethbet    = { apiKey }   (so the primary path also
//        resolves if the streamer ever makes ETHbet their active casino)
//
// It does NOT change activeProvider — ETHbet is added ALONGSIDE the existing
// casino(s), not as a replacement.
//
// USAGE (dry run prints the plan and writes NOTHING):
//   ETHBET_API_KEY=slbk_… node scripts/setup-ethbet-board.js <kickChannel>
//   ETHBET_API_KEY=slbk_… node scripts/setup-ethbet-board.js <kickChannel> --apply
//
// Auth: FIREBASE_SERVICE_ACCOUNT_BASE64 (or _B64), or the individual FIREBASE_* vars.

const path  = require("path");
const admin = require("firebase-admin");
const { findStreamerByChannel } = require(path.join(__dirname, "..", "netlify", "functions", "_lib", "streamer"));
const { fetchEthbetBoard } = require(path.join(__dirname, "..", "netlify", "functions", "_lib", "ethbet"));

const argv    = process.argv.slice(2);
const flags   = new Set(argv.filter((a) => a.startsWith("--")));
const posargs = argv.filter((a) => !a.startsWith("--"));
const APPLY   = flags.has("--apply");
const [channel] = posargs;
const API_KEY = process.env.ETHBET_API_KEY || "";

if (!channel || !API_KEY) {
  console.error("Usage: ETHBET_API_KEY=<key> node scripts/setup-ethbet-board.js <kickChannel> [--apply]");
  process.exit(1);
}

function getDb() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (b64) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) });
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
      admin.initializeApp({ credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }) });
    } else {
      console.error("No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY.");
      process.exit(1);
    }
  }
  return admin.firestore();
}

(async () => {
  // 1) Validate the key against the live API before writing anything.
  console.log("Validating ETHbet API key against the live API …");
  const board = await fetchEthbetBoard(API_KEY);
  if (!board) { console.error("❌ ETHbet key did not return a board (bad key, rate-limited, or API error). Nothing written."); process.exit(1); }
  console.log(`  ✓ board for "${board.sponsor}" — ${board.totalUsers} ranked players, $${board.totalWagered.toFixed(2)} wagered, window ${new Date(board.startAt).toISOString()} → ${new Date(board.endAt).toISOString()}`);

  const db  = getDb();
  const doc = await findStreamerByChannel(db, channel);
  if (!doc) { console.error(`No streamer found for channel "${channel}".`); process.exit(1); }
  const uid = doc.id;

  // 2) Order = one past the current highest board.
  const boards = await db.collection("streamers").doc(uid).collection("leaderboards").get();
  let maxOrder = -1;
  boards.forEach((b) => { const o = Number(b.data().order); if (Number.isFinite(o) && o > maxOrder) maxOrder = o; });
  const existing = boards.docs.find((b) => b.id === "ethbet" || (b.data().provider === "ethbet"));

  const boardDoc = {
    provider:   "ethbet",
    label:      "ETHbet",
    enabled:    true,
    order:      existing ? (existing.data().order ?? maxOrder + 1) : maxOrder + 1,
    prizes:     [],                      // ETHbet supplies its own prize ladder
    period:     {                        // cosmetic for the editor; the portal shows the API's live window
      mode: "rolling", duration: "monthly", autoRenew: false, cycleDay: null,
      startAt: board.startAt, endAt: board.endAt,
    },
    createdAt:  existing ? (existing.data().createdAt ?? Date.now()) : Date.now(),
    credential: { apiKey: API_KEY },
  };

  console.log(`\nStreamer: ${doc.data().kickChannel || channel}  (uid ${uid})`);
  console.log(`  ${existing ? "UPDATE existing" : "CREATE"} leaderboards/ethbet at order ${boardDoc.order}`);
  console.log(`  board doc (key redacted): ${JSON.stringify({ ...boardDoc, credential: { apiKey: "slbk_…redacted" } })}`);
  console.log(`  providers/ethbet = { apiKey: "slbk_…redacted" }`);
  console.log(`  activeProvider left as-is: ${doc.data().activeProvider}`);

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply to save."); process.exit(0); }
  await db.collection("streamers").doc(uid).collection("leaderboards").doc("ethbet").set(boardDoc, { merge: true });
  await db.collection("streamers").doc(uid).collection("providers").doc("ethbet").set({ apiKey: API_KEY }, { merge: true });
  console.log(`\n✅ ETHbet board + provider written for ${uid}.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
