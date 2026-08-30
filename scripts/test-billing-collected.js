// Exercise the REAL admin-billing-overview handler with a stubbed Firestore, to
// prove the collected split is correct — including the card-invoice case that
// cannot happen through the UI today but that the API already accepts.
const path = require("path");
const ROOT = path.join(__dirname, "..", "netlify", "functions");

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// ---- synthetic data -------------------------------------------------------
// meg: crypto monthly + a crypto website build
// walter: a CARD monthly invoice (the case that was misfiled)
// sks: stripe card subscription charges
const DATA = {
  meg:    { chan: "meggambles",
            invoices: [ { status: "paid", amount: 50, recurring: true,  method: "crypto", paidAt: 3 },
                        { status: "paid", amount: 400, recurring: false, method: "crypto", paidAt: 2 },
                        { status: "unpaid", amount: 50, recurring: true, method: "crypto", dueAt: 9 } ],
            payments: [] },
  walter: { chan: "walter",
            invoices: [ { status: "paid", amount: 99, recurring: true, method: "card", paidAt: 5 } ],
            payments: [] },
  sks:    { chan: "skslots",
            invoices: [],
            payments: [ { amount: 25, plan: "pro", paidAt: 7 }, { amount: 25, plan: "pro", paidAt: 8 } ] },
  legacy: { chan: "oldtimer",  // invoice with NO method field at all
            invoices: [ { status: "paid", amount: 10, recurring: true, paidAt: 1 } ],
            payments: [] },
};

const snap = (arr) => ({ docs: arr.map((d) => ({ data: () => d })) });
const db = {
  collection: (name) => {
    if (name !== "streamers") throw new Error("unexpected collection " + name);
    return { get: async () => ({
      docs: Object.entries(DATA).map(([uid, v]) => ({
        id: uid,
        data: () => ({ kickChannel: v.chan }),
        ref: { collection: (sub) => ({ get: async () => snap(sub === "invoices" ? v.invoices : v.payments) }) },
      })),
    }) };
  },
};

stub("_lib/firebase", { getDb: () => db });
stub("_lib/http", {
  res: (status, body) => ({ statusCode: status, body: JSON.stringify(body) }),
  checkRateLimit: async () => true,
});
stub("_lib/admin", { requireAdmin: async () => ({ uid: "owner1" }) });

// ---- run ------------------------------------------------------------------
let fails = 0;
const ok = (label, cond, extra) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${cond ? "" : "   <-- " + extra}`);
  if (!cond) fails++;
};

(async () => {
  const { handler } = require(path.join(ROOT, "admin-billing-overview.js"));
  const out = await handler({ httpMethod: "GET", headers: {} });
  const body = JSON.parse(out.body);
  const c = body.collected;

  console.log("\n== collected block ==");
  console.log(`  stripeSubs   ${c.stripeSubs.total}`);
  console.log(`  invoicedSubs ${c.invoicedSubs.total}`);
  console.log(`  work         ${c.work.total}`);
  console.log(`  grandTotal   ${c.grandTotal}`);
  console.log(`  cryptoTotal  ${c.cryptoTotal}`);
  console.log(`  cryptoShare  ${(c.cryptoShare * 100).toFixed(1)}%`);

  console.log("\n== the three buckets must partition every dollar ==");
  const partition = c.stripeSubs.total + c.invoicedSubs.total + c.work.total;
  ok("stripe + invoiced + work === grandTotal", partition === c.grandTotal, `${partition} !== ${c.grandTotal}`);
  ok("grandTotal is 50+400+99+25+25+10 = 609", c.grandTotal === 609, c.grandTotal);

  console.log("\n== buckets are by WHAT WAS BOUGHT, so the card monthly belongs in invoiced ==");
  ok("invoiced subs = 50 crypto + 99 card + 10 legacy = 159", c.invoicedSubs.total === 159, c.invoicedSubs.total);
  ok("walter's card invoice IS in invoicedSubs", c.invoicedSubs.items.some((i) => i.uid === "walter"), "missing");
  ok("one-off work = 400", c.work.total === 400, c.work.total);
  ok("stripe = 50", c.stripeSubs.total === 50, c.stripeSubs.total);

  console.log("\n== crypto is a cross-cut by RAIL, and must exclude the card invoice ==");
  ok("cryptoTotal = 50 + 400 + 10 legacy = 460 (99 card excluded)", c.cryptoTotal === 460, c.cryptoTotal);
  ok("cryptoTotal < invoicedSubs + work (the card one is out)",
     c.cryptoTotal < c.invoicedSubs.total + c.work.total, "card leaked in");
  ok("walter is NOT counted as crypto",
     !c.invoicedSubs.items.filter((i) => i.method === "crypto").some((i) => i.uid === "walter"), "leaked");
  ok("cryptoShare = 460/609", Math.abs(c.cryptoShare - 460 / 609) < 1e-9, c.cryptoShare);

  console.log("\n== an invoice with no method field reads as crypto (create-time default) ==");
  const legacy = c.invoicedSubs.items.find((i) => i.uid === "legacy");
  ok("legacy invoice present", !!legacy, "missing");
  ok("legacy invoice tagged crypto", legacy && legacy.method === "crypto", legacy && legacy.method);

  console.log("\n== today's data (all crypto) must be UNCHANGED by this fix ==");
  // Drop walter, i.e. the world before any card invoice exists.
  delete DATA.walter;
  delete require.cache[require.resolve(path.join(ROOT, "admin-billing-overview.js"))];
  const { handler: h2 } = require(path.join(ROOT, "admin-billing-overview.js"));
  const c2 = JSON.parse((await h2({ httpMethod: "GET", headers: {} })).body).collected;
  ok("with no card invoices, cryptoTotal === invoiced + work (old behaviour)",
     c2.cryptoTotal === c2.invoicedSubs.total + c2.work.total,
     `${c2.cryptoTotal} vs ${c2.invoicedSubs.total + c2.work.total}`);
  ok("with no card invoices, cryptoShare is 100% of non-stripe",
     Math.abs(c2.cryptoShare - 460 / 510) < 1e-9, c2.cryptoShare);

  console.log("\n== unpaid invoices never count as collected ==");
  ok("meg's unpaid 50 is excluded", c.grandTotal === 609, "unpaid leaked in");

  console.log(fails ? `\n${fails} FAILURE(S)\n` : "\nall collected-split behaviours correct\n");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("threw:", e); process.exit(1); });
