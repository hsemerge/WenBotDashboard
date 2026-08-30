// POST /api/admin-alt-check   (admin only)
// Body: { uid?, channel?, kickUsername }
//
// "Is this viewer running alt accounts on this channel?"
//
// The pieces already existed but only fired ONCE, at the moment someone verified:
// detectAnomalies() posted an embed to the mod feed and wrote a viewer_history
// entry, and that was it. If the embed scrolled away, or the link was made before
// a given check existed, or you simply got suspicious later, there was nothing to
// ask. This re-runs the same reasoning on demand, against the data as it stands
// now, for any viewer.
//
// SCOPE: one streamer's own channel, deliberately. verify-log.js makes the same
// call and gives the reason — another streamer's verified list is their data, and
// "this person also watches someone else" is not misconduct. Alting is two
// accounts in the SAME community claiming the same identity, so the channel is
// the right boundary anyway.
//
// This reports EVIDENCE, never a verdict. Every signal here has an innocent
// explanation as well as a guilty one, so each finding says which it could be and
// how strong it actually is. A tool that says "ALT DETECTED" gets someone banned
// for changing their name.

const { getDb }               = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin }        = require("./_lib/admin");
const { CASINO_NAMES }        = require("./_lib/casinos");

const lc = (s) => String(s == null ? "" : s).toLowerCase().trim();

