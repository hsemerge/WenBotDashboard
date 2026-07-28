// One-off migration: import a Botrix loyalty-table export into a streamer's
// WenBot channel points (streamers/{uid}/viewers/{lowercased-username}.points).
//
// Botrix exports a .xlsx with columns: Username | Level | Points | Watchtime.
// Only Username + Points are used — WenBot has no level/watchtime concept.
//
// Usage:
//   node scripts/import-botrix-points.js --channel <kickChannel> --file <export.xlsx>
//     [--mode set|add] [--apply]
//
//   --mode set  (default) points := Botrix value. Re-runnable, idempotent.
//   --mode add  points += Botrix value. NOT idempotent — never run twice.
//   --apply     actually write. Without it the script is a dry run.
//
// Credentials come from the same env vars the Netlify functions use. Pull them
// with: npx netlify env:get FIREBASE_PRIVATE_KEY (etc.)

const fs   = require("fs");
const zlib = require("zlib");
const admin = require("firebase-admin");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg  = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const CHANNEL = String(arg("channel", "")).toLowerCase().trim();
const FILE    = arg("file", "");
const MODE    = arg("mode", "set");
const APPLY   = argv.includes("--apply");
// Botrix tracks bot accounts alongside real viewers — pass them here to skip.
const EXCLUDE = new Set(String(arg("exclude", "")).toLowerCase().split(",").map(s => s.replace(/^@/, "").trim()).filter(Boolean));

if (!CHANNEL || !FILE) {
  console.error("Usage: node scripts/import-botrix-points.js --channel <kickChannel> --file <export.xlsx> [--mode set|add] [--apply]");
  process.exit(1);
}
if (MODE !== "set" && MODE !== "add") {
  console.error(`--mode must be "set" or "add" (got "${MODE}")`);
  process.exit(1);
}

