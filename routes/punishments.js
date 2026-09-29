const express = require('express');
const { db } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireStaff,
  requireManager,
} = require('../middleware/auth');
const {
  discordOnWarning,
  cleanExpiredPunishments,
  syncMemberDiscordRoles,
} = require('../services/rosterService');

const router = express.Router();

router.get(
  '/',
  requireAuth,
  requireStaff,
  api((req, res) => {
    cleanExpiredPunishments();
    const punishments = db
      .prepare('SELECT * FROM punishments ORDER BY id DESC')
      .all();
    res.json({ punishments });
  })
);

router.post(
  '/:id/remove',
  requireAuth,
  requireManager,
  api((req, res) => {
    const p = db.prepare('SELECT * FROM punishments WHERE id = ?').get(req.params.id);
    if (!p) return fail(res, 404, 'Наказание не найдено');

    if (p.status !== 'removed') {
      const removeReason = String(req.body.reason || '').trim() || 'По решению руководства';
      const removedBy = req.user.callsign || req.user.username || 'Руководство';

      db.prepare(
        `UPDATE punishments 
         SET status = 'removed', 
             removed_at = datetime('now', 'localtime'), 
             remove_reason = ?, 
             removed_by = ? 
         WHERE id = ?`
      ).run(removeReason, removedBy, p.id);

      db.prepare('UPDATE roster SET warnings = MAX(warnings - 1, 0) WHERE id = ?').run(p.roster_id);
      const entry = db.prepare('SELECT * FROM roster WHERE id = ?').get(p.roster_id);
      if (entry) syncMemberDiscordRoles(entry.user_id, entry);

      discordOnWarning(
        entry ? entry.user_id : null,
        p.callsign,
        'Выговор снят',
        `**Причина снятия:** ${removeReason}\n**Снял:** ${removedBy}\n**За что выносился:** ${p.reason || '—'}`
      );
    }
    res.json({ punishment: db.prepare('SELECT * FROM punishments WHERE id = ?').get(p.id) });
  })
);

module.exports = router;
