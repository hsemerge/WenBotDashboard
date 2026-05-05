// ============================================================
// LOGICPLAY GIVEAWAY BOT - Main Application
// ============================================================

// ---- STATE ----
const state = {
  // Connection
  channelName: "",
  chatroomId: null,
  pusher: null,
  chatChannel: null,
  connected: false,

  // Streamer config (loaded from Firestore)
  activeProvider: "gambulls",
  providerApiKey: null,

  // Giveaway
  giveawayId: generateId(),
  keyword: "!giveaway",
  keywordVisible: true,
  source: "code",       // "code" = provider code users, "chat" = anyone in chat
  minWager: 200,
  wagerLuck: 1,
  followerOnly: false,
  subscriberOnly: false,
  paused: false,
  accepting: false,      // true when "Wait for Winner" is active
  chatDisabled: false,

  // Data
  leaderboardUsers: {},  // { usernameLower: { username, wagerAmount } } from provider API
  verifiedUsers: {},     // { kickNameLower: { kickName, providerName, providerUsername, verifiedAt } }
  reverseVerified: {},   // { providerUsernameLower: kickNameLower } - prevents duplicate claims
  entries: [],           // [{ username, kickName, providerUsername, wager, extraEntries, badges }]
  entrySet: new Set(),   // quick lookup of entered kick usernames (lowercase)
  chatMessages: [],
  winners: [],
  activeViewers: new Set(),

  // Timers
  viewerTimeout: {},
};

// ---- AUTH CALLBACKS (called by firebase-config.js) ----
function onAuthReady(user) {
  const profile = fb.streamerProfile;
  if (!profile || !profile.onboarded) {
    window.location.href = "setup.html";
    return;
  }
  // Load streamer config into state and boot the app
  initApp(profile);
}

function onAuthNotLoggedIn() {
  window.location.href = "login.html";
}

// ---- INIT ----
async function initApp(profile) {
  state.channelName = profile.kickChannel || "";
  state.activeProvider = profile.activeProvider || "gambulls";

  // Load provider API key from Firestore
  const providerConfig = await getProviderConfig(state.activeProvider);
  state.providerApiKey = providerConfig?.apiKey || null;

  // Update UI with streamer info
  document.getElementById("giveawayId").textContent = state.giveawayId;
  document.getElementById("keywordInput").value = state.keyword;
  document.getElementById("channelInput").value = state.channelName;
  document.getElementById("minWagerInput").value = state.minWager;
  document.getElementById("headerUser").textContent = profile.displayName || profile.kickChannel;
  document.querySelector(".banner-name").textContent = profile.displayName || profile.kickChannel;

  // Load verified users from Firestore
  await loadVerifiedUsersFromFirestore();

  // Load leaderboard data
  fetchLeaderboardData();

  // Load Pusher library then auto-connect
  loadPusherLib(() => {
    connectToChannel();
  });

  // Refresh leaderboard every 5 minutes
  setInterval(fetchLeaderboardData, 5 * 60 * 1000);

  // Refresh viewer count decay every 30s
  setInterval(decayViewers, 30000);
}

// Init Firebase on page load
document.addEventListener("DOMContentLoaded", () => {
  initFirebase();
});

// ---- VERIFIED USERS (Firestore persistence) ----
async function loadVerifiedUsersFromFirestore() {
  try {
    const users = await loadAllVerifiedUsers();
    state.verifiedUsers = {};
    state.reverseVerified = {};
    for (const [key, data] of Object.entries(users)) {
      state.verifiedUsers[key] = data;
      if (data.providerUsername) {
        state.reverseVerified[normalizeUsername(data.providerUsername)] = key;
      }
    }
  } catch (e) {
    console.error("Failed to load verified users:", e);
  }
  updateVerifiedCount();
}

function updateVerifiedCount() {
  const el = document.getElementById("verifiedCount");
  if (el) el.textContent = Object.keys(state.verifiedUsers).length;
}

