const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');

const {
  db,
  UPLOAD_DIR,
  RANKS,
  POSITIONS,
  isStaff,
  isManager,
  isCommander,
  posToRole,
  getSetting,
  setSetting,
  ensureCommanderBootstrap,
} = require('./db');
const { sendCode, isConfigured } = require('./mailer');
const turnstile = require('./turnstile');
const discord = require('./discord');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(file.originalname || '').slice(0, 12).toLowerCase();
    cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

function api(fn) {
  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result && typeof result.then === 'function') {
        result.catch((err) => {
          console.error(err);
          if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        });
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  };
}

function fail(res, status, message) {
  res.status(status).json({ error: message });
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return fail(res, 401, 'Требуется вход');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    const sid = req.sessionID;
    req.session.destroy(() => {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      dropTrackedSession(sid);
    });
    return fail(res, 401, 'Требуется вход');
  }
  req.user = user;
  trackSession(req);
  next();
}

function requireManager(req, res, next) {
  if (!isManager(req.user)) return fail(res, 403, 'Недостаточно прав');
  next();
}

function requireCommander(req, res, next) {
  if (!isCommander(req.user)) return fail(res, 403, 'Недостаточно прав');
  next();
}

function requireStaff(req, res, next) {
  if (!isStaff(req.user)) return fail(res, 403, 'Недостаточно прав');
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email || '',
    avatar: user.avatar || '',
    about: user.about || '',
    created_at: user.created_at,
    has_security: !!(user.security_question && user.security_answer),
    security_question: user.security_question || '',
    discord_linked: !!user.discord_id,
    discord_username: user.discord_username || '',
  };
}

function getUser(id) {
  return id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
}

function deviceLabel(ua) {
  const s = String(ua || '');
  let browser = 'Браузер';
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/chrome\/|chromium\//i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s)) browser = 'Safari';
  else if (/msie|trident/i.test(s)) browser = 'Internet Explorer';

  let os = 'Другая ОС';
  if (/windows nt 10/i.test(s)) os = 'Windows 10/11';
  else if (/windows nt 6\.3/i.test(s)) os = 'Windows 8.1';
  else if (/windows nt 6\.1/i.test(s)) os = 'Windows 7';
  else if (/windows/i.test(s)) os = 'Windows';
  else if (/iphone|ipod/i.test(s)) os = 'iPhone';
  else if (/ipad/i.test(s)) os = 'iPad';
  else if (/android/i.test(s)) os = 'Android';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/linux/i.test(s)) os = 'Linux';

  return `${browser} · ${os}`;
}

const _sessionTracked = new Map();

function dropTrackedSession(sid) {
  if (sid) _sessionTracked.delete(sid);
}

function trackSession(req) {
  if (!req.sessionID || !req.session || !req.session.userId) return;
  if (_sessionTracked.size > 5000) _sessionTracked.clear();
  const now = Date.now();
  const last = _sessionTracked.get(req.sessionID) || 0;
  if (now - last < 60 * 1000) return;
  _sessionTracked.set(req.sessionID, now);
  const device = deviceLabel(req.headers['user-agent']);
  const ip = String(req.ip || '').slice(0, 64);
  db.prepare(
    `INSERT INTO sessions (sid, user_id, device, ip, last_seen)
     VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
     ON CONFLICT(sid) DO UPDATE SET
       user_id = excluded.user_id,
       device = excluded.device,
       ip = excluded.ip,
       last_seen = excluded.last_seen`
  ).run(req.sessionID, req.session.userId, device, ip);
}

function deleteSessionRow(sid) {
  if (!sid) return;
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  dropTrackedSession(sid);
}

function destroyUserSessions(store, userId, exceptSid) {
  const rows = db.prepare('SELECT sid FROM sessions WHERE user_id = ? AND sid != ?').all(userId, exceptSid || '');
  for (const r of rows) {
    try {
      store.destroy(r.sid, () => {});
    } catch (_) {}
    deleteSessionRow(r.sid);
  }
}

function cleanupUploaded(photos) {
  for (const p of photos || []) {
    const sn = String(p.stored_name || '');
    if (/^[a-zA-Z0-9._-]+$/.test(sn)) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, sn));
      } catch (_) {}
    }
  }
}

const _loginAttempts = new Map();

function currentCommander() {
  return db.prepare("SELECT * FROM users WHERE role = 'commander' LIMIT 1").get() || null;
}

function roleForPosition(position) {
  if (position !== 'Командир О.Б.Р') return posToRole(position);
  return currentCommander() ? 'zam' : 'commander';
}

function positionAllowedFor(position, userId) {
  if (position !== 'Командир О.Б.Р') return true;
  if (!userId) return true;
  const cmdr = currentCommander();
  return !cmdr || cmdr.id === userId;
}

function nextEmployeeNumber() {
  const row = db
    .prepare('SELECT MAX(CAST(employee_number AS INTEGER)) AS m FROM roster')
    .get();
  let n = (row.m || 0) + 1;
  while (db.prepare('SELECT id FROM roster WHERE employee_number = ?').get(String(n))) n++;
  return String(n);
}

function ensureCommanderInRoster() {
  const cmdr = currentCommander();
  if (!cmdr) return;
  const row = db.prepare('SELECT * FROM roster WHERE user_id = ?').get(cmdr.id);
  if (row) {
    let changed = false;
    if (row.position !== 'Командир О.Б.Р') {
      db.prepare("UPDATE roster SET position = 'Командир О.Б.Р' WHERE id = ?").run(row.id);
      changed = true;
    }
    if (row.status !== 'active') {
      db.prepare("UPDATE roster SET status = 'active' WHERE id = ?").run(row.id);
      changed = true;
    }
    if (changed) {
      console.log(`[roster] Командир ${cmdr.username} синхронизирован в штатке как «Командир О.Б.Р».`);
    }
    return;
  }
  db.prepare(
    "INSERT INTO roster (employee_number, callsign, rank, position, status, user_id) VALUES (?, ?, 'Полковник', 'Командир О.Б.Р', 'active', ?)"
  ).run(nextEmployeeNumber(), cmdr.username, cmdr.id);
  console.log(`[roster] Командир ${cmdr.username} автоматически внесён в штат как «Командир О.Б.Р».`);
}

function syncUserRole(userId, position, isActive) {
  const target = getUser(userId);
  if (!target) return;
  if (target.role === 'commander') return;
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(
    isActive ? roleForPosition(position) : 'user',
    target.id
  );
}

function memberMention(userId) {
  const t = userId ? getUser(userId) : null;
  return t && t.discord_id ? `<@${t.discord_id}>` : '';
}

function desiredRolesForEntry(entry) {
  const cfg = discord.loadConfig();
  const set = new Set();
  const add = (v) => {
    for (const r of discord.parseRoles(v)) set.add(r);
  };
  add(cfg.role_on_accept);
  const map = cfg.role_map || {};
  add((map.rank || {})[entry.rank]);
  add((map.position || {})[entry.position]);
  for (const g of map.rank_groups || []) {
    if ((g.ranks || []).includes(entry.rank)) add(g.roles);
  }
  for (const g of map.position_groups || []) {
    if ((g.positions || []).includes(entry.position)) add(g.roles);
  }
  add((map.warnings || {})[String(entry.warnings)]);
  if (vacationActive(entry)) add(map.vacation);
  if (entry.builder) add(cfg.role_builder);
  return [...set];
}

function syncMemberDiscordRoles(userId, entry) {
  const target = userId ? getUser(userId) : null;
  if (!target || !target.discord_id) return;
  discord.syncRoles(target.discord_id, desiredRolesForEntry(entry).join(','));
}

function discordOnAccept(entry, employeeNumber) {
  const target = getUser(entry.user_id);
  const mention = memberMention(entry.user_id);
  if (target && target.discord_id) {
    discord.syncRoles(target.discord_id, desiredRolesForEntry(entry).join(','));
    discord.sendDM(
      target.discord_id,
      `Поздравляем, **${target.discord_username || target.username}**! Вы приняты в О.Б.Р.\nДолжность: ${entry.position}\nНомер: ${employeeNumber}`
    );
  }
  discord.log({
    title: 'Заявка принята',
    description: `**${target ? target.username : entry.callsign}** принят в состав фракции.`,
    fields: [
      { name: 'Позывной', value: entry.callsign || (target ? target.username : '—'), inline: true },
      { name: 'Должность', value: entry.position, inline: true },
      { name: 'Номер', value: employeeNumber, inline: true },
    ],
    color: discord.COLOR_GREEN,
    mention,
  });
}

function discordOnDismissal(userId, callsign, reason, title = 'Увольнение') {
  const target = userId ? getUser(userId) : null;
  const mention = memberMention(userId);
  if (target && target.discord_id) {
    discord.resetRoles(target.discord_id);
    discord.sendDM(target.discord_id, `Уведомление из О.Б.Р:\n${reason}`);
  }
  discord.log({
    title,
    description: reason,
    fields: [{ name: 'Сотрудник', value: callsign || (target ? target.username : '—'), inline: true }],
    color: discord.COLOR_RED,
    mention,
  });
}

