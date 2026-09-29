const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, UPLOAD_DIR } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireManager,
  requireCommander,
  publicUser,
  getUser,
  destroyUserSessions,
  dropTrackedSession,
} = require('../middleware/auth');
const { upload, AVATAR_MIME } = require('../middleware/upload');
const { SECURITY_QUESTIONS, normalizeAnswer, sendEmailCode, consumeCode } = require('../services/codeService');
const { currentCommander, ensureCommanderInRoster } = require('../services/rosterService');

const router = express.Router();
const AVATAR_MAX = 5 * 1024 * 1024;

// Update profile "about"
router.post(
  '/me/profile',
  requireAuth,
  api((req, res) => {
    const about = String(req.body.about || '').trim().slice(0, 500);
    db.prepare('UPDATE users SET about = ? WHERE id = ?').run(about, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  })
);

// Upload avatar
router.post(
  '/me/avatar',
  requireAuth,
  upload.single('avatar'),
  api((req, res) => {
    if (!req.file) return fail(res, 400, 'Выберите изображение');
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!AVATAR_MIME[ext]) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return fail(res, 400, 'Допустимые форматы: PNG, JPG, GIF, WEBP, BMP, AVIF');
    }
    if (req.file.size > AVATAR_MAX) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return fail(res, 400, 'Аватар не должен превышать 5 МБ');
    }
    const old = req.user.avatar;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(req.file.filename, req.user.id);
    if (old && old !== req.file.filename) {
      const oldSafe = path.basename(old);
      try { fs.unlinkSync(path.join(UPLOAD_DIR, oldSafe)); } catch (_) {}
    }
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  })
);

// Get user avatar
router.get('/:id/avatar', (req, res) => {
  const user = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.params.id);
  if (!user || !user.avatar) return res.status(404).end();
  const safeFilename = path.basename(user.avatar);
  const filePath = path.join(UPLOAD_DIR, safeFilename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  const mime = AVATAR_MIME[path.extname(safeFilename).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(filePath).pipe(res);
});

// Change password
router.post(
  '/me/password',
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

// Security question
router.post(
  '/me/security',
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

// ---------- Manage Users & Roles ----------
router.get(
  '/',
  requireAuth,
  requireManager,
  api((req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY created_at, id').all();
    res.json({
      users: (users || []).map((u) => {
        const p = publicUser(u);
        delete p.security_question;
        return p;
      }),
    });
  })
);

router.put(
  '/:id/role',
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
  '/me/transfer/send',
  requireAuth,
  requireCommander,
  api(async (req, res) => {
    const username = String(req.body.username || '').trim().slice(0, 40);
    if (!username) return fail(res, 400, 'Укажите логин пользователя');
    const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!target) return fail(res, 404, 'Пользователь с таким логином не найден');
    if (target.id === req.user.id) return fail(res, 400, 'Вы не можете передать права самому себе');
    if (target.role === 'commander') return fail(res, 400, 'Этот пользователь уже командир');

    const codeKey = `u:${req.user.id}`;
    const result = await sendEmailCode(codeKey, 'transfer', { discordId: req.user.discord_id });
    if (result.error) return fail(res, 429, result.error);
    const channels = (result.channels || []).join(',');
    if (result.dev) return res.json({ ok: true, dev: true, code: result.code, username, channels });
    res.json({ ok: true, username, channels });
  })
);

router.post(
  '/me/transfer/confirm',
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
    if (!/^\d{6}$/.test(code)) return fail(res, 400, 'Введите 6-значный код подтверждения');

    const codeKey = `u:${req.user.id}`;
    const check = consumeCode(codeKey, code);
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
