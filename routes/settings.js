const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const {
  api,
  fail,
  requireAuth,
  requireCommander,
} = require('../middleware/auth');

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

module.exports = router;
