// WenBot Companion — service worker (MV3).
// The single owner of: the pairing token, all network calls to WenBot, and the
// cached slots catalog. Content script + popup never fetch cross-origin or touch
// the token directly — they message this worker. host_permissions on wenbot.gg
// let these fetches read responses regardless of CORS.
importScripts("config.js");
const CFG = self.WENBOT_CONFIG;

// ---- storage helpers -------------------------------------------------------
const store = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
  set: (obj)  => new Promise((r) => chrome.storage.local.set(obj, r)),
};

async function getConn() {
  const { channel = null, token = null, casino = null } = await store.get(["channel", "token", "casino"]);
  return { channel, token, casino };
}

// ---- WenBot API ------------------------------------------------------------
async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["x-wenbot-ext-token"] = token;
  const resp = await fetch(`${CFG.API_BASE}/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!resp.ok) throw Object.assign(new Error(data.error || `HTTP ${resp.status}`), { status: resp.status });
  return data;
}

// Redeem a pairing code → store the long-lived token + channel.
async function pair(code) {
  const data = await api("extension-pair", { method: "POST", body: { code: String(code || "").trim() } });
  if (!data.token || !data.channel) throw new Error("Pairing failed — try a fresh code.");
  await store.set({ token: data.token, channel: data.channel, casino: data.casino || null });
  return data;
}

async function disconnect() {
  await store.set({ token: null });
  return { ok: true };
}

// Live hunt status — public read, only needs the channel.
async function getStatus() {
  const { channel } = await getConn();
  if (!channel) return { connected: false };
  const hunt = await api(`bonus-hunt-data?channel=${encodeURIComponent(channel)}`);
  return { connected: true, channel, hunt };
}

// Add a bonus to the live hunt — needs the token.
async function addBonus(bonus) {
  const { token } = await getConn();
  if (!token) throw Object.assign(new Error("Connect the extension to your WenBot account first."), { status: 401 });
  return api("ext-bonus-hunt", { method: "POST", token, body: { action: "add", bonus } });
}

// ---- slots catalog (cached) ------------------------------------------------
async function getSlots() {
  const { slots, slotsAt } = await store.get(["slots", "slotsAt"]);
  if (slots && slotsAt && Date.now() - slotsAt < CFG.SLOTS_TTL_MS) return slots;
  const resp = await fetch(CFG.SLOTS_URL);
  const list = await resp.json();
  // Keep only what the autocomplete needs (shrinks the 1.4MB payload a lot).
  const slim = (Array.isArray(list) ? list : list.slots || []).map((s) => ({
    name: s.name, provider: s.provider || "", gameId: s.gameId || s.id || null,
    thumbnailUrl: s.thumbnailUrl || null,
  }));
  await store.set({ slots: slim, slotsAt: Date.now() });
  return slim;
}

// ---- message router --------------------------------------------------------
const handlers = { pair, disconnect, getStatus, addBonus, getSlots, getConn };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) { sendResponse({ ok: false, error: "unknown message" }); return false; }
  Promise.resolve(fn(msg.payload))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message, status: err.status || 0 }));
  return true; // async
});
