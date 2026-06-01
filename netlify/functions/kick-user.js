// GET /api/kick-user?channel=<slug>&user=<username>
// Proxies Kick's anonymous channel/user endpoint so the dashboard can show a
// viewer's mod-style profile (follow date, sub length, role, ban status) when
// the streamer is vetting a giveaway winner.
//
// Read-only and stateless: nothing is fetched from or written to our database,
// and no chat content is involved. We only relay public profile metadata Kick
// already serves anonymously (the same data Kick's own user card shows). The
// per-user MESSAGE history endpoint is mod-session gated (401 without the
// streamer's Kick login), so it's intentionally not used here — for messages
// the dashboard links the streamer to Kick's own mod tools instead.

function res(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

// Browser-like headers — Kick sits behind Cloudflare, which intermittently
// challenges plain server requests. A realistic header set plus a couple of
// retries gets through reliably; if it still fails the dashboard falls back to
// its "View on Kick" link, so a miss degrades gracefully rather than breaking.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const KICK_HEADERS = {
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":      UA,
  "Referer":         "https://kick.com/",
  "sec-ch-ua":       '"Chromium";v="120", "Not A(Brand";v="24", "Google Chrome";v="120"',
  "sec-ch-ua-mobile":   "?0",
  "sec-ch-ua-platform": '"Windows"',
};

async function fetchKickUser(url) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: KICK_HEADERS });
    // 404 is authoritative (user has no relationship with the channel) — don't retry.
    if (r.status === 404) return { status: 404 };
    if (r.ok) return { status: 200, data: await r.json() };
    last = r.status;
    // 403/5xx from Cloudflare are usually transient — brief backoff and retry.
    await new Promise((res2) => setTimeout(res2, 250 * (attempt + 1)));
  }
  return { status: last || 502 };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});

  const channel = (event.queryStringParameters?.channel || "").toLowerCase().trim();
  const user    = (event.queryStringParameters?.user || "").trim();
  if (!channel || !user) return res(400, { error: "missing_params" });

  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}/users/${encodeURIComponent(user)}`;
  try {
    const out = await fetchKickUser(url);
    if (out.status === 404) return res(404, { error: "not_found" });
    if (out.status === 429) return res(429, { error: "rate_limited" });
    if (out.status !== 200) return res(502, { error: "kick_error", status: out.status });

    const d = out.data;

    // Whitelist only the profile-card fields — never pass Kick's raw payload through.
    const badges   = Array.isArray(d.badges) ? d.badges : [];
    const hasBadge = (t) => badges.some((b) => b && b.type === t);
    const roles = [];
    if (d.is_channel_owner) roles.push("broadcaster");
    if (d.is_moderator)     roles.push("moderator");
    if (d.is_staff)         roles.push("staff");
    if (hasBadge("og"))     roles.push("og");
    if (hasBadge("vip"))    roles.push("vip");

    return res(200, {
      username:       d.username || user,
      slug:           d.slug || null,
      profilePic:     d.profile_pic || null,
      followingSince: d.following_since || null, // when they followed THIS channel
      subscribedFor:  Number(d.subscribed_for) || 0, // months currently subscribed
      isSubscriber:   hasBadge("subscriber") || (Number(d.subscribed_for) || 0) > 0,
      verified:       hasBadge("verified"),
      roles,
      banned:         d.banned || null, // null, or { reason, permanent, expires_at, ... }
    });
  } catch (err) {
    console.error("[kick-user] error:", err.message);
    return res(500, { error: "internal" });
  }
};
