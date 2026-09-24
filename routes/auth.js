const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { isConfigured } = require('../mailer');
const turnstile = require('../turnstile');
const discord = require('../discord');
const {
  api,
  fail,
  requireAuth,
  publicUser,
  trackSession,
  deleteSessionRow,
  dropTrackedSession,
} = require('../middleware/auth');
const {
  EMAIL_RE,
  normalizeAnswer,
  sendEmailCode,
  consumeCode,
} = require('../services/codeService');

const router = express.Router();

const _loginAttempts = new Map();

router.get('/mail-status', (req, res) => {
  res.json({ configured: isConfigured() });
});

router.get('/captcha-config', (req, res) => {
  const cfg = turnstile.loadConfig();
  res.json({ enabled: turnstile.isConfigured(), sitekey: cfg.sitekey });
});

router.get('/register-config', (req, res) => {
  const discordConfigured = discord.isOAuthConfigured();
  res.json({
    discordRequired: discordConfigured,
    discordEnabled: discordConfigured,
  });
});

router.post(
  '/send-code',
  api(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
    const username = String(req.body.username || '').trim();

    if (!EMAIL_RE.test(email)) return fail(res, 400, 'Введите корректный email');
    if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) {
      return fail(res, 400, 'Логин: 3-20 символов (буквы, цифры, точка, подчёркивание)');
    }
    if (db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username)) {
      return fail(res, 409, 'Такой логин уже занят');
    }
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      return fail(res, 409, 'На эту почту уже зарегистрирован аккаунт');
    }

    const result = await sendEmailCode(email, 'register');
    if (result.error) return fail(res, result.status || 429, result.error);
    if (result.dev) {
      return res.json({ ok: true, dev: true, code: result.code, channel: (result.channels || []).join(',') });
    }
    res.json({ ok: true, channel: (result.channels || []).join(',') });
  })
);

router.get(
  '/pending-discord',
  api((req, res) => {
    if (!req.session.pendingDiscord || !req.session.pendingDiscord.id) {
      return res.json({ pending: false });
    }
    res.json({
      pending: true,
      id: req.session.pendingDiscord.id,
      username: req.session.pendingDiscord.username,
    });
  })
);

if (process.env.ALLOW_TEST_HOOKS === '1') {
  router.post(
    '/__test-pending',
    api((req, res) => {
      req.session.pendingDiscord = {
        id: String(req.body.id || ''),
        username: String(req.body.username || ''),
      };
      res.json({ ok: true });
    })
  );
}

router.post(
  '/register',
  api((req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const pending = req.session.pendingDiscord;
    const discordConfigured = discord.isOAuthConfigured();

    if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) {
      return fail(res, 400, 'Логин: 3-20 символов (буквы, цифры, точка, подчёркивание)');
    }
    if (password.length < 6) {
      return fail(res, 400, 'Пароль должен быть не короче 6 символов');
    }

    // Only enforce discord linking if Discord OAuth is actually configured on server
    if (discordConfigured && (!pending || !pending.id)) {
      return fail(res, 400, 'Сначала привяжите Discord аккаунт');
    }

    const discordId = pending && pending.id ? String(pending.id) : '';
    const discordName = pending && pending.username ? String(pending.username).slice(0, 60) : '';

    if (db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username)) {
      return fail(res, 409, 'Такой логин уже занят');
    }
    if (discordId && db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId)) {
      return fail(res, 409, 'Этот Discord уже привязан к другому аккаунту');
    }

    const hash = bcrypt.hashSync(password, 10);
    const first = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
    let info;
    try {
      info = db
        .prepare(
          'INSERT INTO users (username, password_hash, email, role, discord_id, discord_username) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(username, hash, '', first ? 'commander' : 'user', discordId, discordName);
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE')) return fail(res, 409, 'Такой логин уже занят');
      throw e;
    }

    req.session.pendingDiscord = null;
    const oldSid = req.sessionID;
    req.session.regenerate((err) => {
      try {
        if (err) return fail(res, 500, 'Ошибка регистрации, попробуйте ещё раз');
        deleteSessionRow(oldSid);
        req.session.userId = info.lastInsertRowid;
        trackSession(req);
        const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
        res.json({ user: publicUser(newUser) });
      } catch (e) {
        console.error(e);
        if (!res.headersSent) fail(res, 500, 'Внутренняя ошибка сервера');
      }
    });
  })
);

