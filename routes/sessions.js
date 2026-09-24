const express = require('express');
const { db } = require('../db');
const {
  api,
  fail,
  requireAuth,
  dropTrackedSession,
} = require('../middleware/auth');

const router = express.Router();

router.get(
  '/',
  requireAuth,
  api((req, res) => {
    try {
      db.prepare("DELETE FROM sessions WHERE created_at < datetime('now', '-7 days')").run();
    } catch (_) {}
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

router.delete(
  '/:sid',
  requireAuth,
  api((req, res) => {
    if (req.params.sid === req.sessionID) {
      return fail(res, 400, 'Чтобы выйти с этого устройства, используйте «Выйти» в меню');
    }
    const row = db.prepare('SELECT * FROM sessions WHERE sid = ? AND user_id = ?').get(req.params.sid, req.user.id);
    if (!row) return fail(res, 404, 'Сессия не найдена');
    if (req.sessionStore && typeof req.sessionStore.destroy === 'function') {
      req.sessionStore.destroy(row.sid, (err) => {
        if (err) return fail(res, 500, 'Не удалось завершить сессию');
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
        dropTrackedSession(row.sid);
        res.json({ ok: true });
      });
    } else {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
      dropTrackedSession(row.sid);
      res.json({ ok: true });
    }
  })
);

router.post(
  '/logout-others',
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
      if (req.sessionStore && typeof req.sessionStore.destroy === 'function') {
        req.sessionStore.destroy(r.sid, () => {
          db.prepare('DELETE FROM sessions WHERE sid = ?').run(r.sid);
          dropTrackedSession(r.sid);
          removed++;
          finish();
        });
      } else {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(r.sid);
        dropTrackedSession(r.sid);
        removed++;
        finish();
      }
    }
  })
);

module.exports = router;
