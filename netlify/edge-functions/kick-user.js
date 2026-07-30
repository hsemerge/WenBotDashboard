// GET /api/kick-user?channel=<slug>&user=<username>
//
// Viewer profile card data: follow date, sub length, roles, ban status. Used when
// a streamer vets a giveaway winner, and as the data source for the follow-date
// backfill.
//
// THIS RUNS ON THE EDGE ON PURPOSE. It used to be a Lambda and silently died when
// Kick started 403ing datacenter IPs, which is why nothing called it any more.
// Netlify's edge runtime (Deno) still reaches kick.com/api/v2 where Lambda and
// Railway are both blocked — verified 2026-07-30 against three channels, all 200
// with `following_since` present. Do NOT move this back to netlify/functions/;
// it will 403 immediately. Same reason /api/kick-channel is an edge function.
//
// Read-only and stateless: nothing touches our database, no chat content is
// involved, and only public profile metadata is relayed — the same fields Kick's
// own user card shows anonymously.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const KICK_HEADERS = {
  "Accept":             "application/json, text/plain, */*",
  "Accept-Language":    "en-US,en;q=0.9",
  "User-Agent":         UA,
  "Referer":            "https://kick.com/",
  "sec-ch-ua":          '"Chromium";v="120", "Not A(Brand";v="24", "Google Chrome";v="120"',
  "sec-ch-ua-mobile":   "?0",
  "sec-ch-ua-platform": '"Windows"',
};

function json(status, body, cache) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cache || "no-store",
    },
  });
}

async function fetchKickUser(url) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: KICK_HEADERS });
    // 404 is authoritative (no relationship with this channel) — never retry it.
    if (r.status === 404) return { status: 404 };
    if (r.ok) return { status: 200, data: await r.json() };
    last = r.status;
    await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
  }
  return { status: last || 502 };
}

export default async (request) => {
  if (request.method === "OPTIONS") return json(200, {});

  const url     = new URL(request.url);
  const channel = (url.searchParams.get("channel") || "").toLowerCase().trim();
  const user    = (url.searchParams.get("user") || "").trim();
  if (!channel || !user) return json(400, { error: "missing_params" });

  const target = `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}/users/${encodeURIComponent(user)}`;
  try {
    const out = await fetchKickUser(target);
    if (out.status === 404) return json(404, { error: "not_found" });
    if (out.status === 429) return json(429, { error: "rate_limited" });
    if (out.status !== 200) return json(502, { error: "kick_error", status: out.status });

    const d = out.data;
    // Whitelist the profile-card fields — never pass Kick's raw payload through.
    const badges   = Array.isArray(d.badges) ? d.badges : [];
    const hasBadge = (t) => badges.some((b) => b && b.type === t);
    const roles = [];
    if (d.is_channel_owner) roles.push("broadcaster");
    if (d.is_moderator)     roles.push("moderator");
    if (d.is_staff)         roles.push("staff");
    if (hasBadge("og"))     roles.push("og");
    if (hasBadge("vip"))    roles.push("vip");

    return json(200, {
      username:       d.username || user,
      slug:           d.slug || null,
      profilePic:     d.profile_pic || null,
      followingSince: d.following_since || null, // when they followed THIS channel
      accountCreated: d.created_at || null,      // Kick account age (bot-entry signal)
      subscribedFor:  Number(d.subscribed_for) || 0, // months currently subscribed
      isSubscriber:   hasBadge("subscriber") || (Number(d.subscribed_for) || 0) > 0,
      verified:       hasBadge("verified"),
      roles,
      banned:         d.banned || null, // null, or { reason, permanent, expires_at, ... }
    }, "public, max-age=300");
  } catch (err) {
    return json(500, { error: "internal", detail: String(err && err.message || err).slice(0, 120) });
  }
};

export const config = { path: "/api/kick-user" };
