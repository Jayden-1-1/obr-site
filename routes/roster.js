const express = require('express');
const { db, RANKS, POSITIONS } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireManager,
  getUser,
} = require('../middleware/auth');
const {
  positionAllowedFor,
  ensureCommanderInRoster,
  syncUserRole,
  memberMention,
  toISODate,
  todayISO,
  validUntilDate,
  syncMemberDiscordRoles,
  discordOnDismissal,
  discordOnWarning,
  discordOnVacation,
  cleanExpiredPunishments,
} = require('../services/rosterService');
const discord = require('../discord');

const router = express.Router();

router.get(
  '/',
  requireAuth,
  api((req, res) => {
    ensureCommanderInRoster();
    cleanExpiredPunishments();
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

router.post(
  '/',
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
    const userId = b.user_id ? Number(b.user_id) : null;
    if (!positionAllowedFor(position, userId)) {
      return fail(res, 400, 'Должность «Командир О.Б.Р» может занимать только действующий командир');
    }
    if (userId) {
      const du = db.prepare('SELECT id FROM roster WHERE user_id = ?').get(userId);
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
        userId,
        String(b.age || '').trim().slice(0, 10),
        String(b.discord || '').trim().slice(0, 60)
      );

    syncUserRole(userId, position, true);
    const newEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(info.lastInsertRowid);
    syncMemberDiscordRoles(userId, newEntry);

    res.json({ roster: newEntry });
  })
);

router.put(
  '/:id',
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

    const nextUserId = b.user_id !== undefined ? (b.user_id ? Number(b.user_id) : null) : (entry.user_id ? Number(entry.user_id) : null);
    if (!positionAllowedFor(position, nextUserId)) {
      return fail(res, 400, 'Должность «Командир О.Б.Р» может занимать только действующий командир');
    }
    if (nextUserId) {
      const du = db
        .prepare('SELECT id FROM roster WHERE user_id = ? AND id != ?')
        .get(nextUserId, entry.id);
      if (du) return fail(res, 409, 'Этот пользователь уже есть в штатном расписании');
    }

    if (entry.user_id && Number(entry.user_id) !== Number(nextUserId)) {
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

router.delete(
  '/:id',
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

router.post(
  '/:id/toggle-status',
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

router.post(
  '/:id/warning',
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

router.post(
  '/:id/unwarning',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');
    if (entry.warnings <= 0) return fail(res, 400, 'У сотрудника нет выговоров');

    const removeReason = String(req.body.reason || '').trim() || 'По решению руководства';
    const removedBy = req.user.callsign || req.user.username || 'Руководство';

    db.prepare('UPDATE roster SET warnings = MAX(warnings - 1, 0) WHERE id = ?').run(entry.id);

    const activePun = db.prepare(
      "SELECT id, reason FROM punishments WHERE roster_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(entry.id);

    if (activePun) {
      db.prepare(
        `UPDATE punishments 
         SET status = 'removed', 
             removed_at = datetime('now', 'localtime'), 
             remove_reason = ?, 
             removed_by = ? 
         WHERE id = ?`
      ).run(removeReason, removedBy, activePun.id);
    }

    const updatedEntry = db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id);
    syncMemberDiscordRoles(entry.user_id, updatedEntry);

    discordOnWarning(
      entry.user_id,
      entry.callsign,
      'Выговор снят',
      `**Причина снятия:** ${removeReason}\n**Снял:** ${removedBy}\n**За что выносился:** ${activePun ? activePun.reason : '—'}`
    );

    res.json({ roster: updatedEntry });
  })
);

router.post(
  '/:id/vacation',
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

router.post(
  '/:id/end-vacation',
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

router.post(
  '/:id/demote',
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

router.post(
  '/:id/recert',
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

router.post(
  '/:id/recert-clear',
  requireAuth,
  requireManager,
  api((req, res) => {
    const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(req.params.id);
    if (!entry) return fail(res, 404, 'Запись не найдена');
    db.prepare('UPDATE roster SET recert = 0 WHERE id = ?').run(entry.id);
    res.json({ roster: db.prepare('SELECT * FROM roster WHERE id = ?').get(entry.id) });
  })
);

module.exports = router;
