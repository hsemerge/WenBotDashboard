// End-to-end exercise of the new server logic against a fake Firestore.
const F  = require('../netlify/functions/_lib/fairness');
const O  = require('../netlify/functions/_lib/giveaway-odds');
const SL = require('../netlify/functions/_lib/share-links');
const { performDraw } = require('../netlify/functions/_lib/giveaway-draw-core');

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ok   ' + label); }
                              else { fail++; console.log('  FAIL ' + label); } };

// ── A tiny in-memory Firestore ─────────────────────────────────────────────
function makeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed));   // path -> data
  const colDocs = (col) => Object.keys(store)
    .filter(k => k.startsWith(col + '/') && k.slice(col.length + 1).indexOf('/') === -1)
    .map(k => ({ id: k.split('/').pop(), data: () => store[k], ref: docRef(k) }));

  function docRef(p) {
    return {
      _p: p,
      get: async () => ({ exists: store[p] !== undefined, data: () => store[p], id: p.split('/').pop(), ref: docRef(p) }),
      set: async (v) => { store[p] = JSON.parse(JSON.stringify(v)); },
      update: async (v) => {
        store[p] = store[p] || {};
        for (const [k, val] of Object.entries(v)) {
          if (val && val.__inc !== undefined) {
            const cur = k.split('.').reduce((o, seg) => (o || {})[seg], store[p]) || 0;
            setDeep(store[p], k, cur + val.__inc);
          } else setDeep(store[p], k, val);
        }
      },
      collection: (c) => collRef(p + '/' + c),
    };
  }
  function setDeep(obj, dotted, val) {
    const segs = dotted.split('.');
    let o = obj;
    for (let i = 0; i < segs.length - 1; i++) { o[segs[i]] = o[segs[i]] || {}; o = o[segs[i]]; }
    o[segs[segs.length - 1]] = val;
  }
  function collRef(c) {
    const q = (filter) => ({
      get: async () => ({ docs: colDocs(c).filter(filter), size: colDocs(c).filter(filter).length }),
      where: (f, op, v) => q(d => filter(d) && d.data()[f] === v),
      limit: () => q(filter),
    });
    return Object.assign(q(() => true), { doc: (id) => docRef(c + '/' + id) });
  }
  return {
    collection: collRef,
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      update: (ref, v) => ref.update(v),
      set: (ref, v) => ref.set(v),
    }),
    _store: store,
  };
}
const fakeAdmin = { firestore: { FieldValue: { increment: (n) => ({ __inc: n }) } } };

// ── Fixture ────────────────────────────────────────────────────────────────
const seed = F.newServerSeed();
function fixture(extra) {
  return makeDb(Object.assign({
    'giveaway_fairness/S1': { serverSeed: seed, serverSeedHash: F.sha256Hex(seed), committedAt: 1000, drawNonce: 0 },
    'streamers/S1': { kickChannel: 'tiltbros', giveawayBlocked: ['banned1'], giveawayManualEntries: [{ kickKey: 'handadded', kickName: 'HandAdded' }] },
    'streamers/S1/giveaway_state/snapshot': { entries: [
      { kickKey: 'alice', kickName: 'Alice', isSub: true,  underCode: true,  wager: 3000 },
      { kickKey: 'bob',   kickName: 'Bob',   isSub: false, underCode: false, wager: 0 },
      { kickKey: 'banned1', kickName: 'Banned', isSub: false, underCode: false, wager: 0 },
      { kickKey: 'alice', kickName: 'AliceDupe', isSub: true, underCode: true, wager: 3000 },
    ] },
    'streamers/S1/verified_users/v1': { kickName: 'Alice', provider: 'degen', underAffiliate: true },
    'streamers/S1/discord_links/d1':  { kickUsername: 'Alice' },
  }, extra || {}));
}

