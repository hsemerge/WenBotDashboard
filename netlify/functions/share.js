// POST /api/share — the holder's side of a scoped share link.
// Body: { token, op: "get" | "act", action?, ... }
//
// Everything here is gated on the token AND the scope. The page at /s is a
// convenience; this endpoint is the actual boundary, so no action runs unless
// the scope explicitly lists it.

const { getDb, admin } = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { SHARE_SCOPES, scopeAllows, resolveToken } = require("./_lib/share-links");
const { performDraw } = require("./_lib/giveaway-draw-core");

const PUBLIC = "*";

// Deliberately identical for wrong, revoked and expired tokens. Telling them
// apart turns this into an oracle for guessing links.
const DEAD_LINK = "This link is not valid any more. Ask the streamer for a new one.";

// The pieces of a streamer's data each scope may see. Never the whole profile:
// it carries Kick tokens, Stripe ids and every other setting.
async function viewFor(db, uid, scope) {
  const profDoc = await db.collection("streamers").doc(uid).get();
  const profile = profDoc.data() || {};
  const channel = profile.kickChannel || "";

  if (scope === "slotrequest") {
    const snap = await db.collection("streamers").doc(uid)
      .collection("slot_requests").where("status", "==", "pending").limit(200).get();
    return {
      channel,
      requests: snap.docs.map(d => ({
        id:       d.id,
        slotName: d.data().slotName || d.data().slot || "",
        viewer:   d.data().kickUsername || d.data().viewer || "",
        betSize:  d.data().betSize || 0,
        at:       d.data().createdAt || 0,
      })),
    };
  }

  if (scope === "giveaway") {
    const snapDoc = await db.collection("streamers").doc(uid)
      .collection("giveaway_state").doc("snapshot").get();
    const entries = snapDoc.exists ? (snapDoc.data().entries || []) : [];
    const manual  = Array.isArray(profile.giveawayManualEntries) ? profile.giveawayManualEntries : [];
    return {
      channel,
      active:  !!profile.giveawayActive,
      keyword: profile.giveawayKeyword || "!join",
      // Names only. A mod running the draw does not need wager figures.
      entries: entries.concat(manual)
        .map(e => e.kickName || e.username || e.kickKey)
        .filter(Boolean).slice(0, 500),
      count:   entries.length + manual.length,
      committed: !!(profile.giveawayFairness && profile.giveawayFairness.serverSeedHash),
    };
  }

  return { channel };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(204, {}, PUBLIC);
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" }, PUBLIC);

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }, PUBLIC); }

  const db = getDb();
  const ip = (event.headers["x-nf-client-connection-ip"]
    || event.headers["x-forwarded-for"] || "").split(",")[0].trim();

  // Bearer links are guessable in principle, so rate limit before the lookup —
  // otherwise this is a free brute-force endpoint.
  if (!await checkRateLimit(db, ip, "share", 60, 60)) {
    return res(429, { error: "Too many requests — slow down." }, PUBLIC);
  }

  const resolved = await resolveToken(db, body.token);
  if (!resolved.ok) return res(403, { error: DEAD_LINK }, PUBLIC);

  const { link, ref } = resolved;
  const { uid, scope } = link;

  try {
    // ── get ────────────────────────────────────────────────────────────────
    if (body.op === "get") {
      const view = await viewFor(db, uid, scope);
      return res(200, {
        scope,
        scopeLabel: SHARE_SCOPES[scope].label,
        blurb:      SHARE_SCOPES[scope].blurb,
        expiresAt:  link.expiresAt,
        label:      link.label || "",
        view,
      }, PUBLIC);
    }

    // ── act ────────────────────────────────────────────────────────────────
    if (body.op === "act") {
      const action = String(body.action || "");
      if (!scopeAllows(scope, action)) {
        return res(403, { error: "This link cannot do that." }, PUBLIC);
      }

      // Usage is recorded before the work, so an action that then fails still
      // leaves a trace the streamer can see.
      await ref.update({
        uses:       admin.firestore.FieldValue.increment(1),
        lastUsedAt: Date.now(),
        lastAction: action,
      });

      if (action === "dismiss" || action === "mark_played") {
        const id = String(body.id || "");
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return res(400, { error: "Bad request id" }, PUBLIC);
        await db.collection("streamers").doc(uid)
          .collection("slot_requests").doc(id)
          .update({ status: action === "dismiss" ? "dismissed" : "added_to_hunt" });
        return res(200, { done: true }, PUBLIC);
      }

      if (action === "draw") {
        // NOT body.luck / body.rules. A link holder must not be able to reweight
        // the draw or switch the requirements off — the scope permits the action,
        // it does not licence its arguments. performDraw reads both from the
        // streamer's own profile, and refuses if no giveaway is running.
        const out = await performDraw(db, admin, uid, null, null, {
          fromProfile:   true,
          requireActive: true,
        });
        if (!out.ok) return res(out.status, { error: out.error, code: out.code }, PUBLIC);
        // The proof is public anyway, and the link holder is the one who has to
        // read the winner out — so they get the same payload the dashboard does.
        return res(200, out.result, PUBLIC);
      }
    }

    return res(400, { error: "Unknown operation" }, PUBLIC);
  } catch (err) {
    console.error("[share] error:", err.message);
    return res(500, { error: "Something went wrong." }, PUBLIC);
  }
};
