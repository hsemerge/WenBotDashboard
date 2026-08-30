// Every /api/... path the UI calls must have an explicit redirect in
// netlify.toml, because there is NO catch-all /api/* rule — each endpoint is
// declared one at a time.
//
// That makes adding a function a two-step job, and the second step fails
// silently: the function deploys fine, the build is green, and the call 404s
// only when a human clicks the button. This catches the missing half at build
// time instead.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");

// from = "/api/whatever"   (ignore wildcard rules, they cover themselves)
const declared = new Set(
  [...toml.matchAll(/from\s*=\s*"(\/api\/[^"*]+)"/g)].map((m) => m[1].replace(/\/+$/, ""))
);

// Any file that can issue a call. Scan the sources, never dist/.
const SCAN = ["admin/portal/index.html", "dashboard.html", "index.html"]
  .map((f) => path.join(ROOT, f))
  .filter((f) => fs.existsSync(f));
const JS_DIR = path.join(ROOT, "js");
if (fs.existsSync(JS_DIR)) {
  for (const f of fs.readdirSync(JS_DIR)) if (f.endsWith(".js")) SCAN.push(path.join(JS_DIR, f));
}

const called = new Map();                       // path -> file that calls it
const CALL = /["'`](\/api\/[a-zA-Z0-9\-_]+)["'`]/g;
for (const file of SCAN) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(CALL)) {
    if (!called.has(m[1])) called.set(m[1], path.relative(ROOT, file));
  }
}

const missing = [...called.keys()].filter((p) => !declared.has(p)).sort();

// A declared route pointing at a function that does not exist is dead config —
// report it quietly rather than failing anyone's build over it.
//
// Read the redirect's actual `to` target. A route does NOT have to point at a
// function of the same name: /api/jetpacks-announce deliberately resolves to
// wenball-announce, because one relay serves both games. Inferring the function
// name from the path instead calls that shared route broken.
const fnDir = path.join(ROOT, "netlify", "functions");
const haveFn = new Set(
  fs.readdirSync(fnDir).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3))
);
const targetOf = new Map();
for (const m of toml.matchAll(/from\s*=\s*"(\/api\/[^"*]+)"\s*\n\s*to\s*=\s*"([^"]+)"/g)) {
  targetOf.set(m[1].replace(/\/+$/, ""), m[2]);
}
const orphaned = [...declared].filter((p) => {
  const to = targetOf.get(p);
  if (!to) return false;                                   // no to= parsed; leave it
  const m = to.match(/^\/\.netlify\/functions\/([a-zA-Z0-9\-_]+)/);
  return !!m && !haveFn.has(m[1]);
});

if (missing.length) {
  console.error(`\nFAIL  ${missing.length} /api path(s) are called but have no redirect in netlify.toml.`);
  console.error("      Without one they return 404 at runtime — the build stays green.\n");
  for (const p of missing) {
    console.error(`  ${p}   (called from ${called.get(p)})`);
    console.error(`    [[redirects]]\n      from   = "${p}"\n      to     = "/.netlify/functions/${p.replace(/^\/api\//, "")}"\n      status = 200\n`);
  }
  process.exit(1);
}

if (orphaned.length) {
  console.log(`note  ${orphaned.length} route(s) point at a function that does not exist: ${orphaned.join(", ")}`);
}
console.log(`ok   ${called.size} /api path(s) called by the UI, all routed`);