async function verifyUser(kickName, providerUsername) {
  const kickKey = normalizeUsername(kickName);
  const providerKey = normalizeUsername(providerUsername);

  // Check if another Kick user already claimed this provider name
  const existingClaim = state.reverseVerified[providerKey];
  if (existingClaim && existingClaim !== kickKey) {
    addSystemMessage(`"${providerUsername}" is already linked to another Kick account. Verification denied.`);
    return false;
  }

  // If this Kick user was previously linked to a different name, remove old link
  const oldEntry = state.verifiedUsers[kickKey];
  if (oldEntry) {
    const oldKey = normalizeUsername(oldEntry.providerUsername);
    delete state.reverseVerified[oldKey];
  }

  // Check if they're on the leaderboard (for info only, NOT required)
  const leaderboardData = state.leaderboardUsers[providerKey];

  const verifiedData = {
    kickName: kickName,
    providerName: state.activeProvider,
    providerUsername: providerUsername,
    verifiedAt: Date.now(),
  };

  // Save to Firestore
  try {
    await saveVerifiedUser(kickName, verifiedData);
  } catch (e) {
    console.error("Failed to save verified user:", e);
  }

  // Update local state
  state.verifiedUsers[kickKey] = verifiedData;
  state.reverseVerified[providerKey] = kickKey;
  updateVerifiedCount();

  // Build confirmation message
  let msg = `${kickName} verified as "${providerUsername}" on ${state.activeProvider}`;
  if (leaderboardData) {
    msg += ` ($${Math.round(leaderboardData.wagerAmount).toLocaleString()} wagered under code)`;
  } else {
    msg += ` (not currently on leaderboard — that's OK)`;
  }
  addSystemMessage(msg);
  return true;
}

async function unverifyUser(kickName) {
  const kickKey = normalizeUsername(kickName);
  const entry = state.verifiedUsers[kickKey];
  if (!entry) return;
  const providerKey = normalizeUsername(entry.providerUsername);
  delete state.verifiedUsers[kickKey];
  delete state.reverseVerified[providerKey];
  updateVerifiedCount();

  try {
    await removeVerifiedUser(kickName);
  } catch (e) {
    console.error("Failed to remove verified user:", e);
  }
}

async function clearAllVerified() {
  if (!confirm("Clear all verified users? They will need to !verify again.")) return;
  state.verifiedUsers = {};
  state.reverseVerified = {};
  updateVerifiedCount();

  try {
    await clearAllVerifiedUsers();
  } catch (e) {
    console.error("Failed to clear verified users:", e);
  }
  addSystemMessage("All verified user links cleared.");
}

// ---- UTILITY ----
function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function normalizeUsername(name) {
  return (name || "").trim().toLowerCase();
}

// ---- PUSHER / KICK CHAT ----
function loadPusherLib(callback) {
  if (window.Pusher) { callback(); return; }
  const script = document.createElement("script");
  script.src = "https://js.pusher.com/8.2.0/pusher.min.js";
  script.onload = callback;
  script.onerror = () => {
    setConnectionStatus("disconnected", "Failed to load Pusher library");
  };
  document.head.appendChild(script);
}

