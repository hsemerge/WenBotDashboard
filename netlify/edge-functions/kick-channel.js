export default async (request) => {
  const url = new URL(request.url);
  const username = url.searchParams.get("username");

  if (!username) {
    return new Response(JSON.stringify({ error: "Missing username parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  try {
    const response = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(username)}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: `Kick API returned ${response.status}` }), {
        status: response.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const data = await response.json();
    let avatarUrl = data.user?.profile_pic || null;
    // Kick's API returns profile_pic=null for users on a DEFAULT avatar.
    // The user-page og:image surfaces the real default, BUT Cloudflare's
    // bot protection blocks /<slug> requests from datacenter IPs (Netlify
    // edge), so we just get the "Just a moment..." challenge page. The
    // /api/v2/channels endpoint above is whitelisted; the page isn't.
    // Try the scrape anyway in case CF ever lets it through:
    if (!avatarUrl) {
      try {
        const pageRes = await fetch(`https://kick.com/${encodeURIComponent(username)}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9"
          }
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          const m = html.match(/property=\"og:image\"[^>]*content=\"([^\"]+)\"/i)
                 || html.match(/og:image\"[^>]*content=\"([^\"]+)\"/);
          if (m && m[1] && !m[1].includes('cloudflare')) avatarUrl = m[1];
        }
      } catch {}
    }
    // Final fallback: deterministic illustrated avatar from DiceBear. Same
    // username → same avatar across sessions. Each user looks unique
    // instead of every default-avatar user collapsing to the same initial.
    if (!avatarUrl && username) {
      avatarUrl = `https://api.dicebear.com/9.x/notionists-neutral/svg?seed=${encodeURIComponent(username.toLowerCase())}&radius=50&backgroundColor=0d1117,1a2332,253149`;
    }

    return new Response(JSON.stringify({
      id: data.id,
      username: data.slug,
      chatroom_id: data.chatroom?.id,
      is_live: !!data.livestream,
      followers_count: data.followers_count,
      // Resolved avatar: Kick API → og:image scrape (usually blocked by CF) →
      // DiceBear generated. Never null when a username was provided.
      avatar_url: avatarUrl,
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
};

export const config = { path: "/api/kick-channel" };
