// GET /api/admin-customer-360?uid=…  (admin only)
//
// Everything the team keeps about ONE streamer, in a single call: their outreach
// card + timeline (how we got them), the tickets that mention them, and their
// verified-user / activity counts. Billing and account fields still come from
// admin-user-detail — this endpoint deliberately holds NO money, so it needs no
// role-stripping and staff get the identical response.
//
// The related lookups are best-effort: a missing index or a slow subcollection
// must not blank the page, so each falls back to an empty list.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin }        = require("./_lib/admin");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_c360", 60, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  const params = event.queryStringParameters || {};
  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const uid     = String(params.uid || body.uid || "").trim();
  const channel = String(params.channel || body.channel || "").trim().toLowerCase();
  if (!uid) return res(400, { error: "Missing uid" });

  // ── Outreach: matched by linked uid first, then by handle. Someone courted
  //    before they signed up won't have the uid set, so the handle is the
  //    fallback that keeps the history attached.
  let outreach = null, outreachNotes = [];
  try {
    let snap = await db.collection("outreach").where("streamerUid", "==", uid).limit(1).get();
    if (snap.empty && channel) snap = await db.collection("outreach").where("channel_lower", "==", channel).limit(1).get();
    if (!snap.empty) {
      const d = snap.docs[0];
      outreach = { id: d.id, ...d.data() };
      const ns = await d.ref.collection("notes").orderBy("at", "asc").limit(100).get();
      outreachNotes = ns.docs.map((n) => ({ id: n.id, ...n.data() }));
    }
  } catch (e) { console.warn("[c360] outreach lookup:", e.message); }

  // ── Tickets: linked by uid or by channel name.
  let tickets = [];
  try {
    const seen = new Set();
    const push = (s) => s.docs.forEach((d) => { if (!seen.has(d.id)) { seen.add(d.id); tickets.push({ id: d.id, ...d.data() }); } });
    push(await db.collection("tickets").where("relatedUid", "==", uid).limit(50).get());
    if (channel) push(await db.collection("tickets").where("relatedChannel", "==", channel).limit(50).get());
    tickets.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  } catch (e) { console.warn("[c360] ticket lookup:", e.message); }

  // ── Community footprint: how much of WenBot they actually use. Counts only —
  //    the viewer-level data itself stays where it lives.
  const counts = {};
  await Promise.all([
    ["verified_users", "verified"], ["viewers", "viewers"], ["leaderboards", "boards"],
    ["winners_log", "giveawayWinners"], ["discord_links", "discordLinks"],
  ].map(async ([col, key]) => {
    try {
      const agg = await db.collection("streamers").doc(uid).collection(col).count().get();
      counts[key] = agg.data().count;
    } catch { counts[key] = null; }
  }));

  // ── Recent admin actions touching this streamer, from the shared audit trail.
  //    Billing actions are dropped for staff: invoice_* details carry the amount
  //    and invoice number (admin-create-invoice logs { amount, number }), and
  //    billing is owner-only surface. Same prefix rule as admin-activity.js, so
  //    a future invoice action can't slip through by being new.
  const OWNER_ONLY_ACTIONS = /^(invoice_|admin_billing)/;
  const isOwner = adminUser.role === "owner";
  let history = [];
  try {
    const snap = await db.collection("admin_audit_logs").orderBy("at", "desc").limit(400).get();
    history = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((e) => {
        if (!isOwner && OWNER_ONLY_ACTIONS.test(e.action || "")) return false;
        const det = e.details || {};
        return det.uid === uid || det.targetUid === uid || (channel && String(det.channel || "").toLowerCase() === channel);
      })
      .slice(0, 25)
      .map((e) => ({ action: e.action, at: e.at && e.at.toMillis ? e.at.toMillis() : null, details: e.details || {}, adminUid: e.adminUid }));
    // Resolve the acting admins to emails (tiny set).
    const uids = [...new Set(history.map((h) => h.adminUid).filter(Boolean))];
    if (uids.length) {
      const { admin } = require("./_lib/firebase");
      const r = await admin.auth().getUsers(uids.slice(0, 100).map((u) => ({ uid: u })));
      const map = {}; r.users.forEach((u) => { map[u.uid] = u.email || u.uid; });
      history.forEach((h) => { h.by = map[h.adminUid] || h.adminUid; delete h.adminUid; });
    }
  } catch (e) { console.warn("[c360] history lookup:", e.message); }

  // Login state, for the support actions on the 360 page: is the email verified,
  // are they locked out, do they have 2FA, when did they last sign in.
  let login = null;
  try {
    const u = await admin.auth().getUser(uid);
    login = {
      email:         u.email || null,
      emailVerified: !!u.emailVerified,
      disabled:      !!u.disabled,
      mfa:           !!(u.multiFactor && u.multiFactor.enrolledFactors && u.multiFactor.enrolledFactors.length),
      lastSignIn:    u.metadata && u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime).getTime() : null,
      createdAt:     u.metadata && u.metadata.creationTime ? new Date(u.metadata.creationTime).getTime() : null,
    };
  } catch { login = null; }   // no Firebase login (shouldn't happen, but don't break the page)

  // The internal note thread. Best-effort like everything else here: a missing
  // subcollection just means no notes yet, and must not blank the page.
  let notes = [];
  try {
    const ns = await db.collection("admin_notes").doc(uid).collection("entries")
      .orderBy("at", "desc").limit(100).get();
    notes = ns.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn("[c360] notes lookup:", e.message); }

  // Whether this streamer runs the optional two-role Discord gate, so the panel
  // can offer the backfill only where it applies. Role IDs are not returned —
  // the panel has no use for them and they are the streamer's server config.
  let verifyGate = { on: false };
  try {
    const sd = (await db.collection("streamers").doc(uid).get()).data() || {};
    const v = (sd.discordConfig && sd.discordConfig.verify) || {};
    verifyGate = { on: !!(v.requireSecondRole && v.secondRoleId && v.unlockRoleId && v.roleId && sd.discordConfig.guildId) };
  } catch (e) { console.warn("[c360] gate lookup:", e.message); }

  return res(200, { uid, outreach, outreachNotes, tickets, counts, history, login, notes, verifyGate, role: adminUser.role });
};
