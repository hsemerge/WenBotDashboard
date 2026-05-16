// POST /api/discord-register-commands
// One-time call to register slash commands with Discord globally
// Protected by x-admin-key header

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const key = event.headers["x-admin-key"];
  if (!key || key !== process.env.WENBOT_ADMIN_KEY) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const appId = process.env.DISCORD_APPLICATION_ID;
  const token = process.env.DISCORD_BOT_TOKEN;

  const commands = [
    {
      name:        "points",
      description: "Check your WenBot points balance",
    },
    {
      name:        "buy",
      description: "Spend your points on a store item",
      options: [{
        name:        "item",
        description: "The item ID to purchase",
        type:        3,
        required:    true,
      }],
    },
    {
      name:        "join",
      description: "Join the active giveaway",
    },
    {
      name:        "register",
      description: "Link your Kick account to WenBot",
    },
  ];

  try {
    const r = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
      method:  "PUT",
      headers: {
        "Authorization": `Bot ${token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(commands),
    });

    const data = await r.json();
    return {
      statusCode: r.ok ? 200 : r.status,
      headers:    { "Content-Type": "application/json" },
      body:       JSON.stringify({ ok: r.ok, registered: data }),
    };
  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};
