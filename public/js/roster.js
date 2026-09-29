let editingId = null;
let rosterData = [];
let rosterFilter = '';

const RANK_ORDER = [
  'Стажер',
  'Мл. лейтенант',
  'Лейтенант',
  'Ст. лейтенант',
  'Капитан',
  'Майор',
  'Подполковник',
  'Полковник',
];

function rankWeight(r) {
  const idx = RANK_ORDER.indexOf(r.rank);
  const posBonus = r.position === 'Командир О.Б.Р' ? 9 : r.position === 'Зам. Командира' ? 8 : 0;
  return (idx === -1 ? -1 : idx) * 10 + posBonus;
}

function addSelfRoster() {
  openRosterModal();
  document.getElementById('r-callsign').value = SITE.me.username;
  document.getElementById('r-rank').value = 'Полковник';
  document.getElementById('r-position').value = 'Командир О.Б.Р';
  document.getElementById('r-user').value = String(SITE.me.id);
  clearAlert(document.getElementById('roster-modal-alert'));
}

function openRosterModal() {
  editingId = null;
  document.getElementById('roster-modal-title').textContent = 'Добавить сотрудника';
  document.getElementById('r-number').value = '';
  document.getElementById('r-callsign').value = '';
  document.getElementById('r-rank').value = 'Стажер';
  document.getElementById('r-position').value = 'Сотрудник О.Б.Р';
  document.getElementById('r-age').value = '';
  document.getElementById('r-discord').value = '';
  document.getElementById('r-user').value = '';
  clearAlert(document.getElementById('roster-modal-alert'));
  document.getElementById('roster-modal').style.display = 'flex';
}

function closeRosterModal() {
  document.getElementById('roster-modal').style.display = 'none';
}

async function editRoster(id) {
  try {
    const data = await apiFetch('/api/roster');
    const r = data.roster.find((x) => x.id === id);
    if (!r) return;
    editingId = id;
    document.getElementById('roster-modal-title').textContent = 'Редактировать сотрудника';
    document.getElementById('r-number').value = r.employee_number;
    document.getElementById('r-callsign').value = r.callsign;
    document.getElementById('r-rank').value = r.rank;
    document.getElementById('r-position').value = r.position;
    document.getElementById('r-age').value = r.age || '';
    document.getElementById('r-discord').value = r.discord || '';
    document.getElementById('r-user').value = r.user_id || '';
    clearAlert(document.getElementById('roster-modal-alert'));
    document.getElementById('roster-modal').style.display = 'flex';
  } catch (e) {
    showAlert(document.getElementById('alert'), 'err', e.message);
  }
}

async function toggleStatus(id) {
  const row = document.querySelector(`[data-row-id="${id}"]`);
  const status = row ? row.dataset.status : '';
  const action = status === 'active' ? 'уволить' : 'вернуть в строй';
  const ok = await showConfirmModal({
    title: status === 'active' ? 'Увольнение сотрудника' : 'Возвращение в строй',
    message: `Подтвердите действие: ${action} сотрудника?`,
    confirmText: status === 'active' ? 'Уволить' : 'Вернуть',
    danger: status === 'active',
  });
  if (!ok) return;
  try {
    await apiFetch(`/api/roster/${id}/toggle-status`, { method: 'POST' });
    showToast('ok', `Статус сотрудника изменён (${action})`);
    await load();
  } catch (e) {
    showAlert(document.getElementById('alert'), 'err', e.message);
  }
}

