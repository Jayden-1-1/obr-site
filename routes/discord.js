const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireCommander,
} = require('../middleware/auth');
const discord = require('../discord');

const router = express.Router();

const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS
  ? process.env.ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['obr-site-production.up.railway.app', 'obr-site-proxy.obr-site.workers.dev'];

function oauthHost(req) {
  const xh = req.get('x-original-host');
  const xfh = req.get('x-forwarded-host');
  const h = String((xh || xfh || req.get('host') || '').split(',')[0]).trim().toLowerCase();
  if (ALLOWED_HOSTS.includes(h)) return h;
  if (h === 'localhost' || h.startsWith('localhost:') || h === '127.0.0.1' || h.startsWith('127.0.0.1:')) return h;
  return ALLOWED_HOSTS[0];
}

function oauthOrigin(req) {
  const host = oauthHost(req);
  const isLocal = host === 'localhost' || host.startsWith('localhost:') || host === '127.0.0.1' || host.startsWith('127.0.0.1:');
  const proto = req.get('x-forwarded-proto') || req.protocol || (isLocal ? 'http' : 'https');
  const scheme = isLocal ? proto : 'https';
  return `${scheme}://${host}`;
}

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

router.get(
  '/me',
  requireAuth,
  api((req, res) => {
    res.json({
      linked: !!req.user.discord_id,
      username: req.user.discord_username || '',
      role_on_accept_configured: !!(discord.loadConfig().role_on_accept),
    });
  })
);

router.post(
  '/link',
  requireAuth,
  api(async (req, res) => {
    if (!discord.isOAuthConfigured()) return fail(res, 400, 'Привязка Discord не настроена командованием');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.discordOAuthState = state;
    const redirectUri = `${oauthOrigin(req)}/api/discord/oauth/callback`;
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

router.get(
  '/oauth/callback',
  requireAuth,
  api(async (req, res) => {
    const state = req.session.discordOAuthState;
    req.session.discordOAuthState = null;
    if (!state || state !== req.query.state) {
      return res.redirect('/profile.html?discord=error');
    }
    const code = String(req.query.code || '');
    const redirectUri = `${oauthOrigin(req)}/api/discord/oauth/callback`;
    const token = await discord.exchangeCode(code, redirectUri);
    if (!token || !token.access_token) {
      return res.redirect('/profile.html?discord=error');
    }
    const me = await discord.getMe(token.access_token);
    if (!me || !me.id) {
      return res.redirect('/profile.html?discord=error');
    }
    const uname = me.global_name || me.username || '';
    db.prepare('UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?').run(
      String(me.id),
      String(uname).slice(0, 60),
      req.user.id
    );
    res.redirect('/profile.html?discord=ok');
  })
);

router.post(
  '/reg-link',
  api(async (req, res) => {
    if (!discord.isOAuthConfigured()) return fail(res, 400, 'Привязка Discord не настроена командованием');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.discordOAuthState = state;
    const redirectUri = `${oauthOrigin(req)}/api/discord/reg/callback`;
    const url = await discord.getOAuthURL(redirectUri, state);
    res.json({ url });
  })
);

router.get(
  '/reg/callback',
  api(async (req, res) => {
    const state = req.session.discordOAuthState;
    req.session.discordOAuthState = null;
    if (!state || state !== req.query.state) {
      return res.redirect('/register.html?discord=error');
    }
    const code = String(req.query.code || '');
    const redirectUri = `${oauthOrigin(req)}/api/discord/reg/callback`;
    const token = await discord.exchangeCode(code, redirectUri);
    if (!token || !token.access_token) {
      return res.redirect('/register.html?discord=error');
    }
    const me = await discord.getMe(token.access_token);
    if (!me || !me.id) {
      return res.redirect('/register.html?discord=error');
    }
    const dup = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(String(me.id));
    if (dup) {
      return res.redirect('/register.html?discord=taken');
    }
    req.session.pendingDiscord = {
      id: String(me.id),
      username: me.global_name || me.username || '',
    };
    res.redirect('/register.html?discord=ok');
  })
);

module.exports = router;
