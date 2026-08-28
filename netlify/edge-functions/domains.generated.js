// GENERATED — do not edit by hand.
//
// Written by scripts/bake-domains.js from the `custom_domains` collection, which
// the admin portal manages (Portal Management → Custom domains).
//
// Baked at build time rather than read at runtime because custom-domain.js is
// registered `path: "/*"` — it runs on EVERY request to the site, so a lookup
// there would tax every page load for everyone to serve a handful of domains.
//
// This file is committed, so a deploy never depends on the build being able to
// reach Firestore: if the bake can't connect it leaves the last good map in
// place rather than shipping an empty one and dropping every custom domain.

export const HOST_TO_SLUG = {
  "irishqueenoftheslots.com": "meggambles",
  "megrewards.com": "meggambles",
  "skslots.co.uk": "skslots",
  "tiltbros.com": "thetiltbros",
  "www.irishqueenoftheslots.com": "meggambles",
  "www.megrewards.com": "meggambles",
  "www.skslots.co.uk": "skslots",
  "www.tiltbros.com": "thetiltbros",
};

export const SLUG_TO_PAGE = {
  "meggambles": "/portals/meggambles/index.html",
  "skslots": "/portals/skslots/index.html",
  "thetiltbros": "/portals/thetiltbros/index.html",
};
