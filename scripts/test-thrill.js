// Exercises the Thrill client against a stubbed API.
//
// The two things most likely to be wrong here are money and dates, and both fail
// SILENTLY: atomic units render a plausible-looking wrong number, and an
// exclusive toDate quietly drops the last day of a race — the day that decides
// the winner. Both are pinned below.
const path = require("path");
const ROOT = path.join(__dirname, "..", "netlify", "functions", "_lib");

let fails = 0;
const ok = (l, c, x) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${l}${c ? "" : "   <-- " + x}`); if (!c) fails++; };

// Thrill's own documented example response.
const SAMPLE = {
  items: [
    { username: "bigjohn", campaignName: "Initial Default", createdAt: "2025-08-17T11:37:10.478625Z",
      wager: { value: "123310000000000000000", currency: "USD", decimals: 18 },
      earning: { value: "61655000000000000", currency: "USD", decimals: 18 },
      xp: { value: "0", decimals: 0 } },
    { username: "reame2", campaignName: "Initial Default", createdAt: "2025-08-09T09:53:35.344773Z",
      wager: { value: "255673275000000000000", currency: "USD", decimals: 18 },
      earning: { value: "127836637500000000000", currency: "USD", decimals: 18 },
      xp: { value: "2569799550000000000000", decimals: 18 } },
    { username: "satoshi", campaignName: "Initial Default", createdAt: "2025-08-09T08:55:56.918589Z",
      wager: { value: "470880000000000000000", currency: "USD", decimals: 18 },
      earning: { value: "235440000000000000", currency: "USD", decimals: 18 },
      xp: { value: "0", decimals: 0 } },
    // Referred but never played — must not occupy a prize rank.
    { username: "lurker", wager: { value: "0", decimals: 18 }, xp: { value: "0", decimals: 0 } },
  ],
  isLastBatch: true,
  totalCount: 4,
};

let lastUrl = null, lastCookie = null, mode = "ok";
global.fetch = async (url, opts) => {
  lastUrl = url;
  lastCookie = (opts && opts.headers && opts.headers.Cookie) || null;
  if (mode === "expired") return { status: 403, ok: false, json: async () => ({ errorCode: "invalid_user_error", message: "User with current JWT not valid" }) };
  if (mode === "down")    return { status: 502, ok: false, json: async () => ({}) };
  if (mode === "throw")   throw new Error("ECONNRESET");
  return { status: 200, ok: true, json: async () => SAMPLE };
};

const { fetchThrillBoard, fromAtomic, ThrillAuthError } = require(path.join(ROOT, "thrill.js"));

(async () => {
  const FROM = Date.UTC(2026, 7, 26, 11, 0, 0);   // 26 Aug
  const TO   = Date.UTC(2026, 8, 2, 10, 59, 0);   // 2 Sep — inclusive end, as our races store it

  console.log("\n== money: atomic units become real amounts ==");
  ok("123310000000000000000 @18dp -> 123.31", fromAtomic("123310000000000000000", 18) === 123.31, fromAtomic("123310000000000000000", 18));
  ok("0 @0dp -> 0", fromAtomic("0", 0) === 0, fromAtomic("0", 0));
  ok("non-numeric junk does not throw", fromAtomic("not-a-number", 18) === 0, fromAtomic("not-a-number", 18));
  ok("null value -> 0", fromAtomic(null, 18) === 0, fromAtomic(null, 18));

  console.log("\n== a normal fetch ==");
  const r = await fetchThrillBoard("TOKEN123", FROM, TO);
  ok("3 players (the 0-wager one is dropped)", r.rankings.length === 3, r.rankings.length);
  ok("sorted by wager, satoshi first", r.rankings[0].username === "satoshi", r.rankings[0].username);
  ok("ranks are 1..n", r.rankings.map(x => x.rank).join(",") === "1,2,3", r.rankings.map(x => x.rank).join(","));
  ok("total = 470.88 + 255.673275 + 123.31", Math.abs(r.totalWagered - 849.863275) < 1e-6, r.totalWagered);

  console.log("\n== the date window ==");
  ok("sends the cookie header", lastCookie === "token=TOKEN123", lastCookie);
  ok("fromDate is the race start", /fromDate=2026-08-26/.test(lastUrl), lastUrl);
  // Thrill's toDate is EXCLUSIVE. A race ending 2 Sep must ask for the 3rd, or
  // the final day never counts.
  ok("toDate is start-of-next-day (exclusive end handled)", /toDate=2026-09-03/.test(lastUrl), lastUrl);

  console.log("\n== an expired session must be loud, not empty ==");
  mode = "expired";
  let threw = null;
  try { await fetchThrillBoard("DEAD", FROM, TO); } catch (e) { threw = e; }
  ok("throws rather than returning an empty board", !!threw, "returned quietly");
  ok("throws ThrillAuthError", threw instanceof ThrillAuthError, threw && threw.name);
  ok("flagged authFailed", threw && threw.authFailed === true, "no flag");

  console.log("\n== other failures return null so the caller can serve cache ==");
  mode = "down";
  ok("5xx -> null", (await fetchThrillBoard("T", FROM, TO)) === null, "not null");
  mode = "throw";
  ok("network error -> null", (await fetchThrillBoard("T", FROM, TO)) === null, "not null");
  mode = "ok";
  ok("missing token -> null (no pointless call)", (await fetchThrillBoard("", FROM, TO)) === null, "not null");

  console.log(fails ? `\n${fails} FAILURE(S)\n` : "\nthrill client correct\n");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("threw:", e); process.exit(1); });
