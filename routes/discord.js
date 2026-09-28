const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireCommander,
  deleteSessionRow,
  trackSession,
} = require('../middleware/auth');
const discord = require('../discord');

const router = express.Router();

const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS
  ? process.env.ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'obr-site-production.up.railway.app',
      'obr-site-proxy.obr-site.workers.dev',
      'obr-site-proxy.winkston.workers.dev',
    ];

function oauthHost(req) {
  const xh = req.get('x-original-host');
  const xfh = req.get('x-forwarded-host');
  const h = String((xh || xfh || req.get('host') || '').split(',')[0]).trim().toLowerCase();
  if (ALLOWED_HOSTS.includes(h)) return h;
  if (h === 'localhost' || h.startsWith('localhost:') || h === '127.0.0.1' || h.startsWith('127.0.0.1:')) return h;
  return h || ALLOWED_HOSTS[0];
}

function oauthOrigin(req) {
  const host = oauthHost(req);
  const isLocal = host === 'localhost' || host.startsWith('localhost:') || host === '127.0.0.1' || host.startsWith('127.0.0.1:');
  const proto = req.get('x-forwarded-proto') || req.protocol || (isLocal ? 'http' : 'https');
  const scheme = isLocal ? 'http' : (proto.split(',')[0].trim() || 'https');
  return `${scheme}://${host}`;
}

function getRedirectUri(req) {
  const cfg = discord.loadConfig();
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
  if (cfg.redirect_uri) return cfg.redirect_uri;
  return `${oauthOrigin(req)}/api/discord/oauth/callback`;
}

