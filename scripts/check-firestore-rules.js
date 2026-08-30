// Guards one specific, silent failure mode in firestore.rules.
//
// Under /streamers/{uid} there is a catch-all:
//
//   match /{subcollection}/{doc} {
//     allow read, write: if isOwnerOrMod(uid) && !(subcollection in [ ...names... ]);
//   }
//
// Firestore OR-combines every matching rule, so this catch-all GRANTS write to
// any subcollection missing from that exclusion list — even one that declares
// `allow write: if false` in its own block. The explicit rule looks like it is
// doing something and does nothing.
//
// That is invisible in review and invisible at runtime: nothing errors, the
// collection is simply writable by any mod. For the integrity trails
// (viewer_history, verified_released) it is the whole ballgame — those exist so
// a mod cannot erase evidence about themselves.
//
// So: every subcollection that denies client writes MUST also appear in the
// exclusion list. This asserts exactly that.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");

// The exclusion list inside the catch-all.
const listMatch = src.match(/subcollection in \[([\s\S]*?)\]/);
if (!listMatch) {
  console.error("FAIL  could not find the catch-all exclusion list in firestore.rules");
  process.exit(1);
}
const excluded = new Set([...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

// Every `match /name/{doc} { ... }` block and whether it denies writes.
// Brace-counted rather than regex-bounded, so a nested block cannot end it early.
const denies = [];
const re = /match\s+\/([A-Za-z_][A-Za-z0-9_]*)\/\{[^}]*\}\s*\{/g;
let m;
while ((m = re.exec(src))) {
  const name = m[1];
  let i = re.lastIndex, depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  const body = src.slice(re.lastIndex, i);
  // Only blocks that actually forbid client writes.
  if (/allow\s+(write|create|update|delete)[^;]*:\s*if\s+false\s*;/.test(body)) denies.push(name);
}

// Only collections INSIDE the /streamers/{uid} block are shadowed by its
// catch-all. Scoped by brace-counting that block, not by "appears later in the
// file" — /conversations/{id}/messages sits further down and is governed by its
// own parent, so a position test reports it as an unguarded streamer
// subcollection when it is nothing of the kind.
const sMatch = src.match(/match\s+\/streamers\/\{[^}]*\}\s*\{/);
if (!sMatch) {
  console.error("FAIL  could not find the /streamers/{uid} block in firestore.rules");
  process.exit(1);
}
const sStart = sMatch.index;
// Start just past the BLOCK's opening brace. Searching for the first "{" instead
// lands on the one in "{uid}", whose "}" closes the count immediately and makes
// the block look empty — which reads as "nothing to check" and passes.
let sEnd = sMatch.index + sMatch[0].length;
for (let depth = 1; depth > 0 && sEnd < src.length; sEnd++) {
  if (src[sEnd] === "{") depth++;
  else if (src[sEnd] === "}") depth--;
}
const underStreamer = denies.filter((n) => {
  const at = src.indexOf(`match /${n}/{`);
  return at > sStart && at < sEnd;
});

const unguarded = underStreamer.filter((n) => !excluded.has(n));

if (unguarded.length) {
  console.error(`\nFAIL  ${unguarded.length} subcollection(s) declare "allow write: if false" but are NOT in`);
  console.error("      the catch-all exclusion list, so the catch-all grants mods write anyway.\n");
  unguarded.forEach((n) => console.error(`  ${n}   — add '${n}' to the subcollection exclusion array`));
  console.error("");
  process.exit(1);
}

console.log(`ok   ${underStreamer.length} write-denied subcollection(s), all excluded from the catch-all`);
