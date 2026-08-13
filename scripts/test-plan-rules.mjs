// Firestore rules test for the plan gate.
//
// The failure that matters is NOT "a lapsed user sneaks a write through". It is
// "a paying Elite streamer can no longer save their leaderboard", which would be
// invisible to us and infuriating to them. The elite/agency ALLOW cases below
// are the ones this file exists to protect.
//
// Run (needs Java for the emulator):
//   firebase emulators:exec --only firestore --project wenbot-rules-test \
//     "node scripts/test-plan-rules.mjs"
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { setDoc, doc, updateDoc, getDoc } from 'firebase/firestore';

const OWNER = 'owner1';
let pass = 0, fail = 0;
const check = async (label, p) => {
  try { await p; console.log('  PASS  ' + label); pass++; }
  catch (e) { console.log('  FAIL  ' + label + '  :: ' + String(e.message || e).slice(0, 100)); fail++; }
};

const env = await initializeTestEnvironment({
  projectId: 'wenbot-rules-test',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});

// Seed with rules disabled (admin-equivalent), then act as the signed-in owner.
async function seed(plan) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'streamers', OWNER), {
      ...(plan === undefined ? {} : { plan }),
      leaderboardPeriod: { active: true, startAt: 1 },
      displayName: 'before',
    });
  });
}
const asOwner = () => env.authenticatedContext(OWNER).firestore();
const period = (n) => ({ leaderboardPeriod: { active: true, startAt: n } });

console.log('\nPAYING TIERS — these writes MUST keep working');
for (const plan of ['elite', 'agency']) {
  await seed(plan);
  await check(`${plan}: start a new leaderboard period`,
    assertSucceeds(updateDoc(doc(asOwner(), 'streamers', OWNER), period(2))));
  await seed(plan);
  await check(`${plan}: toggle leaderboardEnabled`,
    assertSucceeds(updateDoc(doc(asOwner(), 'streamers', OWNER), { leaderboardEnabled: true })));
  await seed(plan);
  await check(`${plan}: edit leaderboardPrizes`,
    assertSucceeds(updateDoc(doc(asOwner(), 'streamers', OWNER), { leaderboardPrizes: [100, 50] })));
}

console.log('\nLAPSED TIERS — leaderboard settings must lock');
for (const plan of ['starter', 'pro']) {
  await seed(plan);
  await check(`${plan}: cannot start a new period`,
    assertFails(updateDoc(doc(asOwner(), 'streamers', OWNER), period(2))));
  await seed(plan);
  await check(`${plan}: cannot edit prizes`,
    assertFails(updateDoc(doc(asOwner(), 'streamers', OWNER), { leaderboardPrizes: [100, 50] })));
}
await seed(undefined);
await check('missing plan counts as starter: cannot start a new period',
  assertFails(updateDoc(doc(asOwner(), 'streamers', OWNER), period(2))));

console.log('\nLAPSED STREAMERS STILL RUN THEIR CHANNEL');
await seed('starter');
await check('starter: can still edit unrelated settings',
  assertSucceeds(updateDoc(doc(asOwner(), 'streamers', OWNER), { displayName: 'after' })));
await seed('starter');
await check('starter: can still READ their own doc (board stays visible)',
  assertSucceeds(getDoc(doc(asOwner(), 'streamers', OWNER))));

console.log('\nNO SELF-PROMOTION');
await seed('starter');
await check('starter: cannot set plan to elite',
  assertFails(updateDoc(doc(asOwner(), 'streamers', OWNER), { plan: 'elite' })));
await seed('starter');
await check('starter: cannot sneak plan + period through together',
  assertFails(updateDoc(doc(asOwner(), 'streamers', OWNER), { plan: 'elite', ...period(9) })));

console.log('\nSIGNUP CREATE');
await env.clearFirestore();
await check('new signup CAN create with plan starter',
  assertSucceeds(setDoc(doc(asOwner(), 'streamers', OWNER), { plan: 'starter', displayName: 'new' })));
await env.clearFirestore();
await check('new signup CANNOT create as elite',
  assertFails(setDoc(doc(asOwner(), 'streamers', OWNER), { plan: 'elite', displayName: 'new' })));

await env.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