async function connectToChannel() {
  const input = document.getElementById("channelInput").value.trim();
  if (!input) return;
  state.channelName = input;

  setConnectionStatus("connecting", "Looking up channel...");

  try {
    // Get chatroom ID from Kick API
    const resp = await fetch(`/api/kick-channel?username=${encodeURIComponent(input)}`);
    if (!resp.ok) throw new Error(`Channel not found (${resp.status})`);
    const data = await resp.json();

    if (!data.chatroom_id) throw new Error("No chatroom ID returned");
    state.chatroomId = data.chatroom_id;

    // Disconnect existing
    if (state.chatChannel) {
      state.chatChannel.unbind_all();
      state.pusher?.unsubscribe(`chatrooms.${state.chatroomId}.v2`);
    }
    if (state.pusher) {
      state.pusher.disconnect();
    }

    // Connect to Kick's Pusher
    state.pusher = new Pusher("32cbd69e4b950bf97679", {
      cluster: "us2",
      forceTLS: true,
    });

    state.pusher.connection.bind("connected", () => {
      state.connected = true;
      setConnectionStatus("connected", `Connected to ${state.channelName}`);
    });

    state.pusher.connection.bind("disconnected", () => {
      state.connected = false;
      setConnectionStatus("disconnected", "Disconnected");
    });

    state.pusher.connection.bind("error", (err) => {
      state.connected = false;
      setConnectionStatus("disconnected", "Connection error");
    });

    const channelName = `chatrooms.${state.chatroomId}.v2`;
    state.chatChannel = state.pusher.subscribe(channelName);

    state.chatChannel.bind("App\\Events\\ChatMessageEvent", handleChatMessage);
    state.chatChannel.bind("pusher:subscription_succeeded", () => {
      setConnectionStatus("connected", `Connected to ${state.channelName}`);
    });
    state.chatChannel.bind("pusher:subscription_error", () => {
      setConnectionStatus("disconnected", "Subscription failed");
    });

    // Update banner
    document.querySelector(".banner-name").textContent = state.channelName;

  } catch (err) {
    setConnectionStatus("disconnected", err.message);
  }
}

function setConnectionStatus(status, text) {
  const el = document.getElementById("connectionStatus");
  el.innerHTML = `<span class="status-dot ${status}"></span>${escapeHtml(text)}`;
}

function handleChatMessage(data) {
  if (state.chatDisabled) return;

  const sender = data.sender?.username || data.sender?.slug || "unknown";
  const content = data.content || "";
  const badges = extractBadges(data.sender);
  const role = getPrimaryRole(badges);

  // Track active viewer
  trackViewer(sender);

  // Add to chat display
  addChatMessage(sender, content, role, badges);

  // Check for !verify command
  const trimmedLower = content.trim().toLowerCase();
  if (trimmedLower.startsWith("!verify ")) {
    const gambullsName = content.trim().substring(8).trim();
    if (gambullsName) {
      verifyUser(sender, gambullsName);
    }
    return;
  }

  // Check for giveaway entry
  if (state.accepting && !state.paused) {
    checkEntry(sender, content, badges);
  }
}

function extractBadges(sender) {
  const badges = [];
  if (!sender) return badges;
  if (sender.is_broadcaster || sender.identity?.badges?.find(b => b.type === "broadcaster")) badges.push("owner");
  if (sender.is_moderator || sender.identity?.badges?.find(b => b.type === "moderator")) badges.push("mod");
  if (sender.is_subscriber || sender.identity?.badges?.find(b => b.type === "subscriber")) badges.push("sub");
  if (sender.identity?.badges?.find(b => b.type === "vip")) badges.push("vip");
  if (sender.identity?.badges?.find(b => b.type === "og")) badges.push("og");
  return badges;
}

function getPrimaryRole(badges) {
  if (badges.includes("owner")) return "owner";
  if (badges.includes("mod")) return "mod";
  if (badges.includes("vip")) return "vip";
  if (badges.includes("sub")) return "sub";
  return "default";
}

function trackViewer(username) {
  const key = normalizeUsername(username);
  state.activeViewers.add(key);
  clearTimeout(state.viewerTimeout[key]);
  state.viewerTimeout[key] = setTimeout(() => {
    state.activeViewers.delete(key);
    updateViewerCount();
  }, 5 * 60 * 1000); // 5 min timeout
  updateViewerCount();
}

function decayViewers() {
  updateViewerCount();
}

function updateViewerCount() {
  document.getElementById("activeViewers").textContent = state.activeViewers.size;
}

