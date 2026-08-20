#!/usr/bin/env node
// Execution tests for the "re-run it yourself" snippet.
//
// These are deliberately NOT part of `npm test`, which gates the deploy. They
// spawn subprocesses and touch the temp directory, so they depend on the host in
// ways a deploy gate should not: a failure here can mean the host behaved
// differently rather than the code being wrong, and a deploy gate that can fail
// for reasons unrelated to the change is a gate that gets switched off.
//
// The property that actually matters — that nothing shell-active survives into
// the snippet — is asserted directly and hermetically in test-verify-snippet.js.
// This file is the belt to that braces: run it locally with `npm run test:exec`.

const fs = require('fs'), vm = require('vm'), cp = require('child_process');
const os = require('os'), path = require('path');
const F  = require('../netlify/functions/_lib/fairness');
const O  = require('../netlify/functions/_lib/giveaway-odds');

let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ok   ' + label); }
                                  else { fail++; console.log('  FAIL ' + label + (extra ? '\n         ' + extra : '')); } };

// Build renderRerun out of the shipped page so this exercises what users get.
function renderer() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'verify-draw.html'), 'utf8');
  const src  = html.slice(html.indexOf('function renderRerun'), html.indexOf('function copyRerun'));
  const els  = { rerunInputs: {}, rerunCmd: {}, rerunCard: { style: {} } };
  const g = { document: { getElementById: (id) => els[id] }, esc: String };
  g.$ = (id) => els[id];
  vm.createContext(g);
  vm.runInContext('const $=globalThis.$; const esc=globalThis.esc;' + src + ';globalThis.__r=renderRerun;', g);
  return (proof) => { g.__r(proof); return els.rerunCmd.textContent; };
}

function makeProof(poolSpec, nonce) {
  const { pool, totalTickets } = O.buildPool(poolSpec, O.sanitiseLuck({ sub: 2 }), O.sanitiseRules({}),
    { casino: new Set(), discord: new Set(), boards: {} });
  const seed = F.newServerSeed(), lh = F.entryListHash(pool);
  const { ticket } = F.drawTicket(seed, lh, nonce, totalTickets);
  return { proof: { pool, nonce, serverSeed: seed, serverSeedHash: F.sha256Hex(seed),
                    entryListHash: lh, winningTicket: ticket, totalTickets,
                    winnerKey: F.ownerOfTicket(pool, ticket).key }, lh, ticket, totalTickets };
}

const render = renderer();

console.log('\n== the snippet runs and reproduces the draw ==');
{
  const { proof, lh, ticket, totalTickets } = makeProof(
    [{ kickKey: 'alice', kickName: 'Alice', isSub: true,  underCode: true,  wager: 0 },
     { kickKey: 'bob',   kickName: 'Bob',   isSub: false, underCode: false, wager: 0 }], 2);
  const snippet = render(proof);
  const tmp = path.join(os.tmpdir(), 'wenbot-rerun-' + process.pid + '.js');
  fs.writeFileSync(tmp, snippet);
  let out = '';
  try { out = cp.execFileSync(process.execPath, [tmp], { encoding: 'utf8' }); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }

  const val = (label) => {
    const line = out.split(/\r?\n/).find(l => l.startsWith(label));
    return line ? line.slice(label.length).trim() : null;
  };
  const dump = 'expected seed=' + proof.serverSeedHash + ' list=' + lh
    + ' nonce=' + proof.nonce + ' total=' + totalTickets + ' ticket=' + ticket
    + '\n         got      seed=' + val('seed hash') + ' list=' + val('list hash') + ' ticket=' + val('ticket')
    + '\n         raw: ' + JSON.stringify(out)
    + '\n         snippet:\n' + snippet.split('\n').map(l => '           ' + l).join('\n');

  ok(val('seed hash') === proof.serverSeedHash, 'reproduces the published seed hash', dump);
  ok(val('list hash') === lh,                   'reproduces the entry list hash', dump);
  ok(val('ticket')    === String(ticket),       'reproduces the winning ticket', dump);
}

console.log('\n== a hostile pool key cannot execute, even pasted into a shell ==');
{
  const MARKER = 'WENBOT_INJECTION_MARKER';
  const { proof } = makeProof(
    [{ kickKey: 'x$(echo ' + MARKER + ' >&2)', kickName: 'a', isSub: false, underCode: false, wager: 0 },
     { kickKey: 'y`echo ' + MARKER + ' >&2`',  kickName: 'b', isSub: false, underCode: false, wager: 0 }], 0);
  const snippet = render(proof);

  // Combined stdout+stderr regardless of exit — the probe writes to stderr and
  // the snippet makes sh exit non-zero, so reading only one stream on only one
  // path (the bug that made an earlier version of this pass vacuously) would
  // miss the very thing being tested.
  const runSh = (text) => {
    try { return cp.execFileSync('sh', ['-c', text], { encoding: 'utf8', stdio: 'pipe' }) || ''; }
    catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
  };

  // Sanity-check the probe itself: unescaped text of the same shape MUST trip
  // it, or a pass below would mean nothing.
  ok(runSh('echo pre$(echo ' + MARKER + ')post').includes(MARKER),
     'the probe fires against unescaped text (otherwise this test proves nothing)');

  ok(!runSh(snippet).includes(MARKER),
     'nothing executes when the snippet is pasted into a shell', runSh(snippet).slice(0, 300));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
