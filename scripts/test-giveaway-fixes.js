// Regression tests for the audit fixes.
const F = require('../netlify/functions/_lib/fairness');
const O = require('../netlify/functions/_lib/giveaway-odds');
const { performDraw, settingsFromProfile } = require('../netlify/functions/_lib/giveaway-draw-core');

let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ok   ' + label); }
                                  else { fail++; console.log('  FAIL ' + label + (extra ? '\n         ' + extra : '')); } };

function makeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed));
  let reads = 0;
  const colDocs = (col) => Object.keys(store)
    .filter(k => k.startsWith(col + '/') && k.slice(col.length + 1).indexOf('/') === -1)
    .map(k => ({ id: k.split('/').pop(), data: () => store[k], ref: docRef(k) }));
  function setDeep(obj, dotted, val) {
    const segs = dotted.split('.'); let o = obj;
    for (let i = 0; i < segs.length - 1; i++) { o[segs[i]] = o[segs[i]] || {}; o = o[segs[i]]; }
    o[segs[segs.length - 1]] = val;
  }
  function docRef(p) {
    return {
      _p: p,
      get: async () => { reads++; const snap = store[p] === undefined ? undefined : JSON.parse(JSON.stringify(store[p])); return { exists: snap !== undefined, data: () => snap, id: p.split('/').pop(), ref: docRef(p) }; },
      set: async (v) => { store[p] = JSON.parse(JSON.stringify(v)); },
      update: async (v) => {
        store[p] = store[p] || {};
        for (const [k, val] of Object.entries(v)) {
          if (val && val.__inc !== undefined) {
            const cur = k.split('.').reduce((o, s) => (o || {})[s], store[p]) || 0;
            setDeep(store[p], k, cur + val.__inc);
          } else setDeep(store[p], k, val);
        }
      },
      collection: (c) => collRef(p + '/' + c),
    };
  }
  function collRef(c) {
    const q = (filter) => ({
      get: async () => { reads++; return { docs: colDocs(c).filter(filter) }; },
      where: (f, op, v) => q(d => filter(d) && d.data()[f] === v),
      limit: () => q(filter),
    });
    return Object.assign(q(() => true), { doc: (id) => docRef(c + '/' + id) });
  }
  return { collection: collRef,
    runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, v) => r.update(v), set: (r, v) => r.set(v) }),
    _store: store, _reads: () => reads, _resetReads: () => { reads = 0; } };
}
const A = { firestore: { FieldValue: { increment: (n) => ({ __inc: n }) } } };

const START = 5000;
function fixture(profileExtra, secretExtra) {
  const seed = F.newServerSeed();
  return { seed, db: makeDb({
    'giveaway_fairness/S1': Object.assign(
      { serverSeed: seed, serverSeedHash: F.sha256Hex(seed), committedAt: 1000, drawNonce: 0, forGiveawayAt: START },
      secretExtra || {}),
    'streamers/S1': Object.assign({
      kickChannel: 'tiltbros', giveawayActive: true, giveawayStartedAt: START,
      giveawaySubLuck: 3, giveawayCodeLuck: 2, giveawayWagerLuck: 1,
      giveawaySubOnly: false, giveawayVerifiedCasino: false, giveawayVerifiedDiscord: false,
    }, profileExtra || {}),
    'streamers/S1/giveaway_state/snapshot': { entries: [
      { kickKey: 'alice', kickName: 'Alice', isSub: true,  underCode: true,  wager: 0 },
      { kickKey: 'bob',   kickName: 'Bob',   isSub: false, underCode: false, wager: 0 },
      { kickKey: 'cara',  kickName: 'Cara',  isSub: true,  underCode: false, wager: 0 },
    ] },
    'streamers/S1/verified_users/v1': { kickName: 'Alice', provider: 'degen', underAffiliate: true },
    'streamers/S1/discord_links/d1':  { kickUsername: 'Alice' },
  }) };
}

