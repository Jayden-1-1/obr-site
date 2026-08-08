const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'turnstile-config.json');

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {}
  if (process.env.TURNSTILE_CONFIG) {
    try {
      cfg = { ...cfg, ...JSON.parse(process.env.TURNSTILE_CONFIG) };
    } catch (_) {}
  }
  return {
    sitekey: (cfg.sitekey || '').trim(),
    secret: (cfg.secret || '').trim(),
  };
}

function isConfigured() {
  const cfg = loadConfig();
  return !!(cfg.sitekey && cfg.secret);
}

async function verify(token) {
  const cfg = loadConfig();
  if (!cfg.secret) {
    return { ok: true, dev: true };
  }
  if (!token) {
    return { ok: false, error: 'Пройдите капчу' };
  }
  const form = new URLSearchParams();
  form.set('secret', cfg.secret);
  form.set('response', token);
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const data = await resp.json();
  if (!data.success) {
    return { ok: false, error: 'Капча не пройдена, попробуйте ещё раз' };
  }
  return { ok: true };
}

module.exports = { loadConfig, isConfigured, verify };