// ---- CHAT UI ----
function addChatMessage(username, content, role, badges) {
  const trimmedLower = content.trim().toLowerCase();
  const isEntry = trimmedLower === state.keyword.toLowerCase();
  const isVerify = trimmedLower.startsWith("!verify ");
  const container = document.getElementById("chatMessages");

  const div = document.createElement("div");
  div.className = "chat-msg";

  // Check if it's an entry attempt
  if (isEntry && state.accepting) {
    const key = normalizeUsername(username);
    const check = isUserEligible(key, badges);
    div.className += check.eligible ? " entry-msg" : " entry-msg-rejected";
  }

  // Highlight verify commands
  if (isVerify) {
    div.className += " verify-msg";
  }

  div.innerHTML = `<span class="username ${role}">${escapeHtml(username)}</span>: <span class="message-text">${escapeHtml(content)}</span>`;

  container.appendChild(div);

  // Keep max 500 messages
  while (container.children.length > 500) {
    container.removeChild(container.firstChild);
  }

  // Auto-scroll
  container.scrollTop = container.scrollHeight;
}

// ---- LEADERBOARD API (provider-agnostic) ----
async function fetchLeaderboardData() {
  if (!state.providerApiKey) {
    console.warn("No provider API key configured");
    return;
  }

  try {
    showLoading(`Loading ${state.activeProvider} leaderboard data...`);

    const resp = await fetch(`/api/leaderboard?provider=${state.activeProvider}&limit=100`, {
      headers: {
        "x-provider-key": state.providerApiKey,
      },
    });
    if (!resp.ok) throw new Error(`API error ${resp.status}`);
    const data = await resp.json();

    if (!data.users || !Array.isArray(data.users)) {
      throw new Error("Invalid API response");
    }

    state.leaderboardUsers = {};
    for (const user of data.users) {
      state.leaderboardUsers[normalizeUsername(user.username)] = {
        username: user.username,
        wagerAmount: user.wagerAmount || 0,
      };
    }

    hideLoading();
    console.log(`Loaded ${Object.keys(state.leaderboardUsers).length} ${state.activeProvider} users`);
  } catch (err) {
    hideLoading();
    console.error("Leaderboard fetch error:", err);
  }
}

function showLoading(text) {
  document.getElementById("loadingText").textContent = text;
  document.getElementById("loadingOverlay").style.display = "flex";
}

function hideLoading() {
  document.getElementById("loadingOverlay").style.display = "none";
}

// ---- ENTRY LOGIC ----
function getProviderDataForKickUser(kickKey) {
  // Look up the verified mapping: kick username -> provider username
  const verified = state.verifiedUsers[kickKey];
  if (!verified) return null;
  const providerKey = normalizeUsername(verified.providerUsername);
  return state.leaderboardUsers[providerKey] || null;
}

function checkEntry(username, content, badges) {
  const trimmed = content.trim().toLowerCase();
  if (trimmed !== state.keyword.toLowerCase()) return;

  const kickKey = normalizeUsername(username);

  // Already entered?
  if (state.entrySet.has(kickKey)) return;

  // Check eligibility
  const check = isUserEligible(kickKey, badges);
  if (!check.eligible) {
    addSystemMessage(`${username} denied entry: ${check.reason}`);
    return;
  }

  // Get wager data via verified mapping
  const providerData = getProviderDataForKickUser(kickKey);
  const wager = providerData ? providerData.wagerAmount : 0;
  const providerUsername = providerData ? providerData.username : null;

  // Calculate extra entries from wager luck
  let extraEntries = 0;
  if (state.wagerLuck > 1 && wager > 0) {
    const tier = Math.floor(wager / 1000); // 1 extra per $1000 wagered
    extraEntries = Math.min(tier, state.wagerLuck - 1);
  }

  const entry = {
    username: username,
    kickName: username,
    providerUsername: providerUsername,
    wager: wager,
    extraEntries: extraEntries,
    badges: badges,
    timestamp: Date.now(),
  };

  state.entries.push(entry);
  state.entrySet.add(kickKey);
  renderEntries();
}

