const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, RANKS, POSITIONS, UPLOAD_DIR } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireManager,
  isStaff,
  isManager,
  isCommander,
  getUser,
} = require('../middleware/auth');
const { IMAGE_MIME, setContentDisposition } = require('../middleware/upload');
const {
  positionAllowedFor,
  syncUserRole,
  memberMention,
  syncMemberDiscordRoles,
  discordOnAccept,
  discordOnDismissal,
} = require('../services/rosterService');
const discord = require('../discord');

const router = express.Router();

router.get(
  '/',
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

router.post(
  '/',
  requireAuth,
  api((req, res) => {
    const type = req.body.type === 'leave' ? 'leave' : req.body.type === 'builder' ? 'builder' : 'join';
    const text = String(req.body.text || '').trim().slice(0, 2000);
    const callsign = String(req.body.callsign || '').trim().slice(0, 40);
    const age = String(req.body.age || '').trim().slice(0, 10);
    const discordHandle = String(req.body.discord || '').trim().slice(0, 60);

    if (type === 'builder') {
      let rosterRow = db
        .prepare('SELECT id FROM roster WHERE user_id = ? AND status = ?')
        .get(req.user.id, 'active');
      if (!rosterRow && isStaff(req.user)) {
        rosterRow = db
          .prepare('SELECT id FROM roster WHERE (LOWER(callsign) = LOWER(?) OR LOWER(callsign) = LOWER(?)) AND status = ?')
          .get(req.user.username, callsign, 'active');
        if (rosterRow) {
          db.prepare('UPDATE roster SET user_id = ? WHERE id = ?').run(req.user.id, rosterRow.id);
        }
      }
      if (!rosterRow && !isStaff(req.user)) {
        return fail(res, 403, 'Заявка на билдера доступна персоналу фракции');
      }
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
        const filename = path.basename(String(p.filename || '')).slice(0, 255);
        const stored_name = path.basename(String(p.stored_name || '')).slice(0, 255);
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
      .run(
        type,
        req.user.id,
        text,
        type === 'join' ? callsign : '',
        type === 'join' ? age : '',
        type === 'join' ? discordHandle : '',
        'pending'
      );

    if (type === 'join') {
      const cfg = discord.loadConfig();
      const fighterRole = cfg.role_fighter || '1440260887943450706';
      if (req.user.discord_id && fighterRole) {
        discord.addRoleToMember(req.user.discord_id, fighterRole).catch((err) => {
          console.error('[discord] Не удалось выдать роль бойца при подаче заявки:', err);
        });
      }
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

router.put(
  '/:id',
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

router.get(
  '/:id/photo/:photoId',
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

router.delete(
  '/:id',
  requireAuth,
  requireManager,
  api((req, res) => {
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!app) return fail(res, 404, 'Заявка не найдена');
    const photos = db.prepare('SELECT stored_name FROM application_photos WHERE application_id = ?').all(app.id);
    for (const p of photos) {
      const safeStored = path.basename(p.stored_name);
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, safeStored));
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

router.post(
  '/:id/approve',
  requireAuth,
  requireManager,
  api((req, res) => {
    const application = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!application) return fail(res, 404, 'Заявка не найдена');
    if (application.status !== 'pending') return fail(res, 400, 'Заявка уже рассмотрена');

    if (application.type === 'builder') {
      let rosterEntry = db
        .prepare('SELECT * FROM roster WHERE user_id = ? AND status = ?')
        .get(application.user_id, 'active');
      if (!rosterEntry) {
        rosterEntry = db
          .prepare('SELECT * FROM roster WHERE (LOWER(callsign) = LOWER(?) OR LOWER(callsign) = LOWER(?)) AND status = ?')
          .get(application.callsign, application.callsign, 'active');
        if (rosterEntry) {
          db.prepare('UPDATE roster SET user_id = ? WHERE id = ?').run(application.user_id, rosterEntry.id);
        }
      }
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

router.post(
  '/:id/reject',
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

module.exports = router;