router.post(
  '/login',
  api((req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const now = Date.now();
    const lk = `${req.ip}|${username.toLowerCase()}`;
    if (_loginAttempts.size > 5000) _loginAttempts.clear();
    const rec = _loginAttempts.get(lk);
    if (rec && now - rec.at < 15 * 60 * 1000 && rec.count >= 10) {
      return fail(res, 429, 'Слишком много попыток входа. Попробуйте позже');
    }
    const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      const r = rec && now - rec.at < 15 * 60 * 1000 ? rec : { count: 0, at: now };
      r.count += 1;
      _loginAttempts.set(lk, r);
      return fail(res, 401, 'Неверный логин или пароль');
    }
    _loginAttempts.delete(lk);
    const oldSid = req.sessionID;
    req.session.regenerate((err) => {
      try {
        if (err) return fail(res, 500, 'Ошибка входа, попробуйте ещё раз');
        deleteSessionRow(oldSid);
        req.session.userId = user.id;
        trackSession(req);
        res.json({ user: publicUser(user) });
      } catch (e) {
        console.error(e);
        if (!res.headersSent) fail(res, 500, 'Внутренняя ошибка сервера');
      }
    });
  })
);

router.post('/logout', (req, res) => {
  const sid = req.sessionID;
  if (req.session) {
    req.session.destroy(() => {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      dropTrackedSession(sid);
      res.json({ ok: true });
    });
  } else {
    res.json({ ok: true });
  }
});

router.get(
  '/me',
  api((req, res) => {
    if (!req.session || !req.session.userId) return res.json({ user: null });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) trackSession(req);
    res.json({ user: user ? publicUser(user) : null });
  })
);

// ---------- Password Recovery ----------
router.post(
  '/forgot/send',
  api(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
    const username = String(req.body.username || '').trim();
    let user = null;
    if (email && EMAIL_RE.test(email)) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    } else if (username) {
      user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    } else {
      return fail(res, 400, 'Введите email или логин');
    }
    if (!user) return res.json({ ok: true, hasQuestion: false });
    const codeKey = user.email || `u:${user.id}`;

    const result = await sendEmailCode(codeKey, 'reset', { discordId: user.discord_id });
    if (result.error) return fail(res, result.status || 429, result.error);
    const payload = {
      ok: true,
      dev: !!result.dev,
      channel: (result.channels || []).join(','),
      hasQuestion: !!(user.security_question && user.security_answer),
    };
    if (payload.hasQuestion) payload.question = user.security_question;
    if (result.dev) payload.code = result.code;
    res.json(payload);
  })
);

router.post(
  '/forgot/reset',
  api((req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
    const username = String(req.body.username || '').trim();
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '');
    const answer = String(req.body.answer || '').trim();

    if (!email && !username) return fail(res, 400, 'Введите email или логин');
    if (!/^\d{6}$/.test(code)) return fail(res, 400, 'Введите 6-значный код из письма');
    if (password.length < 6) return fail(res, 400, 'Пароль должен содержать не менее 6 символов');

    let user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    if (!user && username) user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (!user) return fail(res, 404, 'Пользователь не найден');
    const codeKey = user.email || `u:${user.id}`;

    const codeRow = db
      .prepare("SELECT * FROM verify_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1")
      .get(codeKey);
    if (!codeRow) return fail(res, 400, 'Сначала получите код на почту');
    if (codeRow.code !== code) {
      const attempts = (codeRow.attempts || 0) + 1;
      db.prepare('UPDATE verify_codes SET attempts = ? WHERE id = ?').run(attempts, codeRow.id);
      if (attempts >= 5) db.prepare('UPDATE verify_codes SET used = 1 WHERE id = ?').run(codeRow.id);
      return fail(res, 400, 'Неверный код');
    }
    if (new Date(codeRow.expires_at.replace(' ', 'T')).getTime() < Date.now()) {
      return fail(res, 400, 'Код истёк. Запросите новый');
    }

    if (user.security_question && user.security_answer) {
      if (!answer) return fail(res, 400, 'Ответьте на контрольный вопрос');
      if (normalizeAnswer(answer) !== normalizeAnswer(user.security_answer)) {
        return fail(res, 400, 'Неверный ответ на контрольный вопрос');
      }
    }

    db.prepare('UPDATE verify_codes SET used = 1 WHERE id = ?').run(codeRow.id);
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

    // Invalidate other sessions
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

    res.json({ ok: true });
  })
);

module.exports = router;
