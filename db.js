const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const SEED_DIR = path.join(__dirname, 'data-seed');
if (!fs.existsSync(path.join(DATA_DIR, 'obr.db')) && fs.existsSync(path.join(SEED_DIR, 'obr.db'))) {
  try {
    fs.cpSync(SEED_DIR, DATA_DIR, { recursive: true });
    console.log('[SEED] Начальные данные применены');
  } catch (e) {
    console.error('[SEED] Не удалось применить начальные данные:', e);
  }
}

const db = new DatabaseSync(path.join(DATA_DIR, 'obr.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email         TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS verify_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  device     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS roster (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_number TEXT NOT NULL UNIQUE,
  callsign        TEXT NOT NULL,
  rank            TEXT NOT NULL,
  position        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  user_id         INTEGER,
  age             TEXT NOT NULL DEFAULT '',
  discord         TEXT NOT NULL DEFAULT '',
  warnings        INTEGER NOT NULL DEFAULT 0,
  recert          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  filename    TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  access      TEXT NOT NULL DEFAULT 'dsp',
  uploaded_by INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  user_id     INTEGER,
  text        TEXT NOT NULL DEFAULT '',
  callsign    TEXT NOT NULL DEFAULT '',
  age         TEXT NOT NULL DEFAULT '',
  discord     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  roster_id   INTEGER,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  type        TEXT NOT NULL,
  theme       TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL DEFAULT '',
  signature   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS report_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS application_photos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  filename       TEXT NOT NULL,
  stored_name    TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS punishments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  roster_id  INTEGER,
  callsign   TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL DEFAULT '',
  until_date TEXT NOT NULL DEFAULT '',
  issued_by  TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active',
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

function ensureColumn(table, column, type = 'TEXT', def = '') {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} NOT NULL DEFAULT ${JSON.stringify(def)}`);
  }
}

ensureColumn('roster', 'age', 'TEXT', '');
ensureColumn('roster', 'discord', 'TEXT', '');
ensureColumn('roster', 'warnings', 'INTEGER', 0);
ensureColumn('roster', 'recert', 'INTEGER', 0);
ensureColumn('roster', 'builder', 'INTEGER', 0);
ensureColumn('roster', 'vacation_until', 'TEXT', '');
ensureColumn('roster', 'vacation_reason', 'TEXT', '');
ensureColumn('reports', 'v_from', 'TEXT', '');
ensureColumn('reports', 'v_to', 'TEXT', '');
ensureColumn('applications', 'callsign', 'TEXT', '');
ensureColumn('applications', 'age', 'TEXT', '');
ensureColumn('applications', 'discord', 'TEXT', '');
ensureColumn('applications', 'builder_reason', 'TEXT', '');
ensureColumn('applications', 'builder_skill', 'TEXT', '');
ensureColumn('applications', 'builder_builds', 'TEXT', '');
ensureColumn('users', 'email', 'TEXT', '');
ensureColumn('users', 'avatar', 'TEXT', '');
ensureColumn('users', 'about', 'TEXT', '');
ensureColumn('users', 'security_question', 'TEXT', '');
ensureColumn('users', 'security_answer', 'TEXT', '');
ensureColumn('users', 'discord_id', 'TEXT', '');
ensureColumn('users', 'discord_username', 'TEXT', '');

try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username))');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id)');
} catch (e) {
  console.error('[DB] Не удалось создать индексы пользователей:', e.message);
}

const RANKS = [
  'Стажер',
  'Мл. лейтенант',
  'Лейтенант',
  'Ст. лейтенант',
  'Капитан',
  'Майор',
  'Подполковник',
  'Полковник',
];

const POSITIONS = [
  'Сотрудник О.Б.Р',
  'Боец О.Б.Р',
  'Зам. Командира',
  'Командир О.Б.Р',
];

const ROLE_LEVELS = { user: 0, staff: 1, zam: 2, commander: 3 };

function isStaff(user) {
  return !!user && ROLE_LEVELS[user.role] >= 1;
}

function isManager(user) {
  return !!user && ROLE_LEVELS[user.role] >= 2;
}

function isCommander(user) {
  return !!user && user.role === 'commander';
}

function posToRole(position) {
  if (position === 'Командир О.Б.Р') return 'commander';
  if (position === 'Зам. Командира') return 'zam';
  return 'staff';
}

function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function ensureCommanderBootstrap() {
  const any = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (any.c === 0) return;
  const commander = db
    .prepare("SELECT id FROM users WHERE role = 'commander' LIMIT 1")
    .get();
  if (!commander) {
    const first = db
      .prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1')
      .get();
    db.prepare("UPDATE users SET role = 'commander' WHERE id = ?").run(first.id);
    console.log(`[bootstrap] Первый зарегистрированный пользователь назначен командиром (id=${first.id}).`);
  }
}

module.exports = {
  db,
  DATA_DIR,
  UPLOAD_DIR,
  RANKS,
  POSITIONS,
  ROLE_LEVELS,
  isStaff,
  isManager,
  isCommander,
  posToRole,
  getSetting,
  setSetting,
  ensureCommanderBootstrap,
};
