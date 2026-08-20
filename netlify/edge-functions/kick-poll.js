// GET /api/kick-poll?channel=<slug>
//
// Relays whatever poll is currently running in a Kick channel, so the poll
// overlay can show it in OBS. Kick already has a perfectly good /poll command
// built into chat — the point here is that nothing puts it on stream, and a poll
// nobody can see while they vote is not much of a poll.
//
// THIS RUNS ON THE EDGE ON PURPOSE. kick.com/api/v2 403s datacenter IPs from
// Lambda and Railway, but Netlify's edge runtime still reaches it — the same
// reason /api/kick-user and /api/kick-channel live here. Do NOT move it to
// netlify/functions/.
//
// Read-only, stateless, public data: the poll is visible to anyone watching the
// stream. Nothing is stored and no auth is involved, so the overlay URL is safe
// to hand to OBS.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function json(status, body, cache) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // Short, but long enough that a room full of overlays does not each hit
      // Kick every second.
      "Cache-Control": cache || "public, max-age=2",
    },
  });
}

export default async (request) => {
  const url     = new URL(request.url);
  const channel = (url.searchParams.get("channel") || "").trim();
  if (!channel) return json(400, { error: "Missing channel" });
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(channel)) return json(400, { error: "Bad channel" });

  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}/polls`, {
      headers: {
        "Accept":          "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":      UA,
        "Referer":         "https://kick.com/",
      },
    });

    // No poll running is the normal state, and Kick signals it with a 404 as
    // often as with an empty body. Neither is an error worth showing in OBS.
    if (r.status === 404) return json(200, { poll: null });
    if (!r.ok) return json(200, { poll: null, upstream: r.status });

    const data = await r.json().catch(() => null);
    const p    = data?.data?.poll || data?.poll || null;
    if (!p || !Array.isArray(p.options)) return json(200, { poll: null });

    const options = p.options.map((o, i) => ({
      id:    o.id ?? i,
      label: String(o.label ?? o.title ?? "").slice(0, 120),
      votes: Number(o.votes ?? o.vote_count ?? 0) || 0,
    }));
    const total = options.reduce((n, o) => n + o.votes, 0);

    return json(200, {
      poll: {
        title:     String(p.title ?? "").slice(0, 200),
        options,
        total,
        // Kick reports the countdown in seconds remaining; keep both so the
        // overlay can render a bar without another call.
        duration:  Number(p.duration ?? 0) || 0,
        remaining: Number(p.remaining ?? p.time_remaining ?? 0) || 0,
      },
    });
  } catch (err) {
    // Fail as "no poll" rather than as an error: an overlay that flashes a red
    // box every time Kick hiccups is worse than one that briefly shows nothing.
    return json(200, { poll: null, error: String(err.message || err).slice(0, 120) });
  }
};

export const config = { path: "/api/kick-poll" };
