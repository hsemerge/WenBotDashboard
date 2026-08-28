// Retroactively mark moderator accounts that only exist because signup used to
// force a channel.
//
// Until account types were added, a moderator had no way to say "I'm not a
// streamer" — team-add-mod requires them to have a WenBot login first, and the
// only signup path walked them through connecting a Kick channel and picking a
// casino. So they created an empty channel to get through, and have counted as
// streamers in every number since.
//
// This finds those accounts and sets accountType:'moderator'. The bar is
// deliberately high — an account is only reclassified when it BOTH moderates
// someone else's channel AND shows no sign of being a real channel:
//   · never streamed (no recorded live time)
//   · no feature activity at all (no giveaways, commands, hunts…)
//   · no verified viewers
//   · no leaderboard configured
//   · has never paid, and holds no active subscription
// Any one of those being non-zero means it might be a real streamer who also
// mods, so it is left alone and reported for a human to look at.
//
// accountTypeSource:'inferred' records that we deduced this rather than being
// told, so the admin UI can show it honestly and a person can override it.
//
// USAGE (dry run prints the plan and writes NOTHING):
//   node scripts/classify-moderators.js
//   node scripts/classify-moderators.js --apply

const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");

function getDb() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) { console.error("Set FIREBASE_SERVICE_ACCOUNT_BASE64."); process.exit(1); }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) });
  return admin.firestore();
}

(async () => {
  const db = getDb();
  const snap = await db.collection("streamers").get();
  const docs = snap.docs.map((d) => ({ uid: d.id, ref: d.ref, ...d.data() }));

  // Who moderates whom — modUids is the source of truth (see _lib/team.js).
  // Deliberately not the delegatedFor claim: admin switch-ins grant that too.
  const moderates = {};
  docs.forEach((d) => {
    (Array.isArray(d.modUids) ? d.modUids : []).forEach((m) => {
      (moderates[m] = moderates[m] || []).push(d.kickChannel || d.uid);
    });
  });

  const reclassify = [], keep = [];
  for (const d of docs) {
    const mods = moderates[d.uid];
    if (!mods || d.archived) continue;
    if (d.accountType === "moderator") continue;               // already marked

    const activity = Object.values(d.communityStats || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const liveMs   = (d.liveStats && d.liveStats.totalLiveMs) || 0;
    const vu       = await d.ref.collection("verified_users").count().get().then((r) => r.data().count).catch(() => 0);
    const paying   = !!d.stripeSubscriptionActive || (d.totalPaid || 0) > 0 || !!d.cryptoBilling;

    const signals = [];
    if (activity)           signals.push(`${activity} feature actions`);
    if (liveMs)             signals.push(`${Math.round(liveMs / 36e5)}h streamed`);
    if (vu)                 signals.push(`${vu} verified viewers`);
    if (d.leaderboardEnabled) signals.push("leaderboard on");
    if (paying)             signals.push("PAYING");

    (signals.length ? keep : reclassify).push({ d, mods, signals });
  }

  console.log(`${docs.length} accounts · ${Object.keys(moderates).length} moderate someone\n`);
  console.log(`WOULD RECLASSIFY as moderator (${reclassify.length}):`);
  reclassify.forEach(({ d, mods }) =>
    console.log(`  ${String(d.kickChannel || d.uid).padEnd(16)} moderates ${mods.join(", ")}  ·  no activity of its own`));
  if (keep.length) {
    console.log(`\nLEFT ALONE — moderates someone but looks like a real channel (${keep.length}):`);
    keep.forEach(({ d, mods, signals }) =>
      console.log(`  ${String(d.kickChannel || d.uid).padEnd(16)} moderates ${mods.join(", ")}  ·  ${signals.join(", ")}`));
  }

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply to save."); process.exit(0); }
  for (const { d } of reclassify) {
    await d.ref.set({ accountType: "moderator", accountTypeSource: "inferred", accountTypeAt: Date.now() }, { merge: true });
    console.log(`  ✅ ${d.kickChannel || d.uid} → moderator`);
  }
  console.log(`\n✅ Reclassified ${reclassify.length} account(s).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
