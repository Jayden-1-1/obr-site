const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'discord-config.json');

const COLOR_BLUE = 0x5865f2;
const COLOR_GREEN = 0x57f287;
const COLOR_RED = 0xed4245;
const COLOR_YELLOW = 0xfee75c;

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {}
  if (process.env.DISCORD_CONFIG) {
    try {
      cfg = { ...cfg, ...JSON.parse(process.env.DISCORD_CONFIG) };
    } catch (_) {}
  }
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function isConfigured() {
  const c = loadConfig();
  return !!(c.bot_token && c.guild_id);
}

function isOAuthConfigured() {
  const c = loadConfig();
  return !!(c.client_id && c.client_secret);
}

function apiBase() {
  const c = loadConfig();
  return c.api_base || process.env.DISCORD_API_BASE || 'https://discord.com/api';
}

function parseRoles(value) {
  return String(value || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

function publicConfig() {
  const c = loadConfig();
  return {
    configured: isConfigured(),
    oauth_configured: isOAuthConfigured(),
    client_id: c.client_id || '',
    guild_id: c.guild_id || '',
    role_on_accept: c.role_on_accept || '',
    role_civilian: c.role_civilian || '',
    role_builder: c.role_builder || '',
    webhook_url: c.webhook_url || '',
    warnings_webhook_url: c.warnings_webhook_url || '',
    has_bot_token: !!c.bot_token,
    has_client_secret: !!c.client_secret,
    has_webhook: !!c.webhook_url,
    has_warnings_webhook: !!c.warnings_webhook_url,
  };
}

async function saveFromRequest(body) {
  const cur = loadConfig();
  const s = (v) => String(v || '').trim();
  const next = { ...cur };
  for (const k of ['client_id', 'guild_id', 'role_on_accept', 'role_civilian', 'role_builder', 'webhook_url', 'warnings_webhook_url']) {
    if (body[k] !== undefined) next[k] = s(body[k]);
  }
  for (const k of ['bot_token', 'client_secret']) {
    if (body[k] !== undefined && s(body[k])) next[k] = s(body[k]);
  }
  saveConfig(next);
  return publicConfig();
}

async function notifyWebhook(url, payload) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error('[discord] webhook error', res.status);
    return res.ok;
  } catch (e) {
    console.error('[discord] webhook', e.message);
    return false;
  }
}

function buildEmbed(o) {
  const embed = {};
  if (o.title) embed.title = String(o.title);
  if (o.description) embed.description = String(o.description);
  embed.color = o.color;
  embed.timestamp = new Date().toISOString();
  if (Array.isArray(o.fields) && o.fields.length) {
    embed.fields = o.fields.map((f) => ({
      name: String(f.name || '').slice(0, 256),
      value: String(f.value ?? '').slice(0, 1024),
      inline: !!f.inline,
    }));
  }
  if (o.footer) embed.footer = { text: String(o.footer).slice(0, 2048) };
  return embed;
}

async function logEvent({ channel = 'general', title, description = '', color = COLOR_BLUE, fields = [], mention = '', footer = 'О.Б.Р — сайт • автоматическое уведомление' } = {}) {
  const c = loadConfig();
  const url = channel === 'warnings' ? c.warnings_webhook_url : c.webhook_url;
  const payload = {
    username: 'О.Б.Р — сайт',
    embeds: [buildEmbed({ title, description, color, fields, footer })],
  };
  if (mention) payload.content = mention;
  return notifyWebhook(url, payload);
}

async function notify(title, description, color = COLOR_BLUE) {
  return logEvent({ title, description, color });
}

async function notifyWarnings(title, description, color = COLOR_YELLOW) {
  return logEvent({ channel: 'warnings', title, description, color });
}