(async () => {
  console.log('\n== BLOCKER: the seed rotates on every draw ==');
  {
    const { db, seed } = fixture();
    const a = await performDraw(db, A, 'S1', O.sanitiseLuck({}), O.sanitiseRules({}));
    const b = await performDraw(db, A, 'S1', O.sanitiseLuck({}), O.sanitiseRules({}));
    const p1 = db._store['streamers/S1/giveaway_draws/' + a.result.drawId];
    const p2 = db._store['streamers/S1/giveaway_draws/' + b.result.drawId];
    ok(p1.serverSeed === seed, 'draw #1 uses the originally committed seed');
    ok(p2.serverSeed !== p1.serverSeed, 'draw #2 uses a DIFFERENT seed (re-roll is not steerable)');
    ok(p1.nextSeedHash === F.sha256Hex(p2.serverSeed),
       "draw #1 published the commitment that draw #2's seed satisfies");
    ok(db._store['giveaway_fairness/S1'].serverSeed !== p2.serverSeed,
       'the seed draw #2 revealed has already been retired');
    ok(F.verifyDraw(p1).ok && F.verifyDraw(p2).ok, 'both proofs still verify');
    ok(db._store['streamers/S1'].giveawayFairness.serverSeedHash === F.sha256Hex(db._store['giveaway_fairness/S1'].serverSeed),
       'the public hash tracks the live seed');
  }

  console.log('\n== BLOCKER: a share-link draw cannot choose its own odds ==');
  {
    const { db } = fixture({ giveawaySubOnly: true });
    // What share.js now does — caller values are null and ignored.
    const out = await performDraw(db, A, 'S1', null, null, { fromProfile: true, requireActive: true });
    ok(out.ok, 'share-path draw succeeds');
    const p = db._store['streamers/S1/giveaway_draws/' + out.result.drawId];
    ok(p.rules.subOnly === true, "the streamer's Subs Only requirement is applied, not the caller's silence");
    ok(p.luck.sub === 3 && p.luck.code === 2, "the streamer's luck multipliers are applied");
    ok(!p.pool.some(x => x.key === 'bob'), 'the non-sub is excluded, as the streamer intended');

    // And an attacker passing their own weights gets ignored.
    const { db: db2 } = fixture({ giveawaySubOnly: true });
    const evil = await performDraw(db2, A, 'S1',
      O.sanitiseLuck({ sub: 5, code: 5, wager: 5 }), O.sanitiseRules({ subOnly: false }),
      { fromProfile: true, requireActive: true });
    const ep = db2._store['streamers/S1/giveaway_draws/' + evil.result.drawId];
    ok(ep.rules.subOnly === true && ep.luck.sub === 3,
       'caller-supplied luck and rules are discarded on the share path',
       JSON.stringify({ rules: ep.rules, luck: ep.luck }));
  }

  console.log('\n== share links cannot draw a finished giveaway ==');
  {
    const { db } = fixture({ giveawayActive: false });
    const out = await performDraw(db, A, 'S1', null, null, { fromProfile: true, requireActive: true });
    ok(!out.ok && out.code === 'not_active', 'refuses when no giveaway is running', JSON.stringify(out));
    const dash = await performDraw(db, A, 'S1', O.sanitiseLuck({}), O.sanitiseRules({}));
    ok(dash.ok, 'the dashboard can still draw a closed round (entries stay drawable)');
  }

  console.log('\n== a seed from a previous round is refused ==');
  {
    const { db } = fixture({}, { forGiveawayAt: 111 });   // commitment from an older giveaway
    const out = await performDraw(db, A, 'S1', O.sanitiseLuck({}), O.sanitiseRules({}));
    ok(!out.ok && out.code === 'stale_commitment', 'stale commitment refused', JSON.stringify(out));
  }

  console.log('\n== the dashboard path still honours its live sliders ==');
  {
    const { db } = fixture({ giveawaySubLuck: 1, giveawayCodeLuck: 1 });   // stale profile
    const out = await performDraw(db, A, 'S1', O.sanitiseLuck({ sub: 4, code: 1, wager: 1 }), O.sanitiseRules({}));
    const p = db._store['streamers/S1/giveaway_draws/' + out.result.drawId];
    ok(p.luck.sub === 4, 'live slider value wins for the dashboard, not the stored one');
    ok(p.pool.find(x => x.key === 'alice').tickets === 4, 'sub luck 4x gives the sub 4 tickets');
  }

  console.log('\n== eligibility collections are only read when a rule needs them ==');
  {
    const { db } = fixture();
    db._resetReads();
    await performDraw(db, A, 'S1', O.sanitiseLuck({}), O.sanitiseRules({}));
    const open = db._reads();
    const { db: db2 } = fixture();
    db2._resetReads();
    await performDraw(db2, A, 'S1', O.sanitiseLuck({}), O.sanitiseRules({ casino: true }));
    const gated = db2._reads();
    ok(open < gated, 'an open giveaway costs fewer reads than a gated one (' + open + ' vs ' + gated + ')');
  }

  console.log('\n== settingsFromProfile shape ==');
  {
    const s = settingsFromProfile({ giveawaySubLuck: 2, giveawayVerifiedCasino: true, giveawayVerifiedBoard: 'degen' });
    ok(s.luck.sub === 2 && s.luck.code === 1 && s.luck.wager === 1, 'missing luck values default to 1x');
    ok(s.rules.casino === true && s.rules.board === 'degen', 'casino requirement and board carry through');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