function isUserEligible(kickKey, badges) {
  // Returns { eligible: true } or { eligible: false, reason: "..." }

  // Subscriber-only check
  if (state.subscriberOnly && !badges.includes("sub") && !badges.includes("owner") && !badges.includes("mod")) {
    return { eligible: false, reason: "subscribers only" };
  }

  const verified = state.verifiedUsers[kickKey];

  if (state.source === "code") {
    if (!verified) {
      return { eligible: false, reason: "not verified — type !verify YourGambullsName first" };
    }
    const providerData = getProviderDataForKickUser(kickKey);
    if (!providerData) {
      return { eligible: false, reason: `"${verified.providerUsername}" not found under this code on ${state.activeProvider}` };
    }
    if (providerData.wagerAmount < state.minWager) {
      return { eligible: false, reason: `wager $${Math.round(providerData.wagerAmount).toLocaleString()} is below minimum $${state.minWager}` };
    }
  } else {
    if (!verified) {
      return { eligible: false, reason: "not verified — type !verify YourGambullsName first" };
    }
  }

  return { eligible: true };
}

// ---- RENDER ----
function renderEntries() {
  const container = document.getElementById("entriesList");
  const countEl = document.getElementById("entryCount");

  // Total entries including extra
  let totalEntries = 0;
  state.entries.forEach(e => totalEntries += 1 + e.extraEntries);
  countEl.textContent = totalEntries;

  container.innerHTML = "";
  for (const entry of state.entries) {
    const div = document.createElement("div");
    div.className = "entry-item";
    const providerTag = entry.providerUsername ? `<span class="entry-gambulls">${escapeHtml(entry.providerUsername)}</span>` : "";
    div.innerHTML = `
      <span class="entry-name">${escapeHtml(entry.kickName || entry.username)}${providerTag}</span>
      <span>
        <span class="entry-wager">${entry.wager > 0 ? "$" + Math.round(entry.wager).toLocaleString() : ""}</span>
        ${entry.extraEntries > 0 ? `<span class="entry-extra">+${entry.extraEntries}</span>` : ""}
      </span>
    `;
    container.appendChild(div);
  }
}

function renderWinners() {
  const container = document.getElementById("winnersList");
  const countEl = document.getElementById("winnerCount");
  countEl.textContent = state.winners.length;

  container.innerHTML = "";
  state.winners.forEach((winner, i) => {
    const div = document.createElement("div");
    div.className = "winner-item";
    div.innerHTML = `
      <span class="winner-rank">${i + 1}</span>
      <div class="winner-info">
        <div class="name">${escapeHtml(winner.username)}</div>
        <div class="detail">Wagered $${Math.round(winner.wager).toLocaleString()} &middot; ${winner.entries} entries out of ${winner.totalEntries}</div>
      </div>
    `;
    container.appendChild(div);
  });
}

// ---- GIVEAWAY CONTROLS ----
function updateKeyword() {
  const input = document.getElementById("keywordInput").value.trim();
  if (!input) return;
  state.keyword = input;
  document.getElementById("bannerKeyword").textContent = input;
}

function toggleKeywordVisibility() {
  state.keywordVisible = !state.keywordVisible;
  const input = document.getElementById("keywordInput");
  input.type = state.keywordVisible ? "text" : "password";
}

function setSource(source) {
  state.source = source;
  document.getElementById("btnSourceCode").classList.toggle("active", source === "code");
  document.getElementById("btnSourceChat").classList.toggle("active", source === "chat");

  const hint = document.getElementById("sourceHint");
  const wagerGroup = document.getElementById("minWagerGroup");

  if (source === "code") {
    hint.textContent = `Verified users under your code who wagered $${state.minWager}+ can enter`;
    if (wagerGroup) wagerGroup.style.display = "";
  } else {
    hint.textContent = `Verified chat users can enter — wager not verifiable for non-code users`;
    if (wagerGroup) wagerGroup.style.display = "none";
  }
}

function updateWagerLuck() {
  const val = parseInt(document.getElementById("wagerLuckSlider").value);
  state.wagerLuck = val;
  document.getElementById("wagerLuckHint").textContent =
    val === 1 ? "No extra entries for top wagerers" :
    `Top wagerers get up to ${val - 1} extra entries`;
}

function togglePause() {
  state.paused = !state.paused;
  const btn = document.getElementById("pauseBtn");
  btn.textContent = state.paused ? "Resume" : "Pause";
  document.body.classList.toggle("paused", state.paused);
}

