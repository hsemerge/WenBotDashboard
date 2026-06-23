// WenBot Companion — popup controller. Thin UI over the background worker.
const CFG = window.WENBOT_CONFIG;
const $ = (id) => document.getElementById(id);
const bg = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));

function msg(text, ok) {
  const m = $("msg");
  m.textContent = text;
  m.className = "msg show " + (ok ? "ok" : "err");
  if (!text) m.className = "msg";
}
function fmt(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(); }

async function render() {
  const conn = (await bg("getConn")).data || {};
  const connected = !!conn.token;
  const watching = !!conn.channel;

  // Connected (or read-only watching) → show status panel.
  $("view-connected").classList.toggle("hide", !(connected || watching));
  $("view-setup").classList.toggle("hide", connected || watching);

  if (connected || watching) {
    $("ch").textContent = conn.channel || "—";
    $("casino").textContent = conn.casino ? conn.casino : "";
    $("casino").style.display = conn.casino ? "" : "none";
    $("disconnect").style.display = connected ? "" : "none";
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
$("get-code").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: CFG.CONNECT_URL }); };

$("connect").onclick = async () => {
  const code = $("code").value.trim();
  if (!code) return msg("Enter your pair code.", false);
  msg("Connecting…", true);
  const r = await bg("pair", code);
  if (r && r.ok) { msg("Connected ✓", true); render(); }
  else msg((r && r.error) || "Pairing failed.", false);
};

$("watch").onclick = async () => {
  const channel = $("channel").value.trim().toLowerCase();
  if (!channel) return msg("Enter your channel.", false);
  await new Promise((res) => chrome.storage.local.set({ channel }, res));
  msg("Watching your hunt (read-only) ✓", true);
  render();
};

$("disconnect").onclick = async () => {
  await bg("disconnect");
  await new Promise((res) => chrome.storage.local.set({ channel: null, casino: null }, res));
  msg("", true);
  render();
};

$("open-dash").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: "https://wenbot.gg/dashboard.html" }); };

render();
