const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, UPLOAD_DIR } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireStaff,
  requireManager,
  getUser,
} = require('../middleware/auth');
const { IMAGE_MIME, setContentDisposition } = require('../middleware/upload');
const {
  memberMention,
  toISODate,
  validUntilDate,
  cleanupUploaded,
} = require('../services/rosterService');
const discord = require('../discord');

const router = express.Router();
const REPORT_TYPES = ['report', 'promotion', 'complaint', 'vacation'];
const REPORT_TYPE_LABELS = {
  report: 'Рапорт',
  promotion: 'Поощрение',
  complaint: 'Жалоба',
  vacation: 'Заявка на отпуск',
};

router.get(
  '/',
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

router.post(
  '/',
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
      const filename = path.basename(String(p.filename || '')).slice(0, 255);
      const stored_name = path.basename(String(p.stored_name || '')).slice(0, 255);
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

router.get(
  '/:id/photo/:photoId',
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
    const safeStored = path.basename(photo.stored_name);
    const filePath = path.join(UPLOAD_DIR, safeStored);
    if (!fs.existsSync(filePath)) return fail(res, 404, 'Файл не найден');
    const mime = IMAGE_MIME[path.extname(photo.filename).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    setContentDisposition(res, 'inline', photo.filename);
    fs.createReadStream(filePath).pipe(res);
  })
);

router.put(
  '/:id/status',
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

router.delete(
  '/:id',
  requireAuth,
  api((req, res) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!report) return fail(res, 404, 'Рапорт не найден');
    if (!isManager(req.user) && report.user_id !== req.user.id) {
      return fail(res, 403, 'Недостаточно прав');
    }
    const photos = db.prepare('SELECT stored_name FROM report_photos WHERE report_id = ?').all(report.id);
    for (const p of photos) {
      const safeStored = path.basename(p.stored_name);
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, safeStored));
      } catch (_) {}
    }
    db.prepare('DELETE FROM report_photos WHERE report_id = ?').run(report.id);
    db.prepare('DELETE FROM reports WHERE id = ?').run(report.id);
    res.json({ ok: true });
  })
);

module.exports = router;