// Direct login / register via Discord link
router.get('/login', async (req, res) => {
  if (!discord.isOAuthConfigured()) {
    return res.redirect('/login.html?discord=not_configured');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.discordOAuthState = state;
  const redirectUri = getRedirectUri(req);
  req.session.discordRedirectUri = redirectUri;
  const rawNext = String(req.query.next || '/');
  req.session.discordNext = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  const url = await discord.getOAuthURL(redirectUri, state);
  res.redirect(url);
});

// Commander config
router.get(
  '/config',
  requireAuth,
  requireCommander,
  api((req, res) => {
    res.json(discord.publicConfig());
  })
);

router.put(
  '/config',
  requireAuth,
  requireCommander,
  api(async (req, res) => {
    const cfg = await discord.saveFromRequest(req.body);
    res.json(cfg);
  })
);

// Current user discord status
router.get(
  '/me',
  requireAuth,
  api((req, res) => {
    res.json({
      linked: !!req.user.discord_id,
      username: req.user.discord_username || '',
      role_on_accept_configured: !!discord.loadConfig().role_on_accept,
    });
  })
);

// Generate OAuth URL for linking while logged in
router.post(
  '/link',
  requireAuth,
  api(async (req, res) => {
    if (!discord.isOAuthConfigured()) return fail(res, 400, 'Привязка Discord не настроена командованием');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.discordOAuthState = state;
    const redirectUri = getRedirectUri(req);
    req.session.discordRedirectUri = redirectUri;
    const url = await discord.getOAuthURL(redirectUri, state);
    res.json({ url });
  })
);

router.post(
  '/unlink',
  requireAuth,
  api((req, res) => {
    db.prepare("UPDATE users SET discord_id = '', discord_username = '' WHERE id = ?").run(req.user.id);
    res.json({ ok: true });
  })
);

// Legacy reg-link endpoint kept for compatibility
router.post(
  '/reg-link',
  api(async (req, res) => {
    if (!discord.isOAuthConfigured()) return fail(res, 400, 'Привязка Discord не настроена командованием');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.discordOAuthState = state;
    const redirectUri = getRedirectUri(req);
    req.session.discordRedirectUri = redirectUri;
    const url = await discord.getOAuthURL(redirectUri, state);
    res.json({ url });
  })
);

// Unified OAuth callback handler (handles login, auto-registration, and linking)
async function handleOAuthCallback(req, res) {
  const state = req.session.discordOAuthState;
  req.session.discordOAuthState = null;
  if (!state || state !== req.query.state) {
    return res.redirect('/login.html?discord=error_state');
  }

  const code = String(req.query.code || '');
  if (!code) {
    return res.redirect('/login.html?discord=no_code');
  }

  const redirectUri =
    req.session.discordRedirectUri || getRedirectUri(req);
  const token = await discord.exchangeCode(code, redirectUri);
  if (!token || !token.access_token) {
    console.error('[discord oauth] Ошибка обмена токена, redirectUri:', redirectUri);
    return res.redirect('/login.html?discord=token_error');
  }

  const me = await discord.getMe(token.access_token);
  if (!me || !me.id) {
    return res.redirect('/login.html?discord=me_error');
  }

  const discordId = String(me.id);
  const discordUsername = String(me.global_name || me.username || '').slice(0, 60);

  // Case 1: User is already authenticated -> link Discord to existing account
  if (req.session && req.session.userId) {
    const dup = db
      .prepare('SELECT id, username FROM users WHERE discord_id = ? AND id != ?')
      .get(discordId, req.session.userId);
    if (dup) {
      return res.redirect('/profile.html?discord=taken');
    }
    db.prepare('UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?').run(
      discordId,
      discordUsername,
      req.session.userId
    );
    return res.redirect('/profile.html?discord=ok');
  }

  // Case 2: User is NOT logged in -> check if user with this discord_id exists
  let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
  if (user) {
    // Existing user -> login directly
    db.prepare('UPDATE users SET discord_username = ? WHERE id = ?').run(
      discordUsername,
      user.id
    );
    const oldSid = req.sessionID;
    const targetNext = req.session.discordNext || '/';
    req.session.regenerate((err) => {
      if (err) return res.redirect('/login.html?discord=session_error');
      deleteSessionRow(oldSid);
      req.session.userId = user.id;
      trackSession(req);
      res.redirect(targetNext);
    });
    return;
  }

  // Case 3: Brand new user -> auto-register via Discord!
  const rawBase = (me.global_name || me.username || 'Operative').trim();
  let clean = rawBase
    .replace(/[^a-zA-Z0-9_.]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 18);
  if (clean.length < 3) clean = 'Operative_' + discordId.slice(-4);
  let username = clean;
  let counter = 1;
  while (db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username)) {
    username = `${clean.slice(0, 14)}_${counter++}`;
  }

  const randomPassword = crypto.randomBytes(32).toString('hex');
  const passwordHash = bcrypt.hashSync(randomPassword, 10);
  const isFirst = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
  const role = isFirst ? 'commander' : 'user';

  let insertInfo;
  try {
    insertInfo = db
      .prepare(
        'INSERT INTO users (username, password_hash, email, role, discord_id, discord_username) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(username, passwordHash, '', role, discordId, discordUsername);
  } catch (err) {
    console.error('[discord auto-register error]', err);
    return res.redirect('/login.html?discord=db_error');
  }

  const newUserId = insertInfo.lastInsertRowid;

  // Assign civilian role in Discord guild
  const cfg = discord.loadConfig();
  if (cfg.role_civilian) {
    discord.addRoleToMember(discordId, cfg.role_civilian).catch((err) => {
      console.error('[discord] Ошибка выдачи роли гражданина:', err);
    });
  }

  // Send webhook log
  discord
    .notify(
      'Регистрация бойца через Discord',
      `Боец **${username}** (<@${discordId}>) зарегистрирован на сайте.\nРоль: **${
        role === 'commander' ? 'Командир' : 'Кандидат (гражданский)'
      }**`,
      discord.COLOR_GREEN
    )
    .catch(() => {});

  const oldSid = req.sessionID;
  req.session.regenerate((err) => {
    if (err) return res.redirect('/login.html?discord=session_error');
    deleteSessionRow(oldSid);
    req.session.userId = newUserId;
    trackSession(req);
    res.redirect('/profile.html?welcome=1');
  });
}

// Handle all registered redirect endpoints
router.get('/callback', api(handleOAuthCallback));
router.get('/oauth/callback', api(handleOAuthCallback));
router.get('/reg/callback', api(handleOAuthCallback));

module.exports = router;
