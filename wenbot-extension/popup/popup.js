// WenBot Companion — popup controller. Thin UI over the background worker.
const CFG = window.WENBOT_CONFIG;
const $ = (id) => document.getElementById(id);
const bg = (type, payload) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage({ type, payload }, (resp) => {
      const err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : resp);
    });
  } catch (e) { resolve({ ok: false, error: e.message }); }
});

function msg(text, ok) {
  const m = $("msg");
  m.textContent = text;
  m.className = "msg show " + (ok ? "ok" : "err");
  if (!text) m.className = "msg";
}
function fmt(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(); }

const flag = {
  get: (k) => new Promise((r) => chrome.storage.local.get([k], (o) => r(o[k]))),
  set: (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r)),
};

async function render() {
  const conn = (await bg("getConn")).data || {};
  const connected = !!conn.token;
  const watching = !!conn.channel;
  const pairing = await flag.get("wbcPairing"); // mid-pairing → keep showing the code box

  // Decide the view. If they're part-way through pairing, the popup may have
  // closed when they tabbed to grab the code — bring them straight back to it.
  const showSetup = connected ? false : (pairing || !watching);
  $("view-setup").classList.toggle("hide", !showSetup);
  $("view-connected").classList.toggle("hide", showSetup);
  if (showSetup) { setTimeout(() => $("code").focus(), 40); return; }

  if (connected || watching) {
    $("ch").textContent = conn.channel || "—";
    $("casino").textContent = conn.casino ? conn.casino : "";
    $("casino").style.display = conn.casino ? "" : "none";
    $("disconnect").style.display = connected ? "" : "none";
    $("upgrade").classList.toggle("hide", connected); // watch-only → offer pairing
    $("open-dash").href = "https://wenbot.gg/dashboard.html";
    await renderHunt();
  }
}

async function renderHunt() {
  const r = await bg("getStatus");
  const dot = $("dot");
  if (!r || !r.ok) { dot.classList.remove("on"); $("hunt-note").textContent = "Couldn't reach WenBot."; return; }
  dot.classList.toggle("on", !!r.data.connected);
  const hunt = r.data.hunt;
  if (!hunt || !hunt.active) {
    $("count").textContent = "0"; $("be").textContent = "—"; $("pnl").textContent = "—";
    $("hunt-note").textContent = "No active hunt right now.";
    return;
  }
  const b = hunt.bonuses || [];
  const totalBet = b.reduce((a, x) => a + (+x.betSize || 0), 0);
  const winnings = b.reduce((a, x) => a + (+x.payout || 0), 0);
  const opened = b.filter((x) => x.payout != null).length;
  $("count").textContent = String(b.length);
  $("be").textContent = totalBet > 0 ? (hunt.totalCost / totalBet).toFixed(2) + "x" : "—";
  const pnlEl = $("pnl");
  if (opened > 0) {
    const pnl = winnings - hunt.totalCost;
    pnlEl.textContent = (pnl >= 0 ? "+" : "") + fmt(pnl);
    pnlEl.className = "v " + (pnl >= 0 ? "pos" : "neg");
  } else { pnlEl.textContent = fmt(hunt.totalCost || 0); pnlEl.className = "v"; }
  $("hunt-note").textContent = `${opened}/${b.length} opened · start cost ${fmt(hunt.totalCost || 0)}`;
}

// ---- actions ---------------------------------------------------------------
$("get-code").onclick = async (e) => {
  e.preventDefault();
  await flag.set("wbcPairing", true);          // remember we're pairing → survive the popup closing
  chrome.tabs.create({ url: CFG.CONNECT_URL });
};

$("connect").onclick = async () => {
  const code = $("code").value.trim();
  if (!code) return msg("Enter your pair code.", false);
  msg("Connecting…", true);
  const r = await bg("pair", code);
  if (r && r.ok) { await flag.set("wbcPairing", false); msg("Connected ✓", true); render(); }
  else msg((r && r.error) || "Pairing failed.", false);
};

$("watch").onclick = async () => {
  const channel = $("channel").value.trim().toLowerCase();
  if (!channel) return msg("Enter your channel.", false);
  await flag.set("wbcPairing", false);
  await new Promise((res) => chrome.storage.local.set({ channel }, res));
  msg("Watching your hunt (read-only) ✓", true);
  render();
};

$("disconnect").onclick = async () => {
  await bg("disconnect");
  await flag.set("wbcPairing", false);
  await new Promise((res) => chrome.storage.local.set({ channel: null, casino: null }, res));
  msg("", true);
  render();
};

$("open-dash").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: "https://wenbot.gg/dashboard.html" }); };

// Watch-only → reveal the pairing UI without having to disconnect first.
$("upgrade").onclick = async () => {
  await flag.set("wbcPairing", true);
  $("view-connected").classList.add("hide");
  $("view-setup").classList.remove("hide");
  setTimeout(() => $("code").focus(), 40);
};

render();