function resetGiveaway() {
  if (!confirm("Reset the giveaway? This will clear all entries.")) return;
  state.entries = [];
  state.entrySet.clear();
  state.accepting = false;
  state.paused = false;
  state.giveawayId = generateId();
  document.getElementById("giveawayId").textContent = state.giveawayId;
  document.getElementById("pauseBtn").textContent = "Pause";
  document.getElementById("waitForWinnerBtn").textContent = "Wait for Winner";
  document.getElementById("waitForWinnerBtn").classList.remove("btn-danger");
  document.body.classList.remove("paused");
  renderEntries();
}

function waitForWinner() {
  state.accepting = !state.accepting;
  const btn = document.getElementById("waitForWinnerBtn");
  if (state.accepting) {
    btn.textContent = "Stop Accepting";
    btn.classList.add("btn-danger");
    // Update min wager from input
    state.minWager = parseInt(document.getElementById("minWagerInput").value) || 200;
    state.followerOnly = document.getElementById("followerOnly").checked;
    state.subscriberOnly = document.getElementById("subscriberOnly").checked;
    // Update source hint
    setSource(state.source);
    if (state.source === "code") {
      addSystemMessage(`Giveaway started! Type ${state.keyword} to enter. Code users only — min wager: $${state.minWager}. Use !verify YourGambullsName first.`);
    } else {
      addSystemMessage(`Giveaway started! Type ${state.keyword} to enter. Must !verify YourGambullsName first.`);
    }
  } else {
    btn.textContent = "Wait for Winner";
    btn.classList.remove("btn-danger");
    addSystemMessage("Giveaway entries closed.");
  }
}

