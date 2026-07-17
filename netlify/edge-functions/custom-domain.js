// Custom-domain → streamer slug rewriter.
//
// Runs ahead of every request. When a streamer has pointed their own domain
// at the wenbot Netlify site (eg. skslots.co.uk → wenbot.netlify.app), this
// function rewrites the URL so the rest of the stack thinks the request came
// in as /<slug>/<rest>.
//
//   GET skslots.co.uk/             → internal /skslots             → portal.html
//   GET skslots.co.uk/leaderboard  → internal /skslots/leaderboard → portal.html
//                                                                   (tab pre-selected)
//
// New custom domains: add an entry to HOST_TO_SLUG below. Long-term this
// should be backed by Firestore so streamers can self-serve from the
// dashboard, but the hardcoded map ships SKSlots today without that work.

const HOST_TO_SLUG = {
  "skslots.co.uk":     "skslots",
  "www.skslots.co.uk": "skslots",
  "irishqueenoftheslots.com":     "irishqueenoftheslots",
  "www.irishqueenoftheslots.com": "irishqueenoftheslots",
  "megrewards.com":     "irishqueenoftheslots",
  "www.megrewards.com": "irishqueenoftheslots",
};

// Bespoke (Agency-tier) portals: a slug here is served from its own hand-built
// page under /portals/<slug>/ instead of the standard portal.html. The page
// pulls the SAME live data via /api/portal-data?channel=<slug>, so only the
// presentation differs. Slugs NOT listed here fall through to portal.html.
const SLUG_TO_PAGE = {
  skslots: "/portals/skslots/index.html",
  irishqueenoftheslots: "/portals/irishqueenoftheslots/index.html",
};

export default async (request, context) => {
  const url   = new URL(request.url);
  const host  = url.host.toLowerCase();
  const slug  = HOST_TO_SLUG[host];
  if (!slug) return; // unknown host → default behavior (wenbot.gg etc.)

  // Don't rewrite asset / function / netlify-internal requests — only the
  // page routes. Catches /assets/foo, /api/*, /.netlify/*, /favicon.ico, etc.
  const path = url.pathname;
  if (path.startsWith("/api/") ||
      path.startsWith("/.netlify/") ||
      path.startsWith("/_next/") ||
      path.match(/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map)$/i)) {
    return;
  }

  // Bespoke portal: a single self-contained page (hash-routed — #store, #winners,
  // etc.), so there are NO server-side sub-paths. Serve the bespoke page for every
  // page request, including arbitrary paths like /admin123 or /yazo — otherwise
  // they'd fall through to the standard portal.html below and leak the old portal
  // + leaderboard. (Assets, /api/*, /.netlify/* already returned above.)
  const bespoke = SLUG_TO_PAGE[slug];
  if (bespoke) {
    if (path.startsWith("/portals/")) return; // already the page itself
    url.pathname = bespoke;
    return context.rewrite(url.toString());
  }

  // Standard portal: prepend the slug so portal.html resolves the channel.
  // Already prefixed (shouldn't happen, but be idempotent).
  if (path === `/${slug}` || path.startsWith(`/${slug}/`)) return;
  const newPath = path === "/" || path === ""
    ? `/${slug}`
    : `/${slug}${path}`;
  url.pathname = newPath;
  return context.rewrite(url.toString());
};

export const config = { path: "/*" };
