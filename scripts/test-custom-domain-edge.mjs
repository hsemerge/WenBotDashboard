// Behaviour test for the custom-domain edge function.
//
// This function runs on every request to the site. An uncaught throw here is not
// a degraded feature — it is Netlify's crash page instead of the streamer's
// site, for that request, with no partial failure mode. Meg saw exactly that on
// megrewards.com/csgobig.
//
// So what is pinned here is not routing detail but the failure behaviour: no
// input, and no failure inside the buffered OG rewrite, may throw out of the
// handler.
import { pathToFileURL } from "node:url";
import path from "node:path";

const mod = await import(pathToFileURL(path.join(process.cwd(), "netlify/edge-functions/custom-domain.js")).href);
const handler = mod.default;

let fails = 0;
const ok = (l, c, x) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${l}${c ? "" : "   <-- " + x}`); if (!c) fails++; };

const req = (u) => new Request(u);
// A context whose rewrite behaves however the test needs.
const ctx = (rewrite) => ({ rewrite });
const okRewrite = async () => new Response("<html>MegRewards — Wager Race</html>", {
  status: 200, headers: { "content-type": "text/html" },
});

console.log("\n== the shape Netlify needs ==");
ok("default export is a function", typeof handler === "function", typeof handler);
ok("config.path is /*", mod.config && mod.config.path === "/*", JSON.stringify(mod.config));

console.log("\n== normal routing still works ==");
let rewroteTo = null;
const capture = ctx(async (u) => { rewroteTo = u; return okRewrite(); });

await handler(req("https://megrewards.com/"), capture);
ok("known host is rewritten", rewroteTo !== null, "no rewrite happened");

rewroteTo = null;
const passthrough = await handler(req("https://wenbot.gg/anything"), capture);
ok("unknown host passes through untouched", passthrough === undefined && rewroteTo === null, "it rewrote");

rewroteTo = null;
await handler(req("https://megrewards.com/assets/logo.png"), capture);
ok("asset requests are not rewritten", rewroteTo === null, rewroteTo);

rewroteTo = null;
await handler(req("https://megrewards.com/api/portal-data"), capture);
ok("/api/* is not rewritten", rewroteTo === null, rewroteTo);

console.log("\n== nothing buffers the response ==");
// The crash Meg hit came from /csgobig reading the whole page into memory to
// rewrite its OpenGraph tags. That was the only non-streaming path here, and so
// the only one that could fail for a reason other than routing. It is gone.
//
// Asserted against the SOURCE, not behaviour: a reintroduced buffer would pass
// every behavioural test below right up until the day it throws in production.
const src = await (await import("node:fs/promises")).readFile(
  path.join(process.cwd(), "netlify/edge-functions/custom-domain.js"), "utf8");
ok("no .text() on a rewrite result", !/\.text\(\)/.test(src), "something buffers the body again");
ok("no hand-built Response", !/new Response\(/.test(src), "a path builds its own Response");

// And the handler still survives a rewrite that misbehaves, whatever the path.
const breakages = [
  ["rewrite() rejects",      ctx(async () => { throw new Error("rewrite blew up"); })],
  ["rewrite() returns null", ctx(async () => null)],
  ["rewrite() returns junk", ctx(async () => 42)],
];
for (const [name, c] of breakages) {
  let threw = null;
  try { await handler(req("https://megrewards.com/csgobig"), c); }
  catch (e) { threw = e; }
  ok(`/csgobig survives: ${name}`, threw === null, threw && threw.message);
}

console.log("\n== and no other path can crash it either ==");
const hostile = ctx(async () => { throw new Error("everything is broken"); });
for (const p of ["/", "/csgobig", "/store", "/verify", "/terms", "/wild-unknown-path", "/%E0%A4%A"]) {
  let threw = null;
  try { await handler(req("https://megrewards.com" + p), hostile); }
  catch (e) { threw = e; }
  ok(`no throw escapes for ${p}`, threw === null, threw && threw.message);
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : "\ncustom-domain edge function fails safe\n");
process.exit(fails ? 1 : 0);
