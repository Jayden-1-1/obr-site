const SITE = {
  short: 'О.Б.Р',
  full: 'О.Б.Р — Отряд Быстрого Реагирования',
  roleLabels: {
    user: 'Кандидат',
    staff: 'Персонал',
    zam: 'Зам. Командира',
    commander: 'Командир',
  },
  RANKS: [
    'Стажер',
    'Мл. лейтенант',
    'Лейтенант',
    'Ст. лейтенант',
    'Капитан',
    'Майор',
    'Подполковник',
    'Полковник',
  ],
  POSITIONS: [
    'Сотрудник О.Б.Р',
    'Боец О.Б.Р',
    'Зам. Командира',
    'Командир О.Б.Р',
  ],
  SECURITY_QUESTIONS: [
    'Как звали вашего первого учителя?',
    'Как звали вашего первого животного?',
    'Как звали вашего лучшего друга в детстве?',
    'В каком городе вы родились?',
    'Как называется ваша любимая книга?',
    'Название вашей первой школы?',
  ],
  me: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    throw new Error(data.error || 'Ошибка запроса');
  }
  return data;
}

function isStaff(user) {
  return !!user && ['staff', 'zam', 'commander'].includes(user.role);
}

function isManager(user) {
  return !!user && ['zam', 'commander'].includes(user.role);
}

function isCommander(user) {
  return !!user && user.role === 'commander';
}

function roleClass(role) {
  return ['staff', 'zam', 'commander'].includes(role) ? role : '';
}

/* ---------- Уведомления (Alerts & Toasts) ---------- */
function showAlert(el, type, text) {
  if (!el) return;
  el.className = `alert ${type} show`;
  el.textContent = text;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearAlert(el) {
  if (!el) return;
  el.className = 'alert';
  el.textContent = '';
}

function showToast(type, text, duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const iconMap = {
    ok: '✓',
    err: '✕',
    info: 'ℹ',
    warn: '⚠',
  };

  toast.innerHTML = `
    <span class="toast-icon">${iconMap[type] || 'ℹ'}</span>
    <span class="toast-msg">${esc(text)}</span>
    <button type="button" class="toast-close" aria-label="Закрыть">×</button>
    <div class="toast-progress" style="animation-duration:${duration}ms"></div>
  `;

  container.appendChild(toast);

  const remove = () => {
    toast.classList.add('toast-leave');
    setTimeout(() => toast.remove(), 250);
  };

  const timer = setTimeout(remove, duration);
  toast.querySelector('.toast-close').addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}

/* ---------- Тактическое модальное окно подтверждения ---------- */
function showConfirmModal({
  title = 'Подтверждение действия',
  message = 'Вы уверены, что хотите продолжить?',
  confirmText = 'Подтвердить',
  cancelText = 'Отмена',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let modalEl = document.getElementById('app-confirm-modal');
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = 'app-confirm-modal';
      modalEl.className = 'modal-backdrop confirm-backdrop';
      document.body.appendChild(modalEl);
    }

    modalEl.innerHTML = `
      <div class="modal confirm-modal" role="dialog" aria-modal="true">
        <div class="confirm-head">
          <div class="confirm-badge">${danger ? 'ВНИМАНИЕ' : 'ДЕЙСТВИЕ'}</div>
          <h3>${esc(title)}</h3>
        </div>
        <div class="confirm-body">
          <p>${esc(message)}</p>
        </div>
        <div class="confirm-actions">
          <button type="button" class="btn" id="confirm-cancel-btn">${esc(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" id="confirm-ok-btn">${esc(confirmText)}</button>
        </div>
      </div>
    `;

    modalEl.style.display = 'flex';
    setTimeout(() => modalEl.classList.add('in'), 10);

    const cleanup = (result) => {
      modalEl.classList.remove('in');
      setTimeout(() => {
        modalEl.style.display = 'none';
        modalEl.innerHTML = '';
        resolve(result);
      }, 200);
      document.removeEventListener('keydown', onKey);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    };

    document.addEventListener('keydown', onKey);
    document.getElementById('confirm-cancel-btn').addEventListener('click', () => cleanup(false));
    document.getElementById('confirm-ok-btn').addEventListener('click', () => cleanup(true));
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) cleanup(false);
    });
  });
}

