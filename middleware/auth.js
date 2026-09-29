const { db, isStaff, isManager, isCommander } = require('../db');

const _sessionTracked = new Map();

function api(fn) {
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') {
        result.catch((err) => {
          console.error(err);
          if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        });
      }
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  };
}

function fail(res, status, message) {
  res.status(status).json({ error: message });
}

function dropTrackedSession(sid) {
  if (sid) _sessionTracked.delete(sid);
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
      if (store && typeof store.destroy === 'function') {
        store.destroy(r.sid, () => {});
      }
    } catch (_) {}
    deleteSessionRow(r.sid);
  }
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return fail(res, 401, 'Требуется вход');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    const sid = req.sessionID;
    if (req.session && typeof req.session.destroy === 'function') {
      req.session.destroy(() => {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        dropTrackedSession(sid);
      });
    }
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
  if (!user) return null;
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

module.exports = {
  api,
  fail,
  requireAuth,
  requireManager,
  requireCommander,
  requireStaff,
  isStaff,
  isManager,
  isCommander,
  publicUser,
  getUser,
  deviceLabel,
  trackSession,
  deleteSessionRow,
  dropTrackedSession,
  destroyUserSessions,
};
