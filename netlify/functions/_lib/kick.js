// Shared, hardened Kick identity lookup.
//
// Resolves the authenticated Kick user from an OAuth access token. Every external
// failure mode — a stray char in the token (e.g. a trailing newline from the
// OAuth handoff, which makes `fetch` throw on the bad header), a network blip, a
// timeout, a non-OK status, or a non-JSON body — is turned into a structured
// { error, status } result instead of being allowed to throw. That stops a
// transient Kick hiccup from surfacing to viewers as a generic 500
// ("Internal server error") and gives them a clear, retryable message.
//
// On success returns { user } where user is Kick's object ({ name, user_id, ... }).
// Callers do their own name-match / authorization checks on user.

async function getKickUser(accessToken, { timeoutMs = 8000 } = {}) {
  const token = String(accessToken || "").trim();
  if (!token) return { error: "Missing Kick sign-in. Please sign in with Kick again.", status: 401 };

  let resp, raw = "";
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    resp = await fetch("https://api.kick.com/public/v1/users", {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    clearTimeout(timer);
    raw = await resp.text();
  } catch (e) {
    console.error("[kick] identity call failed:", e.name, e.message);
    return { error: "Couldn't reach Kick to confirm your identity. Please try again in a moment.", status: 503 };
  }

  if (!resp.ok) {
    console.warn("[kick] identity non-OK:", resp.status, raw.slice(0, 200));
    return { error: "Your Kick sign-in has expired. Please sign in with Kick again and retry.", status: 401 };
  }

  let data;
  try { data = JSON.parse(raw); }
  catch {
    console.error("[kick] identity non-JSON:", raw.slice(0, 200));
    return { error: "Kick returned an unexpected response. Please try again in a moment.", status: 502 };
  }

  const user = data.data?.[0];
  if (!user || !user.name) return { error: "Could not verify your Kick identity. Please sign in with Kick again.", status: 401 };
  return { user };
}

module.exports = { getKickUser };
