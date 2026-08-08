let selectedPhotos = [];

document.addEventListener('DOMContentLoaded', async () => {
  await initHeader('reports');
  if (!SITE.me) {
    window.location.href = '/login.html?next=reports.html';
    return;
  }
  if (!isStaff(SITE.me)) {
    window.location.href = '/';
    return;
  }

  const alertEl = document.getElementById('alert');
  const manager = isManager(SITE.me);
  const typeLabel = { report: 'Рапорт', promotion: 'На повышение', complaint: 'Жалоба', vacation: 'Заявка на отпуск' };

  document.getElementById('r-date').value = new Date().toLocaleDateString('ru-RU');

  const rType = document.getElementById('r-type');
  const vacDates = document.getElementById('r-vacation-dates');
  const vacFrom = document.getElementById('r-v-from');
  const vacTo = document.getElementById('r-v-to');

  function syncVacationFields() {
    const isVac = rType.value === 'vacation';
    vacDates.style.display = isVac ? '' : 'none';
    vacFrom.required = isVac;
    vacTo.required = isVac;
  }
  rType.addEventListener('change', syncVacationFields);
  syncVacationFields();

  const vacTodayISO = new Date();
  const vacTodayStr = `${vacTodayISO.getFullYear()}-${String(vacTodayISO.getMonth() + 1).padStart(2, '0')}-${String(vacTodayISO.getDate()).padStart(2, '0')}`;
  const vacToISO = (s) => {
    const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  };
  attachDatePicker(vacFrom, { min: vacTodayStr });
  attachDatePicker(vacTo, { min: vacTodayStr });
  const syncVacationTo = () => {
    if (vacFrom.value && (!vacTo.value || vacToISO(vacTo.value) < vacToISO(vacFrom.value))) {
      vacTo.value = vacFrom.value;
    }
  };
  vacFrom.addEventListener('input', syncVacationTo);
  vacFrom.addEventListener('change', syncVacationTo);

  try {
    const data = await apiFetch('/api/roster');
    const me = (data.roster || []).find(
      (r) => r.user_id === SITE.me.id && r.status === 'active'
    );
    if (me) {
      document.getElementById('r-sig').value = `${me.rank} ${me.callsign}`;
    }
  } catch (_) {}
  if (!document.getElementById('r-sig').value) {
    document.getElementById('r-sig').value = SITE.me.username;
  }

  const authorBox = document.getElementById('report-author');
  if (authorBox && SITE.me) {
    authorBox.innerHTML = `
      <span class="report-author-av">${avatarImg(SITE.me.id, SITE.me.avatar, SITE.me.username, 44)}</span>
      <div class="report-author-info">
        <div class="report-author-name">${esc(SITE.me.username)}</div>
        <div class="report-author-role">${esc(SITE.roleLabels[SITE.me.role] || SITE.me.role)}</div>
      </div>`;
  }

  document.getElementById('report-form-btn').addEventListener('click', () => {
    const box = document.getElementById('report-form-box');
    box.style.display = box.style.display === 'none' ? '' : 'none';
  });

  const photosInput = document.getElementById('r-photos');
  const previewBox = document.getElementById('r-photos-preview');

  let photoUrls = [];

  function renderPhotoPreview() {
    photoUrls.forEach((u) => URL.revokeObjectURL(u));
    photoUrls = selectedPhotos.map((f) => URL.createObjectURL(f));
    previewBox.innerHTML = selectedPhotos
      .map(
        (f, i) => `
        <div class="photo-preview-item">
          <img src="${photoUrls[i]}" alt="">
          <button type="button" class="photo-remove" onclick="removeSelectedPhoto(${i})">×</button>
        </div>`
      )
      .join('');
    document.getElementById('r-photo-count').textContent = `${selectedPhotos.length} / 15`;
  }

  window.removeSelectedPhoto = (i) => {
    selectedPhotos.splice(i, 1);
    renderPhotoPreview();
  };

  photosInput.addEventListener('change', () => {
    const remain = 15 - selectedPhotos.length;
    const files = Array.from(photosInput.files).slice(0, remain);
    if (!files.length && selectedPhotos.length >= 15) {
      showAlert(alertEl, 'err', 'Можно прикрепить не более 15 фото');
    }
    selectedPhotos = selectedPhotos.concat(files);
    renderPhotoPreview();
    photosInput.value = '';
  });

  document.getElementById('report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('report-submit-btn');
    btn.disabled = true;
    try {
      let photos = [];
      if (selectedPhotos.length) {
        const fd = new FormData();
        for (const f of selectedPhotos) fd.append('photos', f);
        const up = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
        const upData = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(upData.error || 'Не удалось загрузить фото');
        photos = upData.files;
      }
      await apiFetch('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          type: document.getElementById('r-type').value,
          theme: document.getElementById('r-theme').value,
          text: document.getElementById('r-text').value,
          attachments: document.getElementById('r-attachments').value,
          signature: document.getElementById('r-sig').value,
          photos,
          v_from: document.getElementById('r-v-from').value,
          v_to: document.getElementById('r-v-to').value,
        }),
      });
      e.target.reset();
      selectedPhotos = [];
      renderPhotoPreview();
      document.getElementById('r-date').value = new Date().toLocaleDateString('ru-RU');
      document.getElementById('report-form-box').style.display = 'none';
      syncVacationFields();
      showAlert(alertEl, 'ok', 'Рапорт отправлен командованию');
      await load();
    } catch (err) {
      showAlert(alertEl, 'err', err.message);
    } finally {
      btn.disabled = false;
    }
  });

  function photosHtml(report) {
    if (!report.photos || !report.photos.length) return '';
    return `
      <div class="report-photos">
        ${report.photos
          .map(
            (p) => `
          <div class="report-photo-item" onclick="openLightbox('/api/reports/${report.id}/photo/${p.id}')">
            <img src="/api/reports/${report.id}/photo/${p.id}" alt="${esc(p.filename)}" loading="lazy">
          </div>`
          )
          .join('')}
      </div>`;
  }

  async function load() {
    try {
      const data = await apiFetch('/api/reports');
      const list = document.getElementById('reports-list');
      if (!data.reports.length) {
        list.innerHTML = '<div class="empty">Рапортов пока нет</div>';
        return;
      }
      list.innerHTML = data.reports
        .map((r, i) => {
          let actions = '';
          if (manager) {
            actions += `<button class="btn small ${r.status === 'open' ? 'primary' : ''}" onclick="toggleReportStatus(${r.id})">${r.status === 'open' ? 'Отметить рассмотренным' : 'Вернуть в работу'}</button>`;
          }
          if (manager || r.user_id === SITE.me.id) {
            actions += `<button class="btn small danger" onclick="deleteReport(${r.id})">Удалить</button>`;
          }
          const photosCount = (r.photos || []).length;
          return `
          <div class="report-card reveal ${r.status}" style="--rd:${Math.min(i * 70, 280)}ms">
            <div class="report-strip ${r.type}"></div>
            <div class="report-head">
              <div class="rep-stamp">${statusHtml(r.status)}</div>
              <div class="rep-title">РАПОРТ</div>
              <div class="rep-type">${typeLabel[r.type] || 'Рапорт'}</div>
              <div class="rep-to">Командованию О.Б.Р.</div>
              <div class="rep-from">${avatarInline(r)} От <b>${esc(r.signature || r.username || '—')}</b></div>
            </div>
            <div class="report-meta">
              <span><b>Автор:</b> ${esc(r.username || '—')}</span>
              <span><b>Дата:</b> ${esc(r.date)}</span>
              <span><b>Отправлено:</b> ${formatDate(r.created_at)}</span>
            </div>
            <div class="report-body">
              ${r.v_from && r.v_to ? `<div class="rep-vacation"><b>Отпуск:</b> с ${esc(r.v_from)} по ${esc(r.v_to)}</div>` : ''}
              <div class="rep-theme"><b>Тема:</b> ${esc(r.theme)}</div>
              <div class="rep-text">${esc(r.text)}</div>
              ${r.attachments ? `<div class="rep-attachments"><b>Приложения:</b> ${esc(r.attachments)}</div>` : ''}
            </div>
            ${photosCount ? `<div class="report-photos-block"><div class="rep-photos-title">Приложенные фото и скриншоты (${photosCount})</div>${photosHtml(r)}</div>` : ''}
            <div class="report-sign">
              ${r.status === 'done' && r.reviewed_at ? `<div class="rep-review">Рассмотрено командованием: ${formatDate(r.reviewed_at)}</div>` : ''}
              <div class="rep-sig-line">Подпись: <i>${esc(r.signature || '—')}</i></div>
            </div>
            ${actions ? `<div class="report-actions"><div class="row-actions">${actions}</div></div>` : ''}
          </div>`;
        })
        .join('');
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  }
  await load();

  window.toggleReportStatus = async (id) => {
    try {
      await apiFetch(`/api/reports/${id}/status`, { method: 'PUT' });
      await load();
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  };

  window.deleteReport = async (id) => {
    if (!confirm('Удалить рапорт?')) return;
    try {
      await apiFetch(`/api/reports/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  };

  window.openLightbox = (src) => {
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox').classList.add('open');
  };

  window.closeLightbox = () => {
    document.getElementById('lightbox').classList.remove('open');
    document.getElementById('lightbox-img').src = '';
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });
});