function discordOnWarning(userId, callsign, title, description) {
  const target = userId ? getUser(userId) : null;
  const mention = memberMention(userId);
  if (target && target.discord_id) {
    discord.sendDM(target.discord_id, `Уведомление из О.Б.Р:\n${title}\n${description}`);
  }
  discord.log({
    channel: 'warnings',
    title,
    description,
    fields: [{ name: 'Сотрудник', value: callsign || '—', inline: true }],
    color: discord.COLOR_YELLOW,
    mention,
  });
}

function discordOnVacation(userId, callsign, title, description) {
  const target = userId ? getUser(userId) : null;
  const mention = memberMention(userId);
  if (target && target.discord_id) {
    discord.sendDM(target.discord_id, `Уведомление из О.Б.Р:\n${title}\n${description}`);
  }
  discord.log({
    title,
    description,
    fields: [{ name: 'Сотрудник', value: callsign || '—', inline: true }],
    color: discord.COLOR_BLUE,
    mention,
  });
}

// ---------- Статика ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Авторизация ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const SECURITY_QUESTIONS = [
  'Как звали вашего первого учителя?',
  'Как звали вашего первого животного?',
  'Как звали вашего лучшего друга в детстве?',
  'В каком городе вы родились?',
  'Как называется ваша любимая книга?',
  'Название вашей первой школы?',
];

function normalizeAnswer(s) {
  return String(s || '').trim().toLowerCase();
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function validUntilDate(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (!m) return false;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  if (d.getDate() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getFullYear() !== +m[3]) return false;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return d >= now;
}

function toISODate(s) {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function vacationActive(entry) {
  const iso = toISODate(entry.vacation_until);
  return !!iso && iso >= todayISO();
}

async function sendEmailCode(email, purpose = 'register', opts = {}) {
  db.prepare("DELETE FROM verify_codes WHERE expires_at < datetime('now', 'localtime') OR used = 1").run();

  const last = db
    .prepare("SELECT created_at FROM verify_codes WHERE email = ? ORDER BY id DESC LIMIT 1")
    .get(email);
  if (last) {
    const diff = (Date.now() - new Date(last.created_at.replace(' ', 'T')).getTime()) / 1000;
    if (diff < 60) return { error: `Код уже отправлен. Подождите ${Math.ceil(60 - diff)} секунд` };
  }
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const sent = db
    .prepare("SELECT COUNT(*) c FROM verify_codes WHERE email = ? AND created_at > ?")
    .get(email, hourAgo).c;
  if (sent >= 5) return { error: 'Слишком много попыток. Попробуйте через час' };

  const code = generateCode();
  const purposeLabel = { register: 'регистрации', reset: 'восстановления пароля', transfer: 'передачи прав' }[purpose] || purpose;
  let delivered = false;
  let dev = false;
  const channels = [];

  if (opts.discordId) {
    const dm = await discord.sendDM(
      opts.discordId,
      `🔐 О.Б.Р — код подтверждения ${purposeLabel}: **${code}**\nКод действителен 10 минут.`
    );
    if (dm.ok) {
      delivered = true;
      channels.push('discord');
    }
  }

  if (delivered) {
    dev = false;
  } else if (isConfigured()) {
    const result = await sendCode(email, code, purpose).catch((err) => {
      console.error('[MAIL] Ошибка отправки письма:', err && err.message ? err.message : err);
      return { error: 'Не удалось отправить письмо. Проверьте настройки почты', status: 500 };
    });
    if (result.dev) {
      dev = true;
    } else if (result.error) {
      console.error(`[MAIL] Код для ${email} не отправлен (${result.error}), показываю на экране: ${code}`);
      dev = true;
    } else {
      delivered = true;
      channels.push('email');
    }
  } else {
    dev = true;
    console.log(`[ПОЧТА НЕ НАСТРОЕНА] Код для ${email}: ${code} (${purpose})`);
  }

  if (!delivered && !dev) {
    return { error: 'Не удалось доставить код: почта недоступна и Discord не настроен', status: 500 };
  }

  db.prepare(
    "INSERT INTO verify_codes (email, code, expires_at) VALUES (?, ?, datetime('now', 'localtime', '+10 minutes'))"
  ).run(email, code);
  if (dev && !delivered) return { dev: true, code, channels };
  return { ok: true, channels };
}

function consumeCode(email, code) {
  const row = db
    .prepare("SELECT * FROM verify_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1")
    .get(email);
  if (!row) return { error: 'Сначала получите код на почту' };
  if (row.code !== code) {
    const attempts = (row.attempts || 0) + 1;
    db.prepare('UPDATE verify_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
    if (attempts >= 5) db.prepare('UPDATE verify_codes SET used = 1 WHERE id = ?').run(row.id);
    return { error: 'Неверный код' };
  }
  if (new Date(row.expires_at.replace(' ', 'T')).getTime() < Date.now()) {
    return { error: 'Код истёк. Запросите новый' };
  }
  db.prepare('UPDATE verify_codes SET used = 1 WHERE id = ?').run(row.id);
  return { ok: true };
}

app.get('/api/auth/mail-status', (req, res) => {
  res.json({ configured: isConfigured() });
});

app.get('/api/auth/captcha-config', (req, res) => {
  const cfg = turnstile.loadConfig();
  res.json({ enabled: turnstile.isConfigured(), sitekey: cfg.sitekey });
});

app.post(
  '/api/auth/send-code',
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
    if (result.dev) return res.json({ ok: true, dev: true, code: result.code, channel: (result.channels || []).join(',') });
    res.json({ ok: true, channel: (result.channels || []).join(',') });
  })
);

app.get(
  '/api/auth/pending-discord',
  api((req, res) => {
    if (!req.session.pendingDiscord || !req.session.pendingDiscord.id) {
      return res.json({ pending: false });
    }
    res.json({ pending: true, id: req.session.pendingDiscord.id, username: req.session.pendingDiscord.username });
  })
);

if (process.env.ALLOW_TEST_HOOKS === '1') {
  app.post(
    '/api/auth/__test-pending',
    api((req, res) => {
      req.session.pendingDiscord = {
        id: String(req.body.id || ''),
        username: String(req.body.username || ''),
      };
      res.json({ ok: true });
    })
  );
}

app.post(
  '/api/auth/register',
  api((req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const pending = req.session.pendingDiscord;

    if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) {
      return fail(res, 400, 'Логин: 3-20 символов (буквы, цифры, точка, подчёркивание)');
    }
    if (password.length < 6) {
      return fail(res, 400, 'Пароль должен быть не короче 6 символов');
    }
    if (!pending || !pending.id) {
      return fail(res, 400, 'Сначала привяжите Discord аккаунт');
    }
    const discordId = String(pending.id);
    const discordName = String(pending.username || '').slice(0, 60);
    if (db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username)) {
      return fail(res, 409, 'Такой логин уже занят');
    }
    if (db.prepare('SELECT id FROM users WHERE discord_id = ?').get(discordId)) {
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
        res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
      } catch (e) {
        console.error(e);
        if (!res.headersSent) fail(res, 500, 'Внутренняя ошибка сервера');
      }
    });
  })
);

app.post(
  '/api/auth/login',
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

app.post('/api/auth/logout', (req, res) => {
  const sid = req.sessionID;
  req.session.destroy(() => {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    dropTrackedSession(sid);
    res.json({ ok: true });
  });
});

app.get(
  '/api/auth/me',
  api((req, res) => {
    if (!req.session.userId) return res.json({ user: null });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) trackSession(req);
    res.json({ user: user ? publicUser(user) : null });
  })
);

// ---------- Управление сессиями ----------
app.get(
  '/api/sessions',
  requireAuth,
  api((req, res) => {
    db.prepare("DELETE FROM sessions WHERE created_at < datetime('now', '-7 days')").run();
    const rows = db
      .prepare(
        'SELECT sid, device, ip, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC, created_at DESC'
      )
      .all(req.user.id);
    res.json({
      sessions: rows.map((r) => ({
        id: r.sid,
        device: r.device,
        ip: r.ip,
        created_at: r.created_at,
        last_seen: r.last_seen,
        current: r.sid === req.sessionID,
      })),
    });
  })
);

app.delete(
  '/api/sessions/:sid',
  requireAuth,
  api((req, res) => {
    if (req.params.sid === req.sessionID) {
      return fail(res, 400, 'Чтобы выйти с этого устройства, используйте «Выйти» в меню');
    }
    const row = db.prepare('SELECT * FROM sessions WHERE sid = ? AND user_id = ?').get(req.params.sid, req.user.id);
    if (!row) return fail(res, 404, 'Сессия не найдена');
    req.sessionStore.destroy(row.sid, (err) => {
      if (err) return fail(res, 500, 'Не удалось завершить сессию');
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
      dropTrackedSession(row.sid);
      res.json({ ok: true });
    });
  })
);

