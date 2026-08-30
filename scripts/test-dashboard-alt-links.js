// Tests the alt-linkage clustering that flags accounts on the streamer's
// verified-users table.
//
// Lifted out of dashboard.html and executed, rather than reimplemented here, so
// the test cannot drift away from the code that actually ships.
//
// This one runs on STREAMERS' screens and puts a "Likely alt" badge next to a
// real viewer's name, so the assertions weigh heavily toward what must NOT be
// flagged. A renamed viewer shares their casino account, Discord and connection
// with their own former name; if that reads as an alt, every rename on the
// channel gets accused.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "dashboard.html"), "utf8");
const start = src.indexOf("function computeVerifiedAltLinks");
const end = src.indexOf("function renderVerifiedFromCache");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL  could not find computeVerifiedAltLinks in dashboard.html — was it renamed?");
  process.exit(1);
}
eval(src.slice(start, end));

const R = (name, o) => ({ id: name + "_w", data: Object.assign({ kickName: name, kickName_lower: name.toLowerCase() }, o) });
let fails = 0;
const ok = (l, c, x) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${l}${c ? "" : "   <-- " + x}`); if (!c) fails++; };

console.log("\n== a real alt: shared casino uid + discord ==");
let m = computeVerifiedAltLinks([
  R("Sangamesh149", { kickUserId: "1", providerUid: "W-9", discordUserId: "D1", connHash: "H1" }),
  R("sanga_alt2",   { kickUserId: "2", providerUid: "W-9", discordUserId: "D1", connHash: "H1" }),
  R("Innocent",     { kickUserId: "3", providerUid: "W-3", discordUserId: "D3", connHash: "H3" }),
]);
ok("flags the account", !!m["sangamesh149"], "not flagged");
ok("as strong", m["sangamesh149"] && m["sangamesh149"].strong === true, "not strong");
ok("counts exactly 1 other account", m["sangamesh149"].names.length === 1, m["sangamesh149"].names.join(","));
ok("names it", m["sangamesh149"].names[0] === "sanga_alt2", m["sangamesh149"].names[0]);
ok("leaves the unrelated viewer alone", !m["innocent"], "flagged an innocent viewer");

console.log("\n== a RENAME must never flag ==");
m = computeVerifiedAltLinks([
  R("OldName", { kickUserId: "9", providerUid: "W-5", discordUserId: "D5", connHash: "H5" }),
  R("NewName", { kickUserId: "9", providerUid: "W-5", discordUserId: "D5", connHash: "H5" }),
]);
ok("old name not flagged", !m["oldname"], JSON.stringify(m["oldname"]));
ok("new name not flagged", !m["newname"], JSON.stringify(m["newname"]));

console.log("\n== siblings behind one connection: soft, never strong ==");
m = computeVerifiedAltLinks([
  R("SibA", { kickUserId: "10", providerUid: "W-A", discordUserId: "DA", connHash: "HOME" }),
  R("SibB", { kickUserId: "11", providerUid: "W-B", discordUserId: "DB", connHash: "HOME" }),
]);
ok("both flagged", !!m["siba"] && !!m["sibb"], "missing");
ok("but only softly — an IP alone is not an alt", m["siba"].strong === false, "escalated on IP alone");

console.log("\n== connection PLUS a shared casino escalates ==");
m = computeVerifiedAltLinks([
  R("A", { kickUserId: "20", providerUid: "W-Z", connHash: "HH" }),
  R("B", { kickUserId: "21", providerUid: "W-Z", connHash: "HH" }),
]);
ok("escalated to strong", m["a"].strong === true, "stayed soft");

console.log("\n== absent identifiers must never group people ==");
m = computeVerifiedAltLinks([R("X", { kickUserId: "30" }), R("Y", { kickUserId: "31" }), R("Z", { kickUserId: "32" })]);
ok("nulls do not cluster everyone together", Object.keys(m).length === 0, JSON.stringify(m));

console.log("\n== one viewer with several casino records is not their own alt ==");
m = computeVerifiedAltLinks([
  R("Multi", { kickUserId: "40", providerUid: "M1", connHash: "HM" }),
  { id: "multi_x", data: { kickName: "Multi", kickName_lower: "multi", kickUserId: "40", providerUid: "M2", connHash: "HM" } },
  R("MultiAlt", { kickUserId: "41", providerUid: "M2", connHash: "HM" }),
]);
ok("their two records are not each other", m["multi"].names.every((n) => n.toLowerCase() !== "multi"), m["multi"].names.join(","));
ok("the real alt is found once", m["multi"].names.length === 1 && m["multi"].names[0] === "MultiAlt", m["multi"].names.join(","));

console.log("\n== a viewer with no Kick account id still resolves ==");
// kickUserId predates some records; without it there is no alias set, so the
// viewer must fall back to being their own only alias rather than crashing.
m = computeVerifiedAltLinks([
  R("Legacy", { providerUid: "L1" }),
  R("Other",  { kickUserId: "50", providerUid: "L1" }),
]);
ok("still links them", !!m["legacy"] && m["legacy"].names.includes("Other"), JSON.stringify(m["legacy"]));
ok("and does not list itself", m["legacy"].names.every((n) => n.toLowerCase() !== "legacy"), m["legacy"].names.join(","));

console.log(fails ? `\n${fails} FAILURE(S)\n` : "\ndashboard alt clustering correct\n");
process.exit(fails ? 1 : 0);
