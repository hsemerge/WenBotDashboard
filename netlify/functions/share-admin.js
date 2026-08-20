// POST /api/share-admin — the streamer's side of scoped share links.
// Body: { uid?, action: "list" | "create" | "revoke", scope?, hours?, label?, id? }
//
// The raw token is returned ONCE, by create. We only ever store its hash, so
// there is no "show me that link again" — a lost link is revoked and reissued.

const { getDb, admin } = require("./_lib/firebase");
const { res } = require("./_lib/http");
const {
  SHARE_SCOPES, MAX_ACTIVE, newToken, hashToken, isValidScope, ttlHours,
} = require("./_lib/share-links");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const idToken = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!idToken) return res(401, { error: "Missing auth token" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }

  const db = getDb();
  let uid, actorUid;
  try {
    const decoded   = await admin.auth().verifyIdToken(idToken);
    const requested = body.uid || decoded.uid;
    const delegated = Array.isArray(decoded.delegatedFor) && decoded.delegatedFor.includes(requested);
    if (requested !== decoded.uid && !delegated) {
      return res(403, { error: "You don't have access to that account." });
    }
    uid      = requested;
    actorUid = decoded.uid;
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  const col = db.collection("share_links");

  try {
    // ── list ───────────────────────────────────────────────────────────────
    if (body.action === "list") {
      const snap = await col.where("uid", "==", uid).get();
      const links = snap.docs
        .map(d => {
          const l = d.data();
          return {
            id:        d.id,                      // the hash — safe to show, useless as a key
            scope:     l.scope,
            scopeLabel: SHARE_SCOPES[l.scope]?.label || l.scope,
            label:     l.label || "",
            createdAt: l.createdAt || 0,
            expiresAt: l.expiresAt || 0,
            revoked:   !!l.revoked,
            lastUsedAt: l.lastUsedAt || 0,
            uses:      l.uses || 0,
            expired:   !l.expiresAt || l.expiresAt < Date.now(),
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
      return res(200, { links, scopes: SHARE_SCOPES });
    }

    // ── create ─────────────────────────────────────────────────────────────
    if (body.action === "create") {
      const scope = String(body.scope || "");
      if (!isValidScope(scope)) return res(400, { error: "Unknown scope" });

      // Count only what is still usable — expired links are noise, not a limit.
      const live = await col.where("uid", "==", uid).get();
      const active = live.docs.filter(d => {
        const l = d.data();
        return !l.revoked && l.expiresAt > Date.now();
      }).length;
      if (active >= MAX_ACTIVE) {
        return res(400, { error: `You already have ${MAX_ACTIVE} live links. Revoke one first.` });
      }

      const token = newToken();
      const hours = ttlHours(body.hours);
      await col.doc(hashToken(token)).set({
        uid, scope,
        label:     String(body.label || "").slice(0, 60),
        createdAt: Date.now(),
        createdBy: actorUid,
        expiresAt: Date.now() + hours * 3600 * 1000,
        revoked:   false,
        uses:      0,
      });

      return res(200, {
        // Shown once. We cannot recover it later, and say so in the UI.
        url:       `https://wenbot.gg/s?t=${token}`,
        scope,
        expiresAt: Date.now() + hours * 3600 * 1000,
        hours,
      });
    }

    // ── revoke ─────────────────────────────────────────────────────────────
    if (body.action === "revoke") {
      const id = String(body.id || "");
      if (!/^[0-9a-f]{64}$/.test(id)) return res(400, { error: "Bad link id" });
      const ref = col.doc(id);
      const doc = await ref.get();
      // Check ownership before writing — the id is public in the list response,
      // and without this any streamer could revoke another's link.
      if (!doc.exists || doc.data().uid !== uid) return res(404, { error: "No such link" });
      await ref.update({ revoked: true, revokedAt: Date.now(), revokedBy: actorUid });
      return res(200, { revoked: true });
    }

    return res(400, { error: "Unknown action" });
  } catch (err) {
    console.error("[share-admin] error:", err.message);
    return res(500, { error: "Internal server error" });
  }
};
