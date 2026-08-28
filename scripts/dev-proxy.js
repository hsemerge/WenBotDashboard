// DEV-ONLY front door for local testing (see dev-static-shim.js header for why:
// netlify-cli's dev proxy 403s unclaimed statics and lets the portal catch-alls
// shadow real pages — none of which happens in prod).
//
// Run `netlify dev --offline --port 8888` first (its static server sits on 3999),
// then `node scripts/dev-proxy.js` and browse http://localhost:8899:
//   /api/* and /.netlify/*  -> :8888  (functions, with env)
//   everything else         -> :3999  (plain static dist/, no redirect engine)
//
// Pages and functions share the 8899 origin, so authedFetch('/api/…') works.

const http = require("http");

const FUNCTIONS = { host: "127.0.0.1", port: 8888 };
const STATIC    = { host: "127.0.0.1", port: 3999 };
const PORT      = 8899;

http.createServer((req, res) => {
  const isApi = req.url.startsWith("/api/") || req.url.startsWith("/.netlify/");
  const t = isApi ? FUNCTIONS : STATIC;
  // /api/<name> aliases are resolved by netlify's redirect engine, which the
  // portal catch-alls make flaky in dev — the /.netlify/functions/* form hits
  // the functions layer deterministically, so rewrite to that.
  const path = req.url.startsWith("/api/")
    ? "/.netlify/functions/" + req.url.slice("/api/".length)
    : req.url;
  const up = http.request({ host: t.host, port: t.port, path, method: req.method, headers: { ...req.headers, host: `${t.host}:${t.port}` } }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502); res.end("dev-proxy upstream error: " + e.message); });
  req.pipe(up);
}).listen(PORT, () => console.log(`dev proxy ready → http://localhost:${PORT}  (api→:${FUNCTIONS.port}, static→:${STATIC.port})`));
