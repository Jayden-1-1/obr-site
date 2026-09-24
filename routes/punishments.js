const express = require('express');
const { db } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireStaff,
  requireManager,
} = require('../middleware/auth');
const { discordOnWarning } = require('../services/rosterService');

const router = express.Router();

router.get(
  '/',
  requireAuth,
  requireStaff,
  api((req, res) => {
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

module.exports = router;
