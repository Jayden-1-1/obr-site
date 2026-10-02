/**
 * MartinWSecurityWeb — In-Site Shield & Lockout Overlay Engine
 * Version: 1.2.0
 * 
 * Provides an impenetrable, tamper-resistant in-site full-viewport defense shield.
 * When the website is locked manually (Kill Switch) or placed under LOCKDOWN:
 *   1. Completely intercepts and disables all website interactivity (clicks, scroll, keyboard, touch, devtools).
 *   2. Freezes underlying DOM with deep frosted-glass blur (backdrop-filter: blur(24px)).
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

  const POLL_INTERVAL_MS = 4000;
  let isCurrentlyLocked = false;
  let overlayElement = null;
  let observer = null;
  let pollTimer = null;
  let bannerImageUrl = serverUrl + "/static/banner.png";
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
        background: radial-gradient(circle at 50% 25%, rgba(239, 68, 68, 0.12) 0%, rgba(5, 8, 17, 0.96) 70%) !important;
        backdrop-filter: blur(24px) saturate(180%) !important;
        -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
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
        transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1) !important;
      }
      #mw-security-site-overlay.mw-visible {
        opacity: 1 !important;
      }
      .mw-lock-card {
        background: #090d18 !important;
        border: 1px solid rgba(239, 68, 68, 0.4) !important;
        border-radius: 18px !important;
        max-width: 760px !important;
        width: 100% !important;
        padding: 2.25rem !important;
        text-align: center !important;
        box-shadow: 0 30px 80px -15px rgba(0, 0, 0, 0.95), 0 0 50px -10px rgba(239, 68, 68, 0.4) !important;
        position: relative !important;
        overflow: hidden !important;
        animation: mwCardAppear 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
      }
      @keyframes mwCardAppear {
        from { transform: translateY(30px) scale(0.96); opacity: 0; }
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
        background: radial-gradient(circle, rgba(15, 23, 42, 0.95) 0%, rgba(5, 7, 15, 0.98) 100%) !important;
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
        max-height: 220px !important;
        object-fit: contain !important;
        display: block !important;
        padding: 1.25rem 1rem !important;
        box-sizing: border-box !important;
        filter: drop-shadow(0 4px 20px rgba(0, 0, 0, 0.7)) !important;
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
        font-size: 0.78rem !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        letter-spacing: 0.08em !important;
        margin-bottom: 1rem !important;
        animation: mwBlink 2s infinite ease-in-out !important;
      }
      @keyframes mwBlink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.65; }
      }
      .mw-dot-red {
        width: 8px !important;
        height: 8px !important;
        background: #ef4444 !important;
        border-radius: 50% !important;
        box-shadow: 0 0 10px #ef4444 !important;
      }
      .mw-warning-text {
        background: linear-gradient(90deg, #991b1b, #ef4444, #991b1b) !important;
        background-size: 200% auto !important;
        color: #ffffff !important;
        font-weight: 700 !important;
        font-size: 0.95rem !important;
        padding: 0.85rem 1.25rem !important;
        border-radius: 8px !important;
        margin-bottom: 1.25rem !important;
        text-transform: uppercase !important;
        letter-spacing: 0.04em !important;
        box-shadow: 0 4px 20px rgba(239, 68, 68, 0.3) !important;
        animation: mwShift 4s infinite linear !important;
      }
      @keyframes mwShift {
        0% { background-position: 0% center; }
        100% { background-position: 200% center; }
      }
      .mw-meta-box {
        background: #050811 !important;
        border: 1px solid #1e293b !important;
        border-radius: 10px !important;
        padding: 1.1rem !important;
        font-size: 0.82rem !important;
        color: #94a3b8 !important;
        text-align: left !important;
        font-family: monospace !important;
        margin-top: 1.25rem !important;
      }
      .mw-meta-row {
        display: flex !important;
        justify-content: space-between !important;
        margin-bottom: 0.45rem !important;
      }
      .mw-meta-row:last-child { margin-bottom: 0 !important; }
      .mw-meta-val { color: #f1f5f9 !important; font-weight: 600 !important; }

      .mw-recheck-indicator {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 0.5rem !important;
        margin-top: 1.25rem !important;
        font-size: 0.8rem !important;
        color: #64748b !important;
      }
      .mw-radar-spinner {
        width: 14px !important;
        height: 14px !important;
        border: 2px solid rgba(239, 68, 68, 0.3) !important;
        border-top-color: #ef4444 !important;
        border-radius: 50% !important;
        animation: mwSpin 1s infinite linear !important;
      }
      @keyframes mwSpin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      /* Locked Body Constraints */
      html.mw-site-frozen, body.mw-site-frozen {
        overflow: hidden !important;
        height: 100vh !important;
        touch-action: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // Event Trap Handlers (Prevent clicks, touches, shortcuts, inspection)
  function trapEvents(e) {
    if (!isCurrentlyLocked) return;
    
    // Prevent devtools shortcuts (F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+U)
    if (e.type === "keydown") {
      const isDevTools = 
        e.key === "F12" ||
        (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "i" || e.key === "J" || e.key === "j" || e.key === "C" || e.key === "c")) ||
        (e.ctrlKey && (e.key === "u" || e.key === "U"));
      if (isDevTools) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    }

    // Allow interaction ONLY within the overlay itself if needed
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

    overlayElement.innerHTML = `
      <div class="mw-lock-card">
        <div class="mw-banner-wrapper">
          <img src="${bannerImageUrl}" alt="MartinWSecurityWeb Shield Banner" class="mw-banner-img" onerror="this.style.display='none'">
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
          <div class="mw-meta-row"><span>Сетевой экран:</span><span class="mw-meta-val" style="color:#38bdf8;">ACTIVE SHIELD 1.2</span></div>
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

    // Smooth entrance
    requestAnimationFrame(() => {
      overlayElement.classList.add("mw-visible");
    });

    // Start MutationObserver anti-bypass guard
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
      }, 400);
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

  // Query MartinWSecurityWeb Public Shield Status Endpoint
  async function checkLockStatus() {
    try {
      const response = await fetch(`${serverUrl}/api/v1/shield/status?t=${Date.now()}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });

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
      // In offline / network loss situations, preserve current lock state
    }
  }

  // Periodic Polling Loop
  function startPolling() {
    checkLockStatus();
    pollTimer = setInterval(checkLockStatus, POLL_INTERVAL_MS);
  }

  // Execute on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startPolling);
  } else {
    startPolling();
  }

  // Expose global controller for testing or custom site triggers
  window.MartinWSecurity = {
    check: checkLockStatus,
    lock: () => { isCurrentlyLocked = true; attachEventTraps(); mountOverlay(); },
    unlock: () => { isCurrentlyLocked = false; unmountOverlay(); },
    isLocked: () => isCurrentlyLocked
  };
})();
