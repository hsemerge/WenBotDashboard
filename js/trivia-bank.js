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

  // ── Slots & casino (expanded) ────────────────────────────────────────────
  { cat: 'slots', diff: 'easy',   q: 'In blackjack, what number are you trying not to go over?', a: '21', alts: ['twenty one'] },
  { cat: 'slots', diff: 'easy',   q: 'Which casino game is played with a small ball on a spinning wheel?', a: 'roulette' },
  { cat: 'slots', diff: 'easy',   q: 'How many cards are in a standard deck without jokers?', a: '52', alts: ['fifty two'] },
  { cat: 'slots', diff: 'easy',   q: 'What colour is the single zero pocket on a roulette wheel?', a: 'green' },
  { cat: 'slots', diff: 'easy',   q: 'A two-card hand totalling 21 in blackjack is called a what?', a: 'blackjack' },
  { cat: 'slots', diff: 'easy',   q: 'Betting everything you have in poker is going all what?', a: 'in', alts: ['all in', 'all-in'] },
  { cat: 'slots', diff: 'medium', q: 'The casino’s built-in advantage is called the house what?', a: 'edge' },
  { cat: 'slots', diff: 'medium', q: 'In poker, three of a kind plus a pair is called a what?', a: 'full house', alts: ['fullhouse', 'boat'] },
  { cat: 'slots', diff: 'medium', q: 'What is the highest possible hand in standard poker?', a: 'royal flush', alts: ['royalflush'] },
  { cat: 'slots', diff: 'medium', q: 'In baccarat, the two hands are Player and what?', a: 'banker' },
  { cat: 'slots', diff: 'medium', q: 'A tie in blackjack where you get your bet back is called a what?', a: 'push' },
  { cat: 'slots', diff: 'medium', q: 'The slot feature you pay extra to trigger instantly is called a bonus what?', a: 'buy', alts: ['bonus buy', 'feature buy'] },
  { cat: 'slots', diff: 'hard',   q: 'How many numbers are on a European roulette wheel, including the zero?', a: '37', alts: ['thirty seven'] },
  { cat: 'slots', diff: 'hard',   q: 'How many numbers are on an American roulette wheel, with two zeros?', a: '38', alts: ['thirty eight'] },
  { cat: 'slots', diff: 'hard',   q: 'A straight-up single-number bet in roulette pays how many to one?', a: '35', alts: ['35 to 1', '35:1', '35-1'] },
  { cat: 'slots', diff: 'hard',   q: 'Which studio makes the slots Gates of Olympus and Sugar Rush?', a: 'pragmatic play', alts: ['pragmatic'] },
  { cat: 'slots', diff: 'hard',   q: 'The slot mechanic where symbols pay in groups anywhere, with no paylines, is called what pays?', a: 'cluster', alts: ['cluster pays', 'clusters'] },
  { cat: 'slots', diff: 'hard',   q: 'In Texas Hold’em, how many hole cards does each player get?', a: '2', alts: ['two'] },

  // ── Gaming (expanded) ────────────────────────────────────────────────────
  { cat: 'gaming', diff: 'easy',   q: 'What does Mario jump on to defeat most enemies?', a: 'heads', alts: ['their heads', 'head', 'on them', 'jump on them'] },
  { cat: 'gaming', diff: 'easy',   q: 'What company created Pac-Man?', a: 'namco' },
  { cat: 'gaming', diff: 'easy',   q: 'In Tetris, clearing four lines at once is called a what?', a: 'tetris' },
  { cat: 'gaming', diff: 'easy',   q: 'What is the name of Link’s home series?', a: 'zelda', alts: ['the legend of zelda', 'legend of zelda'] },
  { cat: 'gaming', diff: 'easy',   q: 'In Pac-Man, what is the name of the pink ghost?', a: 'pinky' },
  { cat: 'gaming', diff: 'medium', q: 'What is the best-selling console of all time?', a: 'playstation 2', alts: ['ps2', 'playstation2'] },
  { cat: 'gaming', diff: 'medium', q: 'In Minecraft, what hostile mob explodes when it gets close?', a: 'creeper' },
  { cat: 'gaming', diff: 'medium', q: 'Which company owns the Xbox brand?', a: 'microsoft' },
  { cat: 'gaming', diff: 'medium', q: 'What is the name of the currency in Grand Theft Auto Online?', a: 'gta dollars', alts: ['dollars', 'gta$', 'money'] },
  { cat: 'gaming', diff: 'medium', q: 'Which game features a character named Master Chief?', a: 'halo' },
  { cat: 'gaming', diff: 'hard',   q: 'What year was the first Pokémon game released in Japan?', a: '1996' },
  { cat: 'gaming', diff: 'hard',   q: 'Who is the main character of the Metal Gear Solid series?', a: 'solid snake', alts: ['snake'] },
  { cat: 'gaming', diff: 'hard',   q: 'Which studio created The Witcher 3?', a: 'cd projekt red', alts: ['cd projekt', 'cdpr'] },
  { cat: 'gaming', diff: 'hard',   q: 'In Counter-Strike, what is the bomb the terrorists plant called?', a: 'c4', alts: ['the c4', 'bomb'] },

  // ── General knowledge (expanded) ─────────────────────────────────────────
  { cat: 'general', diff: 'easy',   q: 'How many days are there in a leap year?', a: '366', alts: ['three hundred sixty six'] },
  { cat: 'general', diff: 'easy',   q: 'What is the tallest animal in the world?', a: 'giraffe' },
  { cat: 'general', diff: 'easy',   q: 'What gas do plants absorb from the air?', a: 'carbon dioxide', alts: ['co2'] },
  { cat: 'general', diff: 'easy',   q: 'How many colours are in a rainbow?', a: '7', alts: ['seven'] },
  { cat: 'general', diff: 'easy',   q: 'What is the largest planet in our solar system?', a: 'jupiter' },
  { cat: 'general', diff: 'easy',   q: 'What is the currency of the United Kingdom?', a: 'pound', alts: ['pound sterling', 'gbp', 'british pound'] },
  { cat: 'general', diff: 'medium', q: 'What is the hardest natural substance on Earth?', a: 'diamond' },
  { cat: 'general', diff: 'medium', q: 'How many hearts does an octopus have?', a: '3', alts: ['three'] },
  { cat: 'general', diff: 'medium', q: 'What is the capital of Australia?', a: 'canberra' },
  { cat: 'general', diff: 'medium', q: 'Which planet spins on its side?', a: 'uranus' },
  { cat: 'general', diff: 'medium', q: 'What language has the most native speakers worldwide?', a: 'mandarin', alts: ['chinese', 'mandarin chinese'] },
  { cat: 'general', diff: 'hard',   q: 'What is the chemical symbol for iron?', a: 'fe' },
  { cat: 'general', diff: 'hard',   q: 'How many time zones does Russia span?', a: '11', alts: ['eleven'] },
  { cat: 'general', diff: 'hard',   q: 'What is the longest river in the world?', a: 'nile', alts: ['the nile'] },
  { cat: 'general', diff: 'hard',   q: 'In what year did World War II end?', a: '1945' },

  // ── Maths (expanded) ─────────────────────────────────────────────────────
  { cat: 'maths', diff: 'easy',   q: 'What is 9 x 8?', a: '72' },
  { cat: 'maths', diff: 'easy',   q: 'What is 100 divided by 4?', a: '25', alts: ['twenty five'] },
  { cat: 'maths', diff: 'easy',   q: 'What is half of 150?', a: '75', alts: ['seventy five'] },
  { cat: 'maths', diff: 'easy',   q: 'What is 7 + 8?', a: '15', alts: ['fifteen'] },
  { cat: 'maths', diff: 'medium', q: 'What is 20% of 350?', a: '70', alts: ['seventy'] },
  { cat: 'maths', diff: 'medium', q: 'A $5 bet pays 100x. What does it return?', a: '500', alts: ['$500', '500$'] },
  { cat: 'maths', diff: 'medium', q: 'What is 13 squared?', a: '169' },
  { cat: 'maths', diff: 'medium', q: 'What is 1000 minus 250?', a: '750', alts: ['seven hundred fifty'] },
  { cat: 'maths', diff: 'hard',   q: 'What is 12 x 15?', a: '180' },
  { cat: 'maths', diff: 'hard',   q: 'A $0.20 bet returns $500. What multiplier is that?', a: '2500', alts: ['2500x', '2,500', '2,500x'] },
  { cat: 'maths', diff: 'hard',   q: 'What is the square root of 625?', a: '25', alts: ['twenty five'] },
  { cat: 'maths', diff: 'hard',   q: 'What is 15% of 1200?', a: '180', alts: ['one hundred eighty'] },

  // ── Music (expanded) ─────────────────────────────────────────────────────
  { cat: 'music', diff: 'easy',   q: 'Which instrument has 88 keys?', a: 'piano' },
  { cat: 'music', diff: 'easy',   q: 'How many members were in The Beatles?', a: '4', alts: ['four'] },
  { cat: 'music', diff: 'easy',   q: 'What do you call a group of musicians playing together?', a: 'band', alts: ['a band', 'orchestra'] },
  { cat: 'music', diff: 'medium', q: 'Which artist is known as the King of Pop?', a: 'michael jackson', alts: ['mj'] },
  { cat: 'music', diff: 'medium', q: 'How many strings does a standard bass guitar have?', a: '4', alts: ['four'] },
  { cat: 'music', diff: 'medium', q: 'Which country did the band ABBA come from?', a: 'sweden' },
  { cat: 'music', diff: 'hard',   q: 'Which composer wrote the Ninth Symphony, "Ode to Joy"?', a: 'beethoven' },
  { cat: 'music', diff: 'hard',   q: 'How many notes are in a standard major scale?', a: '7', alts: ['seven', '8', 'eight'] },
  { cat: 'music', diff: 'hard',   q: 'What is Elton John’s real first name?', a: 'reginald', alts: ['reg'] },

  // ── Film & TV (expanded) ─────────────────────────────────────────────────
  { cat: 'film',  diff: 'easy',   q: 'What kind of animal is Simba in The Lion King?', a: 'lion' },
  { cat: 'film',  diff: 'easy',   q: 'In Toy Story, what is the name of the cowboy?', a: 'woody' },
  { cat: 'film',  diff: 'easy',   q: 'What colour is the ogre Shrek?', a: 'green' },
  { cat: 'film',  diff: 'easy',   q: 'Who is the wizard boy with a lightning scar?', a: 'harry potter', alts: ['harry'] },
  { cat: 'film',  diff: 'medium', q: 'Which film features the quote "I’ll be back"?', a: 'terminator', alts: ['the terminator'] },
  { cat: 'film',  diff: 'medium', q: 'What is the name of the fictional African country in Black Panther?', a: 'wakanda' },
  { cat: 'film',  diff: 'medium', q: 'Who directed Jurassic Park?', a: 'steven spielberg', alts: ['spielberg'] },
  { cat: 'film',  diff: 'medium', q: 'In The Matrix, which pill does Neo take, red or blue?', a: 'red' },
  { cat: 'film',  diff: 'hard',   q: 'Which actor played the Joker in The Dark Knight?', a: 'heath ledger', alts: ['ledger'] },
  { cat: 'film',  diff: 'hard',   q: 'What year was the first Star Wars film released?', a: '1977' },
  { cat: 'film',  diff: 'hard',   q: 'Which studio produces the Toy Story films?', a: 'pixar' },
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
