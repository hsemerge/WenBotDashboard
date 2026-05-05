// Exchanges Kick OAuth authorization code for access + refresh tokens (server-side)
// Client sends: { code, code_verifier }
// Returns: { access_token, refresh_token, expires_in, ... }

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { code, code_verifier } = body;
  if (!code || !code_verifier) {
    return json({ error: "Missing code or code_verifier" }, 400);
  }

  const clientId     = Deno.env.get("KICK_CLIENT_ID");
  const clientSecret = Deno.env.get("KICK_CLIENT_SECRET");

  const params = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  "https://wenbot.netlify.app/auth/kick/callback.html",
    code_verifier,
  });

  try {
    const resp = await fetch("https://id.kick.com/oauth/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    params,
    });

    const data = await resp.json();

    if (!resp.ok) {
      return json({ error: "Kick token exchange failed", details: data }, 400);
    }

    return json(data, 200);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const config = { path: "/api/kick-token" };
