// POST /api/discord-post-gate
// Posts (or refreshes) the verification "gate" message with a Verify link button
// into the streamer's configured channel. Auth: Firebase ID token.
//
// The button is a Discord LINK button to the verify page, so no interaction
// handling is needed — the existing verify flow (Kick + casino + Discord link +
// role assignment) does the rest.

const { getDb, admin } = require("./_lib/firebase");
const { res }          = require("./_lib/http");
const { CASINO_NAMES } = require("./_lib/casinos");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const authHeader = (event.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!authHeader) return res(401, { error: "Missing auth token" });

  const db = getDb();
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(authHeader);
  } catch {
    return res(401, { error: "Invalid auth token" });
  }

  // Act on the target account. A moderator (or admin managing an account) carries
  // a `delegatedFor` claim listing the owners they may act for — honor that so
  // they can post the gate on the streamer's behalf, not just their own account.
  let reqBody = {}; try { reqBody = JSON.parse(event.body || "{}"); } catch {}
  const ownerUid  = (reqBody.uid || decoded.uid);
  const delegated = Array.isArray(decoded.delegatedFor) && decoded.delegatedFor.includes(ownerUid);
  if (ownerUid !== decoded.uid && !delegated) {
    return res(403, { error: "You don't have access to that account." });
  }
  const uid = ownerUid;

  const profSnap = await db.collection("streamers").doc(uid).get();
  if (!profSnap.exists) return res(404, { error: "Streamer not found" });
  const data = profSnap.data() || {};

  const channelName = (data.kickChannel || "").toLowerCase();
  const casino      = (data.activeProvider || "").toLowerCase();
  const verify      = data.discordConfig?.verify || {};
  const channelId   = verify.gateChannelId;
  if (!channelId) return res(400, { error: "No verification channel set. Pick one and save first." });
  // Never post a gate that points at the wrong casino — require it to be set.
  if (!casino) return res(400, { error: "Set your casino in Settings before posting the verification gate." });

  // NOTE: the gate no longer carries a URL. It used to be a link button pointing
  // at one fixed address for the entire server:
  //
  //   https://wenbot.gg/verify.html?channel=…&casino=…&src=discord
  //
  // Identical for every member, so Discord never reported who followed it and the
  // resulting verification had no Discord account attached. Since this is the
  // route the whole server is pointed at, it was the one route that could not
  // link Discord on its own — people had to press "Connect Discord" on the
  // success screen afterwards, and whoever missed that step ended up verified
  // with no Discord link at all.
  //
  // It is now an interaction button (custom_id `verify_gate`, handled in
  // WenBotServer's discord-webhook). Discord tells us who clicked, the bot mints
  // that person a one-time link, and Discord attaches by itself. `src=discord`
  // went with the URL and is no loss: verify.html read it into a variable and
  // never used it again.
  // The default copy told people to click and little else. It sits pinned in a
  // channel where nobody can ask a follow-up question, so it has to answer what
  // verifying unlocks, what to have ready, and what actually happens, in the
  // message itself. Written without dashes.
  // Which casinos this message names. Mirrors the dashboard's "Casinos named in
  // the verify message" control (renderVerifyCasinos): the primary plus any
  // enabled leaderboard providers, narrowed by discordConfig.verify.casinos —
  // empty/absent = all, a subset = only those. This function previously named
  // ONLY the primary (activeProvider), so unticking it in the dashboard changed
  // nothing about the posted gate (e.g. a channel that features only Winovo was
  // still told to verify with Gambulls).
  const nameOf = (p) => CASINO_NAMES[p] || p;
  const casList = [], seenCas = new Set();
  const pushCas = (p, label) => {
    p = String(p || "").toLowerCase();
    if (!p || p === "notlisted" || seenCas.has(p)) return;
    seenCas.add(p); casList.push({ provider: p, label: label || nameOf(p) });
  };
  pushCas(casino);
  try {
    const lbSnap = await db.collection("streamers").doc(uid).collection("leaderboards").get();
    lbSnap.docs.map((d) => d.data() || {})
      .filter((b) => b.enabled !== false && b.provider)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .forEach((b) => pushCas(b.provider, b.label));
  } catch { /* boards read is best-effort; the primary alone is fine */ }
  const sel    = (verify.casinos || []).map((s) => String(s).toLowerCase());
  const chosen = sel.length ? casList.filter((c) => sel.includes(c.provider)) : casList;
  const named  = (chosen.length ? chosen : casList).map((c) => c.label);
  const multiCasino   = named.length > 1;
  const casinosPhrase = named.length <= 1
    ? (named[0] || (CASINO_NAMES[casino] || casino))
    : named.slice(0, -1).join(", ") + " or " + named[named.length - 1];

  const casinoOptional = data.casinoRequired === false;

  const defaultGate = [
    "🛡️ **Verify to unlock the server**",
    "",
    `Verification links your Kick account, your Discord, and your ${multiCasino ? `casino account (${casinosPhrase})` : `${casinosPhrase} account`}${casinoOptional ? " (optional)" : ""}. It unlocks the rest of the server and lets you enter giveaways, appear on the leaderboard, and earn points in chat.`,
    "",
    "**Have ready**",
    "• Your Kick login",
    casinoOptional
      ? `• Your ${multiCasino ? `casino username (${casinosPhrase})` : `${casinosPhrase} username`} if you have one. You can skip it and add it later.`
      : (multiCasino
          ? `• Your username on the casino you play (${casinosPhrase}), spelled exactly as it appears on your profile there`
          : `• Your ${casinosPhrase} username, spelled exactly as it appears on your ${casinosPhrase} profile`),
    "",
    "**What happens**",
    "**1.** Press **Verify** below, then **Continue verifying** in the private reply only you can see",
    "**2.** Sign in with Kick when it asks",
    casinoOptional
      ? `**3.** Add your ${multiCasino ? `casino username (${casinosPhrase})` : `${casinosPhrase} username`}, or skip that step`
      : `**3.** Enter your ${multiCasino ? `casino username (${casinosPhrase})` : `${casinosPhrase} username`}`,
    "**4.** Your role is granted as soon as it goes through. Your Discord is attached automatically, so there is nothing else to press",
    "",
    multiCasino
      ? "**If your casino username will not match**, paste your casino User ID instead. It is under Profile, then Settings, then User ID, with a copy button beside it."
      : `**If your ${casinosPhrase} username will not match**, paste your ${casinosPhrase} User ID instead. It is under Profile, then Settings, then User ID, with a copy button beside it.`,
    "",
    "Already verified? Pressing Verify again just updates your details, so nothing is lost.",
  ].join("\n");

  const body = {
    content: verify.gateMessage || defaultGate,
    components: [{
      type: 1,
      // style 2 (secondary) because that is what a link button already rendered
      // as, so the pinned post looks unchanged apart from losing the ↗ icon.
      components: [{ type: 2, style: 2, label: "✅ Verify", custom_id: "verify_gate" }],
    }],
  };

  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method:  "POST",
      headers: { "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("[discord-post-gate] post failed:", r.status, t.slice(0, 200));
      return res(502, { error: `Couldn't post to that channel (Discord ${r.status}). Check WenBot can send messages there.` });
    }
    return res(200, { success: true });
  } catch (e) {
    console.error("[discord-post-gate] error:", e.message);
    return res(500, { error: "Internal server error" });
  }
};
