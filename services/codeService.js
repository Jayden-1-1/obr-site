const { db } = require('../db');
const { sendCode, isConfigured } = require('../mailer');
const discord = require('../discord');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const SECURITY_QUESTIONS = [
  'Как звали вашего первого учителя?',
  'Как звали вашего первого животного?',
  'Как звали вашего лучшего друга в детстве?',
  'В каком городе вы родились?',
  'Как называется ваша любимая книга?',
  'Название вашей первой школы?',
];

function normalizeAnswer(s) {
  return String(s || '').trim().toLowerCase();
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendEmailCode(email, purpose = 'register', opts = {}) {
  try {
    db.prepare("DELETE FROM verify_codes WHERE expires_at < datetime('now', 'localtime') OR used = 1").run();
  } catch (_) {}

  const last = db
    .prepare("SELECT created_at FROM verify_codes WHERE email = ? ORDER BY id DESC LIMIT 1")
    .get(email);
  if (last) {
    const diff = (Date.now() - new Date(last.created_at.replace(' ', 'T')).getTime()) / 1000;
    if (diff < 60) return { error: `Код уже отправлен. Подождите ${Math.ceil(60 - diff)} секунд` };
  }
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const sent = db
    .prepare("SELECT COUNT(*) c FROM verify_codes WHERE email = ? AND created_at > ?")
    .get(email, hourAgo).c;
  if (sent >= 5) return { error: 'Слишком много попыток. Попробуйте через час' };

  const code = generateCode();
  const purposeLabel = { register: 'регистрации', reset: 'восстановления пароля', transfer: 'передачи прав' }[purpose] || purpose;
  let delivered = false;
  let dev = false;
  const channels = [];

  if (opts.discordId) {
    const dm = await discord.sendDM(
      opts.discordId,
      `🔐 О.Б.Р — код подтверждения ${purposeLabel}: **${code}**\nКод действителен 10 минут.`
    );
    if (dm.ok) {
      delivered = true;
      channels.push('discord');
    }
  }

  if (delivered) {
    dev = false;
  } else if (isConfigured()) {
    const result = await sendCode(email, code, purpose).catch((err) => {
      console.error('[MAIL] Ошибка отправки письма:', err && err.message ? err.message : err);
      return { error: 'Не удалось отправить письмо. Проверьте настройки почты', status: 500 };
    });
    if (result && result.dev) {
      dev = true;
    } else if (result && result.error) {
      console.error(`[MAIL] Код для ${email} не отправлен (${result.error}), показываю код в консоли: ${code}`);
      dev = true;
    } else {
      delivered = true;
      channels.push('email');
    }
  } else {
    dev = true;
    console.log(`[ПОЧТА НЕ НАСТРОЕНА] Код для ${email}: ${code} (${purpose})`);
  }

  if (!delivered && !dev) {
    return { error: 'Не удалось доставить код: почта недоступна и Discord не настроен', status: 500 };
  }

  db.prepare(
    "INSERT INTO verify_codes (email, code, expires_at) VALUES (?, ?, datetime('now', 'localtime', '+10 minutes'))"
  ).run(email, code);
  if (dev && !delivered) return { dev: true, code, channels };
  return { ok: true, channels };
}

function consumeCode(email, code) {
  const row = db
    .prepare("SELECT * FROM verify_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1")
    .get(email);
  if (!row) return { error: 'Сначала получите код на почту' };
  if (row.code !== code) {
    const attempts = (row.attempts || 0) + 1;
    db.prepare('UPDATE verify_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
    if (attempts >= 5) db.prepare('UPDATE verify_codes SET used = 1 WHERE id = ?').run(row.id);
    return { error: 'Неверный код' };
  }
  if (new Date(row.expires_at.replace(' ', 'T')).getTime() < Date.now()) {
    return { error: 'Код истёк. Запросите новый' };
  }
  db.prepare('UPDATE verify_codes SET used = 1 WHERE id = ?').run(row.id);
  return { ok: true };
}

module.exports = {
  EMAIL_RE,
  SECURITY_QUESTIONS,
  normalizeAnswer,
  generateCode,
  sendEmailCode,
  consumeCode,
};
