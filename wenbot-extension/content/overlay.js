// WenBot Companion — content overlay.
// A draggable card that AUTO-ANCHORS under the slot you're playing: detect the
// game's iframe/canvas, sit beneath it, follow scroll/resize. Compact by default
// (slot + bet + add), pop out (⤢) for the full HUD, snap back under the game (⌖),
// resize from the corner. COMPLIANCE: only reads the URL/title to identify the
// game — never the account, balance, or bet controls; nothing is automated.
(function () {
  const CFG = window.WENBOT_CONFIG;
  if (!CFG || window.__wbcLoaded) return;
  window.__wbcLoaded = true;

  const site = CFG.SITES.find((s) => s.host.test(location.hostname));

  // Orphaned-after-reload safety: chrome.runtime.* throws once the extension is
  // reloaded. alive() lets us bail quietly; bg()/store swallow lastError.
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };
  const bg = (type, payload) => new Promise((resolve) => {
    if (!alive()) return resolve({ ok: false, error: "context invalidated" });
    try {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : resp);
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
  const store = {
    get: (keys, cb) => { if (alive()) try { chrome.storage.local.get(keys, cb); } catch {} },
    set: (obj)      => { if (alive()) try { chrome.storage.local.set(obj); } catch {} },
  };

  let slots = [];
  let acIndex = -1;
  let chosen = null;   // catalog slot {name, provider, gameId, thumbnailUrl, maxWin, bonusBuy}
  let curHunt = null;  // latest active hunt (for the "already in hunt" check)
  let manual = false;  // user dragged → stop auto-anchoring (floating mode)
  let wantDock = true; // user PREFERENCE (persisted): embed the panel under the slot
                       // (default). Sites without an anchorSel always fall back to float.
  let docked = false;  // whether the panel is CURRENTLY embedded in the page
  let _collapsed = false; // user minimized to the pill (persisted)
  let _offSlot = null;    // null=unknown · true=off a slot (auto corner pill) · false=on a slot
  let _mountedAt = 0;     // load time — brief grace before auto-pilling so it never flashes on a slot page

  // Show the small corner pill (auto-minimized, e.g. off a slot). Distinct from the
  // user's manual minimize (_collapsed); doesn't persist.
  function goPill() {
    docked = false;
    root.classList.remove("wbc-docked");
    ["position", "left", "top", "right", "bottom", "width", "max-width", "margin", "box-shadow"].forEach((p) => root.style.removeProperty(p));
    root.style.display = "none";
    pill.style.display = "block";
  }
  // Start hidden and only fade in once we've actually placed it (game rendered) — stops
  // the "pops in over a still-loading page" tackiness.
  function reveal() {
    if (_collapsed || root.style.display !== "none") return;
    root.style.display = "";
    root.style.opacity = "0";
    requestAnimationFrame(() => { root.style.transition = "opacity .2s ease"; root.style.opacity = "1"; });
  }

  // ---- DOM -----------------------------------------------------------------
  const root = document.createElement("div");
  root.id = "wbc-root";
  root.innerHTML = `
    <div class="wbc-head" id="wbc-drag">
      <span class="wbc-dot" id="wbc-dot"></span>
      <span class="wbc-logo">Wen<span>Bot</span></span>
      <span class="wbc-spacer"></span>
      <button class="wbc-iconbtn" id="wbc-snap" title="Dock under the slot">⤢</button>
      <button class="wbc-iconbtn" id="wbc-expand" title="Compact / full">⛶</button>
      <button class="wbc-iconbtn" id="wbc-min" title="Collapse">—</button>
    </div>
    <div class="wbc-body" id="wbc-body">
      <div class="wbc-stats" id="wbc-stats">
        <div class="wbc-stat" id="wbc-stat-count"><div class="k">Bonuses</div><div class="v" id="wbc-count">—</div></div>
        <div class="wbc-stat" id="wbc-stat-be"><div class="k">Break-even</div><div class="v" id="wbc-be">—</div></div>
        <div class="wbc-stat" id="wbc-stat-pnl"><div class="k">Running P/L</div><div class="v" id="wbc-pnl">—</div></div>
      </div>
      <div class="wbc-row" id="wbc-row">
        <div class="wbc-ac" id="wbc-ac">
          <input class="wbc-input" id="wbc-game" placeholder="Slot name…" autocomplete="off" />
          <div class="wbc-aclist" id="wbc-aclist"></div>
        </div>
        <input class="wbc-input wbc-bet" id="wbc-bet" placeholder="Bet $" inputmode="decimal" />
      </div>
      <div id="wbc-extras">
        <input class="wbc-input" id="wbc-note" placeholder="Note (e.g. super, 5-scat)" autocomplete="off" style="width:100%;margin-top:8px;" />
        <button class="wbc-btn" id="wbc-add">+ Add to Hunt</button>
      </div>
      <div class="wbc-detected" id="wbc-detected"></div>
      <div class="wbc-slotmeta" id="wbc-slotmeta"></div>
      <div class="wbc-foot">🔒 Never touches your casino account</div>
    </div>
    <div class="wbc-bar" id="wbc-bar" style="display:none;">
      <span class="wbc-logo wbc-bar-logo">Wen<span>Bot</span></span>
      <div class="wbc-bar-cell wbc-bar-slot" id="wbc-bar-slot"></div>
      <div class="wbc-bar-cell wbc-bar-bet"  id="wbc-bar-bet"></div>
      <div class="wbc-bar-cell wbc-bar-note" id="wbc-bar-note"></div>
      <div class="wbc-bar-cell wbc-bar-add"  id="wbc-bar-add"></div>
      <div class="wbc-bar-cell wbc-bar-stats" id="wbc-bar-stats"></div>
      <span class="wbc-bar-ctrls">
        <button class="wbc-iconbtn" id="wbc-bpop" title="Pop out (float)">⤢</button>
        <button class="wbc-iconbtn" id="wbc-bmin" title="Collapse">—</button>
      </span>
    </div>
    <div class="wbc-toast" id="wbc-toast"></div>
    <div class="wbc-grip" id="wbc-grip"></div>`;
  const pill = document.createElement("button");
  pill.id = "wbc-pill";
  pill.innerHTML = `Wen<span>Bot</span> ▴`;

  const $ = (id) => root.querySelector(id);

  // The horizontal-bar styles are injected from JS (a fresh <style> each load) rather
  // than the manifest CSS file — browsers cache content-script CSS hard, which bit us
  // repeatedly. This guarantees the bar layout is always current.
  function injectBarCss() {
    if (document.getElementById("wbc-bar-css")) return;
    const st = document.createElement("style");
    st.id = "wbc-bar-css";
    st.textContent = [
      "#wbc-root .wbc-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;}",
      "#wbc-root .wbc-bar-logo{font-weight:800;flex:0 0 auto;white-space:nowrap;}",
      "#wbc-root .wbc-bar-cell{display:flex;align-items:center;min-width:0;}",
      "#wbc-root .wbc-bar-slot{flex:1.3 1 0;position:relative;}",
      "#wbc-root .wbc-bar-bet{flex:0 0 130px;}",
      "#wbc-root .wbc-bar-note{flex:0.9 1 0;}",
      "#wbc-root .wbc-bar-add{flex:0 0 auto;}",
      "#wbc-root .wbc-bar-stats{flex:1 1 0;gap:18px;justify-content:flex-end;}",
      // flex:1 fills the cell — without it the bet input keeps its old 70px flex-basis
      // and leaves dead space in the cell.
      "#wbc-root .wbc-bar .wbc-input{width:100%!important;margin:0!important;flex:1 1 auto!important;}",
      "#wbc-root .wbc-bar .wbc-ac{width:100%;}",
      "#wbc-root .wbc-bar .wbc-btn{width:auto;margin:0;white-space:nowrap;padding:9px 16px;}",
      "#wbc-root .wbc-bar .wbc-stat{background:transparent;border:0;padding:0;text-align:center;}",
      "#wbc-root .wbc-bar .wbc-stat .k{font-size:10px;}",
      "#wbc-root .wbc-bar .wbc-stat .v{font-size:15px;}",
      "#wbc-root .wbc-bar-ctrls{flex:0 0 auto;display:flex;gap:2px;}",
    ].join("");
    (document.head || document.documentElement).appendChild(st);
  }

  function mount() {
    _mountedAt = Date.now();
    document.body.appendChild(root);
    document.body.appendChild(pill);
    root.style.display = "none"; // stay hidden until placed (see reveal())
    injectBarCss();
    restoreState();
    wire();
    detectGame();
    refresh();
    applyPlacement();
    let lastUrl = location.href;
    const stop = () => { clearInterval(t1); clearInterval(t2); };
    const t1 = setInterval(() => { if (!alive()) return stop(); refresh(); }, CFG.POLL_MS);
    const t2 = setInterval(() => {
      if (!alive()) return stop();
      if (location.href !== lastUrl) { lastUrl = location.href; detectGame(); } // new slot
      maintainDock(); // keep embedded as the SPA re-renders (or follow the game if floating)
    }, 1500);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    // The game/anchor render after us — retry placement a few times early.
    [300, 900, 2000, 4000].forEach((ms) => setTimeout(applyPlacement, ms));
  }

  // ---- auto-anchor under the game -----------------------------------------
  function gameEl() {
    let el = site && site.gameSel ? document.querySelector(site.gameSel) : null;
    if (!el) {
      let best = null, area = 0;
      document.querySelectorAll("iframe, canvas").forEach((n) => {
        const r = n.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > area && r.width >= 220 && r.height >= 150 && r.bottom > -200 && r.top < innerHeight + 200) { best = n; area = a; }
      });
      el = best;
    }
    return el;
  }
  function gameRect() { const el = gameEl(); return el ? el.getBoundingClientRect() : null; }
  // ---- dock (embed in the page under the slot) vs float --------------------
  // wantDock = the user's PREFERENCE (persisted). docked = whether we're CURRENTLY
  // embedded. They differ briefly while the SPA is still rendering the game — we keep
  // retrying (see maintainDock) until the anchor exists, then embed.
  function findAnchor() {
    if (!site || !site.anchorSel) return null;   // float-only sites intentionally have no anchor
    // Prefer anchoring to the game element's own context — querySelector(anchorSel)
    // alone can match an unrelated element with the same class (bar in the wrong spot
    // or missed entirely). Detecting the game first is what makes "dock under the slot"
    // work reliably across site variants.
    const g = gameEl();
    if (g) {
      try { const c = g.closest(site.anchorSel); if (c) return c; } catch {}
      // else the game's own reasonably-sized block container
      let el = g;
      for (let i = 0; i < 4 && el.parentElement && el.parentElement !== document.body; i++) {
        const r = el.getBoundingClientRect();
        if (r.width >= 260 && r.height >= 150) return el;
        el = el.parentElement;
      }
      return g;
    }
    // Game not detected yet (still loading) — try the raw selector as an early hint.
    try { return document.querySelector(site.anchorSel); } catch { return null; }
  }
  function updateDockBtn() {
    const b = $("#wbc-snap");
    if (b) { b.textContent = wantDock ? "⤢" : "⌖"; b.title = wantDock ? "Pop out (float)" : "Dock under the slot"; }
  }
  // Insert the panel right after the game so it sits embedded below the slot. Returns
  // false (and floats as a fallback) when the anchor isn't on the page yet.
  function dock() {
    const anchor = findAnchor();
    if (!anchor) return false;   // no slot on the page → maintainDock() shows the corner pill
    // First embed waits until the GAME has actually rendered (has size), so the bar
    // doesn't flash in over a still-loading page. Re-docks (already docked) skip this.
    if (!docked) { const gr = gameRect(); if (!gr || gr.width < 220) return false; }
    docked = true; manual = false; _offSlot = false; pill.style.display = "none";
    root.classList.add("wbc-docked");
    // Move the SHARED controls into the horizontal bar. Ids are preserved, so every
    // detect/autocomplete/add/refresh function keeps working with no other changes.
    $("#wbc-bar-slot").appendChild($("#wbc-ac"));
    $("#wbc-bar-bet").appendChild($("#wbc-bet"));
    $("#wbc-bar-note").appendChild($("#wbc-note"));
    $("#wbc-bar-add").appendChild($("#wbc-add"));
    $("#wbc-bar-stats").appendChild($("#wbc-stat-count"));
    $("#wbc-bar-stats").appendChild($("#wbc-stat-be"));
    $("#wbc-bar-stats").appendChild($("#wbc-stat-pnl"));
    $(".wbc-head").style.display = "none";
    $("#wbc-body").style.display = "none";
    $("#wbc-grip").style.display = "none";
    $("#wbc-bar").style.display = "flex";
    // Full-width bar under the slot. Every prop !important so it beats any cached CSS.
    root.style.cssText += ";position:static!important;left:auto!important;top:auto!important;right:auto!important;bottom:auto!important;width:100%!important;max-width:100%!important;margin:10px 0 6px!important;box-shadow:none!important;";
    if (!root.isConnected || root.previousElementSibling !== anchor) anchor.insertAdjacentElement("afterend", root);
    updateDockBtn();
    reveal();
    console.log("[WenBot] docked — bar embedded under the slot");
    return true;
  }
  function floatCard() {
    docked = false;
    root.classList.remove("wbc-docked");
    // Move the controls back into the vertical card, in their original order.
    $("#wbc-row").appendChild($("#wbc-ac"));
    $("#wbc-row").appendChild($("#wbc-bet"));
    $("#wbc-extras").appendChild($("#wbc-note"));
    $("#wbc-extras").appendChild($("#wbc-add"));
    $("#wbc-stats").appendChild($("#wbc-stat-count"));
    $("#wbc-stats").appendChild($("#wbc-stat-be"));
    $("#wbc-stats").appendChild($("#wbc-stat-pnl"));
    $("#wbc-bar").style.display = "none";
    $(".wbc-head").style.display = "";
    $("#wbc-body").style.display = "";
    $("#wbc-grip").style.display = "";
    ["position", "left", "top", "right", "bottom", "width", "max-width", "margin", "box-shadow"].forEach((p) => root.style.removeProperty(p));
    if (root.parentElement !== document.body) document.body.appendChild(root);
    anchorToGame();
    updateDockBtn();
    if (!wantDock) reveal(); // explicit float → show; float-as-load-fallback stays hidden
    console.log("[WenBot] floating");
  }
  function applyPlacement() {
    if (_collapsed) { root.style.display = "none"; pill.style.display = "block"; return; }
    if (!wantDock) { pill.style.display = "none"; floatCard(); return; }
    const a = findAnchor();
    if (a) { if (dock()) { _offSlot = false; pill.style.display = "none"; } }
    else if (_offSlot !== null || (Date.now() - _mountedAt) >= 4000) { _offSlot = true; goPill(); }
    // else: still within the first-load grace → stay hidden; maintainDock() pills/docks shortly.
  }
  // Called on a timer + slot navigation: keep the panel embedded as the SPA re-renders.
  function maintainDock() {
    if (_collapsed) return;                    // user minimized → leave the pill alone
    if (!wantDock) { if (pill.style.display === "block") pill.style.display = "none"; anchorToGame(); return; }
    const a = findAnchor();
    if (a) {
      // Slot present → embed under it. Only hide the corner pill once we've ACTUALLY
      // docked (the game may still be sizing up behind a splash screen), so it can
      // never get stuck showing the pill on a slot page.
      const need = !docked || !root.isConnected || root.previousElementSibling !== a;
      if (!need || dock()) { _offSlot = false; pill.style.display = "none"; }
    } else {
      // Off a slot (home page, lobby, or a layout we can't anchor) → small corner pill.
      // Brief first-load grace so we never flash the pill before the slot's game renders.
      if (_offSlot === null && (Date.now() - _mountedAt) < 4000) return;
      if (_offSlot !== true) { _offSlot = true; goPill(); }
    }
  }

  function anchorToGame() {
    if (docked || manual || root.style.display === "none") return;
    const w = root.offsetWidth || 280, h = root.offsetHeight || 160;
    const r = gameRect();
    let left = r ? r.left : innerWidth - w - 18;
    let top  = r ? r.bottom + 8 : innerHeight - h - 18;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    top  = Math.max(8, Math.min(top,  innerHeight - h - 8));
    root.style.left = left + "px"; root.style.top = top + "px";
    root.style.right = "auto"; root.style.bottom = "auto";
  }
  let raf = 0;
  function onReflow() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; anchorToGame(); }); }

  // ---- live HUD ------------------------------------------------------------
  function fmt(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(); }
  async function refresh() {
    const r = await bg("getStatus");
    if (!r || !r.ok) return;
    const { connected, hunt } = r.data || {};
    curHunt = hunt && hunt.active ? hunt : null;
    renderSlotMeta();
    $("#wbc-dot").classList.toggle("on", !!connected);
    if (!connected || !hunt || !hunt.active) {
      $("#wbc-count").textContent = connected ? "0" : "—";
      $("#wbc-be").textContent = "—";
      $("#wbc-pnl").textContent = connected ? "no hunt" : "set channel";
      return;
    }
    const b = hunt.bonuses || [];
    const totalBet = b.reduce((a, x) => a + (Number(x.betSize) || 0), 0);
    const winnings = b.reduce((a, x) => a + (Number(x.payout) || 0), 0);
    const opened = b.filter((x) => x.payout != null).length;
    const be = totalBet > 0 ? (hunt.totalCost / totalBet) : 0;
    $("#wbc-count").textContent = String(b.length);
    $("#wbc-be").textContent = be ? be.toFixed(2) + "x" : "—";
    const pnlEl = $("#wbc-pnl");
    if (opened > 0) {
      const pnl = winnings - hunt.totalCost;
      pnlEl.textContent = (pnl >= 0 ? "+" : "") + fmt(pnl);
      pnlEl.className = "v " + (pnl >= 0 ? "pos" : "neg");
    } else { pnlEl.textContent = fmt(hunt.totalCost || 0); pnlEl.className = "v"; }
  }

  // ---- game detection (URL slug → catalog) ---------------------------------
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function urlSlug() { const p = location.pathname.split("/").filter(Boolean); return p.length ? p[p.length - 1] : ""; }
  function matchSlot(text) {
    const ns = norm(text);
    if (ns.length < 3) return null;
    let hit = slots.find((s) => norm(s.gameId) === ns || norm(s.name) === ns);
    if (hit) return hit;
    let best = null, bestLen = 0;
    for (const s of slots) { const g = norm(s.gameId); if (g.length >= 5 && ns.includes(g) && g.length > bestLen) { best = s; bestLen = g.length; } }
    if (best) return best;
    for (const s of slots) { const n = norm(s.name); if (n.length >= 6 && ns.includes(n) && n.length > bestLen) { best = s; bestLen = n.length; } }
    return best;
  }
  let lastAutoFill = "";
  async function detectGame() {
    await ensureSlots();
    let match = matchSlot(urlSlug());
    let guess = "";
    if (!match) {
      for (const sel of (site && site.detect) || []) {
        const el = document.querySelector(sel);
        if (el && el.textContent && el.textContent.trim().length > 1) { guess = el.textContent.trim(); break; }
      }
      if (!guess && document.title) guess = document.title.split(/[|\-–—·]/)[0].trim();
      match = matchSlot(guess);
    }
    const note = $("#wbc-detected"), inp = $("#wbc-game");
    if (match) {
      if (!inp.value || inp.value === lastAutoFill) { inp.value = match.name; lastAutoFill = match.name; chosen = match; }
      note.innerHTML = `Detected: <b>${esc(match.name)}</b> ✓`;
    } else if (guess && norm(guess) !== norm(location.hostname)) {
      note.innerHTML = `Couldn't match "<b>${esc(guess)}</b>" — type it →`;
    } else { note.textContent = "Type the slot you're playing →"; }
    renderSlotMeta();
  }

  function renderSlotMeta() {
    const el = $("#wbc-slotmeta"); if (!el) return;
    const name = $("#wbc-game").value.trim();
    const slot = chosen || slots.find((s) => norm(s.name) === norm(name));
    if (!slot || !name) { el.innerHTML = ""; return; }
    const bits = [];
    if (slot.provider) bits.push(esc(slot.provider));
    if (slot.maxWin)   bits.push("max " + Number(slot.maxWin).toLocaleString() + "x");
    if (slot.bonusBuy) bits.push("bonus buy");
    let html = bits.join(" · ");
    const already = curHunt ? (curHunt.bonuses || []).filter((b) => norm(b.name) === norm(slot.name)).length : 0;
    if (already) html += (html ? " · " : "") + `<span class="wbc-warn">⚠ already in hunt ×${already}</span>`;
    el.innerHTML = html;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---- autocomplete --------------------------------------------------------
  async function ensureSlots() { if (slots.length) return; const r = await bg("getSlots"); if (r && r.ok) slots = r.data || []; }
  function runAC(q) {
    const list = $("#wbc-aclist");
    q = (q || "").toLowerCase().trim();
    chosen = null;
    if (q.length < 2) { list.classList.remove("open"); return; }
    const hits = slots.filter((s) => s.name && s.name.toLowerCase().includes(q)).slice(0, 8);
    if (!hits.length) { list.classList.remove("open"); return; }
    acIndex = -1;
    list.innerHTML = hits.map((s, i) => `<div class="wbc-acitem" data-i="${i}"><span>${esc(s.name)}</span><span class="prov">${esc(s.provider || "")}</span></div>`).join("");
    list._hits = hits; list.classList.add("open");
    list.querySelectorAll(".wbc-acitem").forEach((el) => { el.onclick = () => pick(hits[+el.dataset.i]); });
  }
  function pick(s) { chosen = s; $("#wbc-game").value = s.name; $("#wbc-aclist").classList.remove("open"); renderSlotMeta(); }

  // ---- add to hunt ---------------------------------------------------------
  function toast(msg, ok) { const t = $("#wbc-toast"); t.textContent = msg; t.className = "wbc-toast show " + (ok ? "ok" : "err"); setTimeout(() => t.classList.remove("show"), 3500); }
  async function addBonus() {
    const name = $("#wbc-game").value.trim();
    const bet = parseFloat($("#wbc-bet").value);
    if (!name) return toast("Pick a slot first.", false);
    if (!bet || bet <= 0) return toast("Enter a bet size.", false);
    const match = chosen || slots.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const noteEl = $("#wbc-note"); const note = noteEl ? noteEl.value.trim() : "";
    const bonus = { name: match ? match.name : name, provider: match ? match.provider : "", betSize: bet, gameId: match ? match.gameId : null, thumbnailUrl: match ? match.thumbnailUrl : null, notes: note };
    const btn = $("#wbc-add"); btn.disabled = true; btn.textContent = "Adding…";
    const r = await bg("addBonus", bonus);
    btn.disabled = false; btn.textContent = "+ Add to Hunt";
    if (r && r.ok) { toast(`Added ${bonus.name} ($${bet}) ✓`, true); $("#wbc-game").value = ""; $("#wbc-bet").value = ""; if (noteEl) noteEl.value = ""; chosen = null; refresh(); }
    else toast((r && r.error) || "Failed — is the extension connected?", false);
  }

  // ---- wiring --------------------------------------------------------------
  function wire() {
    ensureSlots();
    const game = $("#wbc-game"), list = $("#wbc-aclist");
    game.addEventListener("input", () => { runAC(game.value); renderSlotMeta(); });
    game.addEventListener("focus", () => { ensureSlots(); if (game.value) runAC(game.value); });
    game.addEventListener("keydown", (e) => {
      const items = list.querySelectorAll(".wbc-acitem");
      if (!list.classList.contains("open") || !items.length) return;
      if (e.key === "ArrowDown") { acIndex = Math.min(acIndex + 1, items.length - 1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { acIndex = Math.max(acIndex - 1, 0); e.preventDefault(); }
      else if (e.key === "Enter" && acIndex >= 0) { pick(list._hits[acIndex]); e.preventDefault(); return; }
      else return;
      items.forEach((el, i) => el.classList.toggle("active", i === acIndex));
    });
    document.addEventListener("click", (e) => { if (!root.contains(e.target)) list.classList.remove("open"); });
    $("#wbc-bet").addEventListener("keydown", (e) => { if (e.key === "Enter") addBonus(); });
    $("#wbc-add").onclick = addBonus;
    $("#wbc-min").onclick = () => collapse(true);
    pill.onclick = () => collapse(false);
    $("#wbc-expand").onclick = () => {
      const full = !root.classList.contains("wbc-full");
      root.classList.toggle("wbc-full", full);
      store.set({ wbcFull: full });
      if (!docked) anchorToGame();
    };
    // Dock ⟷ float toggle (persists the preference).
    $("#wbc-snap").onclick = () => { wantDock = !wantDock; store.set({ wbcDocked: wantDock }); manual = false; applyPlacement(); };
    // Bar controls (visible when docked): pop out to float / collapse.
    $("#wbc-bpop").onclick = () => { wantDock = false; store.set({ wbcDocked: false }); manual = false; applyPlacement(); };
    $("#wbc-bmin").onclick = () => collapse(true);
    makeDraggable($("#wbc-drag"));
    makeResizable($("#wbc-grip"));
  }
  function collapse(on) {
    _collapsed = on;
    store.set({ wbcCollapsed: on });
    if (on) { root.style.display = "none"; pill.style.display = "block"; return; }
    // Expanding from the pill: dock if we're on a slot, otherwise show a floating card
    // so the user can still see the HUD off a slot (don't just bounce back to the pill).
    pill.style.display = "none";
    const a = wantDock ? findAnchor() : null;
    if (a) { _offSlot = false; dock(); }
    else { _offSlot = wantDock ? true : null; floatCard(); root.style.display = ""; }
  }
  function makeDraggable(handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("wbc-iconbtn")) return; // let buttons click
      // Dragging a docked panel pops it out into a floating card (and remembers that).
      const r = root.getBoundingClientRect();
      if (docked) { wantDock = false; store.set({ wbcDocked: false }); floatCard(); }
      drag = true; manual = true; sx = e.clientX; sy = e.clientY;
      ox = r.left; oy = r.top;
      root.style.left = ox + "px"; root.style.top = oy + "px";
      root.style.right = "auto"; root.style.bottom = "auto"; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      root.style.left = Math.max(0, ox + e.clientX - sx) + "px";
      root.style.top = Math.max(0, oy + e.clientY - sy) + "px";
    });
    // Drag floats the card for THIS session only — we no longer persist it, so a
    // fresh page load always re-docks under the slot (use ⌖ to re-dock right away).
    window.addEventListener("mouseup", () => { if (!drag) return; drag = false; });
  }
  function makeResizable(grip) {
    let sx, sw, rz = false;
    grip.addEventListener("mousedown", (e) => { rz = true; sx = e.clientX; sw = root.offsetWidth; e.preventDefault(); e.stopPropagation(); });
    window.addEventListener("mousemove", (e) => { if (!rz) return; root.style.width = Math.max(240, Math.min(560, sw + e.clientX - sx)) + "px"; });
    window.addEventListener("mouseup", () => { if (!rz) return; rz = false; store.set({ wbcWidth: root.offsetWidth }); anchorToGame(); });
  }
  function restoreState() {
    store.get(["wbcFull", "wbcWidth", "wbcCollapsed", "wbcDocked", "wbcDockMig2"], (s) => {
      s = s || {};
      if (s.wbcWidth) root.style.width = s.wbcWidth + "px";
      if (s.wbcFull) root.classList.add("wbc-full");
      // One-time reset: earlier builds could leave the dock preference stuck on "float"
      // (an accidental toggle). Force the docked default once so everyone starts
      // embedded; the preference is respected on every load after this.
      if (!s.wbcDockMig2) { wantDock = true; store.set({ wbcDocked: true, wbcDockMig2: true }); }
      else { wantDock = s.wbcDocked !== false; }
      manual = false;
      updateDockBtn();
      applyPlacement();
      if (s.wbcCollapsed) collapse(true);
    });
  }

  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);
})();
