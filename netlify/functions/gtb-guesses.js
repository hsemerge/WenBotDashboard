// GET /api/gtb-guesses?channel=USERNAME
//
// Public read of the current (or most recent) Guess the Balance round: every
// guess, plus whether entries are still open and the result once a winner is
// drawn. This is what !mygtb and /mygtb link to.
//
// Public by design — guesses are made in public chat, so there's nothing here a
// viewer couldn't already see by scrolling. Nothing identifying beyond the Kick
// username they guessed under is exposed.
//
// Reads the LAST session whether or not it's open: stopGTB() flips gtbActive but
// leaves gtbSessionId, and the interesting moment for a viewer is exactly when
// entries have closed and they want to check what they put in.

const { getDb }     = require("./_lib/firebase");
const { res: _res } = require("./_lib/http");
const { findStreamerByChannel } = require("./_lib/streamer");
const res = (s, b) => _res(s, b, "*");

const MAX_GUESSES = 500;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  if (!channel) return res(400, { error: "Missing channel" });

  try {
    const db = getDb();
    const snapDoc = await findStreamerByChannel(db, channel);
    if (!snapDoc) return res(404, { error: "Channel not found on WenBot" });

    const doc     = snapDoc;
    const profile = doc.data();
    const sessionId = profile.gtbSessionId || null;

    const base = {
      channel,
      displayName: profile.displayName || profile.kickChannel || channel,
      open:        !!profile.gtbActive,
      sessionId,
    };

    if (!sessionId) return res(200, { ...base, guesses: [], total: 0, session: null });

    const sRef = doc.ref.collection("gtb_sessions").doc(sessionId);
    const [sessionSnap, guessSnap] = await Promise.all([
      sRef.get(),
      // Ordered by guess so the list reads as a ladder. Bounded: a huge round
      // shouldn't be able to return an unbounded payload to a public endpoint.
      sRef.collection("guesses").orderBy("guess", "desc").limit(MAX_GUESSES).get(),
    ]);

    const sdata = sessionSnap.exists ? sessionSnap.data() : {};
    const guesses = guessSnap.docs.map((g) => {
      const d = g.data() || {};
      return {
        username: d.kickUsername || g.id,
        guess:    Number(d.guess) || 0,
        at:       d.submittedAt && d.submittedAt.toMillis ? d.submittedAt.toMillis() : null,
      };
    });

    // Once a winner is drawn the round has an answer, which changes what the page
    // should show: distance from the actual balance rather than just the ladder.
    const actual = Number.isFinite(sdata.actual) ? sdata.actual : null;
    if (actual != null) {
      guesses.forEach((g) => { g.diff = Math.abs(g.guess - actual); });
      guesses.sort((a, b) => a.diff - b.diff);
    }

    return res(200, {
      ...base,
      session: {
        startedAt: sdata.startedAt && sdata.startedAt.toMillis ? sdata.startedAt.toMillis() : null,
        actual,
        winner: sdata.winner || null,
      },
      total:   sdata.guessCount || guesses.length,
      guesses,
      truncated: guesses.length >= MAX_GUESSES,
    });
  } catch (err) {
    console.error("[gtb-guesses] error:", err.message);
    return res(500, { error: "Could not load guesses right now." });
  }
};
