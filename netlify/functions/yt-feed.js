// GET /api/yt-feed?channel=UC...
// Latest videos for a YouTube channel via its PUBLIC RSS feed (no API key).
// Returns { videos:[{ id, title, published, thumb }] } — newest first, max 8.
// Empty array = the channel has no public uploads in its feed yet.

const { res: _res } = require("./_lib/http");
const res = (s, b) => _res(s, b, "*");

function decodeXml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(200, {});
  const ch = (event.queryStringParameters?.channel || "").trim();
  if (!/^UC[0-9A-Za-z_-]{20,}$/.test(ch)) return res(400, { error: "bad channel id" });

  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch)}`, {
      headers: { "Accept": "application/atom+xml" },
    });
    if (!r.ok) return res(502, { error: "feed unavailable", videos: [] });
    const xml = await r.text();

    const videos = xml.split("<entry>").slice(1).map((e) => {
      const id        = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
      const title     = (e.match(/<media:title>([^<]*)<\/media:title>/) || [])[1] || "";
      const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1] || null;
      return id ? { id, title: decodeXml(title), published, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } : null;
    }).filter(Boolean).slice(0, 8);

    return res(200, { videos });
  } catch (err) {
    return res(502, { error: err.message, videos: [] });
  }
};
