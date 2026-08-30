// Runs the REAL verified-remove handler against a stubbed Firestore.
//
// The behaviour under test is narrow but load-bearing: removing a verified entry
// must archive its identifiers BEFORE deleting it.
//
// Why it matters more than the self-serve path. Mods can remove any viewer, mods
// can run /lookup, and /lookup names the accounts a viewer is linked to. So the
// person best placed to see an alt flag pointing at them is also the one holding
// the Remove button — and because alt matching needs both halves of a pair,
// removing one entry used to clear the link off the other as well.
const path = require("path");
const ROOT = path.join(__dirname, "..", "netlify", "functions");

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const RECORD = {
  kickName: "sanga_alt2",
  kickUserId: "551999",
  provider: "winovo",
  providerUsername: "sanga_w",
  providerUsername_lower: "sanga_w",
  providerUid: "W-9931",
  discordUserId: "3001",
  discordUsername: "sanga",
  connHash: "SALTED-HASH-XYZ",
  connLabel: "UK mobile",
  verifiedAt: 1756500000000,
};

const archived = [];      // what landed in verified_released
const deleted = [];       // what was deleted
const audits = [];        // what was logged
const history = [];       // viewer_history events

const docStub = (id, data, coll) => ({
  id,
  data: () => data,
  ref: { delete: () => deleted.push(id) },
  __coll: coll,
});

const db = {
  batch: () => ({
    _ops: [],
    delete(ref) { ref.delete(); },
    commit: async () => {},
  }),
  collection: (n) => {
    if (n !== "streamers") throw new Error("unexpected " + n);
    return {
      doc: () => ({
        get: async () => ({ exists: true, data: () => ({ kickChannel: "walter" }) }),
        collection: (sub) => ({
          doc: (id) => ({
            id,
            get: async () => ({ exists: true, data: () => RECORD }),
            delete: () => deleted.push(id),
            set: async (v) => { if (sub === "verified_released") archived.push({ id, ...v }); },
          }),
          orderBy: () => ({ startAt: () => ({ endAt: () => ({ get: async () => ({ docs: [] }) }) }) }),
          get: async () => ({ docs: [] }),
        }),
      }),
    };
  },
  runTransaction: async (fn) => fn({
    get: async () => ({ exists: false, data: () => ({}) }),
    set: (ref, v) => history.push(v),
  }),
};

// `admin` is imported FROM _lib/firebase, not required directly, so the stub has
// to supply auth() and FieldPath here.
stub("_lib/firebase", {
  getDb: () => db,
  admin: {
    auth: () => ({
      verifyIdToken: async () => ({
        uid: "modUid",
        email: "sanga@example.com",
        // A mod working someone else's dashboard.
        delegatedFor: ["walterUid"],
      }),
    }),
    firestore: { FieldPath: { documentId: () => "__name__" } },
  },
});
stub("_lib/http", {
  res: (s, b) => ({ statusCode: s, body: JSON.stringify(b) }),
  checkRateLimit: async () => true,
});
stub("_lib/audit", { logAudit: async (uid, type, d) => audits.push({ type, ...d }) });
stub("_lib/discord-role", { revokeVerifiedRole: async () => ({ ok: true }) });

let fails = 0;
const ok = (l, c, x) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${l}${c ? "" : "   <-- " + x}`); if (!c) fails++; };

(async () => {
  let handler;
  try {
    ({ handler } = require(path.join(ROOT, "verified-remove.js")));
  } catch (e) {
    console.error("could not load verified-remove:", e.message);
    process.exit(1);
  }

  const out = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer tok" },
    body: JSON.stringify({ uid: "walterUid", docId: "sanga_alt2_winovo" }),
  });

  console.log("\n== the entry is really removed ==");
  ok("returned OK", out.statusCode === 200, out.statusCode + " " + out.body);
  ok("the record was deleted", deleted.includes("sanga_alt2_winovo"), deleted.join(","));

  console.log("\n== but its identifiers are archived FIRST ==");
  ok("one archive row written", archived.length === 1, archived.length);
  const a = archived[0] || {};
  ok("keeps the connection fingerprint", a.connHash === "SALTED-HASH-XYZ", a.connHash);
  ok("keeps the casino uid", a.providerUid === "W-9931", a.providerUid);
  ok("keeps the Kick account id", a.kickUserId === "551999", a.kickUserId);
  ok("keeps the Discord id", String(a.discordUserId) === "3001", a.discordUserId);
  ok("marked as a mod removal", a.releasedBy === "mod", a.releasedBy);

  console.log("\n== and it names WHO removed it ==");
  ok("records the mod's uid", a.removedByUid === "modUid", a.removedByUid);
  ok("records the mod's email", a.removedByEmail === "sanga@example.com", a.removedByEmail);

  console.log("\n== the audit entry carries it too, without leaking the hash ==");
  const au = audits.find((x) => x.type === "verified_user_removed") || {};
  ok("audit written", !!au.type, JSON.stringify(audits));
  ok("names the remover", au.removedByEmail === "sanga@example.com", au.removedByEmail);
  ok("flags that a connection was on file", au.hadConnection === true, au.hadConnection);
  ok("does NOT log the hash itself", !JSON.stringify(audits).includes("SALTED-HASH"), "hash leaked into the audit log");

  console.log("\n== nor does the HTTP response leak it ==");
  ok("hash absent from the response", !out.body.includes("SALTED-HASH"), "hash leaked to the client");

  console.log(fails ? `\n${fails} FAILURE(S)\n` : "\nremoval archives evidence correctly\n");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("threw:", e); process.exit(1); });
