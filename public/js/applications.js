let approvingId = null;
let editingAppId = null;

document.addEventListener('DOMContentLoaded', async () => {
  await initHeader('apps');
  if (!SITE.me) {
    window.location.href = '/login.html?next=applications.html';
    return;
  }

  const alertEl = document.getElementById('alert');
  const manager = isManager(SITE.me);

  document.getElementById('a-rank').innerHTML = optionsHtml(SITE.RANKS, 'Стажер');
  document.getElementById('a-position').innerHTML = optionsHtml(SITE.POSITIONS, 'Сотрудник О.Б.Р');

  if (manager) {
    document.getElementById('apps-title').textContent = 'Все заявки';
    document.getElementById('back-link').style.display = 'none';
  }

  const typeTag = { join: 'join', leave: 'leave', builder: 'builder' };
  let applicationsData = [];
  let currentFilter = 'all';

  function updateStats(apps) {
    const pending = apps.filter((a) => a.status === 'pending').length;
    const approved = apps.filter((a) => a.status === 'approved').length;
    const rejected = apps.filter((a) => a.status === 'rejected').length;

    const elAll = document.getElementById('count-all');
    if (elAll) elAll.textContent = apps.length;
    const elPending = document.getElementById('count-pending');
    if (elPending) elPending.textContent = pending;
    const elJoin = document.getElementById('count-join');
    if (elJoin) elJoin.textContent = apps.filter((a) => a.type === 'join').length;
    const elBuilder = document.getElementById('count-builder');
    if (elBuilder) elBuilder.textContent = apps.filter((a) => a.type === 'builder').length;
    const elLeave = document.getElementById('count-leave');
    if (elLeave) elLeave.textContent = apps.filter((a) => a.type === 'leave').length;
    const elApproved = document.getElementById('count-approved');
    if (elApproved) elApproved.textContent = approved;
    const elRejected = document.getElementById('count-rejected');
    if (elRejected) elRejected.textContent = rejected;

    const statsEl = document.getElementById('apps-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <span class="rstat"><b>${apps.length}</b> всего</span>
        <span class="rstat warn"><b>${pending}</b> на рассмотрении</span>
        <span class="rstat ok"><b>${approved}</b> одобрено</span>
        <span class="rstat ${rejected ? 'danger' : ''}"><b>${rejected}</b> отклонено</span>`;
    }
  }

  function renderApps() {
    const list = document.getElementById('apps-list');
    let filtered = applicationsData;
    if (currentFilter === 'pending') {
      filtered = applicationsData.filter((a) => a.status === 'pending');
    } else if (currentFilter === 'approved') {
      filtered = applicationsData.filter((a) => a.status === 'approved');
    } else if (currentFilter === 'rejected') {
      filtered = applicationsData.filter((a) => a.status === 'rejected');
    } else if (currentFilter === 'join' || currentFilter === 'builder' || currentFilter === 'leave') {
      filtered = applicationsData.filter((a) => a.type === currentFilter);
    }

    if (!filtered.length) {
      list.innerHTML = `<div class="empty">${applicationsData.length ? 'Нет заявок по выбранному фильтру' : 'Заявок пока нет'}</div>`;
      return;
    }

    list.innerHTML = filtered
      .map((a, idx) => {
        const statusDone = a.status !== 'pending';
        let actions = '';
        if (manager && !statusDone) {
          if (a.type === 'join') {
            actions = `
              <button class="btn small ok" onclick="openApproveModal(${a.id})">Одобрить</button>
              <button class="btn small danger" onclick="rejectApp(${a.id})">Отклонить</button>
              <button class="btn small" onclick="openEditModal(${a.id})">Изменить</button>
              <button class="btn small danger" onclick="deleteApp(${a.id})">Удалить</button>`;
          } else if (a.type === 'builder') {
            actions = `
              <button class="btn small ok" onclick="approveBuilder(${a.id})">Одобрить</button>
              <button class="btn small danger" onclick="rejectApp(${a.id})">Отклонить</button>
              <button class="btn small" onclick="openEditModal(${a.id})">Изменить</button>
              <button class="btn small danger" onclick="deleteApp(${a.id})">Удалить</button>`;
          } else {
            actions = `
              <button class="btn small ok" onclick="approveLeave(${a.id})">Одобрить</button>
              <button class="btn small danger" onclick="rejectApp(${a.id})">Отклонить</button>
              <button class="btn small" onclick="openEditModal(${a.id})">Изменить</button>
              <button class="btn small danger" onclick="deleteApp(${a.id})">Удалить</button>`;
          }
        } else if (manager) {
          actions = `<button class="btn small danger" onclick="deleteApp(${a.id})">Удалить</button>`;
        }

        const isJoin = a.type === 'join';
        const isBuilder = a.type === 'builder';
        const meta = isBuilder
          ? `
            <span><b>Позывной:</b> ${esc(a.callsign || '—')}</span>
            <span><b>Отправитель:</b> ${esc(a.username || '—')}</span>`
          : isJoin
          ? `
            <span><b>Позывной:</b> ${esc(a.callsign || '—')}</span>
            <span><b>Возраст:</b> ${esc(a.age || '—')}</span>
            <span><b>Discord:</b> ${esc(a.discord || '—')}</span>`
          : `<span><b>Сотрудник:</b> ${esc(a.username || '—')}</span>`;

        const photosHtml = (a.photos && a.photos.length)
          ? `<div class="rep-attachments"><b>Файлы (${a.photos.length}):</b><div class="photo-grid">${a.photos
              .map(
                (p) =>
                  `<a href="/api/applications/${a.id}/photo/${p.id}" target="_blank" class="photo-thumb" title="${esc(p.filename)}">${/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(p.filename) ? `<img src="/api/applications/${a.id}/photo/${p.id}" alt="${esc(p.filename)}" loading="lazy">` : `<span class="file-badge">${esc(p.filename)}</span>`}</a>`
              )
              .join('')}</div></div>`
          : '';

        const builderBody = isBuilder
          ? `
            <div class="rep-theme"><b>Прошу принять меня на должность Билдера</b></div>
            <div class="rep-text">
              <div class="qa"><b>Позывной во фракции:</b> ${esc(a.callsign || '—')}</div>
              <div class="qa"><b>Причина идти на билдера:</b> ${esc(a.builder_reason || '—')}</div>
              <div class="qa"><b>Умение строить:</b> ${esc(a.builder_skill || '—')}</div>
              <div class="qa"><b>Что строил и готов ли показать билды:</b> ${esc(a.builder_builds || '—')}</div>
            </div>
            ${photosHtml}
            ${a.roster_callsign ? `<div class="rep-attachments"><b>Позывной в штате:</b> ${esc(a.roster_callsign)}</div>` : ''}`
          : isJoin
          ? `
            <div class="rep-theme"><b>Прошу принять меня в состав фракции О.Б.Р</b></div>
            <div class="rep-text">${esc(a.text || '—')}</div>
            ${a.roster_callsign ? `<div class="rep-attachments"><b>Позывной в штате:</b> ${esc(a.roster_callsign)}</div>` : ''}`
          : `
            <div class="rep-theme"><b>Прошу уволить меня из состава фракции О.Б.Р</b></div>
            <div class="rep-text">${esc(a.text || '—')}</div>
            ${a.roster_callsign ? `<div class="rep-attachments"><b>Позывной в штате:</b> ${esc(a.roster_callsign)}</div>` : ''}`;

        return `
        <div class="report-card reveal ${a.status}" style="--rd:${Math.min(idx * 60, 240)}ms">
          <div class="report-strip ${typeTag[a.type]}"></div>
          <div class="report-head">
            <div class="rep-stamp">${statusHtml(a.status)}</div>
            <div class="rep-title">ЗАЯВЛЕНИЕ</div>
            <div class="rep-type">${isBuilder ? 'На должность Билдера' : isJoin ? 'О вступлении' : 'Об увольнении'}</div>
            <div class="rep-to">Командованию О.Б.Р.</div>
            <div class="rep-from">${avatarInline(a)} От <b>${isBuilder || isJoin ? esc(a.callsign || a.username || '—') : esc(a.username || '—')}</b></div>
          </div>
          <div class="report-meta">
            ${meta}
            <span><b>Отправлено:</b> ${formatDate(a.created_at)}</span>
          </div>
          <div class="report-body">
            ${builderBody}
          </div>
          <div class="report-sign">
            ${a.reviewed_at ? `<div class="rep-review">Рассмотрено командованием: ${formatDate(a.reviewed_at)}</div>` : ''}
            <div class="rep-sig-line">Заявитель: <i>${esc(a.username || '—')}</i></div>
          </div>
          ${actions ? `<div class="report-actions"><div class="row-actions">${actions}</div></div>` : ''}
        </div>`;
      })
      .join('');
  }

  document.querySelectorAll('#apps-filter-bar .filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#apps-filter-bar .filter-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderApps();
    });
  });

  async function load() {
    try {
      const data = await apiFetch('/api/applications');
      applicationsData = (data && data.applications) || [];
      updateStats(applicationsData);
      renderApps();
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  }
  await load();

  // ---------- Одобрение вступления ----------
  window.openApproveModal = async (id) => {
    approvingId = id;
    const data = await apiFetch('/api/applications');
    const a = data.applications.find((x) => x.id === id);
    if (!a) return;
    document.getElementById('approve-applicant').textContent = `Заявитель: ${a.username}`;
    document.getElementById('a-number').value = '';
    document.getElementById('a-callsign').value = a.callsign || a.username || '';
    document.getElementById('a-rank').value = 'Стажер';
    document.getElementById('a-position').value = 'Сотрудник О.Б.Р';
    document.getElementById('a-age').value = a.age || '';
    document.getElementById('a-discord').value = a.discord || '';
    clearAlert(document.getElementById('approve-alert'));
    document.getElementById('approve-modal').style.display = 'flex';
  };

  window.closeApproveModal = () => {
    document.getElementById('approve-modal').style.display = 'none';
  };

  document.getElementById('approve-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch(`/api/applications/${approvingId}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          employee_number: document.getElementById('a-number').value,
          callsign: document.getElementById('a-callsign').value,
          rank: document.getElementById('a-rank').value,
          position: document.getElementById('a-position').value,
          age: document.getElementById('a-age').value,
          discord: document.getElementById('a-discord').value,
        }),
      });
      closeApproveModal();
      await load();
      showAlert(alertEl, 'ok', 'Сотрудник добавлен в штатное расписание');
    } catch (err) {
      showAlert(document.getElementById('approve-alert'), 'err', err.message);
    }
  });

  // ---------- Одобрение увольнения ----------
  window.approveLeave = async (id) => {
    const ok = await showConfirmModal({
      title: 'Одобрение увольнения',
      message: 'Одобрить увольнение? Сотрудник будет исключён из штатного расписания.',
      confirmText: 'Одобрить увольнение',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/applications/${id}/approve`, { method: 'POST' });
      await load();
      showToast('ok', 'Увольнение одобрено, сотрудник убран из штатного расписания');
    } catch (e) {
      showToast('err', e.message);
    }
  };

  window.rejectApp = async (id) => {
    const ok = await showConfirmModal({
      title: 'Отклонение заявки',
      message: 'Вы уверены, что хотите отклонить эту заявку?',
      confirmText: 'Отклонить',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/applications/${id}/reject`, { method: 'POST' });
      await load();
      showToast('info', 'Заявка отклонена');
    } catch (e) {
      showToast('err', e.message);
    }
  };

  window.approveBuilder = async (id) => {
    const ok = await showConfirmModal({
      title: 'Одобрение заявки на билдера',
      message: 'Одобрить заявку на билдера? Сотрудник получит роль Билдера в Discord.',
      confirmText: 'Одобрить',
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/applications/${id}/approve`, { method: 'POST' });
      await load();
      showToast('ok', 'Заявка одобрена, сотрудник назначен Билдером');
    } catch (e) {
      showToast('err', e.message);
    }
  };

  window.deleteApp = async (id) => {
    const ok = await showConfirmModal({
      title: 'Удаление заявки',
      message: 'Удалить заявку безвозвратно?',
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/applications/${id}`, { method: 'DELETE' });
      await load();
      showToast('ok', 'Заявка удалена');
    } catch (e) {
      showToast('err', e.message);
    }
  };

  // ---------- Редактирование ----------
  window.openEditModal = async (id) => {
    editingAppId = id;
    const data = await apiFetch('/api/applications');
    const a = data.applications.find((x) => x.id === id);
    if (!a) return;
    document.getElementById('e-text').value = a.text || '';
    clearAlert(document.getElementById('edit-alert'));
    document.getElementById('edit-modal').style.display = 'flex';
  };

  window.closeEditModal = () => {
    document.getElementById('edit-modal').style.display = 'none';
  };

  document.getElementById('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch(`/api/applications/${editingAppId}`, {
        method: 'PUT',
        body: JSON.stringify({ text: document.getElementById('e-text').value }),
      });
      closeEditModal();
      await load();
    } catch (err) {
      showAlert(document.getElementById('edit-alert'), 'err', err.message);
    }
  });
});
