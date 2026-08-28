// Bake the custom-domain map into the edge function.
//
// Reads the `custom_domains` collection (managed from the admin portal) and
// rewrites netlify/edge-shared/domains.generated.js, which custom-domain.js
// imports. Runs as part of `npm run build`, so adding a domain in the portal
// takes effect on the next deploy without anyone editing code.
//
// FAIL-SAFE BY DESIGN: if Firestore can't be reached, or returns nothing, this
// exits 0 and leaves the committed file untouched. A build that can't see the
// database must ship the last known-good map — writing an empty one would take
// every Agency customer's domain offline, which is far worse than a stale entry.
//
// USAGE:
//   node scripts/bake-domains.js            # bake (quiet no-op without creds)
//   node scripts/bake-domains.js --check    # print what WOULD be written

const fs   = require("fs");
const path = require("path");

// NOT under netlify/edge-functions/: Netlify registers every file in that
// directory as an edge function, and this one exports constants rather than a
// default handler — which fails edge bundling and blocks the entire deploy.
const OUT = path.join(__dirname, "..", "netlify", "edge-shared", "domains.generated.js");
const CHECK = process.argv.includes("--check");

function creds() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) { try { return JSON.parse(Buffer.from(b64, "base64").toString("utf8")); } catch { return null; } }
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    };
  }
  return null;
}

function render(hostToSlug, slugToPage) {
  const j = (o) => Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
  return `// GENERATED — do not edit by hand.
//
// Written by scripts/bake-domains.js from the \`custom_domains\` collection, which
// the admin portal manages (Portal Management → Custom domains).
//
// Baked at build time rather than read at runtime because custom-domain.js is
// registered \`path: "/*"\` — it runs on EVERY request to the site, so a lookup
// there would tax every page load for everyone to serve a handful of domains.
//
// This file is committed, so a deploy never depends on the build being able to
// reach Firestore: if the bake can't connect it leaves the last good map in
// place rather than shipping an empty one and dropping every custom domain.

export const HOST_TO_SLUG = {
${j(hostToSlug)}
};

export const SLUG_TO_PAGE = {
${j(slugToPage)}
};
`;
}

(async () => {
  const sa = creds();
  if (!sa) { console.log("[bake-domains] no Firebase credentials — keeping the committed map."); process.exit(0); }

  let admin, db;
  try {
    admin = require("firebase-admin");
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
    db = admin.firestore();
  } catch (e) {
    console.log("[bake-domains] Firebase unavailable (" + e.message + ") — keeping the committed map.");
    process.exit(0);
  }

  let snap;
  try { snap = await db.collection("custom_domains").get(); }
  catch (e) { console.log("[bake-domains] read failed (" + e.message + ") — keeping the committed map."); process.exit(0); }

  const hostToSlug = {}, slugToPage = {};
  snap.forEach((d) => {
    const x = d.data();
    if (!x || x.enabled === false || !x.host || !x.slug) return;
    hostToSlug[String(x.host).toLowerCase()] = String(x.slug).toLowerCase();
    if (x.page) slugToPage[String(x.slug).toLowerCase()] = String(x.page);
  });

  if (!Object.keys(hostToSlug).length) {
    console.log("[bake-domains] collection is empty — keeping the committed map (refusing to ship an empty one).");
    process.exit(0);
  }

  const out = render(hostToSlug, slugToPage);
  if (CHECK) { console.log(out); process.exit(0); }

  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (prev === out) { console.log(`[bake-domains] up to date (${Object.keys(hostToSlug).length} hosts).`); process.exit(0); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log(`[bake-domains] wrote ${Object.keys(hostToSlug).length} hosts → ${Object.keys(slugToPage).length} bespoke pages.`);
  process.exit(0);
})().catch((e) => { console.log("[bake-domains] " + e.message + " — keeping the committed map."); process.exit(0); });
