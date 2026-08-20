// Ticket weighting and entry eligibility for giveaways.
//
// This lives in a shared module because the DRAW is now server-side and its
// result is published as a verifiable proof. If the server weighted tickets even
// slightly differently from what the dashboard showed the streamer, the proof
// would be honest but useless — the published pool would not be the pool anyone
// watched fill up. Browser copy: /js/giveaway-odds.js. Keep them identical.

// How many tickets one entry holds under the given luck multipliers.
function ticketsFor(e, luck) {
  // Pre-flag snapshots (entries collected before the bot sent isSub/underCode)
  // → trust the bot's already-correct precomputed tickets, so weighting still
  // works for an in-flight giveaway that spanned the update.
  if (e.isSub === undefined && e.underCode === undefined) return e.tickets || 1;
  // Multi-buy point entries: each purchased entry is a base ticket.
  const base = Math.max(1, e.paidEntries || 1);
  let extra = 0;
  if (luck.wager > 1 && e.wager > 0) extra += Math.min(Math.floor(e.wager / 1000), luck.wager - 1);
  if (luck.sub   > 1 && e.isSub)     extra += (luck.sub - 1);
  if (luck.code  > 1 && e.underCode) extra += (luck.code - 1);
  return base + extra;
}

/**
 * Why an entry does not qualify under the current rules, or null if it does.
 *
 * @param {object} e      entry
 * @param {object} rules  { subOnly, casino, discord, board }
 * @param {object} sets   { casino: Set, discord: Set, boards: {key: string[]} }
 */
function ineligibleReason(e, rules, sets) {
  const key = String(e.kickKey || e.username || e.kickName || "").toLowerCase();
  // isSub === undefined means a snapshot written before the bot sent sub flags.
  // Unknown is not the same as "not a sub" — never strike someone out on data
  // we simply do not have.
  if (rules.subOnly && e.isSub === false) return "not a subscriber";
  if (rules.casino) {
    // "none" is a Kick-only verification with no casino account attached, which
    // does not satisfy a casino requirement.
    const boards = (sets.boards[key] || []).filter(p => p !== "none");
    if (!sets.casino.has(key) || !boards.length) return "not casino verified";
    if (rules.board && !boards.includes(rules.board)) return "not verified on " + rules.board;
  }
  if (rules.discord && !sets.discord.has(key)) return "no Discord linked";
  return null;
}

function anyRuleActive(rules) {
  return !!(rules && (rules.subOnly || rules.casino || rules.discord));
}

// Normalise whatever the client sent into the shape the maths expects. The
// client picks the rules, but it does not get to invent fields.
function sanitiseLuck(raw) {
  const clamp = v => Math.min(5, Math.max(1, parseInt(v, 10) || 1));
  return { sub: clamp(raw?.sub), code: clamp(raw?.code), wager: clamp(raw?.wager) };
}

function sanitiseRules(raw) {
  return {
    subOnly: !!raw?.subOnly,
    casino:  !!raw?.casino,
    discord: !!raw?.discord,
    board:   typeof raw?.board === "string" ? raw.board.slice(0, 40) : "",
  };
}

/**
 * Build the ordered ticket pool a draw runs on.
 * Order is insertion order of the snapshot — stable, and what the participants
 * list shows — so the published list is reproducible.
 *
 * @returns {{ pool: Array<{key,name,tickets}>, totalTickets: number, excluded: Array }}
 */
function buildPool(entries, luck, rules, sets) {
  const pool = [];
  const excluded = [];
  let totalTickets = 0;
  for (const e of entries) {
    const key  = String(e.kickKey || e.kickName || e.username || "").toLowerCase();
    if (!key) continue;
    const name = e.kickName || e.username || key;
    const why  = anyRuleActive(rules) ? ineligibleReason(e, rules, sets) : null;
    if (why) { excluded.push({ key, name, reason: why }); continue; }
    const tickets = Math.max(1, ticketsFor(e, luck));
    pool.push({ key, name, tickets });
    totalTickets += tickets;
  }
  return { pool, totalTickets, excluded };
}

module.exports = {
  ticketsFor, ineligibleReason, anyRuleActive,
  sanitiseLuck, sanitiseRules, buildPool,
};
