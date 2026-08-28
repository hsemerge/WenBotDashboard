// DEV-ONLY: make `netlify dev` serve this site's real pages.
//
// The production redirect engine serves real files before non-forced redirects,
// so the /:streamer and /:streamer/:tab portal catch-alls (netlify.toml) never
// shadow real pages in prod. The netlify-cli dev proxy is NOT at parity: any
// request a redirect rule doesn't claim gets a 403, the catch-alls swallow
// /admin and /dashboard.html with the streamer portal, and a rule whose target
// equals its source 403s as a loop. This script papers over all three for local
// work only:
//   1. copies dist/js  -> dist/devjs  and dist/img -> dist/devimg
//   2. writes dist/_redirects mapping the real paths onto those copies and the
//      admin/dashboard pages onto their files.
// dist/ is gitignored, so none of this can ship. Run AFTER every `npm run build`:
//   npm run build && node scripts/dev-static-shim.js

const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "..", "dist");
if (!fs.existsSync(dist)) { console.error("dist/ missing — run `npm run build` first."); process.exit(1); }

for (const [src, dst] of [["js", "devjs"], ["img", "devimg"]]) {
  const s = path.join(dist, src), d = path.join(dist, dst);
  if (!fs.existsSync(s)) continue;
  fs.rmSync(d, { recursive: true, force: true });
  fs.cpSync(s, d, { recursive: true });
}

const rules = `# DEV-ONLY shim written by scripts/dev-static-shim.js (dist/ is gitignored).
/js/*                   /devjs/:splat              200
/img/*                  /devimg/:splat             200
/admin/portal/          /admin/portal/index.html   200
/admin/portal           /admin/portal/index.html   200
/admin/                 /admin/index.html          200
/admin                  /admin/index.html          200
/dashboard.html         /admin/../dashboard.html   200
`;
// The self-target loop bug also bites /dashboard.html; route it through a copy.
fs.copyFileSync(path.join(dist, "dashboard.html"), path.join(dist, "devdashboard.html"));
fs.copyFileSync(path.join(dist, "login.html"), path.join(dist, "devlogin.html"));
fs.copyFileSync(path.join(dist, "admin", "wenbot-auth.html"), path.join(dist, "devwenbot-auth.html"));
const finalRules = rules.replace("/admin/../dashboard.html", "/devdashboard.html")
  + `/login.html             /devlogin.html             200\n`
  + `/admin/wenbot-auth.html /devwenbot-auth.html       200\n`;
fs.writeFileSync(path.join(dist, "_redirects"), finalRules);
console.log("dev shim written: dist/_redirects + devjs/ devimg/ dev*.html copies");
