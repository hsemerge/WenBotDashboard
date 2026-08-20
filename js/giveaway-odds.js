// Ticket weighting and entry eligibility — browser copy.
// Loaded via <script src="/js/giveaway-odds.js">; defines gwTicketsFor and
// gwIneligibleReasonFor as globals.
//
// The DRAW itself happens server-side now (it has to, so the result can be
// published as a verifiable proof). This copy exists so the participants list
// and the live ticket counts the streamer watches match, entry for entry, the
// pool the server will actually draw from. Server copy:
// netlify/functions/_lib/giveaway-odds.js — keep them identical.

function gwTicketsFor(e, luck) {
  // Pre-flag snapshots (entries collected before the bot sent isSub/underCode)
  // → trust the bot's already-correct precomputed tickets.
  if (e.isSub === undefined && e.underCode === undefined) return e.tickets || 1;
  const base = Math.max(1, e.paidEntries || 1);
  let extra = 0;
  if (luck.wager > 1 && e.wager > 0) extra += Math.min(Math.floor(e.wager / 1000), luck.wager - 1);
  if (luck.sub   > 1 && e.isSub)     extra += (luck.sub - 1);
  if (luck.code  > 1 && e.underCode) extra += (luck.code - 1);
  return base + extra;
}

function gwIneligibleReasonFor(e, rules, sets) {
  const key = String(e.kickKey || e.username || '').toLowerCase();
  if (rules.subOnly && e.isSub === false) return 'not a subscriber';
  if (rules.casino) {
    const boards = (sets.boards[key] || []).filter(p => p !== 'none');
    if (!sets.casino.has(key) || !boards.length) return 'not casino verified';
    if (rules.board && !boards.includes(rules.board)) return 'not verified on ' + rules.board;
  }
  if (rules.discord && !sets.discord.has(key)) return 'no Discord linked';
  return null;
}
