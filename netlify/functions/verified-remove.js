// POST /api/verified-remove  { docId, uid? }
//
// Removes a verified user from the streamer's dashboard AND takes back the
// Discord verified role that verification granted.
//
// Why this exists as an endpoint at all: the dashboard used to delete the
// verified_users doc (and its discord_links rows) straight from the browser.
// That works for Firestore, but the Discord bot token is server-side only, so
// the role was never revoked — a streamer removed someone and they kept their
// verified role and the access it opens. Routing the delete through here lets
// the same action do both.
//
// Mirrors verify-unlink.js, which already does this when a VIEWER unlinks
// themselves; this is the streamer/mod-initiated side of the same operation.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { logAudit }            = require("./_lib/audit");
const { revokeVerifiedRole }  = require("./_lib/discord-role");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "verified_remove", 60, 60))) {
    return res(429, { error: "Too many requests" });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const docId = String(body.docId || "").trim();
  if (!docId) return res(400, { error: "Missing docId" });

  const idToken = (event.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!idToken) return res(401, { error: "Missing auth token" });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return res(401, { error: "Invalid auth token" }); }

  // Operate on the MANAGED streamer, not the caller's own account, so a mod
  // working someone else's dashboard doesn't 404 against their own uid.
  const delegated = Array.isArray(decoded.delegatedFor) ? decoded.delegatedFor : [];
  const uid = (body.uid || "").trim() || decoded.uid;
  if (uid !== decoded.uid && !delegated.includes(uid)) {
    return res(403, { error: "Not authorized for that account" });
  }

  try {
    const ref  = db.collection("streamers").doc(uid).collection("verified_users").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return res(404, { error: "Verified user not found" });
    const v = snap.data();
    const kickName = v.kickName || "";

    // Verifications are stored per casino as `<kickkey>_<provider>`, so one
    // person can hold several. Removing their Gambulls record must NOT strip a
    // role they still hold through, say, Winovo — otherwise a streamer tidying
    // one board silently locks a still-verified viewer out of the Discord.
    //
    // Siblings are found by DOC-ID PREFIX rather than a kickName query: ids are
    // built from the lowercased name, while the kickName FIELD keeps Kick's
    // original casing, so a field match would miss on case alone.
    const kickKey = docId.slice(0, docId.lastIndexOf("_"));
    let stillVerifiedElsewhere = false;
    if (kickKey) {
      const sibs = await db.collection("streamers").doc(uid).collection("verified_users")
        .orderBy(admin.firestore.FieldPath.documentId())
        .startAt(`${kickKey}_`).endAt(`${kickKey}_`)
        .get();
      stillVerifiedElsewhere = sibs.docs.some((d) => d.id !== docId);
    }

    // Their Discord link is only torn down when nothing else keeps them
    // verified. Matched case-insensitively in memory: discord_links rows were
    // written from whatever casing the viewer verified with.
    let linkDocs = [];
    if (!stillVerifiedElsewhere && kickName) {
      const wanted = kickName.toLowerCase();
      const linksSnap = await db.collection("streamers").doc(uid).collection("discord_links").get();
      linkDocs = linksSnap.docs.filter(
        (d) => String(d.data().kickUsername || "").toLowerCase() === wanted
      );
    }

    // Read what we need off the link docs BEFORE anything is deleted. A
    // snapshot keeps its data after the delete, but depending on that is a
    // trap for the next person editing this — capture it while it plainly
    // exists.
    const linkInfo = linkDocs.map((d) => ({
      ref: d.ref,
      discordUserId:   d.data().discordUserId,
      discordUsername: d.data().discordUsername,
    }));

    // Role first: deleting the link would lose the Discord id we need to
    // address the member.
    let roleRevoked = false;
    const streamerSnap = await db.collection("streamers").doc(uid).get();
    const streamerData = streamerSnap.exists ? streamerSnap.data() : {};
    for (const l of linkInfo) {
      const discordUserId = l.discordUserId;
      if (!discordUserId) continue;
      try {
        const r = await revokeVerifiedRole(streamerData, discordUserId);
        if (r && r.ok) roleRevoked = true;
      } catch (e) {
        // A Discord hiccup must not block the removal the streamer asked for.
        console.warn("[verified-remove] role revoke failed:", e.message);
      }
    }

    // ── Keep the identifiers before the record goes ──────────────────────────
    // Same contract as verify-unlink: the delete is real (the entry has to go),
    // but connHash, kickUserId, providerUid and discordUserId are archived first
    // into a collection nothing else queries and no client can write.
    //
    // This path matters MORE than the self-serve one. A mod can remove any
    // viewer, mods can run /lookup, and /lookup names the accounts someone is
    // linked to — so the person best placed to see an alt flag pointing at them
    // is also the one holding the Remove button. Alt matching needs both halves
    // of a pair, so removing one entry used to clear the link off the other too.
    // Removal now costs the entry, not the evidence.
    try {
      await db.collection("streamers").doc(uid)
        .collection("verified_released").doc(`${docId}_${Date.now()}`)
        .set({
          kickName:               kickName || null,
          kickName_lower:         (kickName || "").toLowerCase() || null,
          kickUserId:             v.kickUserId || null,
          provider:               v.provider || null,
          providerUsername:       v.providerUsername || null,
          providerUsername_lower: v.providerUsername_lower || null,
          providerUid:            v.providerUid || null,
          discordUserId:          v.discordUserId || (linkInfo[0] || {}).discordUserId || null,
          discordUsername:        v.discordUsername || (linkInfo[0] || {}).discordUsername || null,
          connHash:               v.connHash || null,
          connLabel:              v.connLabel || null,
          verifiedAt:             v.verifiedAt || null,
          releasedAt:             Date.now(),
          releasedBy:             "mod",
          // WHO removed it. The self-serve path cannot record this (the actor is
          // the viewer); here it is the whole point — a removal is an action a
          // named person took, and if it turns out to have been self-serving
          // that name is the first thing you need.
          removedByUid:           decoded.uid || null,
          removedByEmail:         decoded.email || null,
        });
    } catch (e) {
      // Never block a removal a streamer asked for because the archive failed.
      console.warn("[verified-remove] release snapshot failed:", e.message);
    }

    const batch = db.batch();
    batch.delete(ref);
    linkInfo.forEach((l) => batch.delete(l.ref));
    await batch.commit();

    // Durable trail on the viewer, so /lookup and the alt check still show that
    // this happened after the record itself is gone.
    try {
      const { recordViewerEvent } = require("./_lib/viewer-history");
      if (kickName) {
        await recordViewerEvent(db, uid, kickName, {
          type: "verify_removed_by_mod",
          text: `Verification removed by a moderator`
              + (v.provider ? ` (${v.provider})` : "")
              + (decoded.email ? ` — ${decoded.email}` : ""),
        });
      }
    } catch { /* history is best-effort, never break the removal */ }

    // Awaited: Netlify freezes the container the moment the response returns.
    await logAudit(uid, "verified_user_removed", {
      docId,
      kickUsername: kickName,
      provider: v.provider || null,
      discordLinksRemoved: linkInfo.length,
      discordUsernames: linkInfo.map((l) => l.discordUsername).filter(Boolean),
      roleRevoked,
      stillVerifiedElsewhere,
      // Named, so the Activity log answers "who removed this" without a lookup.
      removedByEmail: decoded.email || null,
      // Whether the record carried a connection fingerprint. The hash itself is
      // never logged — only that one existed, and its coarse label.
      hadConnection: !!v.connHash,
      connLabel: v.connLabel || null,
    });

    return res(200, {
      ok: true,
      kickName,
      roleRevoked,
      linksRemoved: linkInfo.length,
      stillVerifiedElsewhere,
    });
  } catch (err) {
    console.error("[verified-remove]", err.message);
    return res(500, { error: "Removal failed" });
  }
};
