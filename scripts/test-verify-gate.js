// The optional two-role Discord gate, against a stubbed Discord API.
//
// Worth a test in the build rather than a one-off check, because the failure
// modes are asymmetric. Granting the wrong role is a nuisance; REVOKING the
// wrong role locks a whole community out of its own Discord — and the trigger
// would be a Discord outage, i.e. exactly when nobody is watching. Two of these
// cases exist solely to pin that down:
//   • one confirmed absence must never revoke (only the second does)
//   • an unreadable member must never revoke, whatever the miss streak says
// The first case pins the other invariant: with the gate OFF, which is every
// streamer who hasn't opted in, behaviour is byte-identical to before.
process.env.DISCORD_BOT_TOKEN = "test";

const path = require("path");
const LIB = path.join(__dirname, "..", "netlify", "functions", "_lib", "discord-role.js");

// --- stub Discord -----------------------------------------------------------
let memberRoles = [];        // what GET member returns
let memberFail  = false;     // simulate an outage
let notMember   = false;
const calls = [];            // [method, roleId]

global.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  if (method === "GET") {
    if (memberFail) return { ok: false, status: 503, text: async () => "" };
    if (notMember)  return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, json: async () => ({ roles: memberRoles.slice() }) };
  }
  const roleId = url.split("/roles/")[1];
  calls.push([method, roleId]);
  if (method === "PUT" && !memberRoles.includes(roleId)) memberRoles.push(roleId);
  if (method === "DELETE") memberRoles = memberRoles.filter((r) => r !== roleId);
  return { ok: true, status: 204, text: async () => "" };
};

const { grantVerifiedRole, syncUnlockRole } = require(LIB);

const VERIFY = "role_wenbot", SECOND = "role_dc", UNLOCK = "role_unlock";
const gated = { discordConfig: { guildId: "g1", verify: {
  assignRole: true, roleId: VERIFY, requireSecondRole: true,
  secondRoleId: SECOND, unlockRoleId: UNLOCK } } };
const ungated = { discordConfig: { guildId: "g1", verify: { assignRole: true, roleId: VERIFY } } };

let fails = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  <-- " + detail}`);
  if (!cond) fails++;
}
function reset(roles = [], opts = {}) {
  memberRoles = roles.slice(); memberFail = !!opts.fail; notMember = !!opts.notMember; calls.length = 0;
}

(async () => {
  console.log("\n== gate OFF behaves exactly as before ==");
  reset([]);
  let r = await grantVerifiedRole(ungated, "u1");
  check("grants the verified role", r.ok === true, JSON.stringify(r));
  check("grants nothing else", calls.length === 1 && calls[0][1] === VERIFY, JSON.stringify(calls));

  console.log("\n== gate ON, member already through the other bot ==");
  reset([SECOND]);
  r = await grantVerifiedRole(gated, "u1");
  check("succeeds", r.ok === true, JSON.stringify(r));
  check("unlocked", r.unlocked === true, JSON.stringify(r));
  check("granted BOTH roles", calls.filter(c => c[0] === "PUT").length === 2, JSON.stringify(calls));

  console.log("\n== gate ON, member has NOT done the other bot ==");
  reset([]);
  r = await grantVerifiedRole(gated, "u1");
  check("refuses", r.ok === false, JSON.stringify(r));
  check("reports why", r.blocked === "needs-second-role", JSON.stringify(r));
  check("grants NOTHING", calls.length === 0, JSON.stringify(calls));

  console.log("\n== gate ON, Discord unreadable at verify time ==");
  reset([], { fail: true });
  r = await grantVerifiedRole(gated, "u1");
  check("does not claim they failed the gate", r.blocked === undefined, JSON.stringify(r));
  check("marks pending", r.pending === true, JSON.stringify(r));
  check("grants nothing on bad data", calls.length === 0, JSON.stringify(calls));

  console.log("\n== sweep: they did the other bot afterwards ==");
  reset([VERIFY, SECOND]);
  let s = await syncUnlockRole(gated, "u1", { confirmedMisses: 0 });
  check("grants the unlock role", s.action === "granted", JSON.stringify(s));
  check("unlock actually PUT", calls.some(c => c[0] === "PUT" && c[1] === UNLOCK), JSON.stringify(calls));

  console.log("\n== sweep: nothing to do ==");
  reset([VERIFY, SECOND, UNLOCK]);
  s = await syncUnlockRole(gated, "u1", { confirmedMisses: 0 });
  check("no-op", s.action === "noop", JSON.stringify(s));
  check("no writes", calls.length === 0, JSON.stringify(calls));

  console.log("\n== sweep: second role lost — REVOKE MUST BE CAUTIOUS ==");
  reset([VERIFY, UNLOCK]);
  s = await syncUnlockRole(gated, "u1", { confirmedMisses: 0 });
  check("first sighting only records a miss", s.action === "miss", JSON.stringify(s));
  check("does NOT revoke on one reading", calls.length === 0, JSON.stringify(calls));

  reset([VERIFY, UNLOCK]);
  s = await syncUnlockRole(gated, "u1", { confirmedMisses: 1 });
  check("revokes on the second confirmation", s.action === "revoked", JSON.stringify(s));
  check("removed the unlock role only", calls.length === 1 && calls[0][0] === "DELETE" && calls[0][1] === UNLOCK, JSON.stringify(calls));

  console.log("\n== sweep: Discord outage must NEVER revoke ==");
  reset([VERIFY, UNLOCK], { fail: true });
  s = await syncUnlockRole(gated, "u1", { confirmedMisses: 5 });
  check("reports unknown", s.action === "unknown", JSON.stringify(s));
  check("changes NOTHING despite a long miss streak", calls.length === 0, JSON.stringify(calls));

  console.log("\n== sweep: member left the server ==");
  reset([], { notMember: true });
  s = await syncUnlockRole(gated, "u1", { confirmedMisses: 5 });
  check("no-op", s.action === "noop", JSON.stringify(s));
  check("no writes", calls.length === 0, JSON.stringify(calls));

  console.log(fails ? `\n${fails} FAILED\n` : "\nall gate behaviours correct\n");
  process.exit(fails ? 1 : 0);
})();
