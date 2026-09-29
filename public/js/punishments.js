function untilExpired(untilDate) {
  if (!untilDate) return false;
  const m = String(untilDate).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return false;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return d < now;
}

function punishmentStatus(p) {
  if (p.status === 'removed') return 'removed';
  if (untilExpired(p.until_date)) return 'expired';
  return 'active';
}

function punStamp(status) {
  const map = {
    active: ['ДЕЙСТВУЕТ', 'active'],
    expired: ['СРОК ИСТЁК', 'expired'],
    removed: ['СНЯТО', 'removed'],
  };
  const [label, cls] = map[status] || [status, ''];
  return `<span class="status ${cls}">${esc(label)}</span>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  await initHeader('punishments');
  if (!SITE.me) {
    window.location.href = '/login.html?next=punishments.html';
    return;
  }
  if (!isStaff(SITE.me)) {
    window.location.href = '/';
    return;
  }

  const alertEl = document.getElementById('alert');
  const manager = isManager(SITE.me);

  async function load() {
    try {
      const data = await apiFetch('/api/punishments');
      const list = document.getElementById('punishments-list');
      const punishments = (data && data.punishments) || [];
      if (!punishments.length) {
        list.innerHTML = '<div class="empty">Наказаний пока нет</div>';
        return;
      }
      list.innerHTML = punishments
        .map((p, i) => {
          const status = punishmentStatus(p);
          let actions = '';
          if (manager && status !== 'removed') {
            actions += `<button class="btn small" onclick="removePunishment(${p.id})">Снять наказание</button>`;
          }
          return `
          <div class="report-card reveal punishment-card ${status}" style="--rd:${Math.min(i * 70, 280)}ms">
            <div class="report-strip punishment ${status}"></div>
            <div class="report-head">
              <div class="rep-stamp">${punStamp(status)}</div>
              <div class="rep-title">ВЫГОВОР</div>
              <div class="rep-type">Официальное взыскание</div>
              <div class="rep-to">Вынесено по решению командования О.Б.Р.</div>
            </div>
            <div class="report-meta">
              <span><b>Сотрудник:</b> ${esc(p.callsign || '—')}</span>
              <span><b>Вынес:</b> ${esc(p.issued_by || '—')}</span>
              <span><b>Опубликовано:</b> ${formatDate(p.created_at)}</span>
            </div>
            <div class="report-body">
              <div class="rep-theme"><b>За что:</b> ${esc(p.reason || '—')}</div>
            </div>
            <div class="punishment-until">
              <b>Срок действия:</b> до <b>${esc(p.until_date || '—')}</b>
              ${status === 'expired' ? '<span class="pun-note">— срок истёк, выговор отбыт</span>' : ''}
              ${status === 'removed' && p.removed_at ? `<span class="pun-note">— снято: ${formatDate(p.removed_at)}</span>` : ''}
            </div>
            ${actions ? `<div class="report-actions"><div class="row-actions">${actions}</div></div>` : ''}
          </div>`;
        })
        .join('');
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
      const list = document.getElementById('punishments-list');
      if (list) {
        list.innerHTML = `<div class="empty" style="color:var(--danger,#e5484d)">Не удалось загрузить наказания: ${esc(e.message)}<br><button class="btn small" style="margin-top:10px" onclick="location.reload()">Повторить</button></div>`;
      }
    }
  }

  window.removePunishment = async (id) => {
    const ok = await showConfirmModal({
      title: 'Снятие наказания',
      message: 'Снять это наказание? Выговор у сотрудника в личном деле будет аннулирован.',
      confirmText: 'Снять наказание',
      danger: false,
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/punishments/${id}/remove`, { method: 'POST' });
      await load();
      showToast('ok', 'Наказание успешно снято');
    } catch (e) {
      showToast('err', e.message);
    }
  };

  await load();
});
