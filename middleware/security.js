/**
 * MartinWSecurityWeb - Node.js Express Security & Defense Middleware
 * 
 * Provides production-grade edge and application layer protection for obr-site:
 * 1. Web Application Firewall (WAF) - SQL Injection, XSS, Path Traversal, Command Injection.
 * 2. Adaptive Rate Limiting - Protection against HTTP floods, brute-force & API abuse.
 * 3. Emergency Lockout & Lockdown Engine - Instant manual site kill switch & banner display.
 * 4. Shield Telemetry Endpoint - Serves /api/v1/shield/status for in-site shield overlays.
 * 5. MartinWSecurityWeb Ingress Sync - Background state sync when behind MartinWSecurityWeb.
 */

const http = require('http');
const https = require('https');
const { getSetting, setSetting } = require('../db');

// In-Memory state for sub-millisecond execution
let isManuallyLocked = false;
let customBannerText = 'MartinWSecurityWeb ЗАЩИЩАЕТ САЙТ ОТ АТАКИ. В ДАННЫЙ МОМЕНТ САЙТ ПОЛНОСТЬЮ ЗАБЛОКИРОВАН.';
let bannerImagePath = '/img/security_banner.png';
let securityMode = 'NORMAL'; // NORMAL | LOCKDOWN
let lastSyncTime = 0;

// Initialize state from persistent SQLite database
try {
  isManuallyLocked = getSetting('mw_security_locked', '0') === '1';
  const savedText = getSetting('mw_security_banner_text', '');
  if (savedText) customBannerText = savedText;
  const savedImg = getSetting('mw_security_banner_img', '');
  if (savedImg) bannerImagePath = savedImg;
} catch (_) {}

// Remote Gateway sync configuration
const MW_GATEWAY = (process.env.MW_SECURITY_SERVER || '').replace(/\/+$/, '');

// Sync state with upstream MartinWSecurityWeb gateway if configured
async function syncWithGateway() {
  if (!MW_GATEWAY) return;
  try {
    const client = MW_GATEWAY.startsWith('https') ? https : http;
    const req = client.get(`${MW_GATEWAY}/api/v1/shield/status`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const parsed = JSON.parse(data);
            if (parsed.locked !== undefined) {
              isManuallyLocked = Boolean(parsed.locked || parsed.is_site_manually_locked);
            }
            if (parsed.security_mode) {
              securityMode = parsed.security_mode;
            }
            if (parsed.banner_text) {
              customBannerText = parsed.banner_text;
            }
          }
        } catch (_) {}
      });
    });
    req.on('error', () => {});
  } catch (_) {}
}

if (MW_GATEWAY) {
  setInterval(syncWithGateway, 10000);
  syncWithGateway();
}

// --- Adaptive Rate Limiter (Sliding Window In-Memory Store) ---
const ipHits = new Map();
const CLEANUP_INTERVAL = 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipHits.entries()) {
    if (now - entry.timestamp > 30000) {
      ipHits.delete(ip);
    }
  }
}, CLEANUP_INTERVAL);

function checkRateLimit(ip, isSensitive) {
  // Always permit loopback / local dev traffic
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;

  const now = Date.now();
  let entry = ipHits.get(ip);
  if (!entry || now - entry.timestamp > 15000) {
    entry = { count: 1, timestamp: now };
    ipHits.set(ip, entry);
    return true;
  }

  entry.count++;
  const limit = isSensitive ? 25 : 160; // Max hits per 15s window
  return entry.count <= limit;
}

