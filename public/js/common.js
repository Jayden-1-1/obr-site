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

function showAlert(el, type, text) {
  el.className = `alert ${type} show`;
  el.textContent = text;
}

function clearAlert(el) {
  el.className = 'alert';
  el.textContent = '';
}

function optionsHtml(list, selected) {
  return list
    .map((r) => `<option value="${esc(r)}" ${r === selected ? 'selected' : ''}>${esc(r)}</option>`)
    .join('');
}

function avatarImg(userId, stored, name, size = 38) {
  if (stored && userId) {
    return `<img class="avatar" src="/api/users/${userId}/avatar" alt="${esc(name || '')}" width="${size}" height="${size}">`;
  }
  return `<span class="avatar avatar-empty" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc((name || '?').slice(0, 1).toUpperCase())}</span>`;
}

function avatarInline(owner, size = 28) {
  const name = owner.username || owner.callsign || '?';
  if (owner.user_id && owner.avatar) {
    return `<img class="avatar avatar-inline" src="/api/users/${owner.user_id}/avatar" alt="${esc(name)}" width="${size}" height="${size}">`;
  }
  return `<span class="avatar avatar-empty avatar-inline" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${esc(name.slice(0, 1).toUpperCase())}</span>`;
}

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
          ${avatarImg(user.id, user.avatar, user.username, 38)}
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
        <a href="/login.html" class="btn small">Вход</a>
        <a href="/register.html" class="btn small primary">Регистрация</a>
      </div>`;
  }

  const header = document.getElementById('site-header');
  if (header) {
    header.innerHTML = `
      <div class="header-inner">
        <a class="brand" href="/">
          <img class="logo" src="/img/logo.png" alt="О.Б.Р">
          <div class="title">${esc(SITE.short)}<small>Отряд Быстрого Реагирования</small></div>
        </a>
        <nav class="main-nav">${navHtml}</nav>
        ${userHtml}
      </div>`;

    if (!document.getElementById('news-ticker')) {
      header.insertAdjacentHTML(
        'afterend',
        `
        <div class="news-ticker header-ticker" id="news-ticker" style="display:none">
          <div class="news-label">НОВОСТИ</div>
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

let __headerActive = null;

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
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
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
  } catch (_) {
    /* сеть недоступна — всё равно разлогиниваемся локально */
  }
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
    const pw = __dpPopup.offsetWidth;
    const ph = __dpPopup.offsetHeight;
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
    __dpPopup.className = 'datepicker-pop';
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
