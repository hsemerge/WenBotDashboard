// GET/POST /api/admin-team-todos  (admin only)
// The shared Team To-Do list from Triton's admin mock, made real: one list all
// three admins see (the mock kept it in localStorage, so each browser had its
// own). Backed by the server-only `team_todos` collection (locked in
// firestore.rules; every access goes through here with the Admin SDK).
//
//   GET                 → { todos: [...] }  newest first, done items last
//   POST {action:'add',    text, tag?}      → create (text ≤ 300, tag ≤ 60)
//   POST {action:'toggle', id}              → flip done, stamping who/when
//   POST {action:'delete', id}              → remove
//
// Any admin role — this is exactly the shared surface staff are for.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_todos", 60, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });
  const me = adminUser.email || adminUser.uid;

  const col = db.collection("team_todos");

  if (event.httpMethod === "GET") {
    const snap = await col.orderBy("createdAt", "desc").limit(200).get();
    const todos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    todos.sort((a, b) => (a.done === b.done ? (b.createdAt || 0) - (a.createdAt || 0) : (a.done ? 1 : -1)));
    return res(200, { todos });
  }

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const action = String(body.action || "").trim();

  if (action === "add") {
    const text = String(body.text || "").trim().slice(0, 300);
    const tag  = String(body.tag  || "").trim().slice(0, 60);
    if (!text) return res(400, { error: "Task text is required" });
    const doc = await col.add({ text, tag: tag || null, done: false, createdBy: me, createdAt: Date.now(), doneBy: null, doneAt: null });
    logAdminAudit(db, adminUser.uid, "todo_add", { id: doc.id, text: text.slice(0, 80) });
    return res(200, { ok: true, id: doc.id });
  }

  const id = String(body.id || "").trim();
  if (!id) return res(400, { error: "Missing id" });
  const ref  = col.doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res(404, { error: "Task not found" });

  if (action === "toggle") {
    const done = !snap.data().done;
    await ref.set({ done, doneBy: done ? me : null, doneAt: done ? Date.now() : null }, { merge: true });
    return res(200, { ok: true, done });
  }
  if (action === "delete") {
    await ref.delete();
    logAdminAudit(db, adminUser.uid, "todo_delete", { id, text: String(snap.data().text || "").slice(0, 80) });
    return res(200, { ok: true });
  }
  return res(400, { error: "Invalid action" });
};
