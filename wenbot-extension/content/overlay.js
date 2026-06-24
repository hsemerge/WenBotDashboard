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
  let manual = false;  // user dragged → stop auto-anchoring

  // ---- DOM -----------------------------------------------------------------
  const root = document.createElement("div");
  root.id = "wbc-root";
  root.innerHTML = `
    <div class="wbc-head" id="wbc-drag">
      <span class="wbc-dot" id="wbc-dot"></span>
      <span class="wbc-logo">Wen<span>Bot</span></span>
      <span class="wbc-spacer"></span>
      <button class="wbc-iconbtn" id="wbc-snap" title="Snap under the game">⌖</button>
      <button class="wbc-iconbtn" id="wbc-expand" title="Pop out / compact">⤢</button>
      <button class="wbc-iconbtn" id="wbc-min" title="Collapse">—</button>
    </div>
    <div class="wbc-body">
      <div class="wbc-stats">
        <div class="wbc-stat"><div class="k">Bonuses</div><div class="v" id="wbc-count">—</div></div>
        <div class="wbc-stat"><div class="k">Break-even</div><div class="v" id="wbc-be">—</div></div>
        <div class="wbc-stat"><div class="k">Running P/L</div><div class="v" id="wbc-pnl">—</div></div>
      </div>
      <div class="wbc-row">
        <div class="wbc-ac">
          <input class="wbc-input" id="wbc-game" placeholder="Slot name…" autocomplete="off" />
          <div class="wbc-aclist" id="wbc-aclist"></div>
        </div>
        <input class="wbc-input wbc-bet" id="wbc-bet" placeholder="Bet $" inputmode="decimal" />
      </div>
      <button class="wbc-btn" id="wbc-add">+ Add to Hunt</button>
      <div class="wbc-detected" id="wbc-detected"></div>
      <div class="wbc-slotmeta" id="wbc-slotmeta"></div>
      <div class="wbc-toast" id="wbc-toast"></div>
      <div class="wbc-foot">🔒 Never touches your casino account</div>
    </div>
    <div class="wbc-grip" id="wbc-grip"></div>`;
  const pill = document.createElement("button");
  pill.id = "wbc-pill";
  pill.innerHTML = `Wen<span>Bot</span> ▴`;

  const $ = (id) => root.querySelector(id);

  function mount() {
    document.body.appendChild(root);
    document.body.appendChild(pill);
    restoreState();
    wire();
    detectGame();
    refresh();
    let lastUrl = location.href;
    const stop = () => { clearInterval(t1); clearInterval(t2); };
    const t1 = setInterval(() => { if (!alive()) return stop(); refresh(); }, CFG.POLL_MS);
    const t2 = setInterval(() => {
      if (!alive()) return stop();
      if (location.href !== lastUrl) { lastUrl = location.href; detectGame(); }
      anchorToGame(); // game iframe can load/resize late — keep following it
    }, 1500);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    // Game iframes load after us — re-anchor a few times early.
    [300, 900, 2000].forEach((ms) => setTimeout(anchorToGame, ms));
  }

  // ---- auto-anchor under the game -----------------------------------------
  function gameRect() {
    let el = site && site.gameSel ? document.querySelector(site.gameSel) : null;
    if (!el) {
      let best = null, area = 0;
      document.querySelectorAll("iframe, canvas").forEach((n) => {
        const r = n.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > area && r.width >= 260 && r.height >= 180 && r.top < innerHeight && r.bottom > 0) { best = n; area = a; }
      });
      el = best;
    }
    return el ? el.getBoundingClientRect() : null;
  }
  function anchorToGame() {
    if (manual || root.style.display === "none") return;
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
    const bonus = { name: match ? match.name : name, provider: match ? match.provider : "", betSize: bet, gameId: match ? match.gameId : null, thumbnailUrl: match ? match.thumbnailUrl : null };
    const btn = $("#wbc-add"); btn.disabled = true; btn.textContent = "Adding…";
    const r = await bg("addBonus", bonus);
    btn.disabled = false; btn.textContent = "+ Add to Hunt";
    if (r && r.ok) { toast(`Added ${bonus.name} ($${bet}) ✓`, true); $("#wbc-game").value = ""; $("#wbc-bet").value = ""; chosen = null; refresh(); }
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
      anchorToGame();
    };
    $("#wbc-snap").onclick = () => { manual = false; store.set({ wbcManual: false }); anchorToGame(); };
    makeDraggable($("#wbc-drag"));
    makeResizable($("#wbc-grip"));
  }
  function collapse(on) {
    root.style.display = on ? "none" : "block";
    pill.style.display = on ? "block" : "none";
    store.set({ wbcCollapsed: on });
    if (!on) anchorToGame();
  }
  function makeDraggable(handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("wbc-iconbtn")) return; // let buttons click
      drag = true; manual = true; sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
      root.style.right = "auto"; root.style.bottom = "auto"; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      root.style.left = Math.max(0, ox + e.clientX - sx) + "px";
      root.style.top = Math.max(0, oy + e.clientY - sy) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return; drag = false;
      store.set({ wbcManual: true, wbcPos: { left: root.style.left, top: root.style.top } });
    });
  }
  function makeResizable(grip) {
    let sx, sw, rz = false;
    grip.addEventListener("mousedown", (e) => { rz = true; sx = e.clientX; sw = root.offsetWidth; e.preventDefault(); e.stopPropagation(); });
    window.addEventListener("mousemove", (e) => { if (!rz) return; root.style.width = Math.max(240, Math.min(560, sw + e.clientX - sx)) + "px"; });
    window.addEventListener("mouseup", () => { if (!rz) return; rz = false; store.set({ wbcWidth: root.offsetWidth }); anchorToGame(); });
  }
  function restoreState() {
    store.get(["wbcPos", "wbcManual", "wbcFull", "wbcWidth", "wbcCollapsed"], (s) => {
      if (!s) return;
      if (s.wbcWidth) root.style.width = s.wbcWidth + "px";
      if (s.wbcFull) root.classList.add("wbc-full");
      manual = !!s.wbcManual;
      if (manual && s.wbcPos && s.wbcPos.left) {
        root.style.left = s.wbcPos.left; root.style.top = s.wbcPos.top;
        root.style.right = "auto"; root.style.bottom = "auto";
      } else { setTimeout(anchorToGame, 300); }
      if (s.wbcCollapsed) collapse(true);
    });
  }

  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);
})();