app.post(
  '/api/sessions/logout-others',
  requireAuth,
  api((req, res) => {
    const rows = db
      .prepare('SELECT sid FROM sessions WHERE user_id = ? AND sid != ?')
      .all(req.user.id, req.sessionID);
    if (!rows.length) return res.json({ ok: true, removed: 0 });
    let pending = rows.length;
    let removed = 0;
    const finish = () => {
      if (--pending === 0) res.json({ ok: true, removed });
    };
    for (const r of rows) {
      req.sessionStore.destroy(r.sid, () => {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(r.sid);
        dropTrackedSession(r.sid);
        removed++;
        finish();
      });
    }
  })
);

// ---------- Восстановление пароля ----------
app.post(
  '/api/auth/forgot/send',
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
    const payload = { ok: true, dev: !!result.dev, channel: (result.channels || []).join(','), hasQuestion: !!(user.security_question && user.security_answer) };
    if (payload.hasQuestion) payload.question = user.security_question;
    if (result.dev) payload.code = result.code;
    res.json(payload);
  })
);

app.post(
  '/api/auth/forgot/reset',
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
      if (!bcrypt.compareSync(normalizeAnswer(answer), user.security_answer)) {
        const attempts = (codeRow.attempts || 0) + 1;
        db.prepare('UPDATE verify_codes SET attempts = ? WHERE id = ?').run(attempts, codeRow.id);
        if (attempts >= 5) db.prepare('UPDATE verify_codes SET used = 1 WHERE id = ?').run(codeRow.id);
        return fail(res, 400, 'Неверный ответ на контрольный вопрос');
      }
    }

    db.prepare('UPDATE verify_codes SET used = 1 WHERE id = ?').run(codeRow.id);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
    destroyUserSessions(req.sessionStore, user.id, req.sessionID);
    res.json({ ok: true });
  })
);

// ---------- Профиль / настройки ----------
const AVATAR_MAX = 5 * 1024 * 1024;
const AVATAR_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

app.post(
  '/api/users/me/avatar',
  requireAuth,
  upload.single('avatar'),
  api((req, res) => {
    if (!req.file) return fail(res, 400, 'Выберите изображение');
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!AVATAR_MIME[ext]) {
      fs.unlink(req.file.path, () => {});
      return fail(res, 400, 'Допустимые форматы: PNG, JPG, GIF, WEBP, BMP, AVIF');
    }
    if (req.file.size > AVATAR_MAX) {
      fs.unlink(req.file.path, () => {});
      return fail(res, 400, 'Аватар не должен превышать 5 МБ');
    }
    const old = req.user.avatar;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(req.file.filename, req.user.id);
    if (old && old !== req.file.filename) {
      fs.unlink(path.join(UPLOAD_DIR, old), () => {});
    }
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  })
);

app.get('/api/users/:id/avatar', (req, res) => {
  const user = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.params.id);
  if (!user || !user.avatar) return res.status(404).end();
  const filePath = path.join(UPLOAD_DIR, user.avatar);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  const mime = AVATAR_MIME[path.extname(user.avatar).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(filePath).pipe(res);
});

app.post(
  '/api/users/me/profile',
  requireAuth,
  api((req, res) => {
    const about = String(req.body.about || '').trim().slice(0, 500);
    db.prepare('UPDATE users SET about = ? WHERE id = ?').run(about, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  })
);

app.post(
  '/api/users/me/email',
  requireAuth,
  api((req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 255);
    const password = String(req.body.password || '');
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'Введите корректный email');
    if (!password || !bcrypt.compareSync(password, req.user.password_hash)) {
      return fail(res, 400, 'Неверный пароль');
    }
    const dup = db
      .prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .get(email, req.user.id);
    if (dup) return fail(res, 409, 'Этот email уже используется');
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  })
);

app.post(
  '/api/users/me/password',
  requireAuth,
  api((req, res) => {
    const current = String(req.body.current || '');
    const next = String(req.body.next || '');
    if (!current || !bcrypt.compareSync(current, req.user.password_hash)) {
      return fail(res, 400, 'Неверный текущий пароль');
    }
    if (next.length < 6) return fail(res, 400, 'Пароль должен содержать не менее 6 символов');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), req.user.id);
    destroyUserSessions(req.sessionStore, req.user.id, req.sessionID);
    res.json({ ok: true });
  })
);

app.post(
  '/api/users/me/security',
  requireAuth,
  api((req, res) => {
    const password = String(req.body.password || '');
    if (!password || !bcrypt.compareSync(password, req.user.password_hash)) {
      return fail(res, 400, 'Неверный пароль');
    }
    const action = req.body.action === 'remove' ? 'remove' : 'set';
    if (action === 'remove') {
      db.prepare("UPDATE users SET security_question = '', security_answer = '' WHERE id = ?").run(req.user.id);
      return res.json({ user: publicUser(getUser(req.user.id)) });
    }
    const question = String(req.body.question || '').trim();
    const answer = normalizeAnswer(req.body.answer);
    if (!SECURITY_QUESTIONS.includes(question)) return fail(res, 400, 'Выберите контрольный вопрос');
    if (answer.length < 2) return fail(res, 400, 'Придумайте ответ на контрольный вопрос (минимум 2 символа)');
    db.prepare('UPDATE users SET security_question = ?, security_answer = ? WHERE id = ?').run(
      question,
      bcrypt.hashSync(answer, 10),
      req.user.id
    );
    res.json({ user: publicUser(getUser(req.user.id)) });
  })
);

// ---------- Фракция / главная ----------
app.get(
  '/api/faction',
  api((req, res) => {
    const entries = db
      .prepare(
        `SELECT id, callsign, rank, position, user_id FROM roster
         WHERE status = 'active' AND position IN ('Командир О.Б.Р', 'Зам. Командира')
         ORDER BY CASE position WHEN 'Командир О.Б.Р' THEN 0 ELSE 1 END, created_at`
      )
      .all();

    const commanderUsers = db
      .prepare("SELECT username FROM users WHERE role = 'commander' ORDER BY id LIMIT 1")
      .all();
    const zamUsers = db
      .prepare("SELECT username FROM users WHERE role = 'zam' ORDER BY id")
      .all();

    function mergeByCallsign(positionEntries, users) {
      const result = positionEntries.map((e) => ({ callsign: e.callsign, rank: e.rank }));
      const seen = new Set(result.map((r) => r.callsign));
      for (const u of users) {
        if (!seen.has(u.username)) {
          result.push({ callsign: u.username, rank: '' });
          seen.add(u.username);
        }
      }
      return result;
    }

    res.json({
      description: getSetting('faction_description', ''),
      commander: mergeByCallsign(
        entries.filter((e) => e.position === 'Командир О.Б.Р'),
        commanderUsers
      ),
      zam: mergeByCallsign(
        entries.filter((e) => e.position === 'Зам. Командира'),
        zamUsers
      ),
    });
  })
);

app.put(
  '/api/faction',
  requireAuth,
  requireCommander,
  api((req, res) => {
    const description = String(req.body.description || '').trim().slice(0, 10000);
    setSetting('faction_description', description);
    res.json({ ok: true, description });
  })
);

// ---------- Новостная строка ----------
app.get(
  '/api/news',
  api((req, res) => {
    res.json({ text: getSetting('news_ticker', '') });
  })
);

app.put(
  '/api/news',
  requireAuth,
  requireCommander,
  api((req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 100);
    setSetting('news_ticker', text);
    res.json({ ok: true, text });
  })
);

// ---------- Discord ----------
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

app.get(
  '/api/discord/config',
  requireAuth,
  requireCommander,
  api((req, res) => {
    res.json(discord.publicConfig());
  })
);

app.put(
  '/api/discord/config',
  requireAuth,
  requireCommander,
  api(async (req, res) => {
    const cfg = await discord.saveFromRequest(req.body);
    res.json(cfg);
  })
);

app.get(
  '/api/discord/me',
  requireAuth,
  api((req, res) => {
    res.json({
      linked: !!req.user.discord_id,
      username: req.user.discord_username || '',
      role_on_accept_configured: !!(discord.loadConfig().role_on_accept),
    });
  })
);

app.post(
  '/api/discord/link',
  requireAuth,
  api(async (req, res) => {
    if (!discord.isOAuthConfigured()) return fail(res, 400, 'Привязка Discord не настроена командованием');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.discordOAuthState = state;
    const redirectUri = `https://${oauthHost(req)}/api/discord/oauth/callback`;
    console.log('[discord] oauth redirect_uri =', redirectUri);
    const url = await discord.getOAuthURL(redirectUri, state);
    res.json({ url });
  })
);

