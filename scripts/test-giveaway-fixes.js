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
    batch: () => {
      const ops = [];
      return {
        set:    (ref, v) => { ops.push(() => ref.set(v)); },
        update: (ref, v) => { ops.push(() => ref.update(v)); },
        // One commit = one "round trip"; count it as a single read so the
        // read-cost assertion reflects the batching.
        commit: async () => { reads++; for (const op of ops) await op(); },
      };
    },
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

  console.log('\n== short verify codes ==');
  {
    const { newDrawCode } = require('../netlify/functions/_lib/fairness');
    const seen = new Set();
    for (let i = 0; i < 20000; i++) seen.add(newDrawCode());
    ok(seen.size === 20000, '20000 codes, no collisions');
    const all = [...seen].join('');
    ok(!/[01ilo]/.test(all), 'no 0/1/i/l/o — readable off a stream and typeable on a phone');
    ok([...seen].every(c => c.length === 8), 'every code is 8 characters');
    ok(('wenbot.gg/v/' + [...seen][0]).length === 20, 'the chat link is 20 characters, not 80');
  }

  console.log('\n== the winner chat message ==');
  {
    const fs = require('fs'), vm = require('vm');
    // Pulled out of the page so the test exercises the shipped function rather
    // than a copy that can drift away from it.
    const html = fs.readFileSync(__dirname + '/../dashboard.html', 'utf8');
    const src  = html.slice(html.indexOf('function gwBuildWinMessage'),
                            html.indexOf('// Queue the verify link'));
    const g = {}; vm.createContext(g);
    vm.runInContext('let profile=null;' + src + ';globalThis.__b=gwBuildWinMessage;globalThis.__set=p=>{profile=p};', g);
    const build = g.__b, setP = g.__set;
    const URL = 'https://wenbot.gg/v/a7k2m9x4';

    setP({});
    let m = build('luckyviewer', URL);
    ok(m.includes('@luckyviewer') && m.includes('wenbot.gg/v/a7k2m9x4'),
       'default message carries the winner and the link', m);
    ok(m.includes('https://wenbot.gg/v/a7k2m9x4'), 'scheme kept so the link is clickable in chat');

    setP({ giveawayPostVerifyLink: false });
    ok(!build('luckyviewer', URL).includes('wenbot.gg'), 'toggle off suppresses the automatic link');

    setP({ gwWinMessage: '{winner} won! proof: {verify} gg', giveawayPostVerifyLink: false });
    ok(build('luckyviewer', URL).includes('wenbot.gg/v/a7k2m9x4'),
       'an explicit {verify} beats the toggle — placing it IS asking for it');

    setP({ gwWinMessage: '{winner} won! proof: {verify} gg' });
    ok(build('luckyviewer', null) === '@luckyviewer won! gg',
       'with no link, the placeholder AND its stranded label are removed',
       build('luckyviewer', null));

    setP({ gwWinMessage: 'GG {winner} you scooped it' });
    ok(/it · Verify/.test(build('luckyviewer', URL)),
       'a message ending mid-sentence gets a separator, not a run-on', build('luckyviewer', URL));

    setP({ gwWinMessage: '{winner} takes it!' });
    ok(/it! Verify/.test(build('luckyviewer', URL)),
       'a message already ending in punctuation gets no extra separator');

    setP({ gwWinMessage: 'x'.repeat(390) });
    ok(build('luckyviewer', URL).length <= 400, 'output is capped so chat cannot reject it');
  }

  console.log('\n== the "re-run it yourself" snippet — hermetic checks ==');
  {
    const fs = require('fs'), vm = require('vm');
    const F  = require('../netlify/functions/_lib/fairness');
    const O2 = require('../netlify/functions/_lib/giveaway-odds');
    const { pool, totalTickets } = O2.buildPool(
      // Every character a shell could act on, in a name that also has to survive
      // JSON: quotes, backslash, $, backtick, and an apostrophe.
      [{ kickKey: 'x$(id)`whoami`', kickName: 'a', isSub: true, underCode: true, wager: 0 },
       { kickKey: "o'neil\"\\bob", kickName: 'b', isSub: false, underCode: false, wager: 0 }],
      O2.sanitiseLuck({ sub: 2 }), O2.sanitiseRules({}),
      { casino: new Set(), discord: new Set(), boards: {} });
    const seed = F.newServerSeed(), lh = F.entryListHash(pool), nonce = 2;
    const { ticket } = F.drawTicket(seed, lh, nonce, totalTickets);
    const proof = { pool, nonce, serverSeed: seed, serverSeedHash: F.sha256Hex(seed),
                    entryListHash: lh, winningTicket: ticket, totalTickets,
                    winnerKey: F.ownerOfTicket(pool, ticket).key };

    const html = fs.readFileSync(__dirname + '/../verify-draw.html', 'utf8');
    const src  = html.slice(html.indexOf('function renderRerun'), html.indexOf('function copyRerun'));
    const els  = { rerunInputs: {}, rerunCmd: {}, rerunCard: { style: {} } };
    const g = { document: { getElementById: (id) => els[id] }, esc: String };
    g.$ = (id) => els[id];
    vm.createContext(g);
    vm.runInContext('const $=globalThis.$; const esc=globalThis.esc;' + src + ';globalThis.__r=renderRerun;', g);
    g.__r(proof);
    const snippet = els.rerunCmd.textContent;

    // No subprocess. The snippet is a plain JS file the reader saves and runs;
    // whether it reproduces the draw is a property of the STRING, so evaluate it
    // in a vm and read the numbers back. Hermetic — no shell, no temp file, no
    // dependence on how the host prints a number, which is the class of thing
    // that made the subprocess version fail on the build host but nowhere here.
    const logs = [];
    const sandbox = { require, console: { log: (...a) => logs.push(a.join(' ')) }, BigInt, Number, String };
    vm.createContext(sandbox);
    vm.runInContext(snippet, sandbox);
    const line = (label) => { const l = logs.find(x => x.startsWith(label)); return l ? l.slice(label.length).trim() : null; };

    ok(line('seed hash') === proof.serverSeedHash, 'the snippet reproduces the published seed hash',
       'got ' + line('seed hash') + ' want ' + proof.serverSeedHash);
    ok(line('list hash') === lh, 'the snippet reproduces the entry list hash',
       'got ' + line('list hash') + ' want ' + lh);
    ok(line('ticket') === String(ticket), 'the snippet reproduces the winning ticket',
       'got ' + line('ticket') + ' want ' + ticket + '\n         snippet:\n' + snippet);

    // The security property, asserted on the TEXT directly: no character a shell
    // acts on may appear outside a \uXXXX escape. Stronger than executing it,
    // because it holds regardless of which shell a reader pastes it into. $ and
    // backtick are the shell's command-substitution triggers; neither appears
    // anywhere in the snippet template, and jsStr escapes them to \uXXXX inside
    // the data. So after stripping the \uXXXX escapes, neither may remain —
    // whatever a pool key contained.
    const bare = snippet.replace(/\\u[0-9a-f]{4}/g, '');
    ok(!bare.includes('$'), 'no un-escaped $ survives into the snippet', bare.slice(0, 300));
    ok(!bare.includes('`'), 'no un-escaped backtick survives into the snippet', bare.slice(0, 300));
  }


  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
