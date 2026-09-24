const express = require('express');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const { db, UPLOAD_DIR } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireStaff,
  requireManager,
  isStaff,
} = require('../middleware/auth');
const { upload, IMAGE_MIME, setContentDisposition } = require('../middleware/upload');
const discord = require('../discord');

const router = express.Router();

router.get(
  '/',
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

router.post(
  '/',
  requireAuth,
  requireManager,
  upload.single('file'),
  api((req, res) => {
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim().slice(0, 1000);
    const access = req.body.access === 'staff' ? 'staff' : 'dsp';

    if (!title) {
      if (req.file) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
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

router.delete(
  '/:id',
  requireAuth,
  requireManager,
  api((req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return fail(res, 404, 'Документ не найден');
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    const safeStored = path.basename(doc.stored_name);
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, safeStored));
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

router.get(
  '/:id/download',
  requireAuth,
  api((req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return fail(res, 404, 'Документ не найден');
    if (doc.access === 'staff' && !isStaff(req.user)) {
      return fail(res, 403, 'Документ только для персонала');
    }
    const safeStored = path.basename(doc.stored_name);
    const filePath = path.join(UPLOAD_DIR, safeStored);
    if (!fs.existsSync(filePath)) return fail(res, 404, 'Файл не найден');
    res.download(filePath, doc.filename);
  })
);

router.get(
  '/:id/view',
  requireAuth,
  api(async (req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return fail(res, 404, 'Документ не найден');
    if (doc.access === 'staff' && !isStaff(req.user)) {
      return fail(res, 403, 'Документ только для персонала');
    }
    const safeStored = path.basename(doc.stored_name);
    const filePath = path.join(UPLOAD_DIR, safeStored);
    if (!fs.existsSync(filePath)) return fail(res, 404, 'Файл не найден');

    const ext = path.extname(doc.filename).toLowerCase();
    if (ext === '.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      setContentDisposition(res, 'inline', doc.filename);
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
    setContentDisposition(res, 'inline', doc.filename);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(filePath).pipe(res);
  })
);

module.exports = router;
