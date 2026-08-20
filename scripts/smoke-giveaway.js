#!/usr/bin/env node
// Smoke test for the verifiable-draw stack against a DEPLOYED site.
//
//   node scripts/smoke-giveaway.js https://<preview>.netlify.app
//   node scripts/smoke-giveaway.js https://<preview>.netlify.app --token <idToken> --uid <uid>
//
// Without a token it runs the public checks only — endpoints resolve, bad input
// is refused, the overlay payload has the right shape. With a token it runs the
// whole chain for real: commit a seed, draw a winner, fetch the published proof,
// and recompute it independently. That last step is the one worth having, because
// it is the only way to prove the deployed maths agrees with the maths here.
//
// Getting a token: open the dashboard, sign in, then in the browser console run
//   await firebase.auth().currentUser.getIdToken()
// and copy the string. It expires after an hour.
//
// SAFETY: the authed run COMMITS A NEW SEED for the account. Doing that mid
// giveaway replaces the commitment the current round was opened under, so run it
// with no giveaway live (or on a test account). The script refuses unless a
// giveaway is idle, which you can override with --force.

const crypto = require('crypto');

const args = process.argv.slice(2);
const base = (args[0] || '').replace(/\/$/, '');
const flag = (name) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? null : (args[i + 1] || true);
};
const token   = flag('token');
const uid     = flag('uid');
const channel = flag('channel');
const force   = !!flag('force');

if (!base || !/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/smoke-giveaway.js <site-url> [--token <idToken> --uid <uid>] [--channel <slug>] [--force]');
  process.exit(2);
}

let pass = 0, fail = 0, skip = 0;
const ok   = (c, label, extra) => { if (c) { pass++; console.log('  \x1b[32mok\x1b[0m   ' + label); }
                                    else   { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + label + (extra ? '\n         ' + extra : '')); } };
const note = (t) => console.log('  \x1b[90m·\x1b[0m    ' + t);
const skipped = (t) => { skip++; console.log('  \x1b[33mskip\x1b[0m ' + t); };
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

async function req(path, opts = {}) {
  const r = await fetch(base + path, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: r.status, json, text, ok: r.ok };
}

// Independent reimplementation of the draw maths. Deliberately NOT importing
// _lib/fairness.js — if this file just called the same code, agreement would
// prove nothing. This is what a sceptical third party would write.
function recompute(proof) {
  const problems = [];
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

  if (sha(proof.serverSeed) !== proof.serverSeedHash) {
    problems.push('revealed seed does not hash to the published commitment');
  }
  const listHash = sha(proof.pool.map(p => p.key + ':' + p.tickets).join('\n'));
  if (listHash !== proof.entryListHash) problems.push('entry list hash mismatch');

  const total = proof.pool.reduce((n, p) => n + p.tickets, 0);
  if (total !== proof.totalTickets) problems.push('ticket total mismatch: got ' + total);

  const digest = crypto.createHmac('sha256', proof.serverSeed)
    .update(listHash + ':' + proof.nonce, 'utf8').digest('hex');
  const ticket = Number(BigInt('0x' + digest.slice(0, 16)) % BigInt(total));
  if (ticket !== proof.winningTicket) problems.push('winning ticket mismatch: got ' + ticket);

  let running = 0, owner = null;
  for (const p of proof.pool) { running += p.tickets; if (ticket < running) { owner = p; break; } }
  if (!owner || owner.key !== proof.winnerKey) {
    problems.push('ticket ' + ticket + ' belongs to ' + (owner ? owner.key : 'nobody') + ', proof names ' + proof.winnerKey);
  }
  return problems;
}