app.post(
  '/api/discord/unlink',
  requireAuth,
  api((req, res) => {
    db.prepare("UPDATE users SET discord_id = '', discord_username = '' WHERE id = ?").run(req.user.id);
    res.json({ ok: true });
  })
);

app.get(
  '/api/discord/oauth/callback',
  requireAuth,
  api(async (req, res) => {
    const state = req.session.discordOAuthState;
    req.session.discordOAuthState = null;
    if (!state || state !== req.query.state) {
      return res.redirect('/profile.html?discord=error');
    }
    const code = String(req.query.code || '');
    const redirectUri = `https://${oauthHost(req)}/api/discord/oauth/callback`;
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

app.post(
  '/api/discord/reg-link',
  api(async (req, res) => {
    if (!discord.isOAuthConfigured()) return fail(res, 400, 'Привязка Discord не настроена командованием');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.discordOAuthState = state;
    const redirectUri = `https://${oauthHost(req)}/api/discord/reg/callback`;
    const url = await discord.getOAuthURL(redirectUri, state);
    res.json({ url });
  })
);

app.get(
  '/api/discord/reg/callback',
  api(async (req, res) => {
    const state = req.session.discordOAuthState;
    req.session.discordOAuthState = null;
    if (!state || state !== req.query.state) {
      return res.redirect('/register.html?discord=error');
    }
    const code = String(req.query.code || '');
    const redirectUri = `https://${oauthHost(req)}/api/discord/reg/callback`;
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

// ---------- Штатное расписание ----------
app.get(
  '/api/roster',
  requireAuth,
  api((req, res) => {
    ensureCommanderInRoster();
    const now = todayISO();
    const expired = db
      .prepare("SELECT * FROM roster WHERE vacation_until != ''")
      .all()
      .filter((r) => {
        const iso = toISODate(r.vacation_until);
        return iso && iso < now;
      });
    for (const e of expired) {
      db.prepare("UPDATE roster SET vacation_until = '', vacation_reason = '' WHERE id = ?").run(e.id);
      syncMemberDiscordRoles(e.user_id, { ...e, vacation_until: '', vacation_reason: '' });
    }
    const rows = db
      .prepare(
        `SELECT r.*, u.avatar AS avatar FROM roster r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created_at, r.id`
      )
      .all();
    res.json({ roster: rows });
  })
);

app.post(
  '/api/roster',
  requireAuth,
  requireManager,
  api((req, res) => {
    const b = req.body;
    const employee_number = String(b.employee_number || '').trim();
    const callsign = String(b.callsign || '').trim();
    const rank = String(b.rank || '');
    const position = String(b.position || '');

    if (!employee_number) return fail(res, 400, 'Укажите номер сотрудника');
    if (!callsign) return fail(res, 400, 'Укажите позывной');
    if (!RANKS.includes(rank)) return fail(res, 400, 'Выберите звание');
    if (!POSITIONS.includes(position)) return fail(res, 400, 'Выберите должность');
    if (db.prepare('SELECT id FROM roster WHERE employee_number = ?').get(employee_number)) {
      return fail(res, 409, 'Сотрудник с таким номером уже есть в штате');
    }
    if (!positionAllowedFor(position, b.user_id || null)) {
      return fail(res, 400, 'Должность «Командир О.Б.Р» может занимать только действующий командир');
    }
    if (b.user_id) {
      const du = db.prepare('SELECT id FROM roster WHERE user_id = ?').get(b.user_id);
      if (du) return fail(res, 409, 'Этот пользователь уже есть в штатном расписании');
    }

    const info = db
      .prepare(
        "INSERT INTO roster (employee_number, callsign, rank, position, status, user_id, age, discord) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)"
      )
      .run(
        employee_number,
        callsign,
        rank,
        position,
        b.user_id || null,
        String(b.age || '').trim().slice(0, 10),
        String(b.discord || '').trim().slice(0, 60)
      );

    syncUserRole(b.user_id, position, true);
    const newEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(info.lastInsertRowid);
    syncMemberDiscordRoles(b.user_id, newEntry);

    res.json({ roster: newEntry });
  })
);

app.put(
  '/api/roster/:id',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');

    const b = req.body;
    const employee_number = String(b.employee_number ?? entry.employee_number).trim();
    const callsign = String(b.callsign ?? entry.callsign).trim();
    const rank = String(b.rank ?? entry.rank);
    const position = String(b.position ?? entry.position);
    const age = String(b.age ?? entry.age).trim().slice(0, 10);
    const discordHandle = String(b.discord ?? entry.discord).trim().slice(0, 60);

    if (!employee_number) return fail(res, 400, 'Укажите номер сотрудника');
    if (!callsign) return fail(res, 400, 'Укажите позывной');
    if (!RANKS.includes(rank)) return fail(res, 400, 'Выберите звание');
    if (!POSITIONS.includes(position)) return fail(res, 400, 'Выберите должность');
    const dup = db
      .prepare('SELECT id FROM roster WHERE employee_number = ? AND id != ?')
      .get(employee_number, entry.id);
    if (dup) return fail(res, 409, 'Сотрудник с таким номером уже есть в штате');

    const nextUserId = b.user_id !== undefined ? (b.user_id || null) : entry.user_id;
    if (!positionAllowedFor(position, nextUserId)) {
      return fail(res, 400, 'Должность «Командир О.Б.Р» может занимать только действующий командир');
    }
    if (nextUserId) {
      const du = db
        .prepare('SELECT id FROM roster WHERE user_id = ? AND id != ?')
        .get(nextUserId, entry.id);
      if (du) return fail(res, 409, 'Этот пользователь уже есть в штатном расписании');
    }

    if (entry.user_id && entry.user_id !== nextUserId) {
      const old = getUser(entry.user_id);
      if (old && old.role !== 'commander') {
        db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(old.id);
      }
      if (old && old.discord_id) {
        discord.resetRoles(old.discord_id);
      }
    }

    db.prepare(
      'UPDATE roster SET employee_number = ?, callsign = ?, rank = ?, position = ?, user_id = ?, age = ?, discord = ? WHERE id = ?'
    ).run(employee_number, callsign, rank, position, nextUserId, age, discordHandle, entry.id);

    syncUserRole(nextUserId, position, entry.status === 'active');
    const updatedEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id);
    syncMemberDiscordRoles(nextUserId, updatedEntry);

    res.json({ roster: updatedEntry });
  })
);

app.delete(
  '/api/roster/:id',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');
    if (entry.status === 'active' && entry.user_id) {
      const target = getUser(entry.user_id);
      if (target && target.role === 'commander') {
        return fail(res, 400, 'Сначала передайте должность командира');
      }
      db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(entry.user_id);
    }
    if (entry.status === 'active') {
      discordOnDismissal(entry.user_id, entry.callsign, `Исключён из О.Б.Р (${entry.position})`);
    }
    db.prepare('DELETE FROM roster WHERE id = ?').run(entry.id);
    res.json({ ok: true });
  })
);

app.post(
  '/api/roster/:id/toggle-status',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');

    if (entry.status === 'active') {
      const target = getUser(entry.user_id);
      if (target && target.role === 'commander') {
        return fail(res, 400, 'Нельзя уволить командира — сначала передайте должность');
      }
    }

    const newStatus = entry.status === 'active' ? 'fired' : 'active';
    db.prepare('UPDATE roster SET status = ? WHERE id = ?').run(newStatus, entry.id);
    syncUserRole(entry.user_id, entry.position, newStatus === 'active');

    if (newStatus === 'fired') {
      discordOnDismissal(entry.user_id, entry.callsign, `Уволен из О.Б.Р (${entry.position})`);
    } else {
      const updatedEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id);
      syncMemberDiscordRoles(entry.user_id, updatedEntry);
      discord.log({
        title: 'Сотрудник возвращён',
        description: `**${entry.callsign}** восстановлен в составе фракции.`,
        fields: [{ name: 'Должность', value: entry.position, inline: true }],
        color: discord.COLOR_GREEN,
        mention: memberMention(entry.user_id),
      });
    }

    res.json({ roster: db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id) });
  })
);

app.post(
  '/api/roster/:id/warning',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');
    if (entry.warnings >= 3) return fail(res, 400, 'У сотрудника уже 3 выговора');

    const reason = String(req.body.reason || '').trim().slice(0, 300);
    const until = String(req.body.until || '').trim().slice(0, 20);
    if (!reason) return fail(res, 400, 'Укажите причину выговора');
    if (!validUntilDate(until)) return fail(res, 400, 'Выберите корректную дату окончания срока (не в прошлом)');

    db.prepare('UPDATE roster SET warnings = warnings + 1 WHERE id = ?').run(entry.id);
    const info = db
      .prepare(
        "INSERT INTO punishments (roster_id, callsign, reason, until_date, issued_by) VALUES (?, ?, ?, ?, ?)"
      )
      .run(entry.id, entry.callsign, reason, until, req.user.username);

    const updatedEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id);
    syncMemberDiscordRoles(entry.user_id, updatedEntry);

    discordOnWarning(entry.user_id, entry.callsign, 'Выговор сотруднику', `**Причина:** ${reason}\n**Срок до:** ${until}`);

    res.json({
      roster: updatedEntry,
      punishment: db.prepare('SELECT * FROM punishments WHERE id = ?').get(info.lastInsertRowid),
    });
  })
);