function optionsHtml(list, selected) {
  return list
    .map((r) => `<option value="${esc(r)}" ${r === selected ? 'selected' : ''}>${esc(r)}</option>`)
    .join('');
}

function avatarImg(userId, stored, name, size = 38) {
  if (stored && userId) {
    return `<img class="avatar" src="/api/users/${userId}/avatar" alt="${esc(name || '')}" width="${size}" height="${size}" loading="lazy">`;
  }
  return `<span class="avatar avatar-empty" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc((name || '?').slice(0, 1).toUpperCase())}</span>`;
}

function avatarInline(owner, size = 28) {
  const name = owner.username || owner.callsign || '?';
  if (owner.user_id && owner.avatar) {
    return `<img class="avatar avatar-inline" src="/api/users/${owner.user_id}/avatar" alt="${esc(name)}" width="${size}" height="${size}" loading="lazy">`;
  }
  return `<span class="avatar avatar-empty avatar-inline" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${esc(name.slice(0, 1).toUpperCase())}</span>`;
}

let __headerActive = null;

async function initHeader(active) {
  __headerActive = active;
  try {
    const data = await apiFetch('/api/auth/me');
    SITE.me = data.user;
  } catch (_) {}

  const user = SITE.me;
  const nav = [
    { href: '/', label: 'Главная', key: 'home' },
    { href: '/roster.html', label: 'Штатное расписание', key: 'roster', auth: true },
    { href: '/reports.html', label: 'Рапорты', key: 'reports', auth: true, staff: true },
    { href: '/punishments.html', label: 'Наказания', key: 'punishments', auth: true, staff: true },
    { href: '/applications.html', label: 'Заявки', key: 'apps', auth: true },
  ];

  let navHtml = '';
  for (const n of nav) {
    if (n.auth && !user) continue;
    if (n.staff && !isStaff(user)) continue;
    navHtml += `<a href="${n.href}" class="${n.key === active ? 'active' : ''}">${n.label}</a>`;
  }

  let userHtml;
  if (user) {
    userHtml = `
      <div class="user-box">
        <a class="user-chip" href="/profile.html" title="Настройки профиля">
          ${avatarImg(user.id, user.avatar, user.username, 36)}
          <div class="who">
            <div class="name">${esc(user.username)}</div>
            <div class="role">${esc(SITE.roleLabels[user.role] || user.role)}</div>
          </div>
        </a>
        <button class="btn small" onclick="doLogout()">Выйти</button>
      </div>`;
  } else {
    userHtml = `
      <div class="user-box">
        <a href="/api/discord/login" class="btn small discord discord-nav-btn"><svg class="btn-icon" viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-2px"><path fill="currentColor" d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/></svg>Войти через Discord</a>
        <a href="/login.html" class="btn small" title="Резервный вход по паролю">Вход</a>
      </div>`;
  }

  const header = document.getElementById('site-header');
  if (header) {
    header.className = 'site-header';
    header.innerHTML = `
      <div class="header-inner" id="header-inner">
        <a class="brand" href="/">
          <img class="logo" src="/img/logo.png" alt="О.Б.Р">
          <div class="title">
            <div style="display:flex;align-items:center;gap:7px">
              <span>${esc(SITE.short)}</span>
              <span class="brand-status">online</span>
            </div>
            <small>Отряд Быстрого Реагирования</small>
          </div>
        </a>
        <nav class="main-nav" id="main-nav">${navHtml}</nav>
        ${userHtml}
        <button type="button" class="mobile-nav-toggle" id="mobile-nav-toggle" aria-label="Открыть меню">
          <span></span><span></span><span></span>
        </button>
      </div>`;

    const toggle = document.getElementById('mobile-nav-toggle');
    const inner = document.getElementById('header-inner');
    if (toggle && inner) {
      toggle.addEventListener('click', () => {
        inner.classList.toggle('nav-open');
      });
      document.addEventListener('click', (e) => {
        if (!inner.contains(e.target) && inner.classList.contains('nav-open')) {
          inner.classList.remove('nav-open');
        }
      });
    }

    if (!document.getElementById('news-ticker')) {
      header.insertAdjacentHTML(
        'afterend',
        `
        <div class="news-ticker header-ticker" id="news-ticker" style="display:none">
          <div class="news-label">СВОДКА</div>
          <div class="news-track-wrap">
            <div class="news-track" id="news-track"></div>
          </div>
        </div>`
      );
      initNewsTicker();
    }
  }

  initDeveloperBadge();
  initReveal();
}