function addSystemMessage(text) {
  const container = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<span class="username owner">SYSTEM</span>: <span class="message-text">${escapeHtml(text)}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ---- WINNER SELECTION ----
function pickWinner() {
  if (state.entries.length === 0) {
    alert("No entries to pick from!");
    return;
  }

  // Build weighted pool
  const pool = [];
  for (const entry of state.entries) {
    const count = 1 + entry.extraEntries;
    for (let i = 0; i < count; i++) {
      pool.push(entry);
    }
  }

  // Animate picking (visual flash)
  const entriesPanel = document.getElementById("entriesPanel");
  entriesPanel.classList.add("picking");

  setTimeout(() => {
    entriesPanel.classList.remove("picking");

    // Pick random
    const idx = Math.floor(Math.random() * pool.length);
    const winner = pool[idx];
    const winnerEntries = 1 + winner.extraEntries;

    // Show overlay
    document.getElementById("winnerNameDisplay").textContent = winner.username;
    document.getElementById("winnerMetaDisplay").textContent =
      `Wagered $${Math.round(winner.wager).toLocaleString()} · ${winnerEntries} entries out of ${pool.length} total (${((winnerEntries / pool.length) * 100).toFixed(1)}% chance)`;
    document.getElementById("winnerOverlay").style.display = "flex";

    // Store pending winner for accept/reroll
    state._pendingWinner = {
      username: winner.username,
      wager: winner.wager,
      entries: winnerEntries,
      totalEntries: pool.length,
    };
  }, 800);
}

function acceptWinner() {
  if (!state._pendingWinner) return;
  state.winners.push(state._pendingWinner);
  renderWinners();
  addSystemMessage(`Winner: ${state._pendingWinner.username}!`);

  // Remove winner from entries so they can't win again
  const key = normalizeUsername(state._pendingWinner.username);
  state.entries = state.entries.filter(e => normalizeUsername(e.username) !== key);
  state.entrySet.delete(key);
  renderEntries();

  state._pendingWinner = null;
  closeWinnerOverlay();
}

function rerollWinner() {
  closeWinnerOverlay();
  // Small delay then pick again
  setTimeout(pickWinner, 200);
}

function closeWinnerOverlay() {
  document.getElementById("winnerOverlay").style.display = "none";
}

// ---- PANEL ACTIONS ----
function clearEntries() {
  if (!confirm("Clear all entries?")) return;
  state.entries = [];
  state.entrySet.clear();
  renderEntries();
}

function clearChat() {
  document.getElementById("chatMessages").innerHTML = "";
}

function clearWinners() {
  if (!confirm("Clear all winners?")) return;
  state.winners = [];
  renderWinners();
}

function toggleChatDisable() {
  state.chatDisabled = !state.chatDisabled;
  const btn = document.getElementById("disableChatBtn");
  btn.textContent = state.chatDisabled ? "Enable" : "Disable";
}

function copyEntries() {
  const text = state.entries.map(e => e.username).join("\n");
  navigator.clipboard.writeText(text).catch(() => {});
}

function copyWinners() {
  const text = state.winners.map(w => w.username).join("\n");
  navigator.clipboard.writeText(text).catch(() => {});
}

function importEntries() {
  const input = prompt("Paste usernames (one per line):");
  if (!input) return;
  const names = input.split("\n").map(n => n.trim()).filter(Boolean);
  for (const name of names) {
    const key = normalizeUsername(name);
    if (state.entrySet.has(key)) continue;
    const gambullsData = state.leaderboardUsers[key];
    state.entries.push({
      username: gambullsData ? gambullsData.username : name,
      wager: gambullsData ? gambullsData.wagerAmount : 0,
      extraEntries: 0,
      badges: [],
      timestamp: Date.now(),
    });
    state.entrySet.add(key);
  }
  renderEntries();
}

function exportEntries() {
  const data = JSON.stringify(state.entries, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `giveaway-${state.giveawayId}-entries.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function openWinnerChat() {
  if (state.winners.length === 0) {
    alert("No winners yet!");
    return;
  }
  const lastWinner = state.winners[state.winners.length - 1];
  // Open Kick DM or profile (there's no direct DM URL, so open profile)
  window.open(`https://kick.com/${encodeURIComponent(lastWinner.username)}`, "_blank");
}

// ---- VERIFIED USERS UI ----
function showVerifiedList() {
  const body = document.getElementById("verifiedListBody");
  const entries = Object.values(state.verifiedUsers);

  if (entries.length === 0) {
    body.innerHTML = '<p class="hint" style="padding:16px;">No verified users yet. Users type <strong>!verify GambullsName</strong> in chat.</p>';
  } else {
    let html = `<table class="verified-table"><thead><tr><th>Kick</th><th>${state.activeProvider}</th><th>Wager</th><th></th></tr></thead><tbody>`;
    for (const entry of entries) {
      const providerKey = normalizeUsername(entry.providerUsername);
      const providerData = state.leaderboardUsers[providerKey];
      const wager = providerData ? "$" + Math.round(providerData.wagerAmount).toLocaleString() : "—";
      html += `<tr>
        <td>${escapeHtml(entry.kickName)}</td>
        <td>${escapeHtml(entry.providerUsername)}</td>
        <td class="entry-wager">${wager}</td>
        <td><button class="btn btn-sm btn-danger" onclick="removeVerified('${escapeHtml(entry.kickName)}')">X</button></td>
      </tr>`;
    }
    html += '</tbody></table>';
    body.innerHTML = html;
  }
  document.getElementById("verifiedOverlay").style.display = "flex";
}

function closeVerifiedList() {
  document.getElementById("verifiedOverlay").style.display = "none";
}

function removeVerified(kickName) {
  unverifyUser(kickName);
  showVerifiedList(); // refresh
}

// ---- PANEL TOGGLES ----
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

function toggleOptionsPanel() {
  document.getElementById("optionsPanel").style.display =
    document.getElementById("optionsPanel").style.display === "none" ? "" : "none";
}

function toggleChatPanel() {
  document.getElementById("chatPanel").style.display =
    document.getElementById("chatPanel").style.display === "none" ? "" : "none";
}

function toggleWinnersPanel() {
  document.getElementById("winnersPanel").style.display =
    document.getElementById("winnersPanel").style.display === "none" ? "" : "none";
}