// ── minimal xlsx reader ─────────────────────────────────────────────────────
// A .xlsx is a zip. We only need sheet1 + (if present) sharedStrings. Rather
// than pull in a dependency for a one-off, walk the zip central directory and
// inflate the two entries we care about.
function unzip(buf) {
  const out = {};
  // End-of-central-directory record → central directory offset.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad central directory");
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const lhOff    = buf.readUInt32LE(p + 42);
    const name     = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // Local header has its own name/extra lengths — data starts after them.
    const lhNameLen  = buf.readUInt16LE(lhOff + 26);
    const lhExtraLen = buf.readUInt16LE(lhOff + 28);
    const dataStart  = lhOff + 30 + lhNameLen + lhExtraLen;
    const data       = buf.subarray(dataStart, dataStart + compSize);

    out[name] = method === 0 ? data : zlib.inflateRawSync(data);
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function readBotrixExport(path) {
  const files  = unzip(fs.readFileSync(path));
  const sheet  = files["xl/worksheets/sheet1.xml"];
  if (!sheet) throw new Error("No sheet1.xml — is this a Botrix xlsx export?");
  const xml = sheet.toString("utf8");

  // Shared strings are optional (Botrix inlines with t="str", but handle both).
  let shared = [];
  if (files["xl/sharedStrings.xml"]) {
    shared = [...files["xl/sharedStrings.xml"].toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)]
      .map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(""));
  }

  const unesc = s => s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

  const rows = [];
  for (const m of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const [, col, attrs, inner] = c;
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (v === undefined) continue;
      cells[col] = /t="s"/.test(attrs) ? (shared[+v] ?? "") : unesc(v);
    }
    rows.push(cells);
  }

  // Row 1 is the header (Username | Level | Points | Watchtime).
  return rows.slice(1)
    .map(r => ({ username: String(r.A || "").trim(), points: Math.round(Number(r.C || 0)) }))
    .filter(r => r.username && Number.isFinite(r.points));
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const raw = readBotrixExport(FILE);
  console.log(`Parsed ${raw.length} rows from ${FILE}`);

  // Botrix prefixes some names with "@"; WenBot doc IDs are the bare lowercased
  // Kick username. Collapse duplicates by keeping the highest points value.
  const byKey = new Map();
  let skipped = 0;
  for (const r of raw) {
    const key = r.username.replace(/^@/, "").toLowerCase();
    if (!key || r.points <= 0 || EXCLUDE.has(key)) { skipped++; continue; }
    byKey.set(key, Math.max(byKey.get(key) || 0, r.points));
  }
  console.log(`→ ${byKey.size} unique viewers with points (${skipped} skipped: blank or zero)`);

  // Credentials: --creds <path to {projectId, clientEmail, privateKey} json>,
  // or the same env vars the Netlify functions use. Keep any creds file OUTSIDE
  // the repo — this is a local one-off, nothing here should be committed.
  const credsPath = arg("creds", "");
  const creds = credsPath
    ? JSON.parse(fs.readFileSync(credsPath, "utf8"))
    : {
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY,
      };
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   creds.projectId,
      clientEmail: creds.clientEmail,
      privateKey:  String(creds.privateKey || "").replace(/\\n/g, "\n"),
    }),
  });
  const db = admin.firestore();

  const sSnap = await db.collection("streamers").where("kickChannel", "==", CHANNEL).limit(1).get();
  if (sSnap.empty) throw new Error(`No streamer found with kickChannel "${CHANNEL}"`);
  const uid = sSnap.docs[0].id;
  const currency = sSnap.docs[0].data().currencyName || "points";
  console.log(`Streamer: ${CHANNEL} → uid ${uid} (currency: "${currency}")`);

  const col = db.collection("streamers").doc(uid).collection("viewers");
  const keys = [...byKey.keys()];

  // Read current values so the dry run can show real before/after and flag
  // viewers who already have points (i.e. a prior import or live earning).
  const existing = new Map();
  for (let i = 0; i < keys.length; i += 300) {
    const refs = keys.slice(i, i + 300).map(k => col.doc(k));
    const docs = await db.getAll(...refs);
    docs.forEach((d, j) => existing.set(keys[i + j], d.exists ? (d.data().points || 0) : null));
  }

  const plan = keys.map(k => {
    const before = existing.get(k);
    const imported = byKey.get(k);
    return {
      key: k,
      isNew: before === null,
      before: before || 0,
      after: MODE === "set" ? imported : (before || 0) + imported,
      imported,
    };
  }).sort((a, b) => b.imported - a.imported);

  const withPoints = plan.filter(p => p.before > 0);
  console.log(`\nExisting docs: ${plan.filter(p => !p.isNew).length} | new docs: ${plan.filter(p => p.isNew).length}`);
  console.log(`Already holding points > 0: ${withPoints.length}`);
  if (withPoints.length) {
    console.log("  (mode=set overwrites these; mode=add stacks on top)");
    withPoints.slice(0, 15).forEach(p => console.log(`    ${p.key.padEnd(24)} ${String(p.before).padStart(8)} → ${p.after}`));
    if (withPoints.length > 15) console.log(`    …and ${withPoints.length - 15} more`);
  }

  console.log(`\nTop 10 by imported value:`);
  plan.slice(0, 10).forEach(p => console.log(`  ${p.key.padEnd(24)} ${String(p.before).padStart(8)} → ${p.after}`));
  console.log(`\nTotal ${currency} imported: ${plan.reduce((s, p) => s + p.imported, 0).toLocaleString()}`);

  if (!APPLY) {
    console.log(`\n[DRY RUN] mode=${MODE}. Nothing written. Re-run with --apply to commit.`);
    return;
  }

  let written = 0;
  for (let i = 0; i < plan.length; i += 400) {
    const batch = db.batch();
    for (const p of plan.slice(i, i + 400)) {
      batch.set(col.doc(p.key), {
        points: MODE === "set"
          ? p.after
          : admin.firestore.FieldValue.increment(p.imported),
        botrixImportedAt: Date.now(),
      }, { merge: true });
      written++;
    }
    await batch.commit();
    console.log(`  committed ${Math.min(i + 400, plan.length)}/${plan.length}`);
  }
  console.log(`\n✅ Wrote ${written} viewer docs for ${CHANNEL} (mode=${MODE}).`);
})().catch(e => { console.error("\n❌", e.message); process.exit(1); });
