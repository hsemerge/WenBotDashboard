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

// The host→slug map and the bespoke-portal map now come from a GENERATED file,
// baked at build time from the `custom_domains` collection that the admin portal
// manages — so onboarding an Agency customer's domain is a form, not a code edit.
//
// Still a baked constant rather than a runtime lookup because this function is
// registered `path: "/*"`: it runs on every request to the site, and a per-
// request fetch here would slow every page load for everyone.
//
// SLUG_TO_PAGE: a slug listed there is served from its own hand-built page under
// /portals/<slug>/ instead of the standard portal.html. The page pulls the SAME
// live data via /api/portal-data?channel=<slug>, so only the presentation
// differs. Slugs not listed fall through to portal.html.
//
// It lives in netlify/edge-shared/ rather than beside this file because Netlify
// registers EVERY file in netlify/edge-functions/ as an edge function, and a
// constants-only module has no default export — which fails the bundling step
// and takes the whole deploy with it.
import { HOST_TO_SLUG, SLUG_TO_PAGE } from "../edge-shared/domains.generated.js";

// This function runs on EVERY request to the site, and an uncaught throw here is
// not a broken feature — it is Netlify's "This edge function has crashed" page
// where the streamer's site should be. There is no partial failure mode: the
// whole domain goes down for that request.
//
// So the real handler is wrapped. Anything unexpected falls back to passing the
// request through untouched, which for a custom domain serves the wrong page but
// still serves A page — and it logs, so a recurring fault is findable instead of
// showing up as an intermittent crash screen nobody can reproduce.
export default async (request, context) => {
  try {
    return await route(request, context);
  } catch (e) {
    console.error("[custom-domain] unhandled error, passing request through:",
                  (e && e.stack) || (e && e.message) || e);
    return;   // undefined = leave routing alone rather than crash
  }
};

const route = async (request, context) => {
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
      // Media matters as much as images here. Without mp4/mov/webm in this list,
      // a request for a video fell through to the bespoke-page rewrite below and
      // was answered with the portal's HTML, so a browser expecting footage got a
      // web page and simply hung. A missing asset should 404 honestly.
      path.match(/\.(js|css|png|jpg|jpeg|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|map|mp4|mov|webm|ogg|mp3|wav|m4a|json|txt|xml|pdf)$/i)) {
    return;
  }

  // Bespoke portal: a single self-contained page, so there are NO server-side
  // sub-paths. Serve the bespoke page for every page request, including arbitrary
  // paths like /admin123 or /yazo — otherwise they'd fall through to the standard
  // portal.html below and leak the old portal + leaderboard. (Assets, /api/*,
  // /.netlify/* already returned above.)
  //
  // The page routes CLIENT-side off both the hash and the path, so /store and
  // #store both open the store, the same way /csgobig and /degen already work.
  // That's what lets a shared link read as megrewards.com/store rather than
  // megrewards.com/store#store, where the path segment did nothing.
  const bespoke = SLUG_TO_PAGE[slug];
  if (bespoke) {
    if (path.startsWith("/portals/")) return; // already the page itself

    // Real, separate pages that must NOT be swallowed by the catch-all below.
    //
    // The catch-all is deliberate: a bespoke portal routes /store, /winners and
    // /degen client-side, so those have to reach the portal page. But /verify is
    // its own document, and answering it with the portal meant a viewer who
    // pressed "Verify now" on a custom domain was handed the page they were
    // already on. Kick sign-in works from these domains (see the return-origin
    // allowlist in kick-session-mint), so they belong on the streamer's own
    // domain rather than being bounced to wenbot.gg.
    const REAL_PAGES = new Set(["/verify", "/verify-email", "/commands"]);
    if (REAL_PAGES.has(path.replace(/\/+$/, ""))) return;

    // Branded legal pages: megrewards.com/terms + /privacy serve the portal's
    // own documents instead of the catch-all bespoke page. Only for slugs that
    // ship the files.
    const LEGAL_PAGES = new Set(["meggambles"]);
    if ((path === "/terms" || path === "/privacy") && LEGAL_PAGES.has(slug)) {
      url.pathname = `/portals/${slug}${path}.html`;
      return context.rewrite(url.toString());
    }

    url.pathname = bespoke;

    // Shareable board deep links (megrewards.com/csgobig, /degen). The page reads
    // the path on load and opens that board. For /csgobig we also rewrite the
    // OpenGraph/Twitter tags so link-unfurls (Discord/X) show the GOLD CSGOBig
    // artwork + title instead of the default purple MegRewards card — the URL
    // fragment (#csgobig) can't do this because crawlers never receive it.
    const CSGOBIG_OG = {
      slugs: new Set(["meggambles"]),
    };
    if (path === "/csgobig" && CSGOBIG_OG.slugs.has(slug)) {
      // Best-effort, and deliberately so.
      //
      // This is the only path in this function that BUFFERS the response instead
      // of streaming it — everything else hands the rewrite straight back. That
      // makes it the only one that can fail on something other than routing: the
      // body read, a rewrite that resolves to an error page mid-deploy, memory
      // pressure on a cold isolate. Nothing here was caught, and an uncaught
      // throw in an edge function is not a degraded page, it is Netlify's crash
      // screen instead of the site.
      //
      // What is at stake if this fails is the link-unfurl artwork on Discord and
      // X. What was at stake without the catch was the page. Serve the page.
      try {
        const res  = await context.rewrite(url.toString());
        let   html = await res.text();
        const origin = `${url.protocol}//${host}`;
        html = html
          .split(`${origin}/portals/${slug}/assets/megrewards-poster.jpg`)
          .join(`${origin}/portals/${slug}/assets/csgobig-og.png`)
          .split("MegRewards — Wager Race")
          .join("MegRewards × CSGOBig — Monthly Coin Race");
        const headers = new Headers(res.headers);
        headers.delete("content-length");   // body length changed
        headers.delete("content-encoding"); // body is now decoded text
        return new Response(html, { status: res.status, headers });
      } catch (e) {
        console.error("[custom-domain] csgobig og rewrite failed, serving the plain page:", e && e.message);
        return context.rewrite(url.toString());
      }
    }

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