(async () => {
  console.log('\n== performDraw: pool assembly ==');
  {
    const db = fixture();
    const out = await performDraw(db, fakeAdmin, 'S1', O.sanitiseLuck({}), O.sanitiseRules({}));
    ok(out.ok, 'draw succeeds');
    const proof = db._store['streamers/S1/giveaway_draws/' + out.result.drawId];
    const keys = proof.pool.map(p => p.key);
    ok(!keys.includes('banned1'), 'blocked entrant excluded from the pool');
    ok(keys.filter(k => k === 'alice').length === 1, 'duplicate key collapsed to one entry');
    ok(keys.includes('handadded'), 'hand-added entrant included');
    ok(keys[keys.length - 1] === 'handadded', 'hand-added entrant appended, not reordered');
    ok(F.verifyDraw(proof).ok, 'stored proof verifies');
  }

  console.log('\n== performDraw: rules + luck are honoured and published ==');
  {
    const db = fixture();
    const out = await performDraw(db, fakeAdmin, 'S1',
      O.sanitiseLuck({ sub: 3, code: 2, wager: 1 }),
      O.sanitiseRules({ casino: true }));
    ok(out.ok, 'draw with a casino requirement succeeds');
    const proof = db._store['streamers/S1/giveaway_draws/' + out.result.drawId];
    ok(proof.pool.length === 1 && proof.pool[0].key === 'alice', 'only the casino-verified entrant is in the pool');
    ok(proof.pool[0].tickets === 1 + 2 + 1, 'sub 3x + code 2x stack onto the base ticket');
    ok(out.result.excluded.some(e => e.key === 'bob' && /casino/.test(e.reason)), 'bob reported as excluded, with a reason');
    ok(proof.rules.casino === true && proof.luck.sub === 3, 'rules and luck are published in the proof');
  }

  console.log('\n== performDraw: nonce + re-roll ==');
  {
    const db = fixture();
    const a = await performDraw(db, fakeAdmin, 'S1', O.sanitiseLuck({}), O.sanitiseRules({}));
    const b = await performDraw(db, fakeAdmin, 'S1', O.sanitiseLuck({}), O.sanitiseRules({}));
    ok(a.result.nonce === 0 && b.result.nonce === 1, 'nonce increments per draw');
    ok(a.result.drawId !== b.result.drawId, 'each draw gets its own id');
    ok(db._store['giveaway_fairness/S1'].drawNonce === 2, 'nonce persisted');
    const p1 = db._store['streamers/S1/giveaway_draws/' + a.result.drawId];
    const p2 = db._store['streamers/S1/giveaway_draws/' + b.result.drawId];
    ok(F.verifyDraw(p1).ok && F.verifyDraw(p2).ok, 'both draws verify independently');
    // Was 're-roll reuses the same commitment'. That WAS the behaviour and it was
    // the vulnerability: draw #1 publishes its seed, so a shared seed let anyone
    // compute draw #2's winner for a pool they still controlled.
    ok(p1.serverSeedHash !== p2.serverSeedHash, 're-roll runs under its OWN commitment');
    ok(p1.nextSeedHash === p2.serverSeedHash, "draw #1 committed to draw #2's seed before it was used");
  }

  console.log('\n== performDraw: refusals ==');
  {
    const db = makeDb({ 'streamers/S1': {}, 'streamers/S1/giveaway_state/snapshot': { entries: [] } });
    const out = await performDraw(db, fakeAdmin, 'S1', O.sanitiseLuck({}), O.sanitiseRules({}));
    ok(!out.ok && out.code === 'no_commitment', 'refuses to draw with no commitment');
  }
  {
    const db = fixture();
    const out = await performDraw(db, fakeAdmin, 'S1', O.sanitiseLuck({}), O.sanitiseRules({ discord: true, casino: true, board: 'stake' }));
    ok(!out.ok && out.code === 'empty_pool', 'refuses when nobody qualifies');
  }

  console.log('\n== sanitisers reject junk ==');
  {
    const l = O.sanitiseLuck({ sub: 999, code: -4, wager: 'x' });
    ok(l.sub === 5 && l.code === 1 && l.wager === 1, 'luck clamped to 1..5');
    const r = O.sanitiseRules({ subOnly: 'yes', board: 'x'.repeat(200), bogus: true });
    ok(r.subOnly === true && r.board.length === 40 && r.bogus === undefined,
       'rules coerced, board truncated, unknown keys dropped');
  }

  console.log('\n== share links ==');
  {
    const t = SL.newToken();
    ok(t.length >= 30, 'token is long enough to not be guessable');
    ok(SL.hashToken(t) !== t && /^[0-9a-f]{64}$/.test(SL.hashToken(t)), 'stored id is a sha-256, not the token');
    ok(SL.scopeAllows('slotrequest', 'dismiss'), 'slot scope allows dismiss');
    ok(!SL.scopeAllows('slotrequest', 'draw'), 'slot scope CANNOT draw a giveaway');
    ok(!SL.scopeAllows('giveaway', 'dismiss'), 'giveaway scope cannot touch slot requests');
    ok(!SL.scopeAllows('bogus', 'draw'), 'unknown scope allows nothing');
    ok(SL.ttlHours(99999) === 24 * 7 && SL.ttlHours(0) === 12 && SL.ttlHours('x') === 12,
       'ttl clamped to a week, defaults to 12h');

    const db = makeDb({});
    const hash = SL.hashToken(t);
    db._store['share_links/' + hash] = { uid: 'S1', scope: 'giveaway', expiresAt: Date.now() + 3600e3, revoked: false };
    ok((await SL.resolveToken(db, t)).ok, 'a live token resolves');
    ok(!(await SL.resolveToken(db, t + 'x')).ok, 'a wrong token does not');
    db._store['share_links/' + hash].revoked = true;
    ok(!(await SL.resolveToken(db, t)).ok, 'a revoked token does not');
    db._store['share_links/' + hash].revoked = false;
    db._store['share_links/' + hash].expiresAt = Date.now() - 1;
    ok(!(await SL.resolveToken(db, t)).ok, 'an expired token does not');
    ok(!(await SL.resolveToken(db, '')).ok && !(await SL.resolveToken(db, null)).ok, 'empty/null rejected');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
