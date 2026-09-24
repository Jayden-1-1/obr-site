const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireManager,
  requireCommander,
  publicUser,
  getUser,
} = require('../middleware/auth');
const {
  currentCommander,
  ensureCommanderInRoster,
} = require('../services/rosterService');
const { sendEmailCode, consumeCode } = require('../services/codeService');

const router = express.Router();

// ---------- Faction Info ----------
router.get(
  '/faction',
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

router.put(
  '/faction',
  requireAuth,
  requireCommander,
  api((req, res) => {
    const description = String(req.body.description || '').trim().slice(0, 10000);
    setSetting('faction_description', description);
    res.json({ ok: true, description });
  })
);

// ---------- News Ticker ----------
router.get(
  '/news',
  api((req, res) => {
    res.json({ text: getSetting('news_ticker', '') });
  })
);

router.put(
  '/news',
  requireAuth,
  requireCommander,
  api((req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 100);
    setSetting('news_ticker', text);
    res.json({ ok: true, text });
  })
);

// ---------- Manage User Roles (Commander/Manager) ----------
router.get(
  '/users',
  requireAuth,
  requireManager,
  api((req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY created_at, id').all();
    res.json({
      users: users.map((u) => {
        const p = publicUser(u);
        delete p.security_question;
        return p;
      }),
    });
  })
);

router.put(
  '/users/:id/role',
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

// ---------- Transfer Commander Role ----------
router.post(
  '/users/me/transfer/send',
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

router.post(
  '/users/me/transfer/confirm',
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

module.exports = router;
