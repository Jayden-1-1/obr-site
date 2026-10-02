/**
 * MartinWSecurityWeb — In-Site Shield & Lockout Overlay Engine
 * Version: 2.0.0
 * 
 * Provides an impenetrable, tamper-resistant in-site full-viewport defense shield.
 * When the website is locked manually (Kill Switch) or placed under LOCKDOWN:
 *   1. Completely intercepts and disables all website interactivity (clicks, scroll, keyboard, touch, devtools).
 *   2. Freezes underlying DOM with deep frosted-glass blur (backdrop-filter: blur(20px)).
 *   3. Displays the official MartinWSecurityWeb defense banner with glowing cyber animations.
 *   4. Employs MutationObserver and event trapping to prevent client-side bypass or inspection.
 *   5. Real-time background sync automatically restores full site access once unlocked.
 */

(function () {
  "use strict";

  if (window.__MW_SECURITY_SHIELD_INITIALIZED__) return;
  window.__MW_SECURITY_SHIELD_INITIALIZED__ = true;

  // Determine MartinWSecurityWeb API Gateway Base URL
  const scriptTag = document.currentScript || document.querySelector('script[src*="site_shield.js"]');
  let serverUrl = "";
  if (scriptTag && scriptTag.getAttribute("data-mw-server")) {
    serverUrl = scriptTag.getAttribute("data-mw-server").replace(/\/+$/, "");
  } else if (window.MW_SECURITY_SERVER) {
    serverUrl = String(window.MW_SECURITY_SERVER).replace(/\/+$/, "");
  } else {
    serverUrl = window.location.origin;
  }

  const POLL_INTERVAL_MS = 5000;
  let isCurrentlyLocked = false;
  let overlayElement = null;
  let observer = null;
  let pollTimer = null;
  let bannerImageUrl = serverUrl + "/img/security_banner.png";
  let customBannerText = "MartinWSecurityWeb ЗАЩИЩАЕТ САЙТ ОТ АТАКИ. В ДАННЫЙ МОМЕНТ САЙТ ПОЛНОСТЬЮ ЗАБЛОКИРОВАН.";
  let lastIncidentId = "MW-SEC-" + Math.random().toString(36).substring(2, 10).toUpperCase();

  // Inject CSS Styles for the Cyber Defense Overlay
  function injectStyles() {
    if (document.getElementById("mw-shield-styles")) return;
    const style = document.createElement("style");
    style.id = "mw-shield-styles";
    style.textContent = `
      #mw-security-site-overlay {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        z-index: 2147483647 !important;
        background: radial-gradient(circle at 50% 25%, rgba(239, 68, 68, 0.15) 0%, rgba(5, 8, 17, 0.97) 70%) !important;
        backdrop-filter: blur(20px) saturate(160%) !important;
        -webkit-backdrop-filter: blur(20px) saturate(160%) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
        padding: 1.5rem !important;
        box-sizing: border-box !important;
        color: #f9fafb !important;
        pointer-events: all !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        opacity: 0;
        transition: opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1) !important;
      }
      #mw-security-site-overlay.mw-visible {
        opacity: 1 !important;
      }
      .mw-lock-card {
        background: #090d18 !important;
        border: 1px solid rgba(239, 68, 68, 0.45) !important;
        border-radius: 18px !important;
        max-width: 760px !important;
        width: 100% !important;
        padding: 2.25rem !important;
        text-align: center !important;
        box-shadow: 0 30px 80px -15px rgba(0, 0, 0, 0.95), 0 0 50px -10px rgba(239, 68, 68, 0.45) !important;
        position: relative !important;
        overflow: hidden !important;
        animation: mwCardAppear 0.45s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
      }
      @keyframes mwCardAppear {
        from { transform: translateY(25px) scale(0.97); opacity: 0; }
        to { transform: translateY(0) scale(1); opacity: 1; }
      }
      /* Tech Corner Accents */
      .mw-lock-card::before, .mw-lock-card::after {
        content: "" !important;
        position: absolute !important;
        width: 18px !important;
        height: 18px !important;
        border-color: #ef4444 !important;
        pointer-events: none !important;
      }
      .mw-lock-card::before { top: 12px !important; left: 12px !important; border-top: 2px solid; border-left: 2px solid; }
      .mw-lock-card::after { bottom: 12px !important; right: 12px !important; border-bottom: 2px solid; border-right: 2px solid; }

      .mw-banner-wrapper {
        position: relative !important;
        border-radius: 12px !important;
        overflow: hidden !important;
        border: 1px solid rgba(239, 68, 68, 0.5) !important;
        box-shadow: 0 15px 45px rgba(0, 0, 0, 0.8), 0 0 30px rgba(239, 68, 68, 0.3) !important;
        margin-bottom: 1.5rem !important;
        animation: mwBannerPulse 3s infinite ease-in-out !important;
        background: #05070f !important;
      }
      @keyframes mwBannerPulse {
        0%, 100% {
          box-shadow: 0 15px 45px rgba(0, 0, 0, 0.8), 0 0 25px rgba(239, 68, 68, 0.25);
          border-color: rgba(239, 68, 68, 0.45);
        }
        50% {
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.95), 0 0 45px rgba(239, 68, 68, 0.65);
          border-color: rgba(239, 68, 68, 0.85);
        }
      }
      .mw-banner-img {
        width: 100% !important;
        height: auto !important;
        max-height: 280px !important;
        object-fit: cover !important;
        display: block !important;
      }
      /* Laser Scanline Beam */
      .mw-scanline {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 3px !important;
        background: linear-gradient(90deg, transparent, rgba(239, 68, 68, 0.9), #fff, rgba(239, 68, 68, 0.9), transparent) !important;
        box-shadow: 0 0 15px #ef4444, 0 0 25px #ef4444 !important;
        opacity: 0.85 !important;
        animation: mwScanBeam 3.5s infinite linear !important;
      }
      @keyframes mwScanBeam {
        0% { top: -5%; }
        100% { top: 105%; }
      }
      .mw-badge-danger {
        display: inline-flex !important;
        align-items: center !important;
        gap: 0.5rem !important;
        background: rgba(239, 68, 68, 0.15) !important;
        color: #f87171 !important;
        border: 1px solid rgba(239, 68, 68, 0.4) !important;
        padding: 0.4rem 1rem !important;
        border-radius: 9999px !important;
        font-size: 0.75rem !important;
        font-weight: 700 !important;
        letter-spacing: 0.08em !important;
        text-transform: uppercase !important;
        margin-bottom: 1.25rem !important;
      }
      .mw-dot-red {
        width: 8px !important;
        height: 8px !important;
        border-radius: 50% !important;
        background: #ef4444 !important;
        box-shadow: 0 0 10px #ef4444 !important;
        animation: mwBlink 1.2s infinite ease-in-out !important;
      }
      @keyframes mwBlink {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.3; transform: scale(0.8); }
      }
      .mw-warning-text {
        font-size: 1.25rem !important;
        font-weight: 800 !important;
        color: #fca5a5 !important;
        margin-bottom: 1rem !important;
        letter-spacing: -0.01em !important;
        line-height: 1.4 !important;
        text-shadow: 0 0 20px rgba(239, 68, 68, 0.4) !important;
      }
      .mw-meta-box {
        background: rgba(0, 0, 0, 0.5) !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
        border-radius: 10px !important;
        padding: 1rem 1.25rem !important;
        margin: 1.25rem 0 !important;
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 0.75rem !important;
        text-align: left !important;
        font-size: 0.8125rem !important;
      }
      @media (max-width: 600px) {
        .mw-meta-box { grid-template-columns: 1fr !important; }
      }
      .mw-meta-row {
        display: flex !important;
        justify-content: space-between !important;
        color: #94a3b8 !important;
      }
      .mw-meta-val {
        color: #f1f5f9 !important;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
        font-weight: 600 !important;
      }
      .mw-recheck-indicator {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 0.6rem !important;
        font-size: 0.8125rem !important;
        color: #64748b !important;
        margin-top: 1.25rem !important;
      }
      .mw-radar-spinner {
        width: 14px !important;
        height: 14px !important;
        border: 2px solid rgba(239, 68, 68, 0.25) !important;
        border-top-color: #ef4444 !important;
        border-radius: 50% !important;
        animation: mwSpin 0.9s infinite linear !important;
      }
      @keyframes mwSpin {
        to { transform: rotate(360deg); }
      }
      /* Prevent scrolling on the underlying page */
      html.mw-site-frozen, body.mw-site-frozen {
        overflow: hidden !important;
        height: 100vh !important;
      }
    `;
    document.head.appendChild(style);
  }

  // Event Trap to prevent bypass or clicks behind overlay
  function trapEvents(e) {
    if (!isCurrentlyLocked) return;

    if (e.type === "keydown") {
      const k = e.key ? e.key.toLowerCase() : "";
      const isDevTools =
        e.keyCode === 123 || // F12
        (e.ctrlKey && e.shiftKey && (k === "i" || k === "j" || k === "c")) ||
        (e.ctrlKey && k === "u");
      if (isDevTools) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    }

    if (overlayElement && overlayElement.contains(e.target)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  function attachEventTraps() {
    const events = [
      "click", "dblclick", "mousedown", "mouseup", "contextmenu",
      "pointerdown", "touchstart", "touchmove", "wheel", "keydown", "keyup"
    ];
    events.forEach(ev => window.addEventListener(ev, trapEvents, true));
  }

  function detachEventTraps() {
    const events = [
      "click", "dblclick", "mousedown", "mouseup", "contextmenu",
      "pointerdown", "touchstart", "touchmove", "wheel", "keydown", "keyup"
    ];
    events.forEach(ev => window.removeEventListener(ev, trapEvents, true));
  }

  // Construct and Mount Lockout Shield
  function mountOverlay() {
    injectStyles();
    if (document.getElementById("mw-security-site-overlay")) return;

    overlayElement = document.createElement("div");
    overlayElement.id = "mw-security-site-overlay";
    overlayElement.setAttribute("role", "dialog");
    overlayElement.setAttribute("aria-modal", "true");
    overlayElement.setAttribute("aria-label", "Site Access Restricted");

    const imgFallback = `this.onerror=null; this.src='/img/security_banner.png';`;

    overlayElement.innerHTML = `
      <div class="mw-lock-card">
        <div class="mw-banner-wrapper">
          <img src="${bannerImageUrl}" alt="MartinWSecurityWeb Shield Banner" class="mw-banner-img" onerror="${imgFallback}">
          <div class="mw-scanline"></div>
        </div>

        <div class="mw-badge-danger">
          <span class="mw-dot-red"></span>
          <span>КРИТИЧЕСКАЯ ЗАЩИТА АКТИВНА &bull; ДОСТУП ОГРАНИЧЕН</span>
        </div>

        <div class="mw-warning-text">${customBannerText}</div>

        <p style="color:#94a3b8; font-size:0.875rem; line-height:1.6; margin-bottom:0.75rem;">
          Автономная система киберзащиты <strong>MartinWSecurityWeb</strong> перевела веб-ресурс в защитный режим блокировки.
          Любые операции, запросы и взаимодействие временно приостановлены для обеспечения сохранности данных и инфраструктуры.
        </p>

        <div class="mw-meta-box">
          <div class="mw-meta-row"><span>Статус Ресурса:</span><span class="mw-meta-val" style="color:#ef4444;">ПОЛНОСТЬЮ ЗАБЛОКИРОВАН</span></div>
          <div class="mw-meta-row"><span>Инцидент:</span><span class="mw-meta-val">${lastIncidentId}</span></div>
          <div class="mw-meta-row"><span>Профиль защиты:</span><span class="mw-meta-val">MartinWSecurityWeb L7 DDoS & WAF Ingress</span></div>
          <div class="mw-meta-row"><span>Сетевой экран:</span><span class="mw-meta-val" style="color:#38bdf8;">ACTIVE SHIELD 2.0</span></div>
        </div>

        <div class="mw-recheck-indicator">
          <div class="mw-radar-spinner"></div>
          <span>Автоматический мониторинг разблокировки ресурса...</span>
        </div>
      </div>
    `;

    document.documentElement.appendChild(overlayElement);
    document.documentElement.classList.add("mw-site-frozen");
    if (document.body) document.body.classList.add("mw-site-frozen");

    requestAnimationFrame(() => {
      overlayElement.classList.add("mw-visible");
    });

    startObserver();
  }

  // Remove Lockout Shield and Restore Access
  function unmountOverlay() {
    stopObserver();
    if (overlayElement) {
      overlayElement.classList.remove("mw-visible");
      setTimeout(() => {
        if (overlayElement && overlayElement.parentNode) {
          overlayElement.parentNode.removeChild(overlayElement);
        }
        overlayElement = null;
      }, 350);
    }
    document.documentElement.classList.remove("mw-site-frozen");
    if (document.body) document.body.classList.remove("mw-site-frozen");
    detachEventTraps();
  }

  // Anti-Bypass DOM MutationObserver
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (isCurrentlyLocked) {
        const ov = document.getElementById("mw-security-site-overlay");
        if (!ov || !ov.classList.contains("mw-visible")) {
          mountOverlay();
        }
        if (!document.documentElement.classList.contains("mw-site-frozen")) {
          document.documentElement.classList.add("mw-site-frozen");
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // Query MartinWSecurityWeb or local Public Shield Status Endpoint
  async function checkLockStatus() {
    try {
      // First attempt querying configured serverUrl or local endpoint
      let targetUrl = `${serverUrl}/api/v1/shield/status?t=${Date.now()}`;
      let response = await fetch(targetUrl, {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });

      // Fallback to origin if remote server unavailable
      if (!response.ok && serverUrl !== window.location.origin) {
        targetUrl = `${window.location.origin}/api/v1/shield/status?t=${Date.now()}`;
        response = await fetch(targetUrl, {
          method: "GET",
          headers: { "Accept": "application/json" },
          cache: "no-store"
        });
      }

      if (!response.ok) return;
      const data = await response.json();

      const shouldLock = Boolean(data.locked || data.is_site_manually_locked || data.security_mode === "LOCKDOWN");

      if (data.banner_image) bannerImageUrl = data.banner_image;
      if (data.custom_banner || data.banner_text) {
        customBannerText = data.custom_banner || data.banner_text;
      }

      if (shouldLock && !isCurrentlyLocked) {
        isCurrentlyLocked = true;
        attachEventTraps();
        mountOverlay();
      } else if (!shouldLock && isCurrentlyLocked) {
        isCurrentlyLocked = false;
        unmountOverlay();
      }
    } catch (err) {
      // Retain current state in case of network packet drop
    }
  }

  // Periodic Polling Loop
  function startPolling() {
    checkLockStatus();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(checkLockStatus, POLL_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startPolling);
  } else {
    startPolling();
  }

  window.addEventListener("focus", checkLockStatus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkLockStatus();
  });
})();
