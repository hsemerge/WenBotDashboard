// Local dev proxy - serves HTML and proxies API calls
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3001;

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Invalid JSON: " + body.substring(0, 200))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// Provider configs for local dev
const PROVIDERS = {
  gambulls: {
    buildUrl: (apiKey, limit) =>
      `https://api.gambulls.com/api/public/streamer/leaderboard?type=monthly&limit=${Math.min(limit, 100)}`,
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
    buildUrl: (apiKey, limit) =>
      `https://api.csbattle.com/leaderboards/affiliates/${apiKey}?from=2025-01-01%2000:00:00&to=2030-12-31%2023:59:59&limit=${limit}`,
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
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "x-provider-key, Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // API: Provider-agnostic leaderboard proxy
  if (pathname === "/api/leaderboard") {
    const providerName = url.searchParams.get("provider") || "gambulls";
    const limit = url.searchParams.get("limit") || "200";
    const apiKey = req.headers["x-provider-key"];

    if (!apiKey) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing x-provider-key header" }));
      return;
    }

    const provider = PROVIDERS[providerName];
    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown provider: ${providerName}` }));
      return;
    }

    try {
      const apiUrl = provider.buildUrl(apiKey, limit);
      const data = await fetchJson(apiUrl, provider.buildHeaders(apiKey));
      const users = provider.parseResponse(data);

      if (!users) {
        console.error("Parse failed for", providerName, "- raw data keys:", Object.keys(data));
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to parse provider response", debug: Object.keys(data) }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ provider: providerName, users }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Kick channel proxy
  if (pathname === "/api/kick-channel") {
    const username = url.searchParams.get("username");
    if (!username) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing username" }));
      return;
    }
    try {
      const data = await fetchJson(`https://kick.com/api/v2/channels/${encodeURIComponent(username)}`, {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: data.id,
        username: data.slug,
        chatroom_id: data.chatroom?.id,
        is_live: !!data.livestream,
        followers_count: data.followers_count,
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files - default to login.html instead of index.html
  let filePath = pathname === "/" ? "/login.html" : pathname;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  LogicPlay dev server running at:`);
  console.log(`  http://localhost:${PORT}\n`);
});
