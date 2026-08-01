// One-off migration: streamerdoc.leaderboardPeriod (+ hardcoded portal presets)
//   -> streamers/{uid}/leaderboards/{boardId}
//
// Run with --apply to write; without it this is a dry run and touches nothing.
//   node scripts/migrate-leaderboards.js
//   node scripts/migrate-leaderboards.js --apply
//
// SAFE TO RE-RUN. Existing board docs are left alone, so a partial run can simply
// be repeated. `leaderboardPeriod` is NOT deleted — readers fall back to it until
// every consumer is switched over, and leaving it makes rollback a no-op.
//
// Boards created per streamer:
//   1. The active provider, carrying leaderboardPeriod's window/baselines if set.
//   2. Any OTHER configured provider, created DISABLED — configured but not
//      currently shown (emergeonkick has stake alongside gambulls), so enabling
//      it should be a deliberate act, not a side effect of migrating.
//   3. Preset-driven boards that only ever existed in code (Meg's CSGOBig).

const path  = require("path");
const admin = require("firebase-admin");
const { boardIdFor, normalizeBoard } = require(path.join(__dirname, "..", "netlify", "functions", "_lib", "leaderboards"));

const APPLY = process.argv.includes("--apply");

// Accept either credential form so this runs wherever you have access: the
// individual vars the Netlify functions use, or the base64 service account the
// bot host provides (`railway run node scripts/migrate-leaderboards.js`).
function getDb() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (b64) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) });
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        }),
      });
    } else {
      console.error("No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_BASE64, or the FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY trio.");
      process.exit(1);
    }
  }
  return admin.firestore();
}

// Boards that live only in PORTAL_PRESETS today. Keyed by kick channel.
// Mirrors netlify/functions/portal-data.js — remove an entry once that preset's
// csgobig* fields are deleted from the code.
const PRESET_BOARDS = {
  irishqueenoftheslots: [
    {
      label:    "CSGOBig",
      provider: "csgobig",
      order:    1,
      enabled:  true,
      credential: { refCode: "MEG74637HDKOCUR8464" },
      period:   { mode: "cycle", cycleDay: 16 },
      prizes:   [2000, 1000, 500, 400, 300, 250, 200, 150, 100, 50, 25, 15, 10],
    },
  ],
};

// leaderboardPeriod.duration -> period mode. "custom" is still a fixed-length
// window that renews, so it stays rolling; only the absence of a period means
// the casino's own window is in charge.
function periodFromLegacy(lp) {
  if (!lp) return { mode: "provider" };
  return {
    mode:      "rolling",
    duration:  lp.duration || "monthly",
    autoRenew: lp.autoRenew !== false,
    startAt:   Number.isFinite(lp.startAt) ? lp.startAt : null,
    endAt:     Number.isFinite(lp.endAt)   ? lp.endAt   : null,
  };
}

(async () => {
  const db = getDb();
  const snap = await db.collection("streamers").get();
  let created = 0, skipped = 0, streamersTouched = 0;

  for (const doc of snap.docs) {
    const s       = doc.data();
    const channel = s.kickChannel || doc.id;
    const lp      = s.leaderboardPeriod || null;

    const provSnap = await doc.ref.collection("providers").get();
    const providers = provSnap.docs.map((p) => ({ id: p.id, ...p.data() }));
    const presets  = PRESET_BOARDS[channel] || [];
    if (!providers.length && !presets.length) continue;

    const existing = await doc.ref.collection("leaderboards").get();
    const taken    = existing.docs.map((d) => d.id);
    // Skip by PROVIDER, not by generated id. boardIdFor() would see "gambulls"
    // taken and hand back "gambulls-2", which then never matches an existing id —
    // so a re-run quietly created a duplicate of every board.
    const havePro  = new Set(existing.docs.map((d) => String((d.data() || {}).provider || "").toLowerCase()).filter(Boolean));
    const planned  = [];

    const active = (s.activeProvider || "").toLowerCase();
    const primary = providers.find((p) => p.id.toLowerCase() === active) || providers[0] || null;

    if (primary && !havePro.has(primary.id.toLowerCase())) {
      const id = boardIdFor(primary.id, taken);
      taken.push(id);
      planned.push({
        id,
        board: {
          label:    primary.id[0].toUpperCase() + primary.id.slice(1),
          provider: primary.id.toLowerCase(),
          order:    0,
          enabled:  true,
          credential: null,                    // inherits providers/{id}
          period:   periodFromLegacy(lp),
          prizes:   [],
          // Carry the live period state so a mid-window migration doesn't reset
          // anyone's board.
          baselines:    lp?.baselines    || {},
          carryover:    lp?.carryover    || {},
          liveSnapshot: lp?.liveSnapshot || {},
          excluded:     lp?.excluded     || [],
          anchorMonth:  lp?.anchorMonth  || null,
          carryMonth:   lp?.carryMonth   || null,
        },
      });
    }

    for (const p of providers) {
      if (primary && p.id === primary.id) continue;
      if (havePro.has(p.id.toLowerCase())) continue;
      const id = boardIdFor(p.id, taken);
      taken.push(id);
      planned.push({
        id,
        board: {
          label:    p.id[0].toUpperCase() + p.id.slice(1),
          provider: p.id.toLowerCase(),
          order:    planned.length,
          enabled:  false,                     // configured, not currently shown
          credential: null,
          period:   { mode: "provider" },
          prizes:   [],
        },
      });
    }

    for (const preset of presets) {
      if (havePro.has(String(preset.provider).toLowerCase())) continue;
      const id = boardIdFor(preset.provider, taken);
      taken.push(id);
      planned.push({ id, board: { ...preset, order: preset.order ?? planned.length } });
    }

    if (!planned.length) {
      if (havePro.size) { console.log(`
${channel}
  skip    already migrated (${[...havePro].join(", ")})`); skipped += havePro.size; }
      continue;
    }
    streamersTouched++;
    console.log(`\n${channel}`);
    for (const { id, board } of planned) {
      const norm = normalizeBoard(board, id);
      const win  = norm.period.mode;
      console.log(`  ${APPLY ? "create " : "would  "} ${id.padEnd(12)} ${norm.provider.padEnd(10)} order=${norm.order} enabled=${String(norm.enabled).padEnd(5)} period=${win}${norm.period.duration ? "/" + norm.period.duration : ""}${norm.period.cycleDay ? "/day" + norm.period.cycleDay : ""}${norm.prizes.length ? " prizes=" + norm.prizes.length : ""}`);
      if (APPLY) {
        const { id: _drop, ...toWrite } = norm;
        await doc.ref.collection("leaderboards").doc(id).set({ ...toWrite, createdAt: Date.now(), migratedFrom: lp ? "leaderboardPeriod" : "preset" });
        created++;
      }
    }
  }

  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"} — streamers: ${streamersTouched}, boards ${APPLY ? "created" : "to create"}: ${created || (streamersTouched ? "(see above)" : 0)}, skipped: ${skipped}`);
  if (!APPLY) console.log("Re-run with --apply to write. leaderboardPeriod is left in place either way.");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