// How much weight a signal actually carries, so the caller can sort and the UI
// can colour. Nothing here is proof on its own.
const STRONG = "strong", MEDIUM = "medium", INFO = "info";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "POST")    return res(405, { error: "Use POST" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_alt_check", 40, 60))) return res(429, { error: "Too many requests" });

  // Any admin, not owner-only: this is moderation, and the staff who handle
  // giveaway disputes are exactly who needs it. It is read-only throughout.
  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return res(400, { error: "Bad JSON" }); }

  const kickUsername = String(body.kickUsername || "").trim();
  if (!kickUsername) return res(400, { error: "Enter a Kick username" });
  const target = lc(kickUsername);

  // Resolve the streamer either way round — the portal knows the uid, a human
  // typing into the box knows the channel name.
  let uid = String(body.uid || "").trim();
  let channel = String(body.channel || "").trim();
  try {
    if (!uid && channel) {
      const q = await db.collection("streamers").where("kickChannel", "==", channel).limit(1).get();
      if (q.empty) return res(404, { error: `No streamer with channel "${channel}"` });
      uid = q.docs[0].id;
    }
    if (!uid) return res(400, { error: "Give a streamer uid or channel" });
    if (!channel) {
      const s = await db.collection("streamers").doc(uid).get();
      if (!s.exists) return res(404, { error: "Streamer not found" });
      channel = s.data().kickChannel || uid;
    }
  } catch (e) {
    console.error("[admin-alt-check] streamer resolve", e.message);
    return res(500, { error: "Could not resolve the streamer" });
  }

  const base = db.collection("streamers").doc(uid);

  try {
    // One viewer can hold SEVERAL verified_users docs — the id is
    // `${kickName}_${provider}`, so verifying at two casinos makes two records.
    // Pull the whole collection once: it is per-streamer and small, and a scan
    // sidesteps every casing and doc-id-shape problem at once.
    const [vuSnap, dlSnap, relSnap] = await Promise.all([
      base.collection("verified_users").get(),
      base.collection("discord_links").get(),
      // Snapshots taken when a viewer released their OWN verification. They have
      // to be in the pool, because a release hard-deletes the live record and
      // matching needs both halves of a pair: without these, anyone who saw
      // themselves flagged could clear the flag off their alt as well, simply by
      // un-verifying whichever account nobody was watching.
      base.collection("verified_released").get().catch(() => ({ docs: [] })),
    ]);

    const live     = vuSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const released = relSnap.docs.map((d) => ({ id: d.id, ...d.data(), released: true }));
    const all  = live.concat(released);
    const mine = all.filter((r) => lc(r.kickName_lower || r.kickName) === target);

    if (!mine.length && !dlSnap.docs.some((d) => lc(d.data().kickUsername) === target)) {
      return res(200, {
        channel, kickUsername, found: false, findings: [],
        summary: `No verification record for "${kickUsername}" on ${channel}. They may never have verified, or they verified under a different Kick name.`,
      });
    }

    const findings = [];
    const linked = new Set();          // other Kick names this viewer touches
    const noteOther = (name) => { const n = lc(name); if (n && n !== target) linked.add(n); };

    // ── Same Kick ACCOUNT, different name ────────────────────────────────────
    // Runs first, and is NOT an alt signal — it is the guard against one.
    //
    // Kick's numeric account id survives a rename; the name the record is filed
    // under does not. So a viewer who renamed has two records that share their
    // casino account AND their Discord — necessarily, it is one person. Scanning
    // for shared identifiers without knowing that turns a single name change into
    // two STRONG "shared with another Kick user" hits, which is precisely how a
    // tool like this gets someone banned for renaming. Establish the rename up
    // front, then exclude those names from every signal below.
    const renamedFrom = new Set();
    const myKickIds = [...new Set(mine.map((r) => r.kickUserId).filter(Boolean).map(String))];
    for (const kid of myKickIds) {
      const sameAccount = all.filter((r) => String(r.kickUserId || "") === kid
                                         && lc(r.kickName_lower || r.kickName) !== target);
      const names = [...new Set(sameAccount.map((r) => r.kickName).filter(Boolean))];
      names.forEach((n) => renamedFrom.add(lc(n)));
      if (names.length) {
        findings.push({
          signal: "same_kick_account", weight: INFO, alt: false,
          title: "Same Kick account under an older name",
          detail: `Kick account #${kid} is also on record here as ${names.join(", ")}.`,
          meaning: "This is a RENAME, not an alt. Kick's internal account id is identical, so it is literally the same account — one person who changed their display name. Their points and tickets are still under the old name; Admin → Merge viewer joins them.",
          others: names,
        });
      }
    }

    // A shared identifier only means an ALT if the name it is shared with is a
    // different PERSON. This viewer's own former names are not.
    const isOtherPerson = (name) => {
      const n = lc(name);
      return !!n && n !== target && !renamedFrom.has(n);
    };

    // ── The casino account is shared with another Kick name ──────────────────
    // Strong when it is the provider UID (a stable id the viewer cannot change);
    // weaker on username alone, which a rename at the casino would also produce.
    for (const r of mine) {
      const prov = r.provider && r.provider !== "none" ? r.provider : null;
      if (!prov) continue;
      const label = CASINO_NAMES[prov] || prov;

      if (r.providerUid) {
        const shared = all.filter((o) => o.providerUid === r.providerUid
                                      && isOtherPerson(o.kickName_lower || o.kickName));
        const names = [...new Set(shared.map((o) => o.kickName).filter(Boolean))];
        if (names.length) {
          names.forEach(noteOther);
          findings.push({
            signal: "casino_uid_shared", weight: STRONG, alt: true,
            title: `Same ${label} account as another Kick user`,
            detail: `${label} account ${r.providerUid} is verified to both ${kickUsername} and ${names.join(", ")}.`,
            meaning: `Matched on the casino's own internal id, which the viewer cannot rename away. Two Kick names claiming ONE casino account is the classic double-entry setup. Innocent versions exist — a shared household account, or a Kick name change the merge never caught — but this is the strongest single signal available.`,
            others: names,
          });
        }
      }
      if (r.providerUsername_lower) {
        const shared = all.filter((o) => o.providerUsername_lower === r.providerUsername_lower
                                      && isOtherPerson(o.kickName_lower || o.kickName)
                                      && !(r.providerUid && o.providerUid === r.providerUid)); // already reported above
        const names = [...new Set(shared.map((o) => o.kickName).filter(Boolean))];
        if (names.length) {
          names.forEach(noteOther);
          findings.push({
            signal: "casino_name_shared", weight: MEDIUM, alt: true,
            title: `Same ${label} username as another Kick user`,
            detail: `${label} username "${r.providerUsername}" appears under ${kickUsername} and ${names.join(", ")}.`,
            meaning: `Matched on the casino USERNAME rather than its id, so it is a little softer — a casino-side rename could produce it too. Still worth a look: two Kick accounts naming the same casino account is not a coincidence.`,
            others: names,
          });
        }
      }
    }

    // ── The Discord account has been on more than one Kick name ──────────────
    // The hardest thing for someone to duplicate, so reuse here is the signal
    // most likely to mean one human. discord_links holds only the CURRENT
    // mapping (re-linking overwrites the doc), so this catches a Discord that
    // currently points elsewhere; the hop itself is in the history below.
    const myDiscordIds = [...new Set(mine.map((r) => r.discordUserId).filter(Boolean).map(String))];
    for (const did of myDiscordIds) {
      const others = all.filter((o) => String(o.discordUserId || "") === did
                                    && isOtherPerson(o.kickName_lower || o.kickName));
      const names = [...new Set(others.map((o) => o.kickName).filter(Boolean))];
      if (names.length) {
        names.forEach(noteOther);
        findings.push({
          signal: "discord_shared", weight: STRONG, alt: true,
          title: "Same Discord account as another Kick user",
          detail: `Discord ${did} is attached to ${kickUsername} and ${names.join(", ")}.`,
          meaning: "One Discord certifying two Kick accounts is the pattern a Discord-verify gate exists to stop. A second account is cheap to make on Kick; a second Discord with history is not, so people reuse it. Innocent version: two people genuinely sharing a device or a family Discord.",
          others: names,
        });
      }
      // A Discord whose CURRENT link points at someone else entirely.
      const dl = dlSnap.docs.find((d) => d.id === did);
      if (dl && isOtherPerson(dl.data().kickUsername)) {
        noteOther(dl.data().kickUsername);
        findings.push({
          signal: "discord_moved", weight: STRONG, alt: true,
          title: "Their Discord now points at a different Kick account",
          detail: `Discord ${did} verified ${kickUsername}, but its live link is now ${dl.data().kickUsername}.`,
          meaning: "The same Discord was re-used to verify a second Kick account, which moved the link. This is the exact farming pattern the move handler was written to catch.",
          others: [dl.data().kickUsername],
        });
      }
    }

    // ── Same connection as another account ───────────────────────────────────
    // connHash is a SALTED HASH of the IP the account verified from — never the
    // raw IP, and never shown. Mirrors the corroboration rule verify-log.js
    // already applies at verification time, because the distinction is the whole
    // point: a shared connection ALONE is routinely innocent (siblings, a
    // household, halls, CGNAT putting strangers behind one address), so on its
    // own it is the soft "shared connection" flag. When the same account ALSO
    // shares a Discord or casino account, one coincidence has become a pattern
    // and it escalates. Reporting a lone IP match as an alt would flag every
    // sibling on the channel.
    const myHashes = [...new Set(mine.map((r) => r.connHash).filter(Boolean))];
    for (const h of myHashes) {
      const sharers = new Map();       // otherName -> corroborating signal
      for (const o of all) {
        if (o.connHash !== h) continue;
        const name = o.kickName || o.kickName_lower;
        if (!isOtherPerson(name)) continue;
        const rec = sharers.get(lc(name)) || { name, discord: false, casino: false };
        if (mine.some((r) => r.discordUserId && o.discordUserId
                          && String(r.discordUserId) === String(o.discordUserId))) rec.discord = true;
        if (mine.some((r) => (r.providerUid && o.providerUid && r.providerUid === o.providerUid)
                          || (r.providerUsername_lower && o.providerUsername_lower
                              && r.providerUsername_lower === o.providerUsername_lower))) rec.casino = true;
        sharers.set(lc(name), rec);
      }
      if (!sharers.size) continue;
      const list = [...sharers.values()];
      const names = list.map((r) => r.name);
      names.forEach(noteOther);
      const corroborated = list.some((r) => r.discord || r.casino);
      const also = list.some((r) => r.discord) ? "Discord account"
                 : list.some((r) => r.casino)  ? "casino account" : null;
      const label = mine.find((r) => r.connHash === h && r.connLabel);
      findings.push({
        signal: corroborated ? "conn_alt" : "conn_shared",
        weight: corroborated ? STRONG : MEDIUM,
        alt: true,
        title: corroborated ? "Same connection AND the same account details" : "Verified from the same connection",
        detail: `Verified from the same connection${label ? ` (${label.connLabel})` : ""} as ${names.join(", ")}`
              + (corroborated ? `, and shares the same ${also}.` : "."),
        meaning: corroborated
          ? "Two independent signals agreeing. One is a coincidence; two on the same pair of accounts is a pattern. This is the strongest combination the data can produce."
          : "On its own this is weak. A shared house, a shared router, halls of residence, or a mobile network putting strangers behind one address all produce it. Treat it as a reason to look, not a finding.",
        others: names,
      });
    }

    // ── The durable trail written when something was flagged before ──────────
    // detectAnomalies() and handleDiscordMove() both write here, on BOTH accounts
    // involved, so this survives the mod-feed message scrolling away and covers
    // hops that the current records no longer show.
    // Stored as a bounded ARRAY on one doc (viewer-history.js), not a
    // subcollection — read the doc and sort in memory.
    let history = [];
    try {
      const h = await base.collection("viewer_history").doc(target).get();
      if (h.exists && Array.isArray(h.data().events)) {
        history = h.data().events.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
      }
    } catch { /* no history is normal */ }

    // The types that bear on alting. discord_in / discord_out are the two halves
    // of a Discord hopping between Kick names — written on BOTH accounts, so
    // whichever one you look up, the hop is visible from its own side.
    const ALT_TYPES = { casino_shared: MEDIUM, discord_reused: MEDIUM, discord_in: MEDIUM,
                        discord_out: MEDIUM, conn_alt: MEDIUM, conn_shared: INFO };
    const INFO_TYPES = { renamed: INFO, casino_rename: INFO, verify_released: INFO };
    for (const e of history) {
      const weight = ALT_TYPES[e.type] || INFO_TYPES[e.type];
      if (!weight) continue;                       // 'verified' etc: not a signal
      findings.push({
        signal: "history:" + e.type,
        weight,
        alt: !!ALT_TYPES[e.type],
        title: "Flagged when it happened",
        detail: e.text,
        meaning: `Recorded automatically on ${new Date(e.ts).toLocaleString("en-GB")}. This is the durable copy — the mod-feed alert for it has long scrolled away.`,
        others: [],
      });
    }

    // Say so when the case rests partly on archived evidence. A release that
    // lands shortly after an account was flagged is itself worth noticing —
    // mods can run /lookup, and the flag names the other account.
    const releasedNames = new Set(released.map((r) => lc(r.kickName_lower || r.kickName)).filter(Boolean));
    const relevantReleases = [target, ...linked].filter((n) => releasedNames.has(n));
    if (relevantReleases.length) {
      findings.push({
        signal: "released_record", weight: INFO, alt: false,
        title: "Part of this comes from a released verification",
        detail: `${relevantReleases.join(", ")} un-verified at some point. The identifiers above were archived at that moment.`,
        meaning: "Releasing a verification deletes the live record, which would otherwise break the link from BOTH sides and hide it — so this is kept deliberately. Check the timing against when they would have seen themselves flagged.",
        others: relevantReleases,
      });
    }

    const strong = findings.filter((f) => f.weight === STRONG && f.alt).length;
    // Everything alt-relevant that is not strong, medium and info alike — a lone
    // shared connection is weak but it is still a reason to look, and counting
    // only MEDIUM would report "0 softer links" on a page that is showing one.
    const medium = findings.filter((f) => f.alt && f.weight !== STRONG).length;
    const renameOnly = findings.length > 0 && findings.every((f) => !f.alt);

    let summary;
    if (!findings.length) {
      summary = `Nothing links ${kickUsername} to another account on ${channel}. Their casino account, Kick account id and Discord are all unique here. That is not proof they are clean — it means no shared identifier was recorded — but there is no evidence of an alt.`;
    } else if (renameOnly) {
      summary = `${kickUsername} is linked to another name on ${channel}, but only by having the SAME Kick account id — that is a rename, not an alt. Nothing here suggests a second account.`;
    } else if (strong) {
      summary = `${kickUsername} shares an identifier with ${linked.size} other Kick name${linked.size === 1 ? "" : "s"} on ${channel}: ${[...linked].join(", ")}. ${strong} strong signal${strong === 1 ? "" : "s"}${medium ? ` and ${medium} softer one${medium === 1 ? "" : "s"}` : ""}. Worth acting on, but read the innocent explanations before you do.`;
    } else {
      summary = `${kickUsername} has ${medium} softer link${medium === 1 ? "" : "s"} to ${[...linked].join(", ")} on ${channel} — enough to look at, not enough to conclude much on its own.`;
    }

    // Weight order, strongest first, so the UI never buries the real signal.
    const rank = { [STRONG]: 0, [MEDIUM]: 1, [INFO]: 2 };
    findings.sort((a, b) => (rank[a.weight] - rank[b.weight]) || (b.alt - a.alt));

    return res(200, {
      channel, kickUsername, found: true,
      records: mine.map((r) => ({
        provider: r.provider || null,
        providerUsername: r.providerUsername || null,
        providerUid: r.providerUid || null,
        kickUserId: r.kickUserId || null,
        kickName: r.kickName || null,
        discordUserId: r.discordUserId || null,
        discordUsername: r.discordUsername || null,
        // The human-readable half only. connHash is a salted hash of their IP and
        // never leaves the server — the label is a coarse descriptor, the hash is
        // the thing that must not be shipped to a browser.
        connLabel: r.connLabel || null,
        verifiedAt: r.verifiedAt || null,
      })),
      findings, linkedNames: [...linked], summary,
      historyCount: history.length,
    });
  } catch (e) {
    console.error("[admin-alt-check]", e.message);
    return res(500, { error: "Internal server error" });
  }
};
