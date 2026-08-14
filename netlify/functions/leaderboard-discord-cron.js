// Scheduled hourly (see netlify.toml [functions."leaderboard-discord-cron"]).
// Posts live wager standings to each opted-in streamer's Discord channel on
// their chosen cadence.
//
// One hourly tick checks every streamer's own interval, so any cadence works
// without extra infrastructure. Netlify blocks HTTP invocation of scheduled
// functions, so the dashboard's manual button lives in leaderboard-discord-post
// and shares _lib/leaderboard-post.

const { getDb }         = require("./_lib/firebase");
const { postStandings } = require("./_lib/leaderboard-post");

exports.handler = async () => {
  const db = getDb();
  let posted = 0, skipped = 0, failed = 0;

  try {
    const snap = await db.collection("streamers")
      .where("lbDiscordPost.enabled", "==", true).get();

    for (const doc of snap.docs) {
      const cfg = doc.data().lbDiscordPost || {};

      const everyHours = Math.max(1, Math.min(Number(cfg.everyHours) || 5, 24));
      const dueAt = (cfg.lastPostAt || 0) + everyHours * 3600000;
      // 5 min of slack so an hourly tick that drifts late doesn't skip a slot.
      if (Date.now() < dueAt - 5 * 60000) { skipped++; continue; }

      const out = await postStandings(doc);
      if (!out.ok) {
        console.warn(`[lb-cron] ${doc.id}: ${out.error}`);
        failed++;
        // Stamp on a permissions / missing-channel failure so a broken setup
        // stops retrying every hour and surfaces on the dashboard instead.
        if (out.status === 403 || out.status === 404) {
          await doc.ref.set(
            { lbDiscordPost: { lastPostAt: Date.now(), lastError: out.error || null } },
            { merge: true }
          );
        }
        continue;
      }

      await doc.ref.set(
        { lbDiscordPost: { lastPostAt: Date.now(), lastError: null } },
        { merge: true }
      );
      posted++;
    }

    // ── Extra boards ──────────────────────────────────────────────────────────
    // Their config lives on the board doc, so it can't come from the query
    // above. A collectionGroup query would be cheaper but needs a
    // COLLECTION_GROUP index, and indexes deploy through a different Google
    // account than this repo does — not worth the dependency for one sweep.
    // ~40 small subcollection queries an hour today; revisit past a few hundred
    // streamers.
    const all = await db.collection("streamers").get();
    for (const sdoc of all.docs) {
      const sdata = sdoc.data();
      const boards = await sdoc.ref.collection("leaderboards")
        .where("discordPost.enabled", "==", true).get();

      for (const bdoc of boards.docs) {
        const bd  = bdoc.data() || {};
        const cfg = bd.discordPost || {};

        // The main board is driven by the streamer-level config above. If both
        // were set, the same race would post twice into the same channel.
        const isMain = String(bd.provider || "").toLowerCase()
                    === String(sdata.activeProvider || "").toLowerCase();
        if (isMain && (sdata.lbDiscordPost || {}).enabled === true) { skipped++; continue; }

        const everyHours = Math.max(1, Math.min(Number(cfg.everyHours) || 5, 24));
        const dueAt = (cfg.lastPostAt || 0) + everyHours * 3600000;
        if (Date.now() < dueAt - 5 * 60000) { skipped++; continue; }

        const out = await postStandings(sdoc, bdoc);
        if (!out.ok) {
          console.warn(`[lb-cron] ${sdoc.id}/${bdoc.id}: ${out.error}`);
          failed++;
          if (out.status === 403 || out.status === 404) {
            await bdoc.ref.set(
              { discordPost: { lastPostAt: Date.now(), lastError: out.error || null } },
              { merge: true }
            );
          }
          continue;
        }
        await bdoc.ref.set(
          { discordPost: { lastPostAt: Date.now(), lastError: null } },
          { merge: true }
        );
        posted++;
      }
    }

    console.log(`[lb-cron] posted ${posted}, skipped ${skipped}, failed ${failed}`);
    return { statusCode: 200, body: JSON.stringify({ posted, skipped, failed }) };
  } catch (err) {
    console.error("[lb-cron]", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "cron failed" }) };
  }
};