app.post(
  '/api/roster/:id/unwarning',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');
    if (entry.warnings <= 0) return fail(res, 400, 'У сотрудника нет выговоров');
    db.prepare('UPDATE roster SET warnings = warnings - 1 WHERE id = ?').run(entry.id);
    db.prepare(
      "UPDATE punishments SET status = 'removed', removed_at = datetime('now', 'localtime') WHERE id = (SELECT id FROM punishments WHERE roster_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1)"
    ).run(entry.id);

    const updatedEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id);
    syncMemberDiscordRoles(entry.user_id, updatedEntry);

    const removedPun = db.prepare(
      "SELECT reason FROM punishments WHERE roster_id = ? AND status = 'removed' ORDER BY removed_at DESC, id DESC LIMIT 1"
    ).get(entry.id);
    discordOnWarning(
      entry.user_id,
      entry.callsign,
      'Выговор снят',
      `**Причина:** ${removedPun ? removedPun.reason : '—'}`
    );

    res.json({ roster: updatedEntry });
  })
);

app.post(
  '/api/roster/:id/vacation',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');

    const reason = String(req.body.reason || '').trim().slice(0, 300);
    const until = String(req.body.until || '').trim().slice(0, 20);
    if (!reason) return fail(res, 400, 'Укажите причину отпуска');
    if (!validUntilDate(until)) return fail(res, 400, 'Выберите корректную дату окончания отпуска (не в прошлом)');

    db.prepare('UPDATE roster SET vacation_until = ?, vacation_reason = ? WHERE id = ?').run(until, reason, entry.id);
    const updatedEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id);
    syncMemberDiscordRoles(entry.user_id, updatedEntry);

    discordOnVacation(entry.user_id, entry.callsign, 'Сотрудник в отпуске', `**Причина:** ${reason}\n**До:** ${until}`);

    res.json({ roster: updatedEntry });
  })
);

app.post(
  '/api/roster/:id/end-vacation',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');

    db.prepare("UPDATE roster SET vacation_until = '', vacation_reason = '' WHERE id = ?").run(entry.id);
    const updatedEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id);
    syncMemberDiscordRoles(entry.user_id, updatedEntry);

    discordOnVacation(entry.user_id, entry.callsign, 'Отпуск завершён', 'Сотрудник вернулся из отпуска');

    res.json({ roster: updatedEntry });
  })
);

app.post(
  '/api/roster/:id/demote',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');
    const idx = RANKS.indexOf(entry.rank);
    if (idx <= 0) return fail(res, 400, 'Сотрудник уже на минимальном звании');
    db.prepare('UPDATE roster SET rank = ?, warnings = 0 WHERE id = ?').run(RANKS[idx - 1], entry.id);
    db.prepare(
      "UPDATE punishments SET status = 'removed', removed_at = datetime('now', 'localtime') WHERE roster_id = ? AND status = 'active'"
    ).run(entry.id);
    const demotedEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id);
    syncMemberDiscordRoles(entry.user_id, demotedEntry);
    res.json({ roster: demotedEntry });
  })
);

app.post(
  '/api/roster/:id/recert',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');
    db.prepare('UPDATE roster SET recert = 1, warnings = 0 WHERE id = ?').run(entry.id);
    db.prepare(
      "UPDATE punishments SET status = 'removed', removed_at = datetime('now', 'localtime') WHERE roster_id = ? AND status = 'active'"
    ).run(entry.id);
    res.json({ roster: db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id) });
  })
);

app.post(
  '/api/roster/:id/recert-clear',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');
    db.prepare('UPDATE roster SET recert = 0 WHERE id = ?').run(entry.id);
    res.json({ roster: db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id) });
  })
);

// ---------- Наказания ----------
app.get(
  '/api/punishments',
  requireAuth,
  requireStaff,
  api((req, res) => {
    const punishments = db
      .prepare('SELECT * FROM punishments ORDER BY id DESC')
      .all();
    res.json({ punishments });
  })
);

app.post(
  '/api/punishments/:id/remove',
  requireAuth,
  requireManager,
  api((req, res) => {
    const p = db.prepare('SELECT * FROM punishments WHERE id = ?').get(req.params.id);
    if (!p) return fail(res, 404, 'Наказание не найдено');
    if (p.status !== 'removed') {
      db.prepare(
        "UPDATE punishments SET status = 'removed', removed_at = datetime('now', 'localtime') WHERE id = ?"
      ).run(p.id);
      db.prepare('UPDATE roster SET warnings = MAX(warnings - 1, 0) WHERE id = ?').run(p.roster_id);
      const entry = db.prepare('SELECT user_id FROM roster WHERE id = ?').get(p.roster_id);
      discordOnWarning(entry ? entry.user_id : null, p.callsign, 'Выговор снят', `**Причина:** ${p.reason}`);
    }
    res.json({ punishment: db.prepare('SELECT * FROM punishments WHERE id = ?').get(p.id) });
  })
);

// ---------- Документы ----------
app.get(
  '/api/documents',
  requireAuth,
  api((req, res) => {
    let rows;
    if (isStaff(req.user)) {
      rows = db.prepare('SELECT * FROM documents ORDER BY created_at DESC, id DESC').all();
    } else {
      rows = db
        .prepare("SELECT * FROM documents WHERE access = 'dsp' ORDER BY created_at DESC, id DESC")
        .all();
    }
    res.json({ documents: rows });
  })
);

app.post(
  '/api/documents',
  requireAuth,
  requireManager,
  upload.single('file'),
  api((req, res) => {
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim().slice(0, 1000);
    const access = req.body.access === 'staff' ? 'staff' : 'dsp';

    if (!title) {
      if (req.file) fs.unlinkSync(req.file.path);
      return fail(res, 400, 'Укажите название документа');
    }
    if (!req.file) return fail(res, 400, 'Прикрепите файл');

    const info = db
      .prepare(
        'INSERT INTO documents (title, description, filename, stored_name, access, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(title, description, req.file.originalname, req.file.filename, access, req.user.id);

    discord.log({
      title: 'Новый документ',
      description: `**${title}**`,
      fields: [
        { name: 'Доступ', value: access === 'dsp' ? 'ДСП (всем)' : 'Персонал', inline: true },
        { name: 'Загрузил', value: req.user.username, inline: true },
        { name: 'Файл', value: req.file.originalname, inline: true },
      ],
      color: discord.COLOR_GREEN,
    });

    res.json({ document: db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid) });
  })
);

app.delete(
  '/api/documents/:id',
  requireAuth,
  requireManager,
  api((req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return fail(res, 404, 'Документ не найден');
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, doc.stored_name));
    } catch (_) {}
    discord.log({
      title: 'Документ удалён',
      description: `**${doc.title}**`,
      fields: [{ name: 'Удалил', value: req.user.username, inline: true }],
      color: discord.COLOR_RED,
    });
    res.json({ ok: true });
  })
);

app.get(
  '/api/documents/:id/download',
  requireAuth,
  api((req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return fail(res, 404, 'Документ не найден');
    if (doc.access === 'staff' && !isStaff(req.user)) {
      return fail(res, 403, 'Документ только для персонала');
    }
    const filePath = path.join(UPLOAD_DIR, doc.stored_name);
    if (!fs.existsSync(filePath)) return fail(res, 404, 'Файл не найден');
    res.download(filePath, doc.filename);
  })
);

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

app.get(
  '/api/documents/:id/view',
  requireAuth,
  api(async (req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return fail(res, 404, 'Документ не найден');
    if (doc.access === 'staff' && !isStaff(req.user)) {
      return fail(res, 403, 'Документ только для персонала');
    }
    const filePath = path.join(UPLOAD_DIR, doc.stored_name);
    if (!fs.existsSync(filePath)) return fail(res, 404, 'Файл не найден');
    const ext = path.extname(doc.filename).toLowerCase();
    if (ext === '.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return fs.createReadStream(filePath).pipe(res);
    }
    if (ext === '.docx') {
      try {
        const result = await mammoth.convertToHtml({ path: filePath });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(result.value);
      } catch (_) {
        return fail(res, 400, 'Не удалось открыть документ для предпросмотра');
      }
    }
    const mime = IMAGE_MIME[ext];
    if (!mime) return fail(res, 400, 'Этот формат не поддерживает предпросмотр');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(filePath).pipe(res);
  })
);