async function sendDM(userId, text) {
  const c = loadConfig();
  if (!c.bot_token || !userId) return { ok: false, reason: 'not-configured' };
  try {
    const dm = await fetch(`${apiBase()}/users/@me/channels`, {
      method: 'POST',
      headers: { Authorization: `Bot ${c.bot_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: String(userId) }),
    });
    if (!dm.ok) {
      console.error('[discord] DM не создан', dm.status);
      return { ok: false, status: dm.status };
    }
    const dmData = await dm.json();
    const res = await fetch(`${apiBase()}/channels/${dmData.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${c.bot_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: String(text).slice(0, 1900) }),
    });
    if (!res.ok) {
      console.error('[discord] сообщение в ЛС не отправлено', res.status);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[discord] ЛС', e.message);
    return { ok: false, error: e.message };
  }
}

async function addRoleToMember(discordId, roleId) {
  const c = loadConfig();
  if (!c.bot_token || !c.guild_id || !roleId || !discordId) return { ok: false, reason: 'not-configured' };
  try {
    const res = await fetch(`${apiBase()}/guilds/${c.guild_id}/members/${discordId}/roles/${roleId}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${c.bot_token}` },
    });
    if (res.status !== 204 && !res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[discord] добавление роли не удалось', res.status, text);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[discord] добавление роли', e.message);
    return { ok: false, error: e.message };
  }
}

async function removeRoleFromMember(discordId, roleId) {
  const c = loadConfig();
  if (!c.bot_token || !c.guild_id || !roleId || !discordId) return { ok: false, reason: 'not-configured' };
  try {
    const res = await fetch(`${apiBase()}/guilds/${c.guild_id}/members/${discordId}/roles/${roleId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${c.bot_token}` },
    });
    if (res.status === 404) return { ok: true };
    if (res.status !== 204 && !res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[discord] снятие роли не удалось', res.status, text);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[discord] снятие роли', e.message);
    return { ok: false, error: e.message };
  }
}

async function getMemberRoles(discordId) {
  const c = loadConfig();
  if (!c.bot_token || !c.guild_id || !discordId) return null;
  try {
    const res = await fetch(`${apiBase()}/guilds/${c.guild_id}/members/${discordId}`, {
      headers: { Authorization: `Bot ${c.bot_token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.roles) ? data.roles : [];
  } catch (e) {
    console.error('[discord] получение ролей участника', e.message);
    return null;
  }
}

function managedRoleIds() {
  const c = loadConfig();
  const set = new Set();
  const add = (v) => {
    for (const r of parseRoles(v)) set.add(r);
  };
  add(c.role_on_accept);
  add(c.role_civilian);
  add(c.role_builder);
  const map = c.role_map || {};
  for (const k of ['rank', 'position']) {
    for (const v of Object.values(map[k] || {})) add(v);
  }
  for (const g of map.rank_groups || []) add(g.roles);
  for (const g of map.position_groups || []) add(g.roles);
  for (const v of Object.values(map.warnings || {})) add(v);
  add(map.vacation);
  return [...set];
}

async function syncRoles(discordId, desiredRoleIds) {
  const c = loadConfig();
  if (!c.bot_token || !c.guild_id || !discordId) return { ok: false, reason: 'not-configured' };
  const desired = new Set(parseRoles(desiredRoleIds));
  const managed = new Set(managedRoleIds());
  const current = await getMemberRoles(discordId);
  if (current === null) {
    for (const r of desired) await addRoleToMember(discordId, r);
    return { ok: true, partial: true };
  }
  for (const r of current) {
    if (managed.has(r) && !desired.has(r)) await removeRoleFromMember(discordId, r);
  }
  for (const r of desired) {
    if (!current.includes(r)) await addRoleToMember(discordId, r);
  }
  return { ok: true };
}

async function resetRoles(discordId) {
  const c = loadConfig();
  const civilian = parseRoles(c.role_civilian);
  return syncRoles(discordId, civilian.join(','));
}

async function getOAuthURL(redirectUri, state) {
  const c = loadConfig();
  const params = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const c = loadConfig();
  const body = new URLSearchParams({
    client_id: c.client_id,
    client_secret: c.client_secret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`${apiBase()}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    console.error('[discord] обмен кода OAuth не удался', res.status);
    return null;
  }
  return res.json();
}

async function getMe(accessToken) {
  const res = await fetch(`${apiBase()}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

module.exports = {
  loadConfig,
  saveConfig,
  isConfigured,
  isOAuthConfigured,
  publicConfig,
  saveFromRequest,
  notify,
  notifyWarnings,
  log: logEvent,
  sendDM,
  addRoleToMember,
  removeRoleFromMember,
  parseRoles,
  getMemberRoles,
  managedRoleIds,
  syncRoles,
  resetRoles,
  getOAuthURL,
  exchangeCode,
  getMe,
  COLOR_BLUE,
  COLOR_GREEN,
  COLOR_RED,
  COLOR_YELLOW,
};