async function deleteRoster(id) {
  const ok = await showConfirmModal({
    title: 'Удаление из штата',
    message: 'Удалить запись из штатного расписания? Это действие необратимо.',
    confirmText: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await apiFetch(`/api/roster/${id}`, { method: 'DELETE' });
    showToast('ok', 'Сотрудник удалён из штата');
    await load();
  } catch (e) {
    showAlert(document.getElementById('alert'), 'err', e.message);
  }
}

async function addWarning(id, callsign) {
  openWarningModal(id, callsign);
}

function submitWarning() {
  if (warningTargetId == null) return;
  const reason = document.getElementById('w-reason').value.trim();
  const until = document.getElementById('w-until').value.trim();
  const alertEl = document.getElementById('warning-modal-alert');
  if (!reason) {
    showAlert(alertEl, 'err', 'Укажите причину выговора');
    return;
  }
  if (!until) {
    showAlert(alertEl, 'err', 'Выберите дату окончания срока');
    return;
  }
  apiFetch(`/api/roster/${warningTargetId}/warning`, {
    method: 'POST',
    body: JSON.stringify({ reason, until }),
  })
    .then(async () => {
      closeWarningModal();
      showToast('warn', 'Выговор вынесен');
      await load();
    })
    .catch((e) => showAlert(alertEl, 'err', e.message));
}

async function removeWarning(id) {
  const ok = await showConfirmModal({
    title: 'Снятие выговора',
    message: 'Снять выговор у данного сотрудника?',
    confirmText: 'Снять выговор',
  });
  if (!ok) return;
  try {
    await apiFetch(`/api/roster/${id}/unwarning`, { method: 'POST' });
    showToast('ok', 'Выговор снят');
    await load();
  } catch (e) {
    showAlert(document.getElementById('alert'), 'err', e.message);
  }
}

async function demoteRoster(id, rank) {
  const ok = await showConfirmModal({
    title: 'Понижение в звании',
    message: `Понизить сотрудника со звания «${rank}» на одно звание вниз? Выговоры будут сброшены.`,
    confirmText: 'Понизить',
    danger: true,
  });
  if (!ok) return;
  try {
    await apiFetch(`/api/roster/${id}/demote`, { method: 'POST' });
    showToast('warn', 'Сотрудник понижен в звании');
    await load();
  } catch (e) {
    showAlert(document.getElementById('alert'), 'err', e.message);
  }
}

async function recertRoster(id) {
  const ok = await showConfirmModal({
    title: 'Переаттестация',
    message: 'Отправить сотрудника на переаттестацию? Все текущие выговоры будут сняты.',
    confirmText: 'На переаттестацию',
    danger: true,
  });
  if (!ok) return;
  try {
    await apiFetch(`/api/roster/${id}/recert`, { method: 'POST' });
    showToast('info', 'Сотрудник отправлен на переаттестацию');
    await load();
  } catch (e) {
    showAlert(document.getElementById('alert'), 'err', e.message);
  }
}

async function recertClear(id) {
  const ok = await showConfirmModal({
    title: 'Завершение аттестации',
    message: 'Отметить переаттестацию пройденной?',
    confirmText: 'Пройдена',
  });
  if (!ok) return;
  try {
    await apiFetch(`/api/roster/${id}/recert-clear`, { method: 'POST' });
    showToast('ok', 'Переаттестация успешно пройдена');
    await load();
  } catch (e) {
    showAlert(document.getElementById('alert'), 'err', e.message);
  }
}

function warningsBadge(r) {
  const cls = r.warnings >= 3 ? 'danger' : r.warnings > 0 ? 'warn' : 'ok';
  return `<span class="w-badge ${cls}">${r.warnings} / 3</span>`;
}

let warningTargetId = null;

function openWarningModal(id, callsign) {
  warningTargetId = id;
  document.getElementById('warning-modal-title').textContent = `Выговор: ${callsign}`;
  document.getElementById('w-callsign').value = callsign;
  document.getElementById('w-reason').value = '';
  document.getElementById('w-until').value = '';
  clearAlert(document.getElementById('warning-modal-alert'));
  document.getElementById('warning-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('w-reason').focus(), 50);
}

function closeWarningModal() {
  document.getElementById('warning-modal').style.display = 'none';
  warningTargetId = null;
}

let vacationTargetId = null;

function addVacation(id, callsign) {
  openVacationModal(id, callsign);
}

function openVacationModal(id, callsign) {
  vacationTargetId = id;
  document.getElementById('vacation-modal-title').textContent = `Отпуск: ${callsign}`;
  document.getElementById('v-callsign').value = callsign;
  document.getElementById('v-reason').value = '';
  document.getElementById('v-until').value = '';
  clearAlert(document.getElementById('vacation-modal-alert'));
  document.getElementById('vacation-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('v-reason').focus(), 50);
}

function closeVacationModal() {
  document.getElementById('vacation-modal').style.display = 'none';
  vacationTargetId = null;
}

function submitVacation() {
  if (vacationTargetId == null) return;
  const reason = document.getElementById('v-reason').value.trim();
  const until = document.getElementById('v-until').value.trim();
  const alertEl = document.getElementById('vacation-modal-alert');
  if (!reason) {
    showAlert(alertEl, 'err', 'Укажите причину отпуска');
    return;
  }
  if (!until) {
    showAlert(alertEl, 'err', 'Выберите дату возвращения');
    return;
  }
  apiFetch(`/api/roster/${vacationTargetId}/vacation`, {
    method: 'POST',
    body: JSON.stringify({ reason, until }),
  })
    .then(async () => {
      closeVacationModal();
      await load();
    })
    .catch((e) => showAlert(alertEl, 'err', e.message));
}

async function endVacation(id) {
  const ok = await showConfirmModal({
    title: 'Завершение отпуска',
    message: 'Завершить отпуск досрочно? Роль отпуска будет снята.',
    confirmText: 'Завершить',
  });
  if (!ok) return;
  try {
    await apiFetch(`/api/roster/${id}/end-vacation`, { method: 'POST' });
    showToast('ok', 'Отпуск сотрудника завершён');
    await load();
  } catch (e) {
    showAlert(document.getElementById('alert'), 'err', e.message);
  }
}

function vacationBadge(r) {
  if (!r.vacation_until) return '';
  return `<span class="v-badge">Отпуск до ${esc(formatDate(r.vacation_until))}</span>`;
}

function formatDate(dt) {
  if (!dt) return '';
  const m = String(dt).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dt;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function render() {
  const body = document.getElementById('roster-body');
  const manager = isManager(SITE.me);
  const q = rosterFilter.trim().toLowerCase();
  const list = q
    ? rosterData.filter((r) =>
        [r.callsign, r.employee_number, r.position, r.rank, r.discord, r.age]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : rosterData;

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--faint)">${
      rosterData.length ? 'Ничего не найдено' : 'Штат пуст'
    }</td></tr>`;
    return;
  }

  body.innerHTML = list
    .map(
      (r, i) => `
      <tr data-row-id="${r.id}" data-status="${r.status}" ${r.recert ? 'data-recert="1"' : ''} class="reveal" style="--rd:${Math.min(i * 30, 240)}ms">
        <td><span class="num">${i + 1}</span></td>
        <td>
          ${r.user_id && r.avatar
            ? `<img class="avatar avatar-roster" src="/api/users/${r.user_id}/avatar" alt="${esc(r.callsign)}">`
            : `<span class="avatar avatar-empty avatar-roster" style="font-size:16px">${esc((r.callsign || '?').slice(0, 1).toUpperCase())}</span>`}
        </td>
        <td><span class="num">${esc(r.employee_number)}</span></td>
        <td class="callsign-cell">
          <span class="callsign-main" style="font-weight:700" title="${esc(r.callsign)}">${esc(r.callsign)}</span>
          ${r.created_at ? `<span class="num hire-date">с ${formatDate(r.created_at)}</span>` : ''}
        </td>
        <td>${esc(r.rank)}</td>
        <td>${esc(r.position)}</td>
        <td>${esc(r.age || '—')}</td>
        <td class="nowrap-cell"><span class="cell-ellipsis" title="${esc(r.discord || '—')}">${esc(r.discord || '—')}</span></td>
        <td>
          <span class="warn-cell">
            ${warningsBadge(r)}
            ${r.recert ? '<span class="recert-badge">Переаттестация</span>' : ''}
            ${vacationBadge(r)}
          </span>
        </td>
        <td>${statusHtml(r.status)}</td>
        ${manager
          ? `<td>
              <div class="row-actions">
                <button class="btn small" onclick="editRoster(${r.id})">Изменить</button>
                <button class="btn small ${r.status === 'active' ? 'danger' : ''}" onclick="toggleStatus(${r.id})">
                  ${r.status === 'active' ? 'Уволить' : 'Вернуть'}
                </button>
                ${
                  r.warnings < 3
                    ? `<button class="btn small warn" data-cs="${esc(r.callsign)}" onclick="addWarning(${r.id}, this.getAttribute('data-cs'))">Выговор</button>`
                    : ''
                }
                ${
                  r.warnings >= 3
                    ? `<button class="btn small danger" onclick="demoteRoster(${r.id}, '${esc(r.rank)}')">Понизить</button>`
                    : ''
                }
                ${
                  r.warnings > 0 && r.warnings < 3
                    ? `<button class="btn small" onclick="removeWarning(${r.id})">− Выговор</button>`
                    : ''
                }
                ${
                  r.vacation_until
                    ? `<button class="btn small" onclick="endVacation(${r.id})">− Отпуск</button>`
                    : `<button class="btn small vacation" data-cs="${esc(r.callsign)}" onclick="addVacation(${r.id}, this.getAttribute('data-cs'))">Отпуск</button>`
                }
                <button class="btn small danger" onclick="deleteRoster(${r.id})">Удалить</button>
                ${
                  r.warnings >= 3
                    ? `<button class="btn small span2" onclick="recertRoster(${r.id})">Переаттестация</button>`
                    : ''
                }
                ${
                  r.recert
                    ? `<button class="btn small ok span2" onclick="recertClear(${r.id})">Аттестация пройдена</button>`
                    : ''
                }
              </div>
            </td>`
          : ''}
      </tr>`
    )
    .join('');
}

function renderStats() {
  const el = document.getElementById('roster-stats');
  if (!el) return;
  const active = rosterData.filter((r) => r.status === 'active').length;
  const fired = rosterData.length - active;
  const warned = rosterData.filter((r) => r.warnings >= 3).length;
  el.innerHTML = `
    <span class="rstat"><b>${rosterData.length}</b> в списке</span>
    <span class="rstat ok"><b>${active}</b> в строю</span>
    <span class="rstat ${fired ? 'off' : ''}"><b>${fired}</b> уволено</span>
    <span class="rstat ${warned ? 'danger' : ''}"><b>${warned}</b> на грани выговора</span>`;
}

async function load() {
  const alertEl = document.getElementById('alert');
  const body = document.getElementById('roster-body');
  try {
    const data = await apiFetch('/api/roster');
    rosterData = (data && data.roster) || [];
    rosterData.sort(
      (a, b) => rankWeight(b) - rankWeight(a) || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    );
    renderStats();
    render();
  } catch (e) {
    showAlert(alertEl, 'err', e.message);
    if (body) {
      body.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--danger,#e5484d);padding:24px 0">Не удалось загрузить данные таблицы: ${esc(e.message)}<br><button class="btn small" style="margin-top:10px" onclick="load()">Повторить попытку</button></td></tr>`;
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initHeader('roster');
  if (!SITE.me) {
    window.location.href = '/login.html?next=roster.html';
    return;
  }

  const alertEl = document.getElementById('alert');
  const manager = isManager(SITE.me);

  document.getElementById('r-rank').innerHTML = optionsHtml(SITE.RANKS, 'Стажер');
  document.getElementById('r-position').innerHTML = optionsHtml(SITE.POSITIONS, 'Сотрудник О.Б.Р');

  document.getElementById('roster-search').addEventListener('input', (e) => {
    rosterFilter = e.target.value;
    render();
  });

  const untilInput = document.getElementById('w-until');
  const todayISO = new Date();
  const todayStr = `${todayISO.getFullYear()}-${String(todayISO.getMonth() + 1).padStart(2, '0')}-${String(todayISO.getDate()).padStart(2, '0')}`;
  attachDatePicker(untilInput, { min: todayStr });
  attachDatePicker(document.getElementById('v-until'), { min: todayStr });

  document.getElementById('warning-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitWarning();
  });

  document.getElementById('vacation-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitVacation();
  });

  if (manager) {
    document.getElementById('add-roster-btn').style.display = '';
    document.getElementById('actions-th').style.display = '';
    document.getElementById('add-roster-btn').addEventListener('click', () => {
      openRosterModal();
    });

    apiFetch('/api/users')
      .then((data) => {
        const users = (data && data.users) || [];
        const rUser = document.getElementById('r-user');
        if (rUser) {
          rUser.innerHTML =
            '<option value="">— не привязывать —</option>' +
            users
              .map(
                (u) =>
                  `<option value="${u.id}">${esc(u.username)} (${esc(SITE.roleLabels[u.role] || u.role)})</option>`
              )
              .join('');
        }
      })
      .catch((e) => console.warn('Failed to load users for roster binding:', e));
  }

  await load();

  const addSelfBtn = document.getElementById('add-self-btn');
  if (manager && addSelfBtn) {
    const inRoster = rosterData.some((r) => r.user_id === SITE.me.id);
    if (isCommander(SITE.me) && !inRoster) {
      addSelfBtn.style.display = '';
      addSelfBtn.addEventListener('click', addSelfRoster);
    }
  }

  document.getElementById('roster-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      employee_number: document.getElementById('r-number').value,
      callsign: document.getElementById('r-callsign').value,
      rank: document.getElementById('r-rank').value,
      position: document.getElementById('r-position').value,
      age: document.getElementById('r-age').value,
      discord: document.getElementById('r-discord').value,
      user_id: document.getElementById('r-user').value || null,
    };
    try {
      if (editingId) {
        await apiFetch(`/api/roster/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await apiFetch('/api/roster', { method: 'POST', body: JSON.stringify(payload) });
      }
      closeRosterModal();
      await load();
    } catch (err) {
      showAlert(document.getElementById('roster-modal-alert'), 'err', err.message);
    }
  });
});
