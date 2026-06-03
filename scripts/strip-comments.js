// Build step (npm run build) — produces a curated, comment-free `dist/` that
// Netlify publishes.
//
// 1. Copy the FRONT-END into dist/, excluding backend/infra/dev files (see
//    COPY_SKIP). This also keeps node_modules, firestore.rules, .firebaserc,
//    internal docs/PDFs, etc. OUT of the public deploy.
// 2. Strip developer comments from the HTML/JS in dist/ (terser with compress +
//    mangle OFF, so only comments/whitespace go — logic is unchanged). HTML
//    whitespace is preserved (collapseWhitespace off) to avoid layout surprises.
//
// The git repo keeps the commented source; this only shapes what's served.
// Backend (netlify/functions, netlify/edge-functions) is never copied here —
// Netlify reads those from their own dirs, untouched.
//
// Failure policy: copy/setup errors are FATAL (the deploy fails and Netlify keeps
// the previous good deploy — never publishes a half-built site). Per-file strip
// errors are caught and the original file is kept, so one quirky file can't break
// the build.

const fs   = require("fs");
const path = require("path");

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");

// Names NOT copied into the public dist (backend, infra, manifests, dev, docs).
const COPY_SKIP = new Set([
  "node_modules", ".git", ".netlify", ".github", "netlify", "scripts", "dist",
  "package.json", "package-lock.json", "deno.lock",
  ".gitignore", ".firebaserc", "firebase.json", "firestore.rules", "netlify.toml",
  "local-proxy.js", "docs",
]);
// Extensions never served publicly.
const SKIP_EXT = new Set([".md", ".pdf", ".bak"]);

const TERSER_OPTS = { compress: false, mangle: false, format: { comments: false } };

function shouldCopy(name) {
  if (name.startsWith(".")) return false;        // dotfiles
  if (COPY_SKIP.has(name)) return false;
  if (SKIP_EXT.has(path.extname(name).toLowerCase())) return false;
  return true;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

(async () => {
  const { minify: minifyHtml } = require("html-minifier-terser");
  const { minify: minifyJs }   = require("terser");

  // 1. Fresh dist + curated copy (fatal on failure → keeps last good deploy).
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  let copied = 0;
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!shouldCopy(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(DIST, e.name), { recursive: true });
    copied++;
  }
  console.log(`[build] copied ${copied} top-level item(s) into dist/`);

  // 2. Strip comments from HTML/JS in dist (per-file tolerant).
  let html = 0, js = 0, errors = 0;
  for (const f of walk(DIST)) {
    try {
      if (f.endsWith(".html")) {
        const out = await minifyHtml(fs.readFileSync(f, "utf8"), {
          removeComments: true,
          collapseWhitespace: false,
          minifyJS: TERSER_OPTS,
          minifyCSS: false,
        });
        if (out && out.length) { fs.writeFileSync(f, out); html++; }
      } else if (f.endsWith(".js")) {
        const r = await minifyJs(fs.readFileSync(f, "utf8"), TERSER_OPTS);
        if (r && r.code) { fs.writeFileSync(f, r.code); js++; }
      }
    } catch (e) {
      console.warn(`[build] kept original (could not strip) ${path.relative(DIST, f)}: ${e.message}`);
      errors++;
    }
  }
  console.log(`[build] stripped html:${html} js:${js} kept-on-error:${errors}`);
})().catch((e) => {
  // Copy/setup failure is fatal — fail the deploy so the last good one stays live.
  console.error("[build] FATAL:", e.message);
  process.exit(1);
});