// ---------- Заявки ----------
app.get(
  '/api/applications',
  requireAuth,
  api((req, res) => {
    let rows;
    if (isManager(req.user)) {
      rows = db
        .prepare(
          `SELECT a.*, u.username, u.avatar AS avatar, r.callsign AS roster_callsign
           FROM applications a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN roster r ON r.id = a.roster_id
           ORDER BY a.created_at DESC, a.id DESC`
        )
        .all();
    } else {
      rows = db
        .prepare(
          `SELECT a.*, u.username, u.avatar AS avatar, r.callsign AS roster_callsign
           FROM applications a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN roster r ON r.id = a.roster_id
           WHERE a.user_id = ?
           ORDER BY a.created_at DESC, a.id DESC`
        )
        .all(req.user.id);
    }
    const ids = rows.map((r) => r.id);
    const photos = ids.length
      ? db
          .prepare(
            `SELECT id, application_id, filename, stored_name FROM application_photos WHERE application_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
          )
          .all(...ids)
      : [];
    const byApp = {};
    for (const p of photos) {
      (byApp[p.application_id] = byApp[p.application_id] || []).push({
        id: p.id,
        filename: p.filename,
        stored_name: p.stored_name,
      });
    }
    for (const r of rows) r.photos = byApp[r.id] || [];
    res.json({ applications: rows });
  })
);

app.post(
  '/api/applications',
  requireAuth,
  api((req, res) => {
    const type = req.body.type === 'leave' ? 'leave' : req.body.type === 'builder' ? 'builder' : 'join';
    const text = String(req.body.text || '').trim().slice(0, 2000);
    const callsign = String(req.body.callsign || '').trim().slice(0, 40);
    const age = String(req.body.age || '').trim().slice(0, 10);
    const discordHandle = String(req.body.discord || '').trim().slice(0, 60);

    if (type === 'builder') {
      if (!isStaff(req.user)) return fail(res, 403, 'Заявка на билдера доступна персоналу фракции');
      const rosterRow = db
        .prepare('SELECT id FROM roster WHERE user_id = ? AND status = ?')
        .get(req.user.id, 'active');
      if (!rosterRow) return fail(res, 400, 'Вы не состоите в штате фракции');
      const reason = String(req.body.reason || '').trim().slice(0, 1500);
      const skill = String(req.body.skill || '').trim().slice(0, 1500);
      const builds = String(req.body.builds || '').trim().slice(0, 2000);
      if (!callsign) return fail(res, 400, 'Укажите позывной во фракции');
      if (reason.length < 10) return fail(res, 400, 'Опишите причину — почему хотите стать билдером');
      if (skill.length < 10) return fail(res, 400, 'Опишите, насколько хорошо вы умеете строить');
      if (builds.length < 10) return fail(res, 400, 'Опишите, что вы строили');
      const dup = db
        .prepare("SELECT id FROM applications WHERE user_id = ? AND type = 'builder' AND status = 'pending'")
        .get(req.user.id);
      if (dup) return fail(res, 409, 'У вас уже есть рассматриваемая заявка на билдера');
      const photos = Array.isArray(req.body.photos) ? req.body.photos.slice(0, 15) : [];

      const info = db
        .prepare(
          `INSERT INTO applications (type, user_id, text, callsign, builder_reason, builder_skill, builder_builds, status)
           VALUES ('builder', ?, ?, ?, ?, ?, ?, 'pending')`
        )
        .run(
          req.user.id,
          `Заявка на должность Билдера\n\nПозывной: ${callsign}\n\nПричина: ${reason}\n\nУмение строить: ${skill}\n\nЧто строил: ${builds}`,
          callsign,
          reason,
          skill,
          builds
        );

      for (const p of photos) {
        const filename = String(p.filename || '').slice(0, 255);
        const stored_name = String(p.stored_name || '').slice(0, 255);
        if (!stored_name || !/^[a-zA-Z0-9._-]+$/.test(stored_name)) continue;
        const filePath = path.join(UPLOAD_DIR, stored_name);
        if (!fs.existsSync(filePath)) continue;
        db.prepare(
          'INSERT INTO application_photos (application_id, filename, stored_name) VALUES (?, ?, ?)'
        ).run(info.lastInsertRowid, filename, stored_name);
      }

      const entry = db
        .prepare('SELECT callsign, position FROM roster WHERE id = ?')
        .get(rosterRow.id);
      discord.log({
        title: 'Новая заявка на билдера',
        description: `**${callsign}** хочет стать билдером отряда.`,
        fields: [
          { name: 'Позывной', value: callsign, inline: true },
          { name: 'Должность', value: entry ? entry.position : '—', inline: true },
          { name: 'Файлы', value: String(photos.length), inline: true },
        ],
        color: discord.COLOR_BLUE,
      });

      return res.json({ application: db.prepare('SELECT * FROM applications WHERE id = ?').get(info.lastInsertRowid) });
    }

    if (type === 'join') {
      if (isStaff(req.user)) return fail(res, 400, 'Вы уже в составе фракции');
      if (text.length < 10) return fail(res, 400, 'Заполните заявку — ответьте на все вопросы');
      if (!callsign) return fail(res, 400, 'Укажите позывной');
      if (!age) return fail(res, 400, 'Укажите возраст');
      const dup = db
        .prepare("SELECT id FROM applications WHERE user_id = ? AND type = 'join' AND status = 'pending'")
        .get(req.user.id);
      if (dup) return fail(res, 409, 'У вас уже есть рассматриваемая заявка');
    } else {
      if (!isStaff(req.user)) return fail(res, 403, 'Заявление на увольнение доступно персоналу');
      const dup = db
        .prepare("SELECT id FROM applications WHERE user_id = ? AND type = 'leave' AND status = 'pending'")
        .get(req.user.id);
      if (dup) return fail(res, 409, 'У вас уже есть рассматриваемое заявление');
    }

    const info = db
      .prepare(
        'INSERT INTO applications (type, user_id, text, callsign, age, discord, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(type, req.user.id, text, type === 'join' ? callsign : '', type === 'join' ? age : '', type === 'join' ? discordHandle : '', 'pending');

    if (type === 'join') {
      discord.log({
        title: 'Новая заявка на вступление',
        description: `**${callsign}** хочет вступить в отряд.`,
        fields: [
          { name: 'Возраст', value: age || '—', inline: true },
          { name: 'Discord', value: discordHandle || '—', inline: true },
          { name: 'Заявитель', value: req.user.username, inline: true },
        ],
        color: discord.COLOR_BLUE,
      });
    }

    res.json({ application: db.prepare('SELECT * FROM applications WHERE id = ?').get(info.lastInsertRowid) });
  })
);

app.put(
  '/api/applications/:id',
  requireAuth,
  requireManager,
  api((req, res) => {
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!app) return fail(res, 404, 'Заявка не найдена');
    const text = String(req.body.text ?? app.text).trim().slice(0, 2000);
    db.prepare('UPDATE applications SET text = ? WHERE id = ?').run(text, app.id);
    res.json({ application: db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id) });
  })
);

app.get(
  '/api/applications/:id/photo/:photoId',
  requireAuth,
  api((req, res) => {
    const application = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!application) return fail(res, 404, 'Заявка не найдена');
    if (!isManager(req.user) && application.user_id !== req.user.id) {
      return fail(res, 403, 'Недостаточно прав');
    }
    const photo = db
      .prepare('SELECT * FROM application_photos WHERE id = ? AND application_id = ?')
      .get(req.params.photoId, application.id);
    if (!photo) return fail(res, 404, 'Файл не найден');
    const filePath = path.join(UPLOAD_DIR, photo.stored_name);
    if (!fs.existsSync(filePath)) return fail(res, 404, 'Файл не найден');
    const mime = IMAGE_MIME[path.extname(photo.filename).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(filePath).pipe(res);
  })
);

app.delete(
  '/api/applications/:id',
  requireAuth,
  requireManager,
  api((req, res) => {
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!app) return fail(res, 404, 'Заявка не найдена');
    const photos = db.prepare('SELECT stored_name FROM application_photos WHERE application_id = ?').all(app.id);
    for (const p of photos) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, p.stored_name));
      } catch (_) {}
    }
    db.prepare('DELETE FROM application_photos WHERE application_id = ?').run(app.id);
    db.prepare('DELETE FROM applications WHERE id = ?').run(app.id);
    discord.log({
      title: 'Заявка удалена',
      description: `Тип: ${app.type === 'join' ? 'вступление' : app.type === 'builder' ? 'билдер' : 'увольнение'}`,
      fields: [
        { name: 'Позывной', value: app.callsign || '—', inline: true },
        { name: 'Удалил', value: req.user.username, inline: true },
      ],
      color: discord.COLOR_RED,
    });
    res.json({ ok: true });
  })
);

app.post(
  '/api/applications/:id/approve',
  requireAuth,
  requireManager,
  api((req, res) => {
    const application = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!application) return fail(res, 404, 'Заявка не найдена');
    if (application.status !== 'pending') return fail(res, 400, 'Заявка уже рассмотрена');

    if (application.type === 'builder') {
      const rosterEntry = db
        .prepare('SELECT * FROM roster WHERE user_id = ? AND status = ?')
        .get(application.user_id, 'active');
      if (!rosterEntry) return fail(res, 400, 'Сотрудник не состоит в штате фракции');
      db.prepare('UPDATE roster SET builder = 1 WHERE id = ?').run(rosterEntry.id);
      const withBuilder = db.prepare('SELECT * FROM roster WHERE id = ?').get(rosterEntry.id);
      syncMemberDiscordRoles(application.user_id, withBuilder);
      const target = getUser(application.user_id);
      if (target && target.discord_id) {
        discord.sendDM(
          target.discord_id,
          `Поздравляем, **${target.discord_username || target.username}**! Ваша заявка на должность Билдера одобрена.`
        );
      }
      db.prepare(
        "UPDATE applications SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now', 'localtime') WHERE id = ?"
      ).run(req.user.id, application.id);
      discord.log({
        title: 'Заявка на билдера одобрена',
        description: `**${application.callsign || (target ? target.username : '—')}** принят на должность Билдера.`,
        fields: [{ name: 'Рассмотрел', value: req.user.username, inline: true }],
        color: discord.COLOR_GREEN,
        mention: memberMention(application.user_id),
      });
      return res.json({ application: db.prepare('SELECT * FROM applications WHERE id = ?').get(application.id) });
    }

    if (application.type === 'join') {
      const b = req.body;
      const employee_number = String(b.employee_number || '').trim();
      const callsign = String(b.callsign || application.callsign || '').trim();
      const rank = String(b.rank || '');
      const position = String(b.position || '');
      const age = String(b.age ?? application.age ?? '').trim().slice(0, 10);
      const discordHandle = String(b.discord ?? application.discord ?? '').trim().slice(0, 60);

      if (!employee_number) return fail(res, 400, 'Укажите номер сотрудника');
      if (!callsign) return fail(res, 400, 'Укажите позывной');
      if (!RANKS.includes(rank)) return fail(res, 400, 'Выберите звание');
      if (!POSITIONS.includes(position)) return fail(res, 400, 'Выберите должность');
      if (db.prepare('SELECT id FROM roster WHERE employee_number = ?').get(employee_number)) {
        return fail(res, 409, 'Сотрудник с таким номером уже есть в штате');
      }
      if (!positionAllowedFor(position, application.user_id)) {
        return fail(res, 400, 'Должность «Командир О.Б.Р» может занимать только действующий командир');
      }

      const existing = db
        .prepare('SELECT id FROM roster WHERE user_id = ? AND status = ?')
        .get(application.user_id, 'active');
      if (existing) return fail(res, 409, 'Пользователь уже состоит в штате');

      const info = db
        .prepare(
          "INSERT INTO roster (employee_number, callsign, rank, position, status, user_id, age, discord) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)"
        )
        .run(employee_number, callsign, rank, position, application.user_id, age, discordHandle);

      const rosterEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(info.lastInsertRowid);
      syncUserRole(application.user_id, position, true);

      discordOnAccept(rosterEntry, employee_number);
      db.prepare(
        "UPDATE applications SET status = 'approved', roster_id = ?, reviewed_by = ?, reviewed_at = datetime('now', 'localtime') WHERE id = ?"
      ).run(info.lastInsertRowid, req.user.id, application.id);
    } else {
      const entry = db
        .prepare('SELECT * FROM roster WHERE user_id = ? AND status = ?')
        .get(application.user_id, 'active');
      if (entry && entry.user_id) {
        const target = getUser(entry.user_id);
        if (target && target.role === 'commander') {
          return fail(res, 400, 'Нельзя уволить командира — сначала передайте должность');
        }
        if (target) {
          db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(target.id);
        }
      }
      if (entry) {
        db.prepare('DELETE FROM roster WHERE id = ?').run(entry.id);
      }
      db.prepare(
        "UPDATE applications SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now', 'localtime') WHERE id = ?"
      ).run(req.user.id, application.id);

      const firedCallsign = entry ? entry.callsign : application.callsign || '';
      discordOnDismissal(application.user_id, firedCallsign || '—', 'Заявление об увольнении одобрено', 'Заявление об увольнении одобрено');
    }

    res.json({
      application: db.prepare('SELECT * FROM applications WHERE id = ?').get(application.id),
    });
  })
);

app.post(
  '/api/applications/:id/reject',
  requireAuth,
  requireManager,
  api((req, res) => {
    const application = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!application) return fail(res, 404, 'Заявка не найдена');
    if (application.status !== 'pending') return fail(res, 400, 'Заявка уже рассмотрена');
    db.prepare(
      "UPDATE applications SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(req.user.id, application.id);
    const appType = application.type === 'join' ? 'на вступление' : application.type === 'builder' ? 'на билдера' : 'об увольнении';
    discord.log({
      title: 'Заявка отклонена',
      description: `**${application.callsign || '—'}** (${appType})`,
      fields: [{ name: 'Рассмотрел', value: req.user.username, inline: true }],
      color: discord.COLOR_RED,
      mention: memberMention(application.user_id),
    });
    res.json({ application: db.prepare('SELECT * FROM applications WHERE id = ?').get(application.id) });
  })
);

// ---------- Рапорты ----------
const REPORT_TYPES = ['report', 'promotion', 'complaint', 'vacation'];
const REPORT_TYPE_LABELS = { report: 'Рапорт', promotion: 'Поощрение', complaint: 'Жалоба', vacation: 'Заявка на отпуск' };

app.post(
  '/api/uploads',
  requireAuth,
  requireStaff,
  upload.array('photos', 15),
  api((req, res) => {
    if (!req.files || !req.files.length) return fail(res, 400, 'Прикрепите файлы');
    const files = req.files.map((f) => ({
      filename: f.originalname,
      stored_name: f.filename,
    }));
    res.json({ files });
  })
);

app.get(
  '/api/reports',
  requireAuth,
  requireStaff,
  api((req, res) => {
    let rows;
    if (isManager(req.user)) {
      rows = db
        .prepare(
          `SELECT r.*, u.username, u.avatar AS avatar FROM reports r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC, r.id DESC`
        )
        .all();
    } else {
      rows = db
        .prepare(
          `SELECT r.*, u.username, u.avatar AS avatar FROM reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.user_id = ? ORDER BY r.created_at DESC, r.id DESC`
        )
        .all(req.user.id);
    }
    const ids = rows.map((r) => r.id);
    const photos = ids.length
      ? db
          .prepare(
            `SELECT id, report_id, filename, stored_name FROM report_photos WHERE report_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
          )
          .all(...ids)
      : [];
    const byReport = {};
    for (const p of photos) {
      (byReport[p.report_id] = byReport[p.report_id] || []).push({
        id: p.id,
        filename: p.filename,
        stored_name: p.stored_name,
      });
    }
    for (const r of rows) r.photos = byReport[r.id] || [];
    res.json({ reports: rows });
  })
);

