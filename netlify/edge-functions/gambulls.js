const GAMBULLS_API_KEY = "sk_f088e685a5d14c6cb517cd41b1260615";
const GAMBULLS_URL = "https://api.gambulls.com/api/public/streamer/leaderboard";

export default async (request) => {
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "monthly";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 100);

  const apiUrl = `${GAMBULLS_URL}?type=${type}&limit=${limit}`;

  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "x-streamer-api-key": GAMBULLS_API_KEY,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return new Response(JSON.stringify({ success: false, error: "API returned non-JSON (possibly blocked)" }), {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};

export const config = { path: "/api/gambulls" };
