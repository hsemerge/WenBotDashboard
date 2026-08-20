// Browser reimplementation of the draw maths, for the public verifier page.
// Server copy: netlify/functions/_lib/fairness.js. These MUST agree byte for
// byte — the whole point is that a stranger can recompute our result without
// trusting our code, so the page recomputes locally rather than asking us.
//
// Uses SubtleCrypto, which needs a secure context; wenbot.gg is HTTPS-only.

async function fvSha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fvHmacSha256Hex(keyStr, msgStr) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msgStr));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Frozen format — one "key:tickets" pair per entry, pool order, newline joined.
function fvCanonicalEntryList(pool) {
  return pool.map(p => `${p.key}:${p.tickets}`).join('\n');
}

function fvOwnerOfTicket(pool, ticket) {
  let running = 0;
  for (const p of pool) {
    running += p.tickets;
    if (ticket < running) return p;
  }
  return pool[pool.length - 1];
}

/**
 * Recompute a proof from first principles.
 * @returns {Promise<{ok:boolean, checks:Array<{label:string, ok:boolean, detail:string}>}>}
 */
async function fvVerify(proof) {
  const checks = [];
  const pool = Array.isArray(proof.pool) ? proof.pool : [];

  const seedHash = await fvSha256Hex(proof.serverSeed);
  checks.push({
    label:  'The revealed seed matches the hash published before entries opened',
    ok:     seedHash === proof.serverSeedHash,
    detail: `SHA-256(seed) = ${seedHash}`,
  });

  const listHash = await fvSha256Hex(fvCanonicalEntryList(pool));
  checks.push({
    label:  'The entry list matches the hash recorded at draw time',
    ok:     listHash === proof.entryListHash,
    detail: `SHA-256(list of ${pool.length}) = ${listHash}`,
  });

  const total = pool.reduce((n, p) => n + (p.tickets || 0), 0);
  checks.push({
    label:  'Ticket total adds up',
    ok:     total === proof.totalTickets,
    detail: `${pool.length} entries hold ${total} tickets`,
  });

  const digest = await fvHmacSha256Hex(proof.serverSeed, `${listHash}:${proof.nonce}`);
  // Mirrors the server: first 64 bits of the digest, modulo the ticket count.
  const ticket = total > 0 ? Number(BigInt('0x' + digest.slice(0, 16)) % BigInt(total)) : -1;
  checks.push({
    label:  'The winning ticket is the one this seed produces',
    ok:     ticket === proof.winningTicket,
    detail: `HMAC-SHA256(seed, "${listHash.slice(0, 12)}…:${proof.nonce}") → ticket ${ticket}`,
  });

  const owner = pool.length ? fvOwnerOfTicket(pool, ticket) : null;
  checks.push({
    label:  'That ticket belongs to the announced winner',
    ok:     !!owner && owner.key === proof.winnerKey,
    detail: owner ? `Ticket ${ticket} → ${owner.name}` : 'No entries in the proof',
  });

  return { ok: checks.every(c => c.ok), checks };
}
