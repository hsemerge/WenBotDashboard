// Parse every inline <script type="module"> in the site's HTML.
//
// WHY THIS EXISTS: the build's terser pass validates syntax but NOT early
// errors — a duplicate `const` in the same scope, or a stray `}` left by an
// edit, parses fine there and is rejected outright by the browser, which then
// runs none of the page's JavaScript. A 200 OK serving a completely dead page
// is the worst kind of failure: every automated check passes.
//
// Node's own module parser catches exactly this class, so the build now asks it.
// A module script is its own scope, so each block is checked independently.
// Classic <script> blocks are skipped: they share one global scope across tags
// and legitimately redeclare things, so parsing them in isolation would report
// failures that aren't real.
//
// USAGE:  node scripts/check-inline-js.js
//         node scripts/check-inline-js.js admin/portal/index.html   (one file)

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".netlify", "Games", "MegWebsite", "wenbot-extension"]);

function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) htmlFiles(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// Imports point at a CDN; we are parsing, not running, so make the specifier
// bare rather than resolving anything over the network.
const deCdn = (js) => js.replace(/from\s+["']https?:\/\/[^"']+["']/g, 'from "node:util"');

function checkFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const problems = [];
  const re = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/gi;
  let m, n = 0;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf("</script>", start);
    if (end < 0) continue;
    n++;
    const tmp = path.join(os.tmpdir(), `inline-check-${process.pid}-${n}.mjs`);
    fs.writeFileSync(tmp, deCdn(src.slice(start, end)));
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (e) {
      const detail = (e.stderr || e.stdout || "").toString().split("\n").slice(0, 12).join("\n");
      problems.push(`  module script #${n}:\n${detail}`);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  return { count: n, problems };
}

const args = process.argv.slice(2);
const files = args.length ? args.map((f) => path.resolve(ROOT, f)) : htmlFiles(ROOT);

let modules = 0, bad = 0;
for (const f of files) {
  const { count, problems } = checkFile(f);
  modules += count;
  if (problems.length) {
    bad++;
    console.error(`\n✗ ${path.relative(ROOT, f)}`);
    problems.forEach((p) => console.error(p));
  }
}

if (bad) {
  console.error(`\n${bad} file(s) contain a module script the browser would refuse to run.`);
  process.exit(1);
}
console.log(`ok   ${modules} inline module script(s) parse across ${files.length} html file(s)`);
