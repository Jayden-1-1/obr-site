const express = require('express');
const compression = require('compression');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const {
  db,
  UPLOAD_DIR,
  ensureCommanderBootstrap,
} = require('./db');
const {
  api,
  fail,
  requireAuth,
  isStaff,
} = require('./middleware/auth');
const { upload } = require('./middleware/upload');
const {
  ensureCommanderInRoster,
  toISODate,
  todayISO,
  syncMemberDiscordRoles,
} = require('./services/rosterService');

// Routers
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const sessionsRoutes = require('./routes/sessions');
const rosterRoutes = require('./routes/roster');
const reportsRoutes = require('./routes/reports');
const applicationsRoutes = require('./routes/applications');
const punishmentsRoutes = require('./routes/punishments');
const documentsRoutes = require('./routes/documents');
const discordRoutes = require('./routes/discord');
const settingsRoutes = require('./routes/settings');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// HTTP Gzip/Deflate compression for fast cross-border transfer
app.use(compression());

// Security & Parsing
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// Lightweight Health / Keep-Alive Ping
app.get('/api/ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, uptime: Math.floor(process.uptime()), timestamp: Date.now() });
});

// Static Assets with Cache-Control headers for rapid repeat loads
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (/\.(jpg|jpeg|png|webp|svg|ico|woff2?|ttf|mp3|ogg)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      } else if (/\.(css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (/\.html$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  })
);

// Multi-file upload for reports and applications
app.post(
  '/api/uploads',
  requireAuth,
  upload.array('photos', 15),
  api((req, res) => {
    const activeMember = db
      .prepare('SELECT id FROM roster WHERE user_id = ? AND status = ?')
      .get(req.user.id, 'active');
    if (!isStaff(req.user) && !activeMember) {
      return fail(res, 403, 'Загрузка файлов доступна сотрудникам фракции');
    }
    if (!req.files || !req.files.length) return fail(res, 400, 'Прикрепите файлы');
    const files = req.files.map((f) => ({
      filename: f.originalname,
      stored_name: f.filename,
    }));
    res.json({ files });
  })
);

// Mount API Routers
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/roster', rosterRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/applications', applicationsRoutes);
app.use('/api/punishments', punishmentsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/discord', discordRoutes);
app.use('/api', settingsRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return fail(
      res,
      400,
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Файл слишком большой (максимум 25 МБ)'
        : 'Ошибка загрузки файла'
    );
  }
  if (err && err.type === 'entity.too.large') {
    return fail(res, 400, 'Слишком большой объём данных');
  }
  console.error('[UNHANDLED ERROR]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Bootstrapping
ensureCommanderBootstrap();
ensureCommanderInRoster();

// Maintenance: clean expired vacations on startup
try {
  const now = todayISO();
  const expiredVacations = db
    .prepare("SELECT id, user_id FROM roster WHERE vacation_until != ''")
    .all()
    .filter((r) => {
      const iso = toISODate(r.vacation_until);
      return iso && iso < now;
    });
  for (const e of expiredVacations) {
    db.prepare("UPDATE roster SET vacation_until = '', vacation_reason = '' WHERE id = ?").run(e.id);
    const row = db.prepare('SELECT * FROM roster WHERE id = ?').get(e.id);
    if (row) syncMemberDiscordRoles(e.user_id, row);
  }
  if (expiredVacations.length) {
    console.log(`[VACATION] Истёкшие отпуска очищены: ${expiredVacations.length}`);
  }
} catch (e) {
  console.error('[VACATION] Ошибка очистки истёкших отпусков:', e);
}

// Start Server
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`О.Б.Р — сайт запущен: http://localhost:${PORT}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !process.env.PORT) {
      const fallbackPort = 3001;
      console.warn(`[SERVER] Порт ${PORT} занят. Переключаемся на резервный порт ${fallbackPort}...`);
      app.listen(fallbackPort, () => {
        console.log(`О.Б.Р — сайт запущен: http://localhost:${fallbackPort}`);
      });
    } else {
      console.error('[SERVER] Ошибка запуска сервера:', err);
    }
  });
}

// Keep-alive heartbeat for Render free tier (prevents cold-start 50s idle spin-down)
const RENDER_EXTERNAL_URL =
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER || process.env.NODE_ENV === 'production' ? 'https://obr-site.onrender.com' : null);

if (RENDER_EXTERNAL_URL) {
  const https = require('https');
  const PING_INTERVAL_MS = 12 * 60 * 1000; // 12 minutes (Render idle sleep threshold is 15 minutes)
  setInterval(() => {
    try {
      const pingUrl = `${RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/api/ping`;
      https.get(pingUrl, (res) => {
        res.resume();
      }).on('error', (err) => {
        console.warn('[KEEP-ALIVE] Ping error:', err.message);
      });
    } catch (e) {
      console.warn('[KEEP-ALIVE] Interval error:', e.message);
    }
  }, PING_INTERVAL_MS);
  console.log(`[KEEP-ALIVE] Heartbeat initialized for ${RENDER_EXTERNAL_URL} (every 12m)`);
}

module.exports = app;
