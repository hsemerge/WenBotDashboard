// Kick OAuth 2.1 with PKCE
// Used for both streamer connect and WenBot admin auth

const KICK_CLIENT_ID   = "01KQTY89PFZ2GAZ68ZTAXKGTF8";
const KICK_REDIRECT_URI = "https://wenbot.netlify.app/auth/kick/callback.html";

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

// ---- OAuth Redirect ----

// purpose: "streamer" | "wenbot" | "viewer"
// For wenbot, an admin key input with id="adminKeyInput" must be in the DOM
// For viewer, pass channel name as second arg
async function initiateKickAuth(purpose = "streamer", channel = "") {
  const verifier   = await generateCodeVerifier();
  const challenge  = await generateCodeChallenge(verifier);

  let state;
  let scopes;

  if (purpose === "wenbot") {
    const adminKeyEl = document.getElementById("adminKeyInput");
    const adminKey   = adminKeyEl ? adminKeyEl.value.trim() : "";
    if (!adminKey) {
      alert("Enter your admin key first.");
      return;
    }
    state  = `wenbot_${adminKey}`;
    scopes = "chat:write user:read";
  } else if (purpose === "viewer") {
    if (!channel) {
      alert("Missing channel.");
      return;
    }
    state  = `viewer_${channel.toLowerCase().trim()}`;
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
