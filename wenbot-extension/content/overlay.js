// WenBot Companion — content overlay.
// Injects a single draggable card onto the casino page: live hunt HUD +
// "Add to Hunt" bar. COMPLIANCE: this script only READS the document title to
// guess the current game name. It never reads the account/balance, never touches
// bet controls, never automates anything. The streamer always confirms the game
// and bet before anything is sent to WenBot.
(function () {
  const CFG = window.WENBOT_CONFIG;
  if (!CFG || window.__wbcLoaded) return;
  window.__wbcLoaded = true;

  const site = CFG.SITES.find((s) => s.host.test(location.hostname));
  const bg = (type, payload) =>
    new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve));

  let slots = [];
  let acIndex = -1;
  let chosen = null; // {name, provider, gameId, thumbnailUrl}

  // ---- build DOM -----------------------------------------------------------
  const root = document.createElement("div");
  root.id = "wbc-root";
  root.innerHTML = `
    <div class="wbc-head" id="wbc-drag">
      <span class="wbc-dot" id="wbc-dot"></span>
      <span class="wbc-logo">Wen<span>Bot</span></span>
      <span class="wbc-spacer"></span>
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
      <button class="wbc-btn full" id="wbc-add">+ Add to Hunt</button>
      <div class="wbc-detected" id="wbc-detected"></div>
      <div class="wbc-toast" id="wbc-toast"></div>
      <div class="wbc-foot">🔒 <span class="lock">Read-only — never touches your casino account</span></div>
    </div>`;
  const pill = document.createElement("button");
  pill.id = "wbc-pill";
  pill.innerHTML = `Wen<span>Bot</span> ▴`;

  function mount() {
    document.body.appendChild(root);
    document.body.appendChild(pill);
    restorePosition();
    wire();
    detectGame();
    refresh();
    setInterval(refresh, CFG.POLL_MS);
    // Stake & co. are SPAs — the URL changes between games without a reload.
    let lastUrl = location.href;
    setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; detectGame(); } }, 1500);
  }

  // ---- live HUD ------------------------------------------------------------
  const $ = (id) => root.querySelector(id);
  function fmt(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(); }

  async function refresh() {
    const r = await bg("getStatus");
    const dot = $("#wbc-dot");
    if (!r || !r.ok) return;
    const { connected, hunt } = r.data || {};
    dot.classList.toggle("on", !!connected);
    if (!connected || !hunt || !hunt.active) {
      $("#wbc-count").textContent = connected ? "0" : "—";
      $("#wbc-be").textContent = "—";
      $("#wbc-pnl").textContent = connected ? "no hunt" : "set channel";
      return;
    }
    const bonuses = hunt.bonuses || [];
    const totalBet = bonuses.reduce((a, b) => a + (Number(b.betSize) || 0), 0);
    const winnings = bonuses.reduce((a, b) => a + (Number(b.payout) || 0), 0);
    const opened = bonuses.filter((b) => b.payout != null).length;
    const be = totalBet > 0 ? (hunt.totalCost / totalBet) : 0;
    $("#wbc-count").textContent = String(bonuses.length);
    $("#wbc-be").textContent = be ? be.toFixed(2) + "x" : "—";
    const pnlEl = $("#wbc-pnl");
    if (opened > 0) {
      const pnl = winnings - hunt.totalCost;
      pnlEl.textContent = (pnl >= 0 ? "+" : "") + fmt(pnl);
      pnlEl.className = "v " + (pnl >= 0 ? "pos" : "neg");
    } else {
      pnlEl.textContent = fmt(hunt.totalCost || 0);
      pnlEl.className = "v";
    }
  }

  // ---- game detection ------------------------------------------------------
  // Casino game pages are canvas/iframe (unreadable, and we shouldn't read them
  // anyway), but the URL carries the slug — e.g. stake .../casino/games/le-bandit.
  // Match that slug against WenBot's catalog (gameId/name) → exact, canonical hit.
  // Title is only a weak fallback hint.
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function urlSlug() {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }
  function matchSlot(text) {
    const ns = norm(text);
    if (ns.length < 3) return null;
    let hit = slots.find((s) => norm(s.gameId) === ns || norm(s.name) === ns);   // exact
    if (hit) return hit;
    let best = null, bestLen = 0;
    for (const s of slots) {            // slug CONTAINS a gameId (longest wins)
      const g = norm(s.gameId);
      if (g.length >= 5 && ns.includes(g) && g.length > bestLen) { best = s; bestLen = g.length; }
    }
    if (best) return best;
    for (const s of slots) {            // slug CONTAINS a full name
      const n = norm(s.name);
      if (n.length >= 6 && ns.includes(n) && n.length > bestLen) { best = s; bestLen = n.length; }
    }
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
    const note = $("#wbc-detected");
    const inp = $("#wbc-game");
    if (match) {
      if (!inp.value || inp.value === lastAutoFill) { inp.value = match.name; lastAutoFill = match.name; chosen = match; }
      note.innerHTML = `Detected: <b>${esc(match.name)}</b> ✓`;
    } else if (guess && norm(guess) !== norm(location.hostname)) {
      note.innerHTML = `Couldn't match "<b>${esc(guess)}</b>" — type it →`;
    } else {
      note.textContent = "Type the slot you're playing →";
    }
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---- autocomplete --------------------------------------------------------
  async function ensureSlots() {
    if (slots.length) return;
    const r = await bg("getSlots");
    if (r && r.ok) slots = r.data || [];
  }
  function runAC(q) {
    const list = $("#wbc-aclist");
    q = (q || "").toLowerCase().trim();
    chosen = null;
    if (q.length < 2) { list.classList.remove("open"); return; }
    const hits = slots.filter((s) => s.name && s.name.toLowerCase().includes(q)).slice(0, 8);
    if (!hits.length) { list.classList.remove("open"); return; }
    acIndex = -1;
    list.innerHTML = hits.map((s, i) =>
      `<div class="wbc-acitem" data-i="${i}"><span>${esc(s.name)}</span><span class="prov">${esc(s.provider || "")}</span></div>`
    ).join("");
    list._hits = hits;
    list.classList.add("open");
    list.querySelectorAll(".wbc-acitem").forEach((el) => {
      el.onclick = () => pick(hits[+el.dataset.i]);
    });
  }
  function pick(s) {
    chosen = s;
    $("#wbc-game").value = s.name;
    $("#wbc-aclist").classList.remove("open");
  }

  // ---- add to hunt ---------------------------------------------------------
  function toast(msg, ok) {
    const t = $("#wbc-toast");
    t.textContent = msg; t.className = "wbc-toast show " + (ok ? "ok" : "err");
    setTimeout(() => t.classList.remove("show"), 3500);
  }
  async function addBonus() {
    const name = $("#wbc-game").value.trim();
    const bet = parseFloat($("#wbc-bet").value);
    if (!name) return toast("Pick a slot first.", false);
    if (!bet || bet <= 0) return toast("Enter a bet size.", false);
    const match = chosen || slots.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const bonus = {
      name: match ? match.name : name,
      provider: match ? match.provider : "",
      betSize: bet,
      gameId: match ? match.gameId : null,
      thumbnailUrl: match ? match.thumbnailUrl : null,
    };
    const btn = $("#wbc-add"); btn.disabled = true; btn.textContent = "Adding…";
    const r = await bg("addBonus", bonus);
    btn.disabled = false; btn.textContent = "+ Add to Hunt";
    if (r && r.ok) {
      toast(`Added ${bonus.name} ($${bet}) to your hunt ✓`, true);
      $("#wbc-game").value = ""; $("#wbc-bet").value = ""; chosen = null;
      refresh();
    } else {
      toast((r && r.error) || "Failed — is the extension connected?", false);
    }
  }

  // ---- wiring + drag + collapse -------------------------------------------
  function wire() {
    ensureSlots();
    const game = $("#wbc-game"), list = $("#wbc-aclist");
    game.addEventListener("input", () => runAC(game.value));
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
    makeDraggable($("#wbc-drag"));
  }
  function collapse(on) {
    root.style.display = on ? "none" : "block";
    pill.style.display = on ? "block" : "none";
    chrome.storage.local.set({ wbcCollapsed: on });
  }
  function makeDraggable(handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
      root.style.right = "auto"; root.style.bottom = "auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      root.style.left = Math.max(0, ox + e.clientX - sx) + "px";
      root.style.top = Math.max(0, oy + e.clientY - sy) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return; drag = false;
      chrome.storage.local.set({ wbcPos: { left: root.style.left, top: root.style.top } });
    });
  }
  function restorePosition() {
    chrome.storage.local.get(["wbcPos", "wbcCollapsed"], (s) => {
      if (s.wbcPos && s.wbcPos.left) {
        root.style.left = s.wbcPos.left; root.style.top = s.wbcPos.top;
        root.style.right = "auto"; root.style.bottom = "auto";
      }
      if (s.wbcCollapsed) collapse(true);
    });
  }

  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);
})();
