// Exercise the REAL admin-alt-check handler against a stubbed Firestore.
//
// The point of the tool is judgement, not lookup, so the assertions are mostly
// about what it REFUSES to call an alt. A rename that reads as a second account
// gets an innocent viewer banned, which is worse than missing a real alt.
const path = require("path");
const ROOT = path.join(__dirname, "..", "netlify", "functions");

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// ── the channel's records ──────────────────────────────────────────────────
// sangamesh149 : shares a Winovo UID with "sanga_alt2" and a Discord with it too
// bigwin       : clean, nothing shared
// oldname/newname : ONE person who renamed (same kickUserId) — must NOT read as alt
let VERIFIED = [];
let LINKS = [];
let HISTORY = {};

function reset() {
  VERIFIED = [
    { id: "sangamesh149_winovo", kickName: "Sangamesh149", kickName_lower: "sangamesh149",
      kickUserId: "551001", provider: "winovo", providerUsername: "sanga_w",
      providerUsername_lower: "sanga_w", providerUid: "W-9931",
      discordUserId: "3001", discordUsername: "sanga", verifiedAt: 1756000000000 },
    { id: "sanga_alt2_winovo", kickName: "sanga_alt2", kickName_lower: "sanga_alt2",
      kickUserId: "551999", provider: "winovo", providerUsername: "sanga_w",
      providerUsername_lower: "sanga_w", providerUid: "W-9931",
      discordUserId: "3001", discordUsername: "sanga", verifiedAt: 1756500000000 },
    { id: "bigwin_winovo", kickName: "BigWin", kickName_lower: "bigwin",
      kickUserId: "552000", provider: "winovo", providerUsername: "bigwin",
      providerUsername_lower: "bigwin", providerUid: "W-1111",
      discordUserId: "4001", verifiedAt: 1756000000000 },
    { id: "oldname_winovo", kickName: "OldName", kickName_lower: "oldname",
      kickUserId: "553000", provider: "winovo", providerUsername: "renamer",
      providerUsername_lower: "renamer", providerUid: "W-2222",
      discordUserId: "5001", verifiedAt: 1755000000000 },
    { id: "newname_winovo", kickName: "NewName", kickName_lower: "newname",
      kickUserId: "553000", provider: "winovo", providerUsername: "renamer",
      providerUsername_lower: "renamer", providerUid: "W-2222",
      discordUserId: "5001", verifiedAt: 1756900000000 },
  ];
  LINKS = [
    { id: "3001", kickUsername: "sanga_alt2" },   // the Discord now points at the alt
    { id: "4001", kickUsername: "BigWin" },
    { id: "5001", kickUsername: "NewName" },
  ];
  HISTORY = {
    sangamesh149: { events: [
      { ts: 1756500000000, type: "discord_out", text: "Discord @sanga moved to Kick user sanga_alt2" },
      { ts: 1756000000000, type: "verified", text: "Verified at Winovo" },
    ] },
    newname: { events: [{ ts: 1756900000000, type: "renamed", text: "Renamed on Kick — same account was verified as OldName" }] },
  };
}

const snap = (arr) => ({ docs: arr.map((d) => ({ id: d.id, data: () => d })), empty: !arr.length });
const db = {
  collection: (n) => {
    if (n !== "streamers") throw new Error("unexpected " + n);
    return {
      where: () => ({ limit: () => ({ get: async () => snap([{ id: "walterUid", kickChannel: "walter" }]) }) }),
      doc: () => ({
        get: async () => ({ exists: true, data: () => ({ kickChannel: "walter" }) }),
        collection: (sub) => ({
          get: async () => snap(sub === "verified_users" ? VERIFIED : LINKS),
          doc: (key) => ({ get: async () => ({ exists: !!HISTORY[key], data: () => HISTORY[key] || {} }) }),
        }),
      }),
    };
  },
};

stub("_lib/firebase", { getDb: () => db });
stub("_lib/http", {
  res: (status, body) => ({ statusCode: status, body: JSON.stringify(body) }),
  checkRateLimit: async () => true,
});
stub("_lib/admin", { requireAdmin: async () => ({ uid: "admin1" }) });

let fails = 0;
const ok = (l, c, x) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${l}${c ? "" : "   <-- " + x}`); if (!c) fails++; };
const run = async (kickUsername) => {
  const { handler } = require(path.join(ROOT, "admin-alt-check.js"));
  const r = await handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ uid: "walterUid", channel: "walter", kickUsername }) });
  return JSON.parse(r.body);
};

(async () => {
  reset();

  console.log("\n== a genuine alt: shared casino UID AND shared Discord ==");
  const a = await run("Sangamesh149");
  ok("found the viewer", a.found === true, a.summary);
  const sig = a.findings.map((f) => f.signal);
  ok("flags the shared casino UID", sig.includes("casino_uid_shared"), sig.join(","));
  ok("flags the shared Discord", sig.includes("discord_shared"), sig.join(","));
  ok("flags that the Discord now points elsewhere", sig.includes("discord_moved"), sig.join(","));
  ok("names the other account", a.linkedNames.includes("sanga_alt2"), a.linkedNames.join(","));
  ok("does NOT invent extra links", a.linkedNames.length === 1, a.linkedNames.join(","));
  ok("strongest signal is sorted first", a.findings[0].weight === "strong", a.findings[0].weight);
  ok("picks up the durable history entry", sig.includes("history:discord_out"), sig.join(","));
  ok("summary calls it worth acting on", /strong signal/.test(a.summary), a.summary);

  console.log("\n== a rename must NOT read as an alt ==");
  const b = await run("NewName");
  ok("found", b.found === true, b.summary);
  ok("reports the same-account link", b.findings.some((f) => f.signal === "same_kick_account"), "missed");
  ok("marks it NOT an alt", b.findings.filter((f) => f.signal === "same_kick_account").every((f) => f.alt === false), "flagged as alt");
  ok("NO strong alt signal is raised", !b.findings.some((f) => f.alt && f.weight === "strong"), "raised one");
  ok("summary says rename, not alt", /rename, not an alt/.test(b.summary), b.summary);

  console.log("\n== a clean viewer ==");
  const c = await run("BigWin");
  ok("found", c.found === true, c.summary);
  ok("no findings at all", c.findings.length === 0, JSON.stringify(c.findings.map((f) => f.signal)));
  ok("summary does not claim proof of innocence", /not proof they are clean/.test(c.summary), c.summary);

  console.log("\n== an unknown name ==");
  const d = await run("nobody_here");
  ok("reports not found rather than erroring", d.found === false, JSON.stringify(d));
  ok("explains why", /never have verified/.test(d.summary), d.summary);

  console.log("\n== the same casino UID is never double-reported ==");
  const uidHits = a.findings.filter((f) => f.signal === "casino_uid_shared").length;
  const nameHits = a.findings.filter((f) => f.signal === "casino_name_shared").length;
  ok("uid match reported once", uidHits === 1, uidHits);
  ok("username match suppressed when the uid already matched", nameHits === 0, nameHits);

  console.log(fails ? `\n${fails} FAILURE(S)\n` : "\nalt-check reasoning correct\n");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("threw:", e); process.exit(1); });
