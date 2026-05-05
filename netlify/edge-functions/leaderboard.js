// Provider-agnostic leaderboard proxy
// Accepts provider name and API key, returns normalized user list

const PROVIDERS = {
  gambulls: {
    buildUrl: (limit) => `https://api.gambulls.com/api/public/streamer/leaderboard?type=monthly&limit=${Math.min(limit, 100)}`,
    buildHeaders: (apiKey) => ({
      "x-streamer-api-key": apiKey,
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }),
    parseResponse: (data) => {
      if (!data.success || !data.responseObject?.rankings) return null;
      return data.responseObject.rankings.map(entry => ({
        username: entry.user?.name || "Unknown",
        wagerAmount: entry.wagerAmount || 0,
      })).filter(u => u.username !== "Unknown");
    },
  },

  csbattle: {
    buildUrl: (limit) => {
      // CSBattle uses date range - wide range to get all data
      return `https://api.csbattle.com/leaderboards/affiliates/{affiliateId}?from=2025-01-01%2000:00:00&to=2030-12-31%2023:59:59&limit=${limit}`;
    },
    buildHeaders: () => ({
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }),
    parseResponse: (data) => {
      if (!Array.isArray(data)) return null;
      return data.map(entry => ({
        username: entry.username || entry.name || "Unknown",
        wagerAmount: entry.wagered || entry.amount || 0,
      })).filter(u => u.username !== "Unknown");
    },
    // CSBattle uses affiliateId in the URL instead of a header
    buildUrlWithKey: (apiKey, limit) => {
      return `https://api.csbattle.com/leaderboards/affiliates/${apiKey}?from=2025-01-01%2000:00:00&to=2030-12-31%2023:59:59&limit=${limit}`;
    },
  },
};

export default async (request) => {
  const url = new URL(request.url);
  const providerName = url.searchParams.get("provider") || "gambulls";
  const limit = url.searchParams.get("limit") || "200";
  const apiKey = request.headers.get("x-provider-key");

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing API key" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const provider = PROVIDERS[providerName];
  if (!provider) {
    return new Response(JSON.stringify({ error: `Unknown provider: ${providerName}` }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    // Build the request URL (some providers embed the key in the URL)
    const apiUrl = provider.buildUrlWithKey
      ? provider.buildUrlWithKey(apiKey, limit)
      : provider.buildUrl(limit);

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: provider.buildHeaders(apiKey),
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return new Response(JSON.stringify({ error: "API returned non-JSON response" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const rawData = await response.json();
    const users = provider.parseResponse(rawData);

    if (!users) {
      return new Response(JSON.stringify({ error: "Failed to parse provider response" }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(JSON.stringify({ provider: providerName, users }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
};

export const config = { path: "/api/leaderboard" };
