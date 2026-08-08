document.addEventListener('DOMContentLoaded', async () => {
  await initHeader('home');

  const alertEl = document.getElementById('alert');

  // ---------- Информация о фракции ----------
  async function loadFaction() {
    try {
      const data = await apiFetch('/api/faction');
      document.getElementById('faction-desc').textContent = data.description || '';
      const commander = data.commander
        .map((c) => `${esc(c.callsign)}${c.rank ? ' · ' + esc(c.rank) : ''}`)
        .join('<br>');
      const zam = data.zam
        .map((z) => `${esc(z.callsign)}${z.rank ? ' · ' + esc(z.rank) : ''}`)
        .join('<br>');
      document.getElementById('commander-name').innerHTML = commander || '—';
      document.getElementById('zam-name').innerHTML = zam || '—';
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  }
  await loadFaction();

  const user = SITE.me;

  // Редактирование описания — только командир
  const editDescBox = document.getElementById('edit-desc-box');
  if (isCommander(user)) {
    document.getElementById('edit-desc-btn').style.display = '';
    document.getElementById('edit-desc-btn').addEventListener('click', () => {
      document.getElementById('desc-input').value = document.getElementById('faction-desc').textContent;
      editDescBox.style.display = '';
      document.getElementById('edit-desc-btn').style.display = 'none';
    });
    document.getElementById('cancel-desc-btn').addEventListener('click', () => {
      editDescBox.style.display = 'none';
      document.getElementById('edit-desc-btn').style.display = '';
    });
    document.getElementById('save-desc-btn').addEventListener('click', async () => {
      try {
        await apiFetch('/api/faction', {
          method: 'PUT',
          body: JSON.stringify({ description: document.getElementById('desc-input').value }),
        });
        showAlert(alertEl, 'ok', 'Описание сохранено');
        editDescBox.style.display = 'none';
        document.getElementById('edit-desc-btn').style.display = '';
        await loadFaction();
      } catch (e) {
        showAlert(alertEl, 'err', e.message);
      }
    });
  }

  // ---------- Документация ----------
  const addDocBox = document.getElementById('add-doc-box');
  if (isManager(user)) {
    document.getElementById('add-doc-btn').style.display = '';
    document.getElementById('add-doc-btn').addEventListener('click', () => {
      addDocBox.style.display = '';
      document.getElementById('add-doc-btn').style.display = 'none';
    });
    document.getElementById('cancel-doc-btn').addEventListener('click', () => {
      addDocBox.style.display = 'none';
      document.getElementById('add-doc-btn').style.display = '';
    });
    document.getElementById('doc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('title', document.getElementById('doc-title').value);
      fd.append('description', document.getElementById('doc-desc').value);
      fd.append('access', document.getElementById('doc-access').value);
      fd.append('file', document.getElementById('doc-file').files[0]);
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/documents', { method: 'POST', body: fd, credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');
        showAlert(alertEl, 'ok', 'Документ закреплён');
        e.target.reset();
        addDocBox.style.display = 'none';
        document.getElementById('add-doc-btn').style.display = '';
        await loadDocs();
      } catch (err) {
        showAlert(alertEl, 'err', err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'];
  const PREVIEW_EXT = [...IMAGE_EXT, '.pdf', '.docx'];
  let docsCache = [];

  function fileExt(filename) {
    const m = (filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
    return m ? m[0] : '';
  }

  function canPreview(filename) {
    return PREVIEW_EXT.includes(fileExt(filename));
  }

  function sanitizeDocxHtml(html) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    d.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach((n) => n.remove());
    d.querySelectorAll('*').forEach((n) => {
      for (const attr of Array.from(n.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || (name === 'href' && /^\s*javascript:/i.test(attr.value))) {
          n.removeAttribute(attr.name);
        }
      }
    });
    return d.body.innerHTML;
  }

  window.openPreview = (id) => {
    const doc = docsCache.find((x) => x.id === id);
    const ext = fileExt(doc ? doc.filename : '');
    const body = document.getElementById('preview-body');
    body.innerHTML = '';
    document.getElementById('preview-title').textContent = (doc && doc.title) || 'Документ';
    if (ext === '.pdf') {
      const frame = document.createElement('iframe');
      frame.src = `/api/documents/${id}/view`;
      body.appendChild(frame);
    } else if (ext === '.docx') {
      const box = document.createElement('div');
      box.className = 'docx-preview';
      box.textContent = 'Загрузка…';
      body.appendChild(box);
      fetch(`/api/documents/${id}/view`, { credentials: 'same-origin' })
        .then((r) =>
          r.ok
            ? r.text()
            : r.json().then((d) => Promise.reject(new Error(d.error || 'Ошибка загрузки')))
        )
        .then((html) => {
          box.innerHTML = sanitizeDocxHtml(html);
        })
        .catch((err) => {
          box.textContent = err.message;
        });
    } else {
      const img = document.createElement('img');
      img.src = `/api/documents/${id}/view`;
      img.alt = 'Предпросмотр документа';
      body.appendChild(img);
    }
    document.getElementById('preview-modal').style.display = 'flex';
  };

  window.closePreview = () => {
    document.getElementById('preview-modal').style.display = 'none';
    document.getElementById('preview-body').innerHTML = '';
  };

  async function loadDocs() {
    if (!user) {
      document.getElementById('docs-list').innerHTML =
        '<div class="empty">Документация доступна после <a href="/login.html" style="color:var(--accent);font-weight:700">входа</a>.</div>';
      return;
    }
    try {
      const data = await apiFetch('/api/documents');
      docsCache = data.documents || [];
      const list = document.getElementById('docs-list');
      if (!data.documents.length) {
        list.innerHTML = '<div class="empty">Документов пока нет</div>';
        return;
      }
      list.innerHTML = data.documents
        .map(
          (d, i) => `
        <div class="doc-item reveal" style="--rd:${Math.min(i * 60, 240)}ms">
          <div class="icon">Док</div>
          <div class="meta">
            <div class="name">${esc(d.title)}</div>
            ${d.description ? `<div class="desc">${esc(d.description)}</div>` : ''}
            <div class="extra">${esc(d.filename)} · ${formatDate(d.created_at)}</div>
          </div>
          <span class="flag ${d.access}">${d.access === 'dsp' ? 'ДСП' : 'Персонал'}</span>
          ${canPreview(d.filename) ? `<button class="btn small" onclick="openPreview(${d.id})">Просмотр</button>` : ''}
          <a class="btn small primary" href="/api/documents/${d.id}/download">Скачать</a>
          ${isManager(user) ? `<button class="btn small danger" onclick="deleteDoc(${d.id})">Удалить</button>` : ''}
        </div>`
        )
        .join('');
    } catch (e) {
      document.getElementById('docs-list').innerHTML =
        `<div class="empty">${esc(e.message)}</div>`;
    }
  }
  await loadDocs();

  window.deleteDoc = async (id) => {
    if (!confirm('Удалить документ?')) return;
    try {
      await apiFetch(`/api/documents/${id}`, { method: 'DELETE' });
      await loadDocs();
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  };

  // ---------- Заявления ----------
  const joinBox = document.getElementById('join-box');
  const leaveBox = document.getElementById('leave-box');
  const loginHint = document.getElementById('login-hint');

  if (!user) {
    loginHint.style.display = '';
  } else if (isStaff(user)) {
    leaveBox.style.display = '';
  } else {
    joinBox.style.display = '';
  }

  // ---------- Заявка на билдера (персонал) ----------
  const builderBox = document.getElementById('builder-box');
  const builderFilesInput = document.getElementById('b-files');
  const builderFilesHint = document.getElementById('b-files-hint');
  if (isStaff(user)) {
    builderBox.style.display = '';
    builderFilesInput.addEventListener('change', () => {
      const n = builderFilesInput.files.length;
      builderFilesHint.textContent = n ? `Выбрано файлов: ${n}` : 'Файлы не выбраны';
      if (n > 15) {
        const dt = new DataTransfer();
        for (const f of Array.from(builderFilesInput.files).slice(0, 15)) dt.items.add(f);
        builderFilesInput.files = dt.files;
        builderFilesHint.textContent = 'Выбрано файлов: 15 (максимум)';
      }
    });
    document.getElementById('builder-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('builder-submit');
      submitBtn.disabled = true;
      try {
        let photos = [];
        const files = Array.from(builderFilesInput.files).slice(0, 15);
        if (files.length) {
          const fd = new FormData();
          for (const f of files) fd.append('photos', f);
          const upRes = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
          const upData = await upRes.json();
          if (!upRes.ok) throw new Error(upData.error || 'Ошибка загрузки файлов');
          photos = upData.files || [];
        }
        await apiFetch('/api/applications', {
          method: 'POST',
          body: JSON.stringify({
            type: 'builder',
            callsign: document.getElementById('b-callsign').value,
            reason: document.getElementById('b-reason').value,
            skill: document.getElementById('b-skill').value,
            builds: document.getElementById('b-builds').value,
            photos,
          }),
        });
        showAlert(alertEl, 'ok', 'Заявка на билдера отправлена! Ожидайте решения руководства.');
        builderBox.style.display = 'none';
        const note = document.createElement('div');
        note.className = 'empty';
        note.textContent = 'Ваша заявка на билдера на рассмотрении. Статус можно смотреть в разделе «Заявки».';
        builderBox.parentElement.insertBefore(note, builderBox);
      } catch (err) {
        showAlert(alertEl, 'err', err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  document.getElementById('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = [
      'Заявка на вступление во фракцию О.Б.Р',
      '',
      'Вопросы и ответы:',
      `• Какой позывной? — ${document.getElementById('j-callsign').value}`,
      `• Сколько вам лет? — ${document.getElementById('j-age').value}`,
      `• Ваш юзер в Discord? — ${document.getElementById('j-discord').value}`,
      `• Чем будете полезны во фракции? — ${document.getElementById('j-useful').value}`,
      `• Расскажите о себе (3+ предложений) — ${document.getElementById('j-about').value}`,
      `• Соблюдать правила? — ${document.getElementById('j-rules').value}`,
      `• Активити? — ${document.getElementById('j-active').value}`,
    ].join('\n');

    const submitBtn = document.getElementById('join-submit');
    submitBtn.disabled = true;
    try {
      await apiFetch('/api/applications', {
        method: 'POST',
        body: JSON.stringify({
          type: 'join',
          text,
          callsign: document.getElementById('j-callsign').value,
          age: document.getElementById('j-age').value,
          discord: document.getElementById('j-discord').value,
        }),
      });
      showAlert(alertEl, 'ok', 'Заявка отправлена! Ожидайте решения руководства.');
      joinBox.style.display = 'none';
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = 'Ваша заявка на рассмотрении. Следить за статусом можно в разделе «Заявки».';
      joinBox.parentElement.insertBefore(note, joinBox);
    } catch (err) {
      showAlert(alertEl, 'err', err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById('leave-submit').addEventListener('click', async () => {
    if (!confirm('Отправить заявление об увольнении?')) return;
    try {
      await apiFetch('/api/applications', {
        method: 'POST',
        body: JSON.stringify({ type: 'leave', text: document.getElementById('leave-text').value }),
      });
      showAlert(alertEl, 'ok', 'Заявление об увольнении отправлено.');
      document.getElementById('leave-text').value = '';
      leaveBox.style.display = 'none';
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  });
});
