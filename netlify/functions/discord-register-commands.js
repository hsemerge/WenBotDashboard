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

  const appId      = process.env.DISCORD_APPLICATION_ID;
  const token      = process.env.DISCORD_BOT_TOKEN;
  const params     = event.queryStringParameters || {};
  const clearGuild = params.clearGuildId;

  // If clearGuildId query param is passed, wipe guild-specific commands (removes duplicates)
  if (clearGuild) {
    const r = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${clearGuild}/commands`, {
      method:  "PUT",
      headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify([]),
    });
    const data = await r.json();
    return {
      statusCode: r.ok ? 200 : r.status,
      headers:    { "Content-Type": "application/json" },
      body:       JSON.stringify({ ok: r.ok, cleared: data }),
    };
  }

  const commands = [
    {
      name:        "points",
      description: "Check your WenBot points balance",
    },
    {
      name:        "give",
      description: "Give some of your points to another linked member",
      options: [
        { name: "user",   description: "Who to give points to",   type: 6, required: true },
        { name: "amount", description: "How many points to give", type: 4, required: true },
      ],
    },
    {
      name:        "giveall",
      description: "Drop points to every active chatter (streamer only)",
      // Hidden from regular members in the UI; only members with Administrator
      // see it by default. Actual use is locked server-side to the streamer's
      // configured Discord ID.
      default_member_permissions: "0",
      options: [
        { name: "amount", description: "How many points to drop to each active chatter", type: 4, required: true },
      ],
    },
    {
      name:        "buy",
      description: "Spend your points on a store item",
      options: [{
        name:        "item",
        description: "The item name to purchase (use /store to see available items)",
        type:        3,
        required:    true,
      }],
    },
    {
      name:        "join",
      description: "Join the active giveaway",
    },
    {
      name:        "store",
      description: "Browse available store items",
    },
    {
      name:        "register",
      description: "Link your Kick account to WenBot",
    },
    {
      name:        "verify",
      description: "Verify your casino + Kick account (same as /register)",
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
