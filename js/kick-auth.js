// Kick OAuth 2.1 with PKCE
// Used for streamer connect, WenBot admin auth, and viewer/verify flows.
//
// State handling:
//   The OAuth `state` parameter is a short random nonce only — never carries payload.
//   The real payload (channel, casino, dtoken, adminKey, etc.) is stored in localStorage
//   keyed by that nonce. The callback page consumes it. This prevents URL/state tampering
//   and keeps secrets like admin keys out of browser history / server logs.

const KICK_CLIENT_ID    = "01KQTY89PFZ2GAZ68ZTAXKGTF8";
// Must match the redirect URI configured in the Kick OAuth app's settings.
// Same-origin as where verify.html / signup pages live so localStorage
// (the PKCE verifier + state nonce) survives the OAuth round-trip.
const KICK_REDIRECT_URI = "https://wenbot.gg/auth/kick/callback.html";

// ---- PKCE Helpers ----

function base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

async function generateCodeChallenge(verifier) {
  const data   = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64urlEncode(digest);
}

function makeNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

// Sweep any stale oauth_state_* entries older than 10 minutes
function pruneOldOAuthStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("oauth_state_")) continue;
    try {
      const v = JSON.parse(localStorage.getItem(key) || "{}");
      if ((v.createdAt || 0) < cutoff) localStorage.removeItem(key);
    } catch { localStorage.removeItem(key); }
  }
}

// ---- OAuth Redirect ----

// purpose: "streamer" | "wenbot" | "viewer" | "verify"
// payload: for "verify" pass {channel, casino, dtoken?}, for "viewer" pass channel string,
//          for "wenbot" reads adminKeyInput from DOM, for "streamer" uses Firebase uid
async function initiateKickAuth(purpose = "streamer", payload = "") {
  pruneOldOAuthStates();

  const verifier  = await generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  let state;
  let scopes;

  if (purpose === "wenbot") {
    const adminKeyEl = document.getElementById("adminKeyInput");
    const adminKey   = adminKeyEl ? adminKeyEl.value.trim() : "";
    if (!adminKey) { alert("Enter your admin key first."); return; }

    const nonce = makeNonce();
    localStorage.setItem(`oauth_state_${nonce}`, JSON.stringify({
      purpose: "wenbot", adminKey, createdAt: Date.now(),
    }));
    state  = `wenbot_${nonce}`;
    scopes = "chat:write user:read";

  } else if (purpose === "viewer") {
    // payload is either a channel string, or { channel, returnOrigin } for the
    // cross-domain handoff.
    const channel = (typeof payload === "string"
      ? payload
      : (payload && payload.channel) || "").toLowerCase().trim();
    if (!channel) { alert("Missing channel."); return; }

    // Cross-domain handling: the Kick OAuth callback only runs on the auth origin
    // (KICK_AUTH_ORIGIN, where the single registered redirect URI lives). If the
    // viewer is on a white-label custom domain (e.g. skslots.co.uk), the PKCE
    // verifier + callback can't be read here, so we must run the WHOLE OAuth on
    // the auth origin and hand the finished session back. We do that by bouncing
    // to the auth origin's bootstrap page, carrying the channel + returnOrigin.
    const authOrigin = "https://wenbot.gg";
    const here       = window.location.origin;
    if (here !== authOrigin) {
      const u = new URL(authOrigin + "/auth/kick/start.html");
      u.searchParams.set("channel", channel);
      u.searchParams.set("returnOrigin", here);
      window.location.href = u.toString();
      return;
    }

    const nonce = makeNonce();
    // returnOrigin (when present) tells the callback to mint a one-time code and
    // redirect back to the originating custom domain instead of staying here.
    const ro = (typeof payload === "object" && payload && payload.returnOrigin) || null;
    localStorage.setItem(`oauth_state_${nonce}`, JSON.stringify({
      purpose: "viewer", channel, createdAt: Date.now(),
      returnOrigin: ro,
      // Same-origin return path for normal (non-custom-domain) viewer logins.
      returnUrl: window.location.pathname + window.location.search + window.location.hash,
    }));
    state  = `viewer_${nonce}`;
    scopes = "user:read";

  } else if (purpose === "login") {
    // "Sign in with Kick" — no payload needed; the callback exchanges the code
    // server-side and mints a Firebase custom token. user:read is enough to
    // read the Kick profile for the account lookup.
    const nonce = makeNonce();
    localStorage.setItem(`oauth_state_${nonce}`, JSON.stringify({
      purpose: "login", createdAt: Date.now(),
    }));
    state  = `login_${nonce}`;
    scopes = "user:read";

  } else if (purpose === "verify") {
    // payload is either an object {channel, casino, dtoken?} or a legacy base64 string
    let p;
    if (typeof payload === "object" && payload !== null) {
      p = payload;
    } else {
      try { p = JSON.parse(atob(payload)); } catch { p = {}; }
    }
    const nonce = makeNonce();
    localStorage.setItem(`oauth_state_${nonce}`, JSON.stringify({
      purpose:   "verify",
      channel:   (p.channel || "").toLowerCase(),
      casino:    p.casino || "gambulls",
      dtoken:    p.dtoken || null,
      // Where the viewer came from (tournament / bb / …) — carried through the
      // OAuth round-trip so verify.html can offer a "back to where you were".
      ret:       p.ret || null,
      createdAt: Date.now(),
    }));
    state  = `verify_${nonce}`;
    scopes = "user:read";

  } else {
    if (typeof fb === "undefined" || !fb.currentUser) {
      alert("You must be signed in first.");
      return;
    }
    state  = fb.currentUser.uid;
    scopes = "user:read channel:read";
  }

  localStorage.setItem("kick_code_verifier", verifier);
  localStorage.setItem("kick_auth_purpose",  purpose);

  const params = new URLSearchParams({
    client_id:             KICK_CLIENT_ID,
    response_type:         "code",
    redirect_uri:          KICK_REDIRECT_URI,
    state,
    scope:                 scopes,
    code_challenge:        challenge,
    code_challenge_method: "S256",
  });

  window.location.href = `https://id.kick.com/oauth/authorize?${params}`;
}

// ---- Unified Kick Viewer Session ----
// Single session shared across verify.html, bonus-battle.html, tournament.html
// Contains identity only — channel/casino are per-page context, not stored here.

const KICK_SESSION_KEY = "kick_viewer_session";

function getKickViewerSession() {
  try {
    const raw = localStorage.getItem(KICK_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.expiresAt && Date.now() > s.expiresAt) {
      localStorage.removeItem(KICK_SESSION_KEY);
      return null;
    }
    return s;
  } catch { return null; }
}

function saveKickViewerSession(session) {
  localStorage.setItem(KICK_SESSION_KEY, JSON.stringify(session));
}

function clearKickViewerSession() {
  localStorage.removeItem(KICK_SESSION_KEY);
}
