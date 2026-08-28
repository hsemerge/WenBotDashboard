// Set an account's type by channel (or email), and optionally clear a bogus
// Stripe flag left over from testing.
//
// accountType decides whether an account counts as a CUSTOMER in the admin
// portal's numbers — streamer counts, MRR, the onboarding funnel, trial
// conversion. Getting it right matters more than it sounds:
//   streamer   a real channel (the default, and what everything counts)
//   moderator  only exists to help run someone else's channel
//   internal   us — team members and test accounts, never a customer
//
// --clear-ghost-sub removes stripeSubscriptionActive when the account has NO
// Stripe subscription id, NO recorded payments and NO paid invoices. That flag
// gets left behind by testing and makes an account show up as an active
// subscriber in the portal and on the streamer's own billing page.
//
// USAGE (dry run prints the plan and writes NOTHING):
//   node scripts/set-account-type.js <channel|email> --type moderator
//   node scripts/set-account-type.js triitongm --type internal --clear-ghost-sub --apply
//   node scripts/set-account-type.js --list            (show every non-streamer)

const admin = require("firebase-admin");

const argv  = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const APPLY = flags.has("--apply");
const CLEAR = flags.has("--clear-ghost-sub");
const LIST  = flags.has("--list");
const ti    = argv.indexOf("--type");
const TYPE  = ti >= 0 ? String(argv[ti + 1] || "").toLowerCase() : null;
const who   = argv.filter((a) => !a.startsWith("--") && a !== TYPE)[0] || null;

const TYPES = ["streamer", "moderator", "internal"];

function getDb() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) { console.error("Set FIREBASE_SERVICE_ACCOUNT_BASE64."); process.exit(1); }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) });
  return admin.firestore();
}

(async () => {
  const db = getDb();

  if (LIST) {
    const snap = await db.collection("streamers").get();
    const rows = snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
      .filter((x) => !x.archived && x.accountType && x.accountType !== "streamer");
    console.log(`Non-streamer accounts (${rows.length}):`);
    rows.forEach((x) => console.log(`  ${String(x.accountType).padEnd(10)} ${String(x.kickChannel || x.uid).padEnd(18)} ${x.accountTypeSource === "inferred" ? "(inferred)" : "(stated)"}`));
    process.exit(0);
  }

  if (!who || !TYPES.includes(TYPE)) {
    console.error(`Usage: node scripts/set-account-type.js <channel|email> --type ${TYPES.join("|")} [--clear-ghost-sub] [--apply]`);
    process.exit(1);
  }

  const key = who.toLowerCase();
  let snap = await db.collection("streamers").where("kickChannel", "==", key).limit(1).get();
  if (snap.empty) snap = await db.collection("streamers").where("email", "==", key).limit(1).get();
  if (snap.empty) { console.error(`No account found for "${who}".`); process.exit(1); }

  const doc = snap.docs[0], x = doc.data();
  const update = { accountType: TYPE, accountTypeSource: "stated", accountTypeAt: Date.now() };

  console.log(`${x.kickChannel || doc.id}  (uid ${doc.id})`);
  console.log(`  accountType: ${x.accountType || "(unset)"} → ${TYPE}`);

  if (CLEAR) {
    // Only ever clear a flag that is demonstrably false — never one backed by a
    // real subscription, payment or paid invoice.
    const paidInv = await doc.ref.collection("invoices").where("status", "==", "paid").limit(1).get();
    const pays    = await doc.ref.collection("payments").limit(1).get();
    const real = !!x.stripeSubscriptionId || !paidInv.empty || !pays.empty || (x.totalPaid || 0) > 0;
    if (!x.stripeSubscriptionActive) {
      console.log("  stripeSubscriptionActive: already false — nothing to clear");
    } else if (real) {
      console.log("  ⚠ stripeSubscriptionActive looks REAL (has a subscription/payment/paid invoice) — refusing to clear");
    } else {
      update.stripeSubscriptionActive = false;
      console.log("  stripeSubscriptionActive: true → false  (no subscription, no payments, no paid invoices)");
    }
  }

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply to save."); process.exit(0); }
  await doc.ref.set(update, { merge: true });
  console.log("\n✅ Saved.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