async function initNewsTicker() {
  try {
    const data = await apiFetch('/api/news');
    const ticker = document.getElementById('news-ticker');
    if (!ticker) return;
    const track = document.getElementById('news-track');
    const text = data.text || '';
    if (!text) {
      ticker.style.display = 'none';
      return;
    }
    ticker.style.display = '';
    const tickerW = ticker.clientWidth || window.innerWidth;
    const probe = document.createElement('span');
    probe.textContent = text;
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;';
    document.body.appendChild(probe);
    const one = probe.offsetWidth;
    probe.remove();
    const copies = 2 * Math.max(1, Math.ceil((tickerW + 32) / (one + 32)));
    track.innerHTML = Array(copies).fill(`<span>${esc(text)}</span>`).join('');
  } catch (_) {
    const ticker = document.getElementById('news-ticker');
    if (ticker) ticker.style.display = 'none';
  }
}

async function refreshHeaderUser() {
  await initHeader(__headerActive);
}

function initReveal() {
  if (window.__revealInit) return;
  window.__revealInit = true;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.08, rootMargin: '0px 0px -20px 0px' }
  );
  const scan = () =>
    document.querySelectorAll('.reveal:not(.in)').forEach((el) => io.observe(el));
  scan();
  if (window.MutationObserver) {
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }
}

function toggleDevPanel() {
  const p = document.getElementById('dev-panel');
  if (p) p.classList.toggle('open');
}

