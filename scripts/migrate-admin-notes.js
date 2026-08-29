// Move existing admin notes off the streamer document.
//
// `adminNotes` lived on `streamers/{uid}`, which firestore.rules lets the
// streamer AND their moderators read. Firestore has no field-level read rules,
// so every internal note ever written was readable by the person it was about —
// "trial ends soon, try to convert", "comped for launch help, revisit Aug".
// Nothing displayed it to them, but the client SDK would hand it over on
// request.
//
// This copies each note into admin_notes/{uid}/entries (admin-SDK only, denied
// to every client by firestore.rules) and then CLEARS the field on the streamer
// doc. admin-user-note.js does the same migration lazily whenever a note is
// next written, so this script is for clearing the back catalogue at once.
//
// USAGE (dry run prints the plan and writes NOTHING):
//   FIREBASE_SERVICE_ACCOUNT_BASE64=… node scripts/migrate-admin-notes.js
//   …                                                                 … --apply

const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");

function getDb() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) { console.error("Set FIREBASE_SERVICE_ACCOUNT_BASE64."); process.exit(1); }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))) });
  return admin.firestore();
}

(async () => {
  const db = getDb();
  const snap = await db.collection("streamers").get();

  const work = [];
  snap.forEach((d) => {
    const x = d.data();
    const text = String(x.adminNotes || "").trim();
    if (text) work.push({ ref: d.ref, uid: d.id, channel: x.kickChannel || d.id, text,
                          by: x.adminNotesUpdatedBy || "unknown",
                          at: Number(x.adminNotesUpdatedAt) || Date.now() });
  });

  if (!work.length) { console.log("No notes left on any streamer document. Nothing to move."); process.exit(0); }

  console.log(`${work.length} account(s) still carry a readable admin note:\n`);
  work.forEach((w) => {
    console.log(`  ${String(w.channel).padEnd(18)} ${w.text.replace(/\s+/g, " ").slice(0, 68)}${w.text.length > 68 ? "…" : ""}`);
  });
  console.log(`\nEach moves to admin_notes/${"{uid}"}/entries and is cleared from the streamer doc.`);

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

  for (const w of work) {
    const nref = db.collection("admin_notes").doc(w.uid);
    // Skip if this exact note is already in the thread (the lazy migration in
    // admin-user-note.js may have moved it), so re-running can't duplicate.
    const dupe = await nref.collection("entries").where("text", "==", w.text).limit(1).get();
    if (dupe.empty) await nref.collection("entries").add({ text: w.text, by: w.by, at: w.at, migrated: true });
    const latest = await nref.collection("entries").orderBy("at", "desc").limit(1).get();
    const top = latest.empty ? null : latest.docs[0].data();
    const count = await nref.collection("entries").count().get().catch(() => null);
    await nref.set({
      channel: w.channel,
      latest: top ? top.text : null,
      at: top ? top.at : null,
      by: top ? top.by : null,
      count: count ? count.data().count : 1,
    }, { merge: true });
    await w.ref.set({ adminNotes: "", adminNotesUpdatedAt: null, adminNotesUpdatedBy: null }, { merge: true });
    console.log(`  ✅ ${w.channel}`);
  }
  console.log(`\n✅ Moved ${work.length} note(s) out of reach of the streamers they describe.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