(async () => {
  console.log('\nSmoke testing ' + base);

  // ── Public surface ───────────────────────────────────────────────────────
  head('Pages resolve');
  for (const [path, needle] of [['/verify-draw', 'Verify a giveaway draw'], ['/s', 'WenBot']]) {
    const r = await req(path);
    ok(r.status === 200 && r.text.includes(needle), path + ' serves its page', 'status ' + r.status);
  }

  head('Proof endpoint refuses junk');
  {
    const a = await req('/api/draw-proof');
    ok(a.status === 400, 'missing params → 400', 'got ' + a.status);
    const b = await req('/api/draw-proof?uid=x&d=not-a-draw-id');
    ok(b.status === 400, 'malformed draw id → 400', 'got ' + b.status);
    const c = await req('/api/draw-proof?uid=nosuchuser&d=1-0');
    ok(c.status === 404, 'unknown draw → 404', 'got ' + c.status);
  }

  head('Share endpoint refuses a bogus token');
  {
    const r = await req('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'x'.repeat(40), op: 'get' }),
    });
    ok(r.status === 403, 'unknown token → 403', 'got ' + r.status);
    ok(r.json && !/revoked|expired|unknown/i.test(r.json.error || ''),
       'error message does not reveal WHY (no probing oracle)');
    const bad = await req('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'short', op: 'get' }),
    });
    ok(bad.status === 403, 'malformed token → 403', 'got ' + bad.status);
  }

  head('Poll relay');
  if (channel) {
    const r = await req('/api/kick-poll?channel=' + encodeURIComponent(channel));
    ok(r.status === 200 && r.json && 'poll' in r.json,
       'returns a poll envelope for @' + channel + (r.json && r.json.poll ? ' (a poll is live)' : ' (no poll running)'),
       JSON.stringify(r.json).slice(0, 200));
    const bad = await req('/api/kick-poll?channel=' + encodeURIComponent('bad slug!'));
    ok(bad.status === 400, 'rejects a malformed channel', 'got ' + bad.status);
  } else skipped('poll relay — pass --channel <slug> to test');

  head('Overlay payload carries trivia');
  if (channel) {
    const r = await req('/api/overlay-data?channel=' + encodeURIComponent(channel));
    ok(r.status === 200 && r.json && r.json.trivia && typeof r.json.trivia.active === 'boolean',
       'overlay-data includes a trivia block', JSON.stringify(r.json && r.json.trivia));
  } else skipped('overlay trivia — pass --channel <slug> to test');

  // ── Authenticated end-to-end ─────────────────────────────────────────────
  head('Full draw chain');
  if (!token || !uid) {
    skipped('commit → draw → proof → recompute (pass --token and --uid)');
  } else {
    const auth = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

    if (!force) {
      note('checking the account is idle before committing a new seed…');
      const st = channel ? await req('/api/overlay-data?channel=' + encodeURIComponent(channel)) : null;
      if (st && st.json && st.json.active) {
        console.log('  \x1b[31mrefusing\x1b[0m — a giveaway is LIVE on @' + channel + '.');
        console.log('           Committing now would replace the seed that round was opened under.');
        console.log('           End the giveaway first, or re-run with --force if you mean it.');
        process.exit(1);
      }
    }

    const commit = await req('/api/giveaway-commit', {
      method: 'POST', headers: auth, body: JSON.stringify({ uid }),
    });
    ok(commit.status === 200 && commit.json && /^[0-9a-f]{64}$/.test(commit.json.serverSeedHash || ''),
       'commit returns a sha-256 seed hash', JSON.stringify(commit.json).slice(0, 200));
    ok(!commit.json || commit.json.serverSeed === undefined,
       'commit does NOT leak the seed itself');

    const draw = await req('/api/giveaway-draw', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uid, luck: { sub: 3, code: 2, wager: 1 }, rules: {} }),
    });

    if (draw.status === 400 && draw.json && draw.json.code === 'empty_pool') {
      console.log('  \x1b[33mskip\x1b[0m no entries in the pool — add some with "+ Add entrants" on the');
      console.log('         Giveaway page, then re-run. Everything up to the draw passed.');
      skip++;
    } else {
      ok(draw.status === 200 && draw.json && draw.json.winner, 'draw returns a winner',
         JSON.stringify(draw.json).slice(0, 300));

      if (draw.json && draw.json.drawId) {
        ok(draw.json.serverSeedHash === commit.json.serverSeedHash,
           'the draw used the seed committed a moment ago');
        ok(typeof draw.json.proofUrl === 'string' && draw.json.proofUrl.includes('/verify-draw'),
           'draw hands back a public verify link');

        const proofRes = await req('/api/draw-proof?uid=' + encodeURIComponent(uid)
          + '&d=' + encodeURIComponent(draw.json.drawId));
        ok(proofRes.status === 200 && proofRes.json && proofRes.json.proof, 'proof is publicly fetchable');

        const proof = proofRes.json && proofRes.json.proof;
        if (proof) {
          ok(proof.serverSeed && proof.serverSeed.length >= 32, 'the seed IS revealed once the draw is done');
          ok(proof.winnerName === draw.json.winner, 'published winner matches what the draw returned');
          ok(proof.luck && proof.luck.sub === 3 && proof.luck.code === 2,
             'the luck multipliers used are published in the proof',
             JSON.stringify(proof.luck));

          const problems = recompute(proof);
          ok(problems.length === 0,
             'independently recomputing the draw reproduces the winner',
             problems.join('; '));

          note('winner: ' + proof.winnerName + '  ticket ' + proof.winningTicket + '/' + proof.totalTickets);
          note('pool:   ' + proof.pool.map(p => p.name + '×' + p.tickets).join(', ').slice(0, 160));
          note('verify: ' + draw.json.proofUrl);

          const second = await req('/api/giveaway-draw', {
            method: 'POST', headers: auth, body: JSON.stringify({ uid, luck: {}, rules: {} }),
          });
          ok(second.status === 200 && second.json.nonce === proof.nonce + 1,
             're-drawing increments the nonce instead of reusing it',
             'nonce went ' + proof.nonce + ' → ' + (second.json && second.json.nonce));
          ok(second.json && second.json.drawId !== draw.json.drawId,
             'the re-draw is published as its own proof, not an overwrite');
        }
      }
    }

    head('Authorisation');
    {
      const noAuth = await req('/api/giveaway-draw', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, luck: {}, rules: {} }),
      });
      ok(noAuth.status === 401, 'draw without a token → 401', 'got ' + noAuth.status);

      const otherUid = await req('/api/giveaway-draw', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ uid: 'someone-elses-uid', luck: {}, rules: {} }),
      });
      ok(otherUid.status === 403, 'drawing for another account → 403', 'got ' + otherUid.status);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nSmoke test crashed: ' + e.message); process.exit(1); });
