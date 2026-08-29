// GET /api/admin-users  (admin only)
// Returns every streamer with key ops fields + global rollups for the admin panel.
// Authority verified server-side via requireAdmin (Firebase token + allowlist).

const { getDb, admin }        = require("./_lib/firebase");
const { res, checkRateLimit } = require("./_lib/http");
const { requireAdmin, logAdminAudit } = require("./_lib/admin");

function ms(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();            // Firestore Timestamp
  if (v._seconds != null) return v._seconds * 1000;
  return null;
}

// How an account actually pays.
//
// `planManual` was doing double duty: it marks a comp AND it's how an
// invoice-paying customer's plan is held above Stripe. So a customer who pays
// every month by crypto invoice was labelled "comp" and dropped out of revenue
// — which is wrong about the money and wrong about the relationship.
//
// cryptoBilling is the explicit signal (admin-confirm-invoice sets it the first
// time an invoice is confirmed), so it decides ahead of planManual. A live
// Stripe subscription outranks both. `billingMethod` lets an admin correct any
// account by hand when the history doesn't tell the truth.
function billingTypeOf(s) {
  const forced = s.billingMethod;
  if (forced === "stripe" || forced === "crypto" || forced === "comp" || forced === "free") return forced;
  if (s.stripeSubscriptionActive) return "stripe";
  if (s.cryptoBilling === true)   return "crypto";
  if (s.planManual)               return "comp";
  return "free";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return res(405, { error: "Method not allowed" });

  const db = getDb();
  const ip = event.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (!(await checkRateLimit(db, ip, "admin_users", 30, 60))) return res(429, { error: "Too many requests" });

  const adminUser = await requireAdmin(event);
  if (!adminUser) return res(403, { error: "Not authorized" });

  const snap = await db.collection("streamers").get();
  const users = snap.docs.map((d) => {
    const s = d.data();
    return {
      uid:                d.id,
      kickChannel:        s.kickChannel || null,
      displayName:        s.displayName || s.kickChannel || null,
      email:              s.email || null,
      plan:               s.plan || "starter",
      planManual:         s.planManual === true,       // admin comp (survives Stripe)
      planTrial:          s.planTrial === true,         // comped plan with an expiry
      trialPlan:          s.trialPlan || null,
      trialEndsAt:        ms(s.trialEndsAt),
      trialExpiredAt:     ms(s.trialExpiredAt),          // set by the daily sweep when a trial lapses
      // Who on the team owns this relationship (set from Customer 360). Drives
      // the "my streamers" book on the dashboard and the roster filter.
      accountManager:     s.accountManager || null,
      accountManagerAt:   ms(s.accountManagerAt),     // drives "newly assigned to you"
      accountManagerBy:   s.accountManagerBy || null,
      hasNote:            !!(s.adminNotes && String(s.adminNotes).trim()),
      noteSnippet:        s.adminNotes ? String(s.adminNotes).replace(/\s+/g, " ").trim().slice(0, 80) : null,
      provider:           s.activeProvider || s.casino || null,
      // What they said they were at signup. Older accounts predate the question,
      // so fall back to what the record shows: a connected channel means they
      // stream; anything else is unknown until someone says otherwise.
      accountType:        s.accountType || (s.kickChannel ? "streamer" : null),
      accountTypeStated:  !!s.accountType,
      subscriptionActive: !!s.stripeSubscriptionActive,
      paymentFailed:      !!s.stripePaymentFailed,
      onboarded:          !!s.onboarded,
      archived:           s.archived === true,
      referredBy:         s.referredBy || null,
      referralCount:      s.referralCount || 0,
      // How they pay — a CATEGORY, not an amount, so staff get it too. Without
      // it a crypto customer is indistinguishable from a freebie.
      billingType:        billingTypeOf(s),
      billingMethodSet:   !!s.billingMethod,          // an admin said so by hand
      // Free months already handed out for referrals that converted. Owed =
      // converted - used (both computed below).
      referralCreditsUsed: Number(s.referralCreditsUsed || 0),
      totalPaid:          s.totalPaid || 0,
      paymentCount:       s.paymentCount || 0,
      lastPaymentAt:      ms(s.lastPaymentAt),
      kickConnectedAt:    ms(s.kickConnectedAt),
      // Channel health + platform usage. Cheap (already on the doc) and it powers
      // the Channels support view and the Analytics rollup without a second read.
      kickLive:           !!s.kickLive,
      kickLiveAt:         ms(s.kickLiveAt),
      botEnabled:         s.botEnabled !== false,
      botDisabledReason:  s.botDisabledReason || null,
      hasDiscord:         !!(s.discordConfig && s.discordConfig.guildId),
      discordChannels:    !!(s.discordConfig && (s.discordConfig.giveawayChannelId || s.discordConfig.announcementChannelId)),
      verifyRole:         !!(s.discordConfig && s.discordConfig.verify && s.discordConfig.verify.assignRole),
      leaderboardEnabled: !!s.leaderboardEnabled,
      communityStats:     s.communityStats || null,
      liveStats:          s.liveStats || null,
      // Baseline "last login" from our own activity ping (dashboard load). The
      // Firebase lastSignInTime below is max'd in — whichever is newer wins.
      lastLoginAt:        ms(s.lastActiveAt),
      // Billing/renewals: next payment date. Stripe subs come from the webhook;
      // crypto subs advance on admin-confirm. Either drives the "Due Soon" view.
      stripeSubscribed:   !!s.stripeSubscriptionId,
      stripePeriodEnd:    ms(s.stripePeriodEnd),
      // Real billing state from Stripe (scripts/sync-stripe-cycles.js + webhook).
      // autoRenew is the one that matters: a cancelled subscription still reads
      // as "active" right up until its period ends, so without this the only
      // window to save that customer passes unnoticed.
      stripeStatus:       s.stripeStatus || null,
      stripeAutoRenew:    s.stripeAutoRenew === undefined ? null : !!s.stripeAutoRenew,
      stripeCancelAt:     ms(s.stripeCancelAt),
      stripeCanceledAt:   ms(s.stripeCanceledAt),
      stripeAmount:       s.stripeAmount ?? null,
      stripeInterval:     s.stripeInterval || null,
      cryptoNextDue:      ms(s.cryptoBillingNextDue),
      cryptoBilling:      !!s.cryptoBilling,
    };
  });

  // Moderator relationships, derived from `modUids` (the source of truth — see
  // _lib/team.js). Deliberately NOT from the delegatedFor claim: an admin
  // switching into an account is also granted delegation, so that claim would
  // report every admin as a moderator of everyone they have ever helped.
  //
  // This is a RELATIONSHIP, not an account type: 7 of the 8 real moderators run
  // their own channel as well, so "is a moderator" and "is a streamer" are not
  // alternatives. Each account gets both directions — who moderates them, and
  // whose channels they moderate.
  {
    const byUid = Object.fromEntries(users.map((u) => [u.uid, u]));
    users.forEach((u) => { u.mods = []; u.moderates = []; });
    snap.docs.forEach((d) => {
      const owner = byUid[d.id];
      const list  = d.data().modUids;
      if (!owner || !Array.isArray(list)) return;
      list.forEach((modUid) => {
        const mod = byUid[modUid];
        owner.mods.push({ uid: modUid, channel: mod ? (mod.kickChannel || null) : null, email: mod ? mod.email : null });
        if (mod) mod.moderates.push({ uid: d.id, channel: owner.kickChannel || null });
      });
    });

    // A moderator added before account types existed may have no streamer doc at
    // all (they never finished onboarding), which left their row blank — "is
    // moderated by:" and then nothing. Resolve those from Firebase Auth so the
    // person is at least identifiable by email.
    const orphans = [...new Set(users.flatMap((u) => u.mods).filter((m) => !m.channel && !m.email).map((m) => m.uid))];
    if (orphans.length) {
      try {
        const r = await admin.auth().getUsers(orphans.slice(0, 100).map((uid) => ({ uid })));
        const emails = {};
        r.users.forEach((au) => { emails[au.uid] = au.email || null; });
        users.forEach((u) => u.mods.forEach((m) => { if (!m.email && emails[m.uid]) m.email = emails[m.uid]; }));
      } catch (e) { console.warn("[admin-users] orphan mod lookup:", e.message); }
    }
  }

  // Referrals, both directions, with the bit that actually matters: which of the
  // people someone referred are PAYING.
  //
  // referralCount on the doc counts sign-ups, and a sign-up earns nothing — the
  // reward is a free month per referral that converts to a paying customer, so
  // "3 referrals" was unanswerable as a question about credit. Computed here
  // from the roster we already hold, so it costs no extra reads.
  //
  // "Paying" means money is actually arriving: a live Stripe subscription or a
  // crypto/invoice customer. A comp or a trial is not a conversion.
  {
    const byUid = Object.fromEntries(users.map((u) => [u.uid, u]));
    const paying = (u) => (u.billingType === "stripe" || u.billingType === "crypto") && !u.planTrial;
    users.forEach((u) => { u.referrals = []; u.referralsConverted = 0; });
    users.forEach((u) => {
      // referredBy has been stored as a uid and, on older accounts, as a channel
      // name — resolve either so historic referrals still count.
      const ref = u.referredBy;
      if (!ref) return;
      const owner = byUid[ref]
        || users.find((x) => String(x.kickChannel || "").toLowerCase() === String(ref).toLowerCase());
      if (!owner || owner.uid === u.uid) return;
      const converted = paying(u);
      owner.referrals.push({
        uid: u.uid, channel: u.kickChannel || u.email || u.uid,
        plan: u.plan, converted, since: u.kickConnectedAt || null,
      });
      if (converted) owner.referralsConverted++;
    });
    users.forEach((u) => {
      u.referralsSignedUp = u.referrals.length;
      // Free months earned but not yet given. Never negative: handing out an
      // extra month off-book shouldn't read as a debt the streamer owes us.
      u.referralCreditsOwed = Math.max(0, u.referralsConverted - (u.referralCreditsUsed || 0));
    });
  }

  // Bespoke portals and custom domains, from `custom_domains` (the same
  // collection the edge function's map is baked from).
  //
  // Without this, an Agency customer with a hand-built portal read as a SETUP
  // GAP — "leaderboard off" — because the standard portal flag is off for
  // exactly the people who have something better. Meg is the case in point: she
  // has megrewards.com and a bespoke page, and the roster called it a gap.
  //
  // One small read for the whole request; the collection holds a handful of docs.
  try {
    const dom = await db.collection("custom_domains").get();
    const bespoke = new Set();
    const hostsBySlug = {};
    dom.forEach((d) => {
      const x = d.data() || {};
      if (x.enabled === false || !x.slug) return;
      const slug = String(x.slug).toLowerCase();
      if (x.page) bespoke.add(slug);
      if (x.host) (hostsBySlug[slug] = hostsBySlug[slug] || []).push(String(x.host).toLowerCase());
    });
    users.forEach((u) => {
      const slug = String(u.kickChannel || "").toLowerCase();
      u.customPortal  = !!slug && bespoke.has(slug);
      u.customDomains = (slug && hostsBySlug[slug]) ? hostsBySlug[slug] : [];
    });
  } catch (e) {
    // Non-fatal: without it the roster just falls back to the plain portal flag.
    console.warn("[admin-users] custom_domains lookup:", e.message);
    users.forEach((u) => { u.customPortal = false; u.customDomains = []; });
  }

  // Last login — pulled from Firebase Auth metadata (no per-login writes needed).
  // Batched getUsers (max 100/call). Non-fatal: on any failure, leave it null.
  try {
    for (let i = 0; i < users.length; i += 100) {
      const chunk = users.slice(i, i + 100).map((u) => ({ uid: u.uid }));
      const r = await admin.auth().getUsers(chunk);
      const m = {};
      r.users.forEach((rec) => {
        const t = rec.metadata && rec.metadata.lastSignInTime;
        if (t) m[rec.uid] = new Date(t).getTime();
      });
      for (const u of users.slice(i, i + 100)) u.lastLoginAt = Math.max(m[u.uid] || 0, u.lastLoginAt || 0) || null;
    }
  } catch (e) {
    console.warn("[admin-users] last-login lookup failed:", e.message);
  }

  users.sort((a, b) => (b.totalPaid - a.totalPaid) ||
    String(a.kickChannel || "").localeCompare(String(b.kickChannel || "")));

  // The "Streamers" count and its breakdowns are about actual streamer customers,
  // not moderator/internal accounts. A mod who signed up (or was manually set
  // mod-only) shouldn't inflate the streamer count or the plan mix — they remain
  // in `users` for the table + moderator filters, just not in these totals.
  const streamers = users.filter((u) => u.accountType !== "moderator" && u.accountType !== "internal");
  const stats = {
    total:        streamers.length,
    onboarded:    streamers.filter((u) => u.onboarded).length,
    activeSubs:   streamers.filter((u) => u.subscriptionActive).length,
    totalRevenue: streamers.reduce((sum, u) => sum + (u.totalPaid || 0), 0),
    byPlan:       streamers.reduce((m, u) => { const k = u.plan; m[k] = (m[k] || 0) + 1; return m; }, {}),
  };

  // Staff see the ops surface only — billing is hidden entirely (owner's call).
  // Stripped SERVER-side so the numbers never even reach a staff browser: every
  // dollar figure, payment date, renewal date and billing method goes; the
  // booleans a support conversation needs (has an active sub / payment failed)
  // stay. The list is then RE-SORTED alphabetically — the owner's default order
  // is total-paid descending, which would hand staff the exact revenue ranking
  // the stripped fields hide.
  if (adminUser.role !== "owner") {
    for (const u of users) {
      delete u.totalPaid; delete u.paymentCount; delete u.lastPaymentAt;
      delete u.stripePeriodEnd; delete u.cryptoNextDue; delete u.cryptoBilling;
      delete u.stripeSubscribed;
    }
    delete stats.totalRevenue;
    users.sort((a, b) => String(a.kickChannel || "").localeCompare(String(b.kickChannel || "")));
  }

  logAdminAudit(db, adminUser.uid, "admin_users_view", { count: users.length, role: adminUser.role });
  return res(200, { stats, users, admin: adminUser.email, role: adminUser.role });
};
