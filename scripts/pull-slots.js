/* ============================================================================
 * pull-slots.js — Stake slot extractor for the wenbot slot-picker catalog.
 *
 * HOW TO USE:
 *   1. Open stake.com in your browser, log in / pass Cloudflare normally.
 *   2. Open DevTools console (F12) and paste this ENTIRE file, press Enter.
 *      (Or save it as a bookmarklet — see BOOKMARKLET note at the bottom.)
 *   3. Wait ~40s. A box pops up with the JSON, pre-selected.
 *      Ctrl+C to copy (it also auto-copies to clipboard if allowed).
 *   4. Save the copied text as  slots-pull.json  in the project root.
 *   5. Run:  node scripts/ingest-slots.js
 *
 * Pulls top providers + the first ~200 of the "slots" group (newest-first),
 * so it catches both per-studio releases and brand-new drops from anyone.
 *
 * NOTE: run this yourself, in your own browser, occasionally. Do NOT wire it
 * into an automated headless scraper — that defeats Stake's bot protection and
 * is a clear ToS breach. See memory: project_slot_catalog_sourcing.
 * ==========================================================================*/
(async () => {
  // Top providers worth sweeping every refresh (slug => true). Slugs verified
  // working against slugKuratorGroup. Wrong slugs just return null (harmless).
  const PROVIDERS = [
    'pragmatic-play', 'hacksaw-gaming', 'nolimit', 'playngo', 'relax',
    'bgaming', 'elk', 'big-time-gaming', 'redtiger', 'netent', 'thunderkick',
    'quickspin', 'avatarux', 'booming', 'blueprint', 'push-gaming', 'pgsoft',
    '3-oaks', 'wazdan', 'endorphina',
  ];
  // Also sweep the newest slots across ALL providers (this group is sorted
  // newest-first; 200 is plenty to catch a month's worth of releases).
  const NEW_RELEASES_SLUG = 'slots';
  const NEW_RELEASES_COUNT = 200;

  const LIMIT = 50;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchGroup(slug, maxOffset) {
    const out = [];
    let offset = 0;
    while (offset < maxOffset) {
      const query = `{slugKuratorGroup(slug:"${slug}"){groupGamesList(limit:${LIMIT},offset:${offset}){game{name slug thumbnailUrl provider{name}}}}}`;
      let resp;
      try {
        resp = await fetch('/_api/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
      } catch (e) { console.warn(`  network error for ${slug}:`, e.message); break; }
      if (!resp.ok) { console.warn(`  HTTP ${resp.status} for ${slug}`); break; }
      const json = await resp.json();
      if (json.errors) { console.warn(`  GQL error for ${slug}:`, json.errors[0]?.message); break; }
      const list = json.data?.slugKuratorGroup?.groupGamesList;
      if (!list) { console.warn(`  (no group for "${slug}")`); break; }
      out.push(...list.map(i => i.game).filter(Boolean));
      if (list.length < LIMIT) break;
      offset += LIMIT;
      await sleep(200);
    }
    return out;
  }

  const all = [];
  for (const slug of PROVIDERS) {
    console.log(`Fetching ${slug}...`);
    const g = await fetchGroup(slug, 5000);
    console.log(`  → ${g.length}`);
    all.push(...g);
  }
  console.log(`Fetching newest ${NEW_RELEASES_COUNT} from "${NEW_RELEASES_SLUG}"...`);
  const fresh = await fetchGroup(NEW_RELEASES_SLUG, NEW_RELEASES_COUNT);
  console.log(`  → ${fresh.length}`);
  all.push(...fresh);

  // dedupe by slug, slim to the fields the ingest needs
  const seen = new Set();
  const slim = [];
  for (const g of all) {
    if (!g?.slug || !g?.name || seen.has(g.slug)) continue;
    seen.add(g.slug);
    slim.push({ name: g.name, slug: g.slug, thumbnailUrl: g.thumbnailUrl, provider: g.provider?.name });
  }
  const payload = JSON.stringify(slim, null, 2);
  console.log(`\nTotal unique games: ${slim.length}`);

  // try clipboard, but always show a pre-selected textarea as the reliable path
  try { await navigator.clipboard.writeText(payload); console.log('✅ Auto-copied to clipboard.'); }
  catch (e) { console.log('Clipboard blocked — use the box below (Ctrl+C).'); }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.85);display:flex;flex-direction:column;padding:24px;box-sizing:border-box;font-family:system-ui';
  wrap.innerHTML = `<div style="color:#fff;margin-bottom:8px;font-size:15px">${slim.length} games — select all (Ctrl+A) then copy (Ctrl+C), save as <b>slots-pull.json</b>. <button id="__close" style="margin-left:12px;padding:4px 10px">Close</button></div>`;
  const ta = document.createElement('textarea');
  ta.value = payload;
  ta.style.cssText = 'flex:1;width:100%;font-family:monospace;font-size:12px;padding:8px;box-sizing:border-box';
  wrap.appendChild(ta);
  document.body.appendChild(wrap);
  ta.focus(); ta.select();
  document.getElementById('__close').onclick = () => wrap.remove();
})();

/* BOOKMARKLET: to make this one-click, create a bookmark whose URL is
 *   javascript:(the minified contents of this file)
 * Any JS minifier works; keep the leading `javascript:` prefix.
 */
