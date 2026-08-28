// GET /api/admin-team  (admin only)
// The admin roster: everyone who can sign into the portal, with their role.
//
// The portal's "assign to" / "owner" pickers used to be built from whoever
// already held a ticket or an outreach card, which is circular — on an empty
// board the only name available was your own, so a teammate could never be
// assigned anything. This is the authority instead: users carrying an adminRole
// custom claim, plus anyone on the ADMIN_UIDS env allowlist (implicit owners).
//
// Returns emails + roles only — no tokens, no claims dump.

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, adminUids } = require("./_lib/admin");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_team", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  const members = new Map();   // uid → { uid, email, role, mfa }
  const add = (u, role) => {
    if (!u) return;
    const prev = members.get(u.uid);
    // Owner wins if a user shows up twice (claim + env allowlist).
    if (prev && prev.role === "owner") return;
    members.set(u.uid, {
      uid:   u.uid,
      email: u.email || u.uid,
      name:  (u.email || u.uid).split("@")[0],
      role,
      mfa:   !!(u.multiFactor && u.multiFactor.enrolledFactors && u.multiFactor.enrolledFactors.length),
    });
  };

  // 1) Everyone holding an adminRole claim. The roster is tiny (a handful of
  //    people), so a paged scan is cheap and always current.
  try {
    let pageToken;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      for (const u of page.users) {
        const r = u.customClaims && u.customClaims.adminRole;
        if (r === "owner" || r === "staff") add(u, r);
      }
      pageToken = page.pageToken;
    } while (pageToken);
  } catch (e) {
    console.warn("[admin-team] listUsers failed:", e.message);
  }

  // 2) The env allowlist — implicit owners, and the break-glass path, so they
  //    appear even before anyone has run the claims script.
  try {
    const envUids = adminUids();
    if (envUids.length) {
      const r = await admin.auth().getUsers(envUids.slice(0, 100).map((uid) => ({ uid })));
      r.users.forEach((u) => add(u, "owner"));
    }
  } catch (e) {
    console.warn("[admin-team] env allowlist lookup failed:", e.message);
  }

  const team = [...members.values()].sort((a, b) =>
    (a.role === b.role ? a.name.localeCompare(b.name) : (a.role === "owner" ? -1 : 1)));

  return res(200, { team, me: adminUser.email || adminUser.uid, role: adminUser.role });
};