app.post(
  '/api/reports',
  requireAuth,
  requireStaff,
  api((req, res) => {
    const type = REPORT_TYPES.includes(req.body.type) ? req.body.type : 'report';
    const theme = String(req.body.theme || '').trim().slice(0, 200);
    const text = String(req.body.text || '').trim().slice(0, 5000);
    const attachments = String(req.body.attachments || '').trim().slice(0, 1000);
    const signature = String(req.body.signature || '').trim().slice(0, 60);
    const photos = Array.isArray(req.body.photos) ? req.body.photos.slice(0, 15) : [];
    const v_from = String(req.body.v_from || '').trim().slice(0, 20);
    const v_to = String(req.body.v_to || '').trim().slice(0, 20);

    const cleanupOnFail = (status, message) => {
      cleanupUploaded(photos);
      return fail(res, status, message);
    };

    if (!theme) return cleanupOnFail(400, 'Укажите тему рапорта');
    if (text.length < 10) return cleanupOnFail(400, 'Опишите содержание рапорта');
    if (type === 'vacation') {
      if (!validUntilDate(v_from) || !validUntilDate(v_to)) {
        return cleanupOnFail(400, 'Укажите даты начала и окончания отпуска (не в прошлом)');
      }
      if (toISODate(v_to) < toISODate(v_from)) {
        return cleanupOnFail(400, 'Дата окончания отпуска раньше даты начала');
      }
    }

    const info = db
      .prepare(
        "INSERT INTO reports (user_id, type, theme, text, attachments, date, signature, status, v_from, v_to) VALUES (?, ?, ?, ?, ?, date('now', 'localtime'), ?, 'open', ?, ?)"
      )
      .run(req.user.id, type, theme, text, attachments, signature || req.user.username, v_from, v_to);

    discord.log({
      title: type === 'vacation' ? 'Новая заявка на отпуск' : 'Новый рапорт',
      description: `**${theme}**`,
      fields: [
        { name: 'Тип', value: REPORT_TYPE_LABELS[type] || 'Рапорт', inline: true },
        { name: 'Автор', value: req.user.username, inline: true },
        ...(type === 'vacation'
          ? [
              { name: 'Отпуск с', value: v_from, inline: true },
              { name: 'по', value: v_to, inline: true },
            ]
          : []),
      ],
      color: discord.COLOR_BLUE,
    });

    for (const p of photos) {
      const filename = String(p.filename || '').slice(0, 255);
      const stored_name = String(p.stored_name || '').slice(0, 255);
      if (!stored_name || !/^[a-zA-Z0-9._-]+$/.test(stored_name)) continue;
      const filePath = path.join(UPLOAD_DIR, stored_name);
      if (!fs.existsSync(filePath)) continue;
      db.prepare(
        'INSERT INTO report_photos (report_id, filename, stored_name) VALUES (?, ?, ?)'
      ).run(info.lastInsertRowid, filename, stored_name);
    }

    res.json({ report: db.prepare('SELECT * FROM reports WHERE id = ?').get(info.lastInsertRowid) });
  })
);

