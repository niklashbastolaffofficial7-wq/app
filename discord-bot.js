/**
 * Discord bot helpers for install notifications.
 */

const DISCORD_API = "https://discord.com/api/v10";

async function discordRequest(token, method, path, body) {
  const resp = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord API ${method} ${path} => ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function findOrCreateCategory(token, guildId, name) {
  const channels = await discordRequest(
    token,
    "GET",
    `/guilds/${guildId}/channels`,
  );
  const existing = channels.find(
    (c) => c.type === 4 && c.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing) return existing.id;
  const created = await discordRequest(
    token,
    "POST",
    `/guilds/${guildId}/channels`,
    { name, type: 4 },
  );
  return created.id;
}

function sanitizeChannelName(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-_\s]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 100) || "install"
  );
}

async function notifyInstall(opts) {
  const { botToken, serverId, categoryId, appName, packageName } = opts;
  let parentId = categoryId || null;
  if (!parentId) {
    parentId = await findOrCreateCategory(
      botToken,
      serverId,
      "App Installed Count",
    );
  }
  const channelName = sanitizeChannelName(appName);
  const channel = await discordRequest(
    botToken,
    "POST",
    `/guilds/${serverId}/channels`,
    {
      name: channelName,
      type: 0,
      ...(parentId ? { parent_id: parentId } : {}),
    },
  );
  const content =
    `📱 **${appName}** was just installed!\n` +
    `**Package:** \`${packageName}\`\n` +
    `**Time:** <t:${Math.floor(Date.now() / 1000)}:F>`;
  await discordRequest(botToken, "POST", `/channels/${channel.id}/messages`, {
    content,
  });
  console.log(
    `[discord-bot] Install notification sent, channelId=${channel.id}`,
  );
  return { channelId: channel.id };
}

module.exports = { notifyInstall };
