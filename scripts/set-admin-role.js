// Admin-portal roles: set / clear the adminRole custom claim on a Firebase user.
//
// requireAdmin (netlify/functions/_lib/admin.js) trusts this claim:
//   owner — everything, incl. billing/invoicing + destructive actions
//   staff — day-to-day ops; billing endpoints refuse them
// The ADMIN_UIDS env allowlist keeps working as an implicit-owner fallback, so
// running this can never lock the existing owner out.
//
// Claims are MERGE-spread: an admin who also moderates a streamer keeps their
// delegatedFor claim (same rule _lib/team.js follows). After a change the user's
// refresh tokens are revoked so the new role applies on their next sign-in
// instead of up to an hour later.
//
// USAGE (dry run prints the plan and writes NOTHING):
//   node scripts/set-admin-role.js <email> --role owner|staff
//   node scripts/set-admin-role.js <email> --role staff --apply
//   node scripts/set-admin-role.js <email> --clear --apply     (remove the claim)
//   node scripts/set-admin-role.js --list                      (everyone holding a role)
//
// Auth: FIREBASE_SERVICE_ACCOUNT_BASE64 (or the individual FIREBASE_* vars).

const admin = require("firebase-admin");

const argv   = process.argv.slice(2);
const flags  = new Set(argv.filter((a) => a.startsWith("--")));
const APPLY  = flags.has("--apply");
const CLEAR  = flags.has("--clear");
const LIST   = flags.has("--list");
const roleI  = argv.indexOf("--role");
const ROLE   = roleI >= 0 ? String(argv[roleI + 1] || "").toLowerCase() : null;
const email  = argv.filter((a) => !a.startsWith("--") && a !== ROLE)[0] || null;

function getAuth() {
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
  return admin.auth();
}

(async () => {
  const auth = getAuth();

  if (LIST) {
    // MFA status included so ADMIN_REQUIRE_MFA is only ever flipped once every
    // owner shows "mfa=enrolled" here — flipped early it locks all owners out.
    console.log("Users holding an adminRole claim:");
    let token, found = 0;
    do {
      const page = await auth.listUsers(1000, token);
      for (const u of page.users) {
        const r = u.customClaims && u.customClaims.adminRole;
        if (r) {
          found++;
          const mfa = (u.multiFactor && u.multiFactor.enrolledFactors && u.multiFactor.enrolledFactors.length)
            ? `enrolled (${u.multiFactor.enrolledFactors.map((f) => f.factorId).join(",")})` : "none";
          console.log(`  ${r.padEnd(6)} ${u.email || "(no email)"}  uid=${u.uid}  verified=${u.emailVerified}  mfa=${mfa}`);
        }
      }
      token = page.pageToken;
    } while (token);
    if (!found) console.log("  (none — only the ADMIN_UIDS env fallback is in effect)");
    process.exit(0);
  }

  if (!email || (!CLEAR && !["owner", "staff"].includes(ROLE))) {
    console.error("Usage: node scripts/set-admin-role.js <email> --role owner|staff [--apply] | <email> --clear --apply | --list");
    process.exit(1);
  }

  const user = await auth.getUserByEmail(email).catch(() => null);
  if (!user) { console.error(`No Firebase user with email "${email}". Create the account first (they sign up once at /admin, or via the Firebase console).`); process.exit(1); }

  const claims = { ...(user.customClaims || {}) };
  const before = claims.adminRole || "(none)";
  if (CLEAR) delete claims.adminRole; else claims.adminRole = ROLE;

  console.log(`User:  ${user.email}  (uid ${user.uid})  emailVerified=${user.emailVerified}`);
  console.log(`  adminRole: ${before}  →  ${CLEAR ? "(cleared)" : ROLE}`);
  console.log(`  other claims kept: ${JSON.stringify(Object.keys(claims).filter((k) => k !== "adminRole"))}`);
  if (!user.emailVerified) console.log("  ⚠ email not verified — requireAdmin refuses unverified emails; have them verify first.");

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply to save."); process.exit(0); }
  await auth.setCustomUserClaims(user.uid, claims);
  await auth.revokeRefreshTokens(user.uid); // apply on next sign-in, not in ~1h
  console.log("\n✅ Claim saved. They sign out/in once and the role is live.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
