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

    console.log(`[lb-cron] posted ${posted}, skipped ${skipped}, failed ${failed}`);
    return { statusCode: 200, body: JSON.stringify({ posted, skipped, failed }) };
  } catch (err) {
    console.error("[lb-cron]", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "cron failed" }) };
  }
};
