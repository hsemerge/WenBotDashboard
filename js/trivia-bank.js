// Built-in trivia questions, so a streamer can start a round without writing
// anything first. Loaded via <script src="/js/trivia-bank.js">; defines
// TRIVIA_BANK and the answer-matching helpers as globals.
//
// Every question carries `alts` — the other spellings chat will actually type.
// Without them the game is a spelling test, and the first person to type the
// right answer the wrong way feels robbed. Add generously.

const TRIVIA_BANK = [
  // ── Slots & casino ───────────────────────────────────────────────────────
  { cat: 'slots', diff: 'easy',   q: 'What does RTP stand for?', a: 'return to player', alts: ['returntoplayer', 'return-to-player'] },
  { cat: 'slots', diff: 'easy',   q: 'In slots, what is the term for a winning combination line?', a: 'payline', alts: ['pay line', 'paylines', 'line'] },
  { cat: 'slots', diff: 'medium', q: 'What does a slot’s "volatility" describe?', a: 'risk', alts: ['variance', 'how risky it is', 'risk level'] },
  { cat: 'slots', diff: 'medium', q: 'What is the term for a jackpot that grows until someone wins it?', a: 'progressive', alts: ['progressive jackpot'] },
  { cat: 'slots', diff: 'easy',   q: 'What symbol substitutes for others to complete a win?', a: 'wild', alts: ['wild symbol', 'wilds'] },
  { cat: 'slots', diff: 'easy',   q: 'Which symbol usually triggers free spins?', a: 'scatter', alts: ['scatters', 'scatter symbol'] },
  { cat: 'slots', diff: 'hard',   q: 'A win expressed as a multiple of your stake is measured in what?', a: 'x', alts: ['multiplier', 'multi', 'times', 'multiples'] },

  // ── Gaming ───────────────────────────────────────────────────────────────
  { cat: 'gaming', diff: 'easy',   q: 'What is the best-selling video game of all time?', a: 'minecraft' },
  { cat: 'gaming', diff: 'easy',   q: 'Which company makes the PlayStation?', a: 'sony' },
  { cat: 'gaming', diff: 'easy',   q: 'What colour is Sonic the Hedgehog?', a: 'blue' },
  { cat: 'gaming', diff: 'medium', q: 'In Among Us, what is the non-crewmate role called?', a: 'impostor', alts: ['imposter'] },
  { cat: 'gaming', diff: 'medium', q: 'Which game popularised the term "battle royale" in 2017?', a: 'fortnite', alts: ['pubg', 'playerunknowns battlegrounds'] },
  { cat: 'gaming', diff: 'medium', q: 'What is the name of the princess Mario usually rescues?', a: 'peach', alts: ['princess peach'] },
  { cat: 'gaming', diff: 'hard',   q: 'What year was the original Half-Life released?', a: '1998' },
  { cat: 'gaming', diff: 'hard',   q: 'Which studio developed Elden Ring?', a: 'fromsoftware', alts: ['from software'] },

  // ── General knowledge ────────────────────────────────────────────────────
  { cat: 'general', diff: 'easy',   q: 'How many continents are there?', a: '7', alts: ['seven'] },
  { cat: 'general', diff: 'easy',   q: 'What is the capital of Japan?', a: 'tokyo' },
  { cat: 'general', diff: 'easy',   q: 'How many sides does a hexagon have?', a: '6', alts: ['six'] },
  { cat: 'general', diff: 'easy',   q: 'What is the largest ocean on Earth?', a: 'pacific', alts: ['pacific ocean', 'the pacific'] },
  { cat: 'general', diff: 'medium', q: 'What is the chemical symbol for gold?', a: 'au' },
  { cat: 'general', diff: 'medium', q: 'How many bones are in the adult human body?', a: '206', alts: ['two hundred and six'] },
  { cat: 'general', diff: 'medium', q: 'Which planet is known as the Red Planet?', a: 'mars' },
  { cat: 'general', diff: 'hard',   q: 'What is the smallest country in the world by area?', a: 'vatican city', alts: ['vatican', 'the vatican'] },
  { cat: 'general', diff: 'hard',   q: 'In what year did the Berlin Wall fall?', a: '1989' },

  // ── Maths (fast, and impossible to argue with) ───────────────────────────
  { cat: 'maths', diff: 'easy',   q: 'What is 12 x 12?', a: '144' },
  { cat: 'maths', diff: 'easy',   q: 'What is 25% of 200?', a: '50', alts: ['fifty'] },
  { cat: 'maths', diff: 'medium', q: 'What is 15% of 240?', a: '36', alts: ['thirty six'] },
  { cat: 'maths', diff: 'medium', q: 'A $2 bet pays 350x. What does it pay?', a: '700', alts: ['$700', '700$'] },
  { cat: 'maths', diff: 'hard',   q: 'What is the square root of 1369?', a: '37', alts: ['thirty seven'] },
  { cat: 'maths', diff: 'hard',   q: 'A $0.40 bet returns $1,000. What multiplier is that?', a: '2500', alts: ['2500x', '2,500', '2,500x'] },

  // ── Music & film ─────────────────────────────────────────────────────────
  { cat: 'music', diff: 'easy',   q: 'How many strings does a standard guitar have?', a: '6', alts: ['six'] },
  { cat: 'music', diff: 'medium', q: 'Which band released "Bohemian Rhapsody"?', a: 'queen' },
  { cat: 'music', diff: 'hard',   q: 'How many keys are on a standard full-size piano?', a: '88', alts: ['eighty eight'] },
  { cat: 'film',  diff: 'easy',   q: 'Who plays Iron Man in the Marvel films?', a: 'robert downey jr', alts: ['robert downey junior', 'rdj', 'robert downey'] },
  { cat: 'film',  diff: 'medium', q: 'What is the highest-grossing film of all time?', a: 'avatar' },
  { cat: 'film',  diff: 'hard',   q: 'Which film won Best Picture at the 2020 Oscars?', a: 'parasite' },
];

