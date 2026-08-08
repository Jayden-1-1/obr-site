const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'mail-config.json');

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {}
  if (process.env.MAIL_CONFIG) {
    try {
      cfg = { ...cfg, ...JSON.parse(process.env.MAIL_CONFIG) };
    } catch (_) {}
  }
  return {
    provider: (cfg.provider || (cfg.apiKey ? 'brevo' : 'smtp')).toLowerCase(),
    apiKey: (cfg.apiKey || '').trim(),
    host: cfg.host || 'smtp.gmail.com',
    port: cfg.port || 465,
    secure: cfg.secure !== false,
    user: (cfg.user || '').trim(),
    pass: (cfg.pass || '').trim(),
    from: (cfg.from || '').trim(),
    fromName: (cfg.fromName || 'О.Б.Р — сайт').trim(),
  };
}

function isConfigured() {
  const cfg = loadConfig();
  if (cfg.provider === 'brevo') return !!cfg.apiKey;
  return !!(cfg && cfg.user && cfg.pass);
}

const MESSAGES = {
  register: {
    subject: 'О.Б.Р — код подтверждения регистрации',
    text: (code) =>
      `Ваш код подтверждения регистрации на сайте О.Б.Р:\n\n${code}\n\nКод действителен 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.`,
    title: 'Введите этот код на сайте, чтобы завершить регистрацию:',
  },
  transfer: {
    subject: 'О.Б.Р — подтверждение передачи прав',
    text: (code) =>
      `Код подтверждения передачи прав командира на сайте О.Б.Р:\n\n${code}\n\nКод действителен 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.`,
    title: 'Введите этот код на сайте, чтобы подтвердить передачу прав командира:',
  },
  reset: {
    subject: 'О.Б.Р — восстановление пароля',
    text: (code) =>
      `Код восстановления пароля на сайте О.Б.Р:\n\n${code}\n\nКод действителен 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.`,
    title: 'Введите этот код на сайте, чтобы восстановить пароль:',
  },
};

function emailHtml(code, msg) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#16161a;color:#f2f2f4;border:1px solid #2a2a32;border-radius:12px;padding:28px;text-align:center">
      <div style="font-size:12px;letter-spacing:4px;color:#a2a2ad;text-transform:uppercase">О.Б.Р — Отряд Быстрого Реагирования</div>
      <h2 style="margin:18px 0 6px;font-weight:700">Код подтверждения</h2>
      <p style="color:#a2a2ad;font-size:14px">${msg.title}</p>
      <div style="display:inline-block;margin:16px 0;padding:14px 30px;background:#0b0b0d;border:1px solid #2a2a32;border-radius:10px;font-size:30px;font-weight:800;letter-spacing:8px">${code}</div>
      <p style="color:#6b6b76;font-size:12px">Код действителен 10 минут.<br>Если вы не запрашивали код — просто проигнорируйте письмо.</p>
    </div>`;
}

async function sendViaBrevo(cfg, to, subject, html, text) {
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': cfg.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: cfg.fromName, email: cfg.from || cfg.user },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });
  const body = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`Brevo API ${resp.status}: ${body.slice(0, 300)}`);
  }
}

async function sendCode(to, code, purpose = 'register') {
  const msg = MESSAGES[purpose] || MESSAGES.register;
  const cfg = loadConfig();

  if (cfg.provider === 'brevo') {
    if (!cfg.apiKey) {
      console.log(`[ПОЧТА НЕ НАСТРОЕНА] Код для ${to}: ${code} (${purpose})`);
      return { dev: true, code };
    }
    await sendViaBrevo(cfg, to, msg.subject, emailHtml(code, msg), msg.text(code));
    return { dev: false };
  }

  if (!cfg || !cfg.user || !cfg.pass) {
    console.log(`[ПОЧТА НЕ НАСТРОЕНА] Код для ${to}: ${code} (${purpose})`);
    return { dev: true, code };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  await transporter.sendMail({
    from: cfg.from || cfg.user,
    to,
    subject: msg.subject,
    text: msg.text(code),
    html: emailHtml(code, msg),
  });

  return { dev: false };
}

module.exports = { sendCode, isConfigured };
