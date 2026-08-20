// Attack the "re-run it yourself" snippet with pool keys a malicious streamer
// could have published through hand-added entrants.
const fs = require('fs'), vm = require('vm'), cp = require('child_process'), path = require('path');
const ROOT = require('path').join(__dirname, '..') + '/';
const F = require(ROOT + 'netlify/functions/_lib/fairness');

const HERE   = require('os').tmpdir();
// POSIX-shaped so `sh -c` can genuinely create it. With a Windows path the
// injected `touch` fails for the wrong reason and the test passes vacuously.
const MARKER = 'WENBOT_INJECTION_MARKER';
const CANARY = path.join(HERE, 'PWNED');
try { fs.unlinkSync(CANARY); } catch (e) {}

// Every one of these was capable of either executing or breaking the old
// shell-based snippet.
const pool = [
  { key: 'normaluser',                       name: 'normaluser', tickets: 1 },
  { key: 'x$(touch ' + CANARY + ')',         name: 'cmdsub',     tickets: 1 },
  { key: 'y`touch ' + CANARY + '`',          name: 'backtick',   tickets: 1 },
  { key: "o'neill",                          name: "o'neill",    tickets: 1 },
  { key: 'has"doublequote',                  name: 'dq',         tickets: 1 },
  { key: 'back\\slash',                      name: 'bs',         tickets: 1 },
  { key: 'new\nline',                        name: 'nl',         tickets: 1 },
];
const total = pool.reduce((n, p) => n + p.tickets, 0);
const seed  = F.newServerSeed();
const lh    = F.entryListHash(pool);
const nonce = 0;
const { ticket } = F.drawTicket(seed, lh, nonce, total);
const proof = {
  pool, nonce, serverSeed: seed, serverSeedHash: F.sha256Hex(seed),
  entryListHash: lh, winningTicket: ticket, totalTickets: total,
  winnerKey: F.ownerOfTicket(pool, ticket).key,
};

// Pull renderRerun verbatim out of the shipped page.
const html = fs.readFileSync(ROOT + 'verify-draw.html', 'utf8');
const src  = html.slice(html.indexOf('function renderRerun'), html.indexOf('function copyRerun'));
const els  = { rerunInputs: {}, rerunCmd: {}, rerunCard: { style: {} } };
const g = { document: { getElementById: (id) => els[id] }, esc: String, JSON, BigInt, Number, String };
g.$ = (id) => els[id];
vm.createContext(g);
vm.runInContext('const $=globalThis.$; const esc=globalThis.esc;' + src + ';globalThis.__r=renderRerun;', g);
g.__r(proof);

const snippet = els.rerunCmd.textContent;
const file = path.join(HERE, 'verify.js');
fs.writeFileSync(file, snippet);

console.log('--- generated snippet ---');
console.log(snippet);
console.log('--- running it ---');
let out = '';
try {
  out = cp.execFileSync(process.execPath, [file], { encoding: 'utf8' });
  console.log(out.trim());
} catch (e) {
  console.log('SNIPPET FAILED TO RUN: ' + e.message);
}

console.log();
const pwned = fs.existsSync(CANARY);
const checks = [
  ['snippet is NOT a shell command', !/^node -e/.test(snippet)],
  ['payload did not execute',        !pwned],
  ['reproduces the seed hash',       out.includes(proof.serverSeedHash)],
  ['reproduces the entry list hash', out.includes(lh)],
  ['reproduces the winning ticket',  new RegExp('ticket\\s+' + ticket + '\\b').test(out)],
];
let bad = 0;
for (const [label, okv] of checks) { if (!okv) bad++; console.log('  ' + (okv ? 'ok  ' : '*** FAIL ***') + ' ' + label); }

// Belt and braces: the old form was dangerous only because it was pasted into a
// shell. Prove that even if someone pipes this file to sh, nothing detonates —
// it should simply be a syntax error, not an execution.
// The payload announces itself on stderr rather than touching a file: Git
// Bash's /tmp is not Node's /tmp, so a file canary silently never fires on
// Windows and the test passes for the wrong reason. sh will of course choke on
// JavaScript — what matters is whether it EXECUTED anything on the way.
const probePool = [{ key: 'x$(echo ' + MARKER + ' >&2)', name: 'p', tickets: 1 },
                   { key: 'y`echo ' + MARKER + ' >&2`',  name: 'q', tickets: 1 }];
const probe = Object.assign({}, proof, { pool: probePool, totalTickets: 2 });
g.__r(probe);
const probeText = els.rerunCmd.textContent;
let shOut = '';
try {
  shOut = cp.execFileSync('sh', ['-c', probeText], { encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  shOut = String(e.stdout || '') + String(e.stderr || '');
}
const pwnedViaSh = shOut.includes(MARKER);
console.log('  ' + (pwnedViaSh ? '*** FAIL ***' : 'ok  ') + ' nothing executes even if the snippet is pasted into a shell');
if (pwnedViaSh) bad++;

console.log('\n' + (bad ? bad + ' FAILURES' : 'all clear'));
process.exit(bad ? 1 : 0);