app.get(
  '/api/reports/:id/photo/:photoId',
  requireAuth,
  requireStaff,
  api((req, res) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!report) return fail(res, 404, 'Рапорт не найден');
    if (!isManager(req.user) && report.user_id !== req.user.id) {
      return fail(res, 403, 'Недостаточно прав');
    }
    const photo = db
      .prepare('SELECT * FROM report_photos WHERE id = ? AND report_id = ?')
      .get(req.params.photoId, report.id);
    if (!photo) return fail(res, 404, 'Фото не найдено');
    const filePath = path.join(UPLOAD_DIR, photo.stored_name);
    if (!fs.existsSync(filePath)) return fail(res, 404, 'Файл не найден');
    const mime = IMAGE_MIME[path.extname(photo.filename).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(filePath).pipe(res);
  })
);

app.put(
  '/api/reports/:id/status',
  requireAuth,
  requireManager,
  api((req, res) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!report) return fail(res, 404, 'Рапорт не найден');
    const nextStatus = report.status === 'open' ? 'done' : 'open';
    db.prepare(
      "UPDATE reports SET status = ?, reviewed_by = ?, reviewed_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(nextStatus, req.user.id, report.id);
    const author = report.user_id ? getUser(report.user_id) : null;
    discord.log({
      title: nextStatus === 'done' ? 'Рапорт одобрен' : 'Рапорт открыт заново',
      description: `**${report.theme}**`,
      fields: [
        { name: 'Автор', value: (author ? author.username : '—') || '—', inline: true },
        { name: 'Статус', value: nextStatus === 'done' ? 'Одобрен' : 'Открыт', inline: true },
        { name: 'Рассмотрел', value: req.user.username, inline: true },
      ],
      color: nextStatus === 'done' ? discord.COLOR_GREEN : discord.COLOR_BLUE,
      mention: memberMention(report.user_id),
    });
    res.json({ report: db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id) });
  })
);

app.delete(
  '/api/reports/:id',
  requireAuth,
  api((req, res) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!report) return fail(res, 404, 'Рапорт не найден');
    if (!isManager(req.user) && report.user_id !== req.user.id) {
      return fail(res, 403, 'Недостаточно прав');
    }
    const photos = db.prepare('SELECT stored_name FROM report_photos WHERE report_id = ?').all(report.id);
    for (const p of photos) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, p.stored_name));
      } catch (_) {}
    }
    db.prepare('DELETE FROM report_photos WHERE report_id = ?').run(report.id);
    db.prepare('DELETE FROM reports WHERE id = ?').run(report.id);
    res.json({ ok: true });
  })
);

// ---------- Пользователи (управление ролями) ----------
app.get(
  '/api/users',
  requireAuth,
  requireManager,
  api((req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY created_at, id').all();
    res.json({ users: users.map((u) => { const p = publicUser(u); delete p.security_question; return p; }) });
  })
);

app.put(
  '/api/users/:id/role',
  requireAuth,
  requireCommander,
  api((req, res) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return fail(res, 404, 'Пользователь не найден');
    const role = String(req.body.role || '');
    if (!['user', 'staff', 'zam', 'commander'].includes(role)) return fail(res, 400, 'Недопустимая роль');

    if (target.id === req.user.id && role !== 'commander') {
      return fail(res, 400, 'Нельзя снять с себя роль командира — сначала назначьте преемника');
    }

    if (role === 'commander' && target.role !== 'commander') {
      const cmdr = currentCommander();
      if (cmdr && cmdr.id !== target.id) {
        db.prepare("UPDATE users SET role = 'zam' WHERE id = ?").run(cmdr.id);
        const oldRow = db.prepare('SELECT id FROM roster WHERE user_id = ?').get(cmdr.id);
        if (oldRow) {
          db.prepare("UPDATE roster SET position = 'Зам. Командира' WHERE id = ?").run(oldRow.id);
        }
      }
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
    ensureCommanderInRoster();
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) });
  })
);

// ---------- Передача прав командира ----------
app.post(
  '/api/users/me/transfer/send',
  requireAuth,
  requireCommander,
  api(async (req, res) => {
    const username = String(req.body.username || '').trim().slice(0, 40);
    if (!username) return fail(res, 400, 'Укажите логин пользователя');
    const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!target) return fail(res, 404, 'Пользователь с таким логином не найден');
    if (target.id === req.user.id) return fail(res, 400, 'Вы не можете передать права самому себе');
    if (target.role === 'commander') return fail(res, 400, 'Этот пользователь уже командир');
    if (!req.user.email) {
      return fail(res, 400, 'У вас не указана почта — сначала добавьте её в настройках');
    }

    const result = await sendEmailCode(req.user.email, 'transfer');
    if (result.error) return fail(res, 429, result.error);
    if (result.dev) return res.json({ ok: true, dev: true, code: result.code, username });
    res.json({ ok: true, username });
  })
);

app.post(
  '/api/users/me/transfer/confirm',
  requireAuth,
  requireCommander,
  api((req, res) => {
    const username = String(req.body.username || '').trim().slice(0, 40);
    const code = String(req.body.code || '').trim();
    if (!username) return fail(res, 400, 'Укажите логин пользователя');
    const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!target) return fail(res, 404, 'Пользователь с таким логином не найден');
    if (target.id === req.user.id) return fail(res, 400, 'Вы не можете передать права самому себе');
    if (target.role === 'commander') return fail(res, 400, 'Этот пользователь уже командир');
    if (!/^\d{6}$/.test(code)) return fail(res, 400, 'Введите 6-значный код из письма');

    const check = consumeCode(req.user.email, code);
    if (check.error) return fail(res, 400, check.error);

    const oldCmdr = req.user;
    db.prepare("UPDATE users SET role = 'commander' WHERE id = ?").run(target.id);
    db.prepare("UPDATE users SET role = 'zam' WHERE id = ?").run(oldCmdr.id);
    const oldRow = db.prepare('SELECT id FROM roster WHERE user_id = ?').get(oldCmdr.id);
    if (oldRow) {
      db.prepare("UPDATE roster SET position = 'Зам. Командира' WHERE id = ?").run(oldRow.id);
    }
    ensureCommanderInRoster();

    res.json({ user: publicUser(getUser(target.id)) });
  })
);

// ---------- Старт ----------
ensureCommanderBootstrap();
ensureCommanderInRoster();

app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (максимум 20 МБ)' : 'Ошибка загрузки файла');
  }
  if (err && err.type === 'entity.too.large') {
    return fail(res, 400, 'Слишком большой объём данных');
  }
  next(err);
});

try {
  const now = todayISO();
  const expiredVacations = db
    .prepare("SELECT id, user_id FROM roster WHERE vacation_until != ''")
    .all()
    .filter((r) => {
      const iso = toISODate(r.vacation_until);
      return iso && iso < now;
    });
  for (const e of expiredVacations) {
    db.prepare("UPDATE roster SET vacation_until = '', vacation_reason = '' WHERE id = ?").run(e.id);
    const row = db.prepare('SELECT * FROM roster WHERE id = ?').get(e.id);
    if (row) syncMemberDiscordRoles(e.user_id, row);
  }
  if (expiredVacations.length) console.log(`[VACATION] Истёкшие отпуска очищены: ${expiredVacations.length}`);
} catch (e) {
  console.error('[VACATION] Ошибка очистки истёкших отпусков:', e);
}

app.listen(PORT, () => {
  console.log(`О.Б.Р — сайт запущен: http://localhost:${PORT}`);
});