function initDeveloperBadge() {
  if (document.getElementById('dev-badge')) return;
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <div class="dev-badge" id="dev-badge" title="Заказать сайт" onclick="toggleDevPanel()">
      <span class="dev-badge-text">Developer</span>
      <span class="dev-badge-dot"></span>
      <span class="dev-badge-name">.martinwinskton</span>
    </div>
    <div class="dev-panel" id="dev-panel">
      <div class="dev-panel-title">Заказать сайт можно здесь</div>
      <a class="dev-panel-link" href="https://t.me/MartinWShop_bot" target="_blank" rel="noopener">@MartinWShop_bot</a>
    </div>`
  );
  document.addEventListener('click', (e) => {
    const p = document.getElementById('dev-panel');
    if (p && p.classList.contains('open') && !e.target.closest('.dev-badge') && !e.target.closest('.dev-panel')) {
      p.classList.remove('open');
    }
  });
}

async function doLogout() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (_) {}
  window.location.href = '/';
}

function formatDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d)) return s;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusHtml(status) {
  const map = {
    active: ['Не уволен', 'active'],
    fired: ['Уволен', 'fired'],
    pending: ['На рассмотрении', 'pending'],
    approved: ['Одобрено', 'approved'],
    rejected: ['Отклонено', 'rejected'],
    open: ['Открыт', 'pending'],
    done: ['Рассмотрен', 'approved'],
  };
  const [label, cls] = map[status] || [status, ''];
  return `<span class="status ${cls}">${esc(label)}</span>`;
}

/* ---------- Календарь-датапикер ---------- */
const __dpInputs = new WeakSet();
let __dpPopup = null;
let __dpInput = null;

function closeDatePicker() {
  if (__dpPopup) {
    __dpPopup.remove();
    __dpPopup = null;
    __dpInput = null;
  }
}

function attachDatePicker(input, opts = {}) {
  if (!input || __dpInputs.has(input)) return;
  __dpInputs.add(input);

  const minISO = opts.min || null;
  const maxISO = opts.max || null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toDisplay = (s) => {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
  };
  const toISO = (s) => {
    const m = String(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  };

  const MONTHS = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
  ];
  const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  function render(view) {
    const y = view.y;
    const m = view.m;
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    const dim = new Date(y, m + 1, 0).getDate();
    const dimPrev = new Date(y, m, 0).getDate();
    const sel = toISO(input.value);
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const n = i - offset + 1;
      let d;
      let yy = y;
      let mo = m;
      if (n < 1) { d = dimPrev + n; mo--; }
      else if (n > dim) { d = n - dim; mo++; }
      else d = n;
      if (mo < 0) { mo = 11; yy--; }
      if (mo > 11) { mo = 0; yy++; }
      const ds = iso(new Date(yy, mo, d));
      let cls = n < 1 || n > dim ? 'dim' : '';
      if (sel === ds) cls += ' selected';
      if (ds === iso(today)) cls += ' today';
      if ((minISO && ds < minISO) || (maxISO && ds > maxISO)) cls += ' disabled';
      cells += `<div class="dp-day${cls ? ' ' + cls : ''}" data-d="${ds}">${d}</div>`;
    }
    __dpPopup.innerHTML =
      `<div class="dp-head">
        <button type="button" class="dp-nav" data-nav="-1" tabindex="-1">‹</button>
        <span class="dp-label">${MONTHS[m]} ${y}</span>
        <button type="button" class="dp-nav" data-nav="1" tabindex="-1">›</button>
      </div>
      <div class="dp-grid">${WD.map((w) => `<span class="dp-wd">${w}</span>`).join('')}${cells}</div>`;
  }

  function position(r) {
    if (!__dpPopup) return;
    __dpPopup.style.visibility = 'hidden';
    const pw = __dpPopup.offsetWidth || 280;
    const ph = __dpPopup.offsetHeight || 260;
    let top = r.bottom + 6;
    let left = r.left;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    __dpPopup.style.top = top + 'px';
    __dpPopup.style.left = left + 'px';
    __dpPopup.style.visibility = '';
  }

  function open() {
    closeDatePicker();
    __dpInput = input;
    const parts = (toISO(input.value) || iso(today)).split('-');
    const view = { y: +parts[0], m: +parts[1] - 1 };
    __dpPopup = document.createElement('div');
    __dpPopup.className = 'datepicker-pop in';
    render(view);
    document.body.appendChild(__dpPopup);
    position(input.getBoundingClientRect());
    __dpPopup.addEventListener('click', (e) => {
      const nav = e.target.closest('.dp-nav');
      if (nav) {
        view.m += +nav.dataset.nav;
        if (view.m < 0) { view.m = 11; view.y--; }
        if (view.m > 11) { view.m = 0; view.y++; }
        render(view);
        return;
      }
      const day = e.target.closest('.dp-day');
      if (!day || day.classList.contains('disabled')) return;
      input.value = toDisplay(day.dataset.d);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closeDatePicker();
    });
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', () => {
    if (!__dpPopup) open();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDatePicker();
  });
}

document.addEventListener('mousedown', (e) => {
  if (__dpPopup && __dpInput && e.target !== __dpInput && !__dpPopup.contains(e.target)) {
    closeDatePicker();
  }
});
window.addEventListener('scroll', () => {
  if (__dpPopup && __dpInput) position(__dpInput.getBoundingClientRect());
}, true);
window.addEventListener('resize', () => {
  if (__dpPopup && __dpInput) position(__dpInput.getBoundingClientRect());
});