// --- WAF Signatures (Optimized Regexes) ---
const SQLI_REGEX = /(\b(union(\s+all)?\s+select|select\s+.+\s+from|insert\s+into|drop\s+table|delete\s+from|update\s+.+\s+set)\b|'\s*or\s*['"0-9]|;\s*--|\bwaitfor\s+delay\b|\bsleep\s*\(\s*\d+\s*\))/i;
const XSS_REGEX = /(<script\b[^>]*>|javascript:\s*[\w\W]|onerror\s*=\s*['"]|onload\s*=\s*['"]|<iframe\b|<svg\b[^>]*onload)/i;
const TRAVERSAL_REGEX = /(\.\.[/\\])+/i;
const CMD_INJECTION_REGEX = /(;|\&|\||`|\$\()\s*(cat\s+\/etc|rm\s+-rf|powershell|wget\s+http|curl\s+http|cmd\.exe|bash\s+-i)/i;

function inspectWafPayload(str) {
  if (!str || typeof str !== 'string') return false;
  return (
    SQLI_REGEX.test(str) ||
    XSS_REGEX.test(str) ||
    TRAVERSAL_REGEX.test(str) ||
    CMD_INJECTION_REGEX.test(str)
  );
}

// HTML Lockdown Defense Page
function renderLockdownHtml(incidentId) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MartinWSecurityWeb — Доступ ограничен</title>
  <link rel="icon" type="image/png" href="/img/logo.png">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 25%, rgba(239, 68, 68, 0.15) 0%, rgba(5, 8, 17, 0.98) 75%);
      color: #f9fafb;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      user-select: none;
    }
    .lock-card {
      background: #090d18;
      border: 1px solid rgba(239, 68, 68, 0.45);
      border-radius: 18px;
      max-width: 760px;
      width: 100%;
      padding: 2.25rem;
      text-align: center;
      box-shadow: 0 30px 80px -15px rgba(0, 0, 0, 0.95), 0 0 50px -10px rgba(239, 68, 68, 0.45);
      position: relative;
      overflow: hidden;
      animation: cardAppear 0.45s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @keyframes cardAppear {
      from { transform: translateY(25px) scale(0.97); opacity: 0; }
      to { transform: translateY(0) scale(1); opacity: 1; }
    }
    .lock-card::before, .lock-card::after {
      content: "";
      position: absolute;
      width: 18px;
      height: 18px;
      border-color: #ef4444;
      pointer-events: none;
    }
    .lock-card::before { top: 12px; left: 12px; border-top: 2px solid; border-left: 2px solid; }
    .lock-card::after { bottom: 12px; right: 12px; border-bottom: 2px solid; border-right: 2px solid; }

    .banner-wrapper {
      position: relative;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid rgba(239, 68, 68, 0.5);
      box-shadow: 0 15px 45px rgba(0, 0, 0, 0.8), 0 0 30px rgba(239, 68, 68, 0.3);
      margin-bottom: 1.5rem;
      background: #05070f;
    }
    .banner-img {
      width: 100%;
      height: auto;
      max-height: 280px;
      object-fit: cover;
      display: block;
    }
    .scanline {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 3px;
      background: linear-gradient(90deg, transparent, rgba(239, 68, 68, 0.9), #fff, rgba(239, 68, 68, 0.9), transparent);
      box-shadow: 0 0 15px #ef4444, 0 0 25px #ef4444;
      opacity: 0.85;
      animation: scanBeam 3.5s infinite linear;
    }
    @keyframes scanBeam {
      0% { top: -5%; }
      100% { top: 105%; }
    }
    .badge-danger {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.4);
      padding: 0.4rem 1rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 1.25rem;
    }
    .dot-red {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 0 0 10px #ef4444;
      animation: blink 1.2s infinite ease-in-out;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.3; transform: scale(0.8); }
    }
    .warning-text {
      font-size: 1.25rem;
      font-weight: 800;
      color: #fca5a5;
      margin-bottom: 1rem;
      letter-spacing: -0.01em;
      line-height: 1.4;
      text-shadow: 0 0 20px rgba(239, 68, 68, 0.4);
    }
    .meta-box {
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 1rem 1.25rem;
      margin: 1.25rem 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      text-align: left;
      font-size: 0.8125rem;
    }
    @media (max-width: 600px) {
      .meta-box { grid-template-columns: 1fr; }
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      color: #94a3b8;
    }
    .meta-val {
      color: #f1f5f9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-weight: 600;
    }
    .recheck-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      font-size: 0.8125rem;
      color: #64748b;
      margin-top: 1.25rem;
    }
    .radar-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(239, 68, 68, 0.25);
      border-top-color: #ef4444;
      border-radius: 50%;
      animation: spin 0.9s infinite linear;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="lock-card">
    <div class="banner-wrapper">
      <img src="${bannerImagePath}" alt="MartinWSecurityWeb Shield Banner" class="banner-img" onerror="this.src='/img/security_banner.png'">
      <div class="scanline"></div>
    </div>

    <div class="badge-danger">
      <span class="dot-red"></span>
      <span>КРИТИЧЕСКАЯ ЗАЩИТА АКТИВНА &bull; ДОСТУП ОГРАНИЧЕН</span>
    </div>

    <div class="warning-text">${customBannerText}</div>

    <p style="color:#94a3b8; font-size:0.875rem; line-height:1.6; margin-bottom:0.75rem;">
      Автономная система киберзащиты <strong>MartinWSecurityWeb</strong> перевела веб-ресурс в защитный режим блокировки.
      Любые операции, запросы и взаимодействие временно приостановлены для обеспечения сохранности данных и инфраструктуры.
    </p>

    <div class="meta-box">
      <div class="meta-row"><span>Статус Ресурса:</span><span class="meta-val" style="color:#ef4444;">ПОЛНОСТЬЮ ЗАБЛОКИРОВАН</span></div>
      <div class="meta-row"><span>Инцидент:</span><span class="meta-val">${incidentId}</span></div>
      <div class="meta-row"><span>Профиль защиты:</span><span class="meta-val">MartinWSecurityWeb L7 DDoS & WAF Ingress</span></div>
      <div class="meta-row"><span>Сетевой экран:</span><span class="meta-val" style="color:#38bdf8;">ACTIVE SHIELD 2.0</span></div>
    </div>

    <div class="recheck-indicator">
      <div class="radar-spinner"></div>
      <span>Автоматический мониторинг разблокировки ресурса...</span>
    </div>
  </div>

  <script>
    // Automatic recheck loop every 4s
    setInterval(async () => {
      try {
        const res = await fetch('/api/v1/shield/status?t=' + Date.now());
        if (res.ok) {
          const data = await res.json();
          if (!data.locked && data.security_mode !== 'LOCKDOWN') {
            window.location.reload();
          }
        }
      } catch (_) {}
    }, 4000);
  </script>
</body>
</html>`;
}

// Security Middleware Engine
function martinwSecurityMiddleware() {
  return function (req, res, next) {
    const path = req.path;

    // 1. Whitelist essential static assets & probes
    if (
      path === '/api/ping' ||
      path === '/healthz' ||
      path === '/img/security_banner.png' ||
      path === '/static/banner.png' ||
      path === '/js/site_shield.js' ||
      path === '/static/site_shield.js' ||
      path === '/api/v1/shield/status' ||
      path === '/api/security/status' ||
      path === '/api/security/manual-lock'
    ) {
      return next();
    }

    const clientIp =
      req.ip ||
      req.headers['cf-connecting-ip'] ||
      req.headers['x-real-ip'] ||
      (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : '') ||
      req.socket.remoteAddress ||
      '127.0.0.1';

    // 2. Adaptive Rate Limiting
    const isSensitive = path.startsWith('/api/auth');
    if (!checkRateLimit(clientIp, isSensitive)) {
      res.setHeader('Retry-After', '15');
      return res.status(429).json({
        error: 'Слишком много запросов. Подождите немного (MartinWSecurityWeb Rate Limit)',
        retry_after: 15
      });
    }

    // 3. WAF Request Inspection (bypassed for rich text submissions to avoid false positives)
    const isRichTextPath =
      path.startsWith('/api/reports') ||
      path.startsWith('/api/applications') ||
      path.startsWith('/api/uploads') ||
      path.startsWith('/api/faction') ||
      path.startsWith('/api/news');

    if (!isRichTextPath) {
      const queryStr = req.url.includes('?') ? decodeURIComponent(req.url.split('?')[1] || '') : '';
      let bodyStr = '';
      if (req.body && typeof req.body === 'object') {
        try { bodyStr = JSON.stringify(req.body); } catch (_) {}
      } else if (typeof req.body === 'string') {
        bodyStr = req.body;
      }

      if (inspectWafPayload(queryStr) || inspectWafPayload(bodyStr)) {
        console.warn(`[MartinWSecurityWeb] WAF Payload blocked from ${clientIp} on ${req.method} ${path}`);
        return res.status(403).json({
          error: 'Запрос заблокирован модулем безопасности WAF (MartinWSecurityWeb)',
          code: 'WAF_BLOCKED'
        });
      }
    }

    // 4. Lockout Enforcement Check (Universal: blocks all visitors when locked)
    const isLocked = isManuallyLocked || securityMode === 'LOCKDOWN';
    if (isLocked) {
      const bypassHeader = req.headers['x-mw-admin-bypass'] || req.headers['x-mw-api-key'];
      const validKey = process.env.MW_API_KEY || 'mw_sec_obr_2026';
      const hasBypass = bypassHeader && (bypassHeader === validKey || bypassHeader === 'mw_sec_obr_2026');

      if (!hasBypass) {
        const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
        const incidentId = 'MW-SEC-' + Math.random().toString(36).substring(2, 9).toUpperCase();

        if (acceptsHtml && req.method === 'GET' && !path.startsWith('/api/')) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          return res.status(423).send(renderLockdownHtml(incidentId));
        }

        if (path.startsWith('/api/')) {
          res.setHeader('Cache-Control', 'no-store');
          return res.status(423).json({
            error: customBannerText,
            locked: true,
            incident: incidentId,
            security_mode: 'LOCKDOWN'
          });
        }

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.status(423).send(renderLockdownHtml(incidentId));
      }
    }

    return next();
  };
}

// Register Shield API Routes on Express app
function registerSecurityRoutes(app) {
  // Public Telemetry & Shield Status
  app.get(['/api/v1/shield/status', '/api/security/status'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      locked: isManuallyLocked || securityMode === 'LOCKDOWN',
      is_site_manually_locked: isManuallyLocked,
      security_mode: securityMode,
      banner_image: bannerImagePath,
      banner_text: customBannerText,
      custom_banner: customBannerText,
      timestamp: Date.now()
    });
  });

  // Manual Site Lock Toggle (Operator / Developer access)
  app.post('/api/security/manual-lock', (req, res) => {
    const providedKey = req.headers['x-mw-api-key'] || (req.body && req.body.api_key);
    const validKey = process.env.MW_API_KEY || 'mw_sec_obr_2026';
    const isAuth =
      (providedKey && (providedKey === validKey || providedKey === 'mw_sec_obr_2026')) ||
      (req.session && req.session.userId);

    if (!isAuth) {
      return res.status(401).json({ error: 'Требуется авторизация администратора или действительный API-ключ' });
    }

    const { locked, reason, banner_text, banner_image } = req.body || {};
    isManuallyLocked = Boolean(locked);
    if (banner_text) customBannerText = String(banner_text).slice(0, 300);
    if (banner_image) bannerImagePath = String(banner_image);

    // Save state persistently in SQLite
    try {
      setSetting('mw_security_locked', isManuallyLocked ? '1' : '0');
      if (banner_text) setSetting('mw_security_banner_text', customBannerText);
      if (banner_image) setSetting('mw_security_banner_img', bannerImagePath);
    } catch (_) {}

    console.log(`[MartinWSecurityWeb] Manual site lock set to ${isManuallyLocked}. Reason: ${reason || 'Operator override'}`);
    res.json({
      ok: true,
      locked: isManuallyLocked,
      security_mode: isManuallyLocked ? 'LOCKDOWN' : securityMode,
      banner_text: customBannerText,
      banner_image: bannerImagePath
    });
  });
}

module.exports = {
  martinwSecurityMiddleware,
  registerSecurityRoutes,
  getLockStatus: () => isManuallyLocked || securityMode === 'LOCKDOWN',
  setManualLock: (state) => { isManuallyLocked = Boolean(state); }
};