const TRIVIA_CATEGORIES = [
  { id: '',        label: 'Any category' },
  { id: 'slots',   label: 'Slots & casino' },
  { id: 'gaming',  label: 'Gaming' },
  { id: 'general', label: 'General knowledge' },
  { id: 'maths',   label: 'Maths' },
  { id: 'music',   label: 'Music' },
  { id: 'film',    label: 'Film' },
];

// Strip everything chat varies on but nobody means differently: case, accents,
// punctuation, leading articles, and the "!answer" prefix if they used one.
// Deliberately does NOT strip inner spaces — "return to player" and
// "returntoplayer" are handled as separate accepted spellings instead, so the
// matcher never accepts something that merely contains the answer.
function triviaNormalise(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^!?answer\s+/, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this chat message answer the question?
 *
 * Whole-message match only. Matching on "contains" sounds friendlier but hands
 * the win to whoever is spamming longest — someone typing every number from 1
 * to 100 would win every numeric question.
 */
function triviaIsCorrect(message, question) {
  const said = triviaNormalise(message);
  if (!said) return false;
  const accepted = [question.a].concat(question.alts || []).map(triviaNormalise);
  return accepted.includes(said);
}

// One random question matching the filters, avoiding anything already asked
// this session so a round does not repeat itself.
function triviaPick(category, difficulty, usedQuestions) {
  const used = new Set(usedQuestions || []);
  let pool = TRIVIA_BANK.filter(q =>
    (!category   || q.cat  === category) &&
    (!difficulty || q.diff === difficulty));
  const fresh = pool.filter(q => !used.has(q.q));
  // Everything in this filter has been asked — start the bank over rather than
  // refusing to deal a question mid-stream.
  if (fresh.length) pool = fresh;
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
