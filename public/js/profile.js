document.addEventListener('DOMContentLoaded', async () => {
  await initHeader('profile');

  const alertEl = document.getElementById('alert');
  const user = SITE.me;
  if (!user) {
    location.href = '/login.html';
    return;
  }

  document.getElementById('p-username').textContent = user.username;
  const roleEl = document.getElementById('p-role');
  roleEl.textContent = SITE.roleLabels[user.role] || user.role;
  roleEl.classList.add(roleClass(user.role));
  document.getElementById('p-created').textContent = formatDate(user.created_at);
  const discordTagEl = document.getElementById('p-discord-tag');
  if (discordTagEl) {
    discordTagEl.textContent = user.discord_username ? `@${user.discord_username}` : 'не привязан';
  }
  document.getElementById('p-about').value = user.about || '';

  function renderAvatar() {
    const box = document.getElementById('avatar-preview');
    box.innerHTML = avatarImg(user.id, user.avatar, user.username, 110);
  }
  renderAvatar();

  // ---------- Загрузка аватара ----------
  const avatarInput = document.getElementById('avatar-input');
  document.getElementById('avatar-wrap').addEventListener('click', () => avatarInput.click());

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('avatar', file);
      const res = await fetch('/api/users/me/avatar', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Ошибка загрузки аватара');
      SITE.me = data.user;
      user.avatar = data.user.avatar;
      renderAvatar();
      refreshHeaderUser();
      showAlert(alertEl, 'ok', 'Аватар обновлён');
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    } finally {
      avatarInput.value = '';
    }
  });

  // ---------- Смена никнейма ----------
  const usernameBadge = document.getElementById('current-username-badge');
  const usernameInput = document.getElementById('p-username-input');
  if (usernameBadge) usernameBadge.textContent = user.username;
  if (usernameInput) usernameInput.value = user.username;

  document.getElementById('p-username-save').addEventListener('click', async () => {
    const nextName = (usernameInput ? usernameInput.value : '').trim();
    if (!nextName) {
      showAlert(alertEl, 'err', 'Введите новый никнейм');
      return;
    }
    try {
      const data = await apiFetch('/api/users/me/username', {
        method: 'POST',
        body: JSON.stringify({ username: nextName }),
      });
      SITE.me = data.user;
      user.username = data.user.username;
      document.getElementById('p-username').textContent = user.username;
      if (usernameBadge) usernameBadge.textContent = user.username;
      renderAvatar();
      await refreshHeaderUser();
      showAlert(alertEl, 'ok', `Никнейм успешно изменён на «${user.username}»`);
      showToast('ok', 'Никнейм обновлён');
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  });

  // ---------- О себе ----------
  document.getElementById('p-about-save').addEventListener('click', async () => {
    try {
      const data = await apiFetch('/api/users/me/profile', {
        method: 'POST',
        body: JSON.stringify({ about: document.getElementById('p-about').value }),
      });
      SITE.me = data.user;
      user.about = data.user.about;
      showAlert(alertEl, 'ok', 'О себе сохранено');
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  });

  // ---------- Смена пароля ----------
  document.getElementById('p-pass-save').addEventListener('click', async () => {
    try {
      await apiFetch('/api/users/me/password', {
        method: 'POST',
        body: JSON.stringify({
          current: document.getElementById('p-pass-current').value,
          next: document.getElementById('p-pass-next').value,
        }),
      });
      document.getElementById('p-pass-current').value = '';
      document.getElementById('p-pass-next').value = '';
      showAlert(alertEl, 'ok', 'Пароль изменён');
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  });

  // ---------- Доп. безопасность ----------
  const secCard = document.getElementById('s-question');
  const secCurrent = document.getElementById('sec-current');
  const secAnswer = document.getElementById('s-answer');
  const secPassword = document.getElementById('s-password');
  const secRemove = document.getElementById('s-remove');
  secCard.innerHTML = optionsHtml(SITE.SECURITY_QUESTIONS, user.security_question || '');

  function renderSecurity() {
    const has = !!(user.has_security && user.security_question);
    if (has) {
      secCurrent.style.display = '';
      secCurrent.textContent = 'Включено. Вопрос: «' + user.security_question + '»';
      secCard.value = user.security_question;
      secAnswer.value = '';
      secRemove.style.display = '';
    } else {
      secCurrent.style.display = 'none';
      secCard.value = SITE.SECURITY_QUESTIONS[0];
      secAnswer.value = '';
      secRemove.style.display = 'none';
    }
    secPassword.value = '';
  }
  renderSecurity();

  document.getElementById('s-save').addEventListener('click', async () => {
    try {
      const data = await apiFetch('/api/users/me/security', {
        method: 'POST',
        body: JSON.stringify({
          action: 'set',
          password: secPassword.value,
          question: secCard.value,
          answer: secAnswer.value,
        }),
      });
      SITE.me = data.user;
      user.has_security = data.user.has_security;
      user.security_question = data.user.security_question;
      renderSecurity();
      showAlert(alertEl, 'ok', 'Контрольный вопрос сохранён');
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  });

  secRemove.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Отключение контрольного вопроса',
      message: 'Вы уверены, что хотите отключить контрольный вопрос для восстановления?',
      confirmText: 'Отключить вопрос',
      danger: true,
    });
    if (!ok) return;
    try {
      const data = await apiFetch('/api/users/me/security', {
        method: 'POST',
        body: JSON.stringify({ action: 'remove', password: secPassword.value }),
      });
      SITE.me = data.user;
      user.has_security = data.user.has_security;
      user.security_question = data.user.security_question;
      renderSecurity();
      showToast('ok', 'Контрольный вопрос отключён');
    } catch (e) {
      showToast('err', e.message);
    }
  });

  // ---------- Новостная строка (командир) ----------
  if (isCommander(user)) {
    const newsCard = document.getElementById('news-card');
    newsCard.style.display = '';
    const nEnabled = document.getElementById('n-enabled');
    const nMode = document.getElementById('n-mode');
    const nSpeed = document.getElementById('n-speed');
    const nText = document.getElementById('n-text');
    const nCount = document.getElementById('n-count');
    const updateCount = () => {
      nCount.textContent = nText.value.length;
    };
    nText.addEventListener('input', updateCount);

    try {
      const data = await apiFetch('/api/news');
      if (nEnabled) nEnabled.checked = !!data.enabled;
      if (nMode) nMode.value = data.mode || 'info';
      if (nSpeed) nSpeed.value = data.speed || 'normal';
      nText.value = data.text || '';
    } catch (_) {}
    updateCount();

    document.getElementById('n-save').addEventListener('click', async () => {
      try {
        const data = await apiFetch('/api/news', {
          method: 'PUT',
          body: JSON.stringify({
            text: nText.value,
            enabled: nEnabled ? nEnabled.checked : true,
            mode: nMode ? nMode.value : 'info',
            speed: nSpeed ? nSpeed.value : 'normal',
          }),
        });
        nText.value = data.text;
        if (nEnabled) nEnabled.checked = !!data.enabled;
        if (nMode) nMode.value = data.mode;
        if (nSpeed) nSpeed.value = data.speed;
        updateCount();
        showAlert(alertEl, 'ok', 'Настройки бегущей строки сохранены');
        showToast('ok', 'Бегущая строка обновлена');
        initNewsTicker();
      } catch (e) {
        showAlert(alertEl, 'err', e.message);
      }
    });
  }

  // ---------- Discord ----------
  const discordCard = document.getElementById('discord-card');
  const discordStatus = document.getElementById('discord-status');
  const discordGlowBox = document.getElementById('discord-glow-box');
  const discordGlowName = document.getElementById('discord-glow-name');
  const discordLinkBtn = document.getElementById('discord-link');
  const discordRelinkBtn = document.getElementById('discord-relink');
  const discordUnlinkBtn = document.getElementById('discord-unlink');

  async function loadDiscordStatus() {
    try {
      const data = await apiFetch('/api/discord/me');
      if (data.linked) {
        if (discordGlowBox) {
          discordGlowBox.style.display = 'flex';
          discordGlowName.textContent = '@' + data.username;
        }
        discordStatus.textContent = 'Учётная запись привязана и синхронизирована с сервером Discord.';
        discordLinkBtn.style.display = 'none';
        if (discordRelinkBtn) discordRelinkBtn.style.display = 'inline-flex';
        discordUnlinkBtn.style.display = 'inline-flex';
      } else {
        if (discordGlowBox) discordGlowBox.style.display = 'none';
        discordStatus.textContent = 'Discord не привязан.';
        discordLinkBtn.style.display = 'inline-flex';
        if (discordRelinkBtn) discordRelinkBtn.style.display = 'none';
        discordUnlinkBtn.style.display = 'none';
      }
    } catch (e) {
      discordStatus.textContent = e.message;
    }
  }
  await loadDiscordStatus();
  discordCard.style.display = '';

  const startDiscordOAuth = async () => {
    try {
      const data = await apiFetch('/api/discord/link', { method: 'POST' });
      window.location.href = data.url;
    } catch (e) {
      showAlert(alertEl, 'err', e.message);
    }
  };

  discordLinkBtn.addEventListener('click', startDiscordOAuth);
  if (discordRelinkBtn) discordRelinkBtn.addEventListener('click', startDiscordOAuth);

  discordUnlinkBtn.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Отвязка Discord',
      message: 'Вы уверены, что хотите отвязать текущую учётную запись Discord?',
      confirmText: 'Отвязать Discord',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch('/api/discord/unlink', { method: 'POST' });
      await loadDiscordStatus();
      showToast('ok', 'Discord успешно отвязан');
    } catch (e) {
      showToast('err', e.message);
    }
  });

  const params = new URLSearchParams(location.search);
  if (params.get('welcome') === '1') {
    showAlert(alertEl, 'ok', 'Добро пожаловать в О.Б.Р! Профиль успешно зарегистрирован через Discord.');
  } else if (params.get('discord') === 'ok') {
    showAlert(alertEl, 'ok', 'Discord успешно привязан');
  } else if (params.get('discord') === 'taken') {
    showAlert(alertEl, 'err', 'Этот Discord аккаунт уже привязан к другому бойцу.');
  } else if (params.get('discord') === 'error') {
    showAlert(alertEl, 'err', 'Не удалось привязать Discord. Проверьте настройки в Discord Developer Portal.');
  }

  // ---------- Устройства и сессии ----------
  const sessionsList = document.getElementById('sessions-list');
  const sessionsLogoutAll = document.getElementById('sessions-logout-all');

  function sessionDeviceIcon(device) {
    const d = String(device).toLowerCase();
    if (d.includes('android') || d.includes('iphone') || d.includes('ipad')) return '📱';
    if (d.includes('mac') || d.includes('iphone')) return '💻';
    if (d.includes('edge') || d.includes('chrome') || d.includes('firefox') || d.includes('opera') || d.includes('safari')) return '🖥';
    return '🌐';
  }

  async function loadSessions() {
    try {
      const data = await apiFetch('/api/sessions');
      const sessions = (data && data.sessions) || [];
      sessionsList.innerHTML = sessions.length
        ? sessions
            .map(
              (s) => `
          <div class="session-item${s.current ? ' current' : ''}">
            <div class="session-icon">${sessionDeviceIcon(s.device)}</div>
            <div class="session-info">
              <div class="session-name">${esc(s.device || 'Устройство')}${s.current ? ' <span class="session-current">это устройство</span>' : ''}</div>
              <div class="session-meta">IP: ${esc(s.ip || '—')} · вход: ${formatDate(s.created_at)} · активность: ${formatDate(s.last_seen)}</div>
            </div>
            ${s.current ? '' : `<button class="btn small danger" data-sid="${s.id}">Выйти</button>`}
          </div>`
            )
            .join('')
        : '<div class="empty">Активных сессий на других устройствах нет</div>';
      sessionsList.querySelectorAll('button[data-sid]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await showConfirmModal({
            title: 'Завершение сессии',
            message: 'Завершить сессию на этом устройстве?',
            confirmText: 'Завершить',
            danger: true,
          });
          if (!ok) return;
          try {
            await apiFetch(`/api/sessions/${encodeURIComponent(btn.getAttribute('data-sid'))}`, { method: 'DELETE' });
            showToast('ok', 'Сессия завершена');
            await loadSessions();
          } catch (e) {
            showToast('err', e.message);
          }
        });
      });
    } catch (e) {
      sessionsList.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  sessionsLogoutAll.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Завершение всех остальных сессий',
      message: 'Вы уверены, что хотите выйти на всех устройствах, кроме текущего?',
      confirmText: 'Выйти на всех остальных',
      danger: true,
    });
    if (!ok) return;
    try {
      const data = await apiFetch('/api/sessions/logout-others', { method: 'POST' });
      showToast('ok', data.removed ? `Завершено сессий: ${data.removed}` : 'Других активных сессий нет');
      await loadSessions();
    } catch (e) {
      showToast('err', e.message);
    }
  });

  await loadSessions();

  // ---------- Discord-конфиг (командир) ----------
  if (isCommander(user)) {
    const dcCard = document.getElementById('discord-config-card');
    dcCard.style.display = '';
    const dcStatus = document.getElementById('dc-config-status');
    const f = (id) => document.getElementById(id);

    try {
      const cfg = await apiFetch('/api/discord/config');
      f('dc-client-id').value = cfg.client_id;
      f('dc-guild-id').value = cfg.guild_id;
      f('dc-role-id').value = cfg.role_on_accept;
      f('dc-role-civilian').value = cfg.role_civilian;
      f('dc-role-builder').value = cfg.role_builder;
      f('dc-webhook').value = cfg.webhook_url;
      f('dc-webhook-warnings').value = cfg.warnings_webhook_url;
      if (f('dc-redirect-uri')) f('dc-redirect-uri').value = cfg.redirect_uri || '';
      const secrets = [];
      if (cfg.has_bot_token) secrets.push('токен бота задан');
      if (cfg.has_client_secret) secrets.push('client secret задан');
      if (cfg.has_webhook) secrets.push('канал заявок задан');
      if (cfg.has_warnings_webhook) secrets.push('канал выговоров задан');
      dcStatus.textContent = cfg.configured
        ? 'Бот настроен. ' + secrets.join(', ')
        : 'Сохранено. Для бота (роли/ЛС) нужны токен бота, ID сервера и ролей. Логи по webhook работают сразу.';
    } catch (e) {
      dcStatus.textContent = e.message;
    }

    f('dc-save').addEventListener('click', async () => {
      try {
        const cfg = await apiFetch('/api/discord/config', {
          method: 'PUT',
          body: JSON.stringify({
            client_id: f('dc-client-id').value,
            client_secret: f('dc-client-secret').value,
            bot_token: f('dc-bot-token').value,
            guild_id: f('dc-guild-id').value,
            role_on_accept: f('dc-role-id').value,
            role_civilian: f('dc-role-civilian').value,
            role_builder: f('dc-role-builder').value,
            webhook_url: f('dc-webhook').value,
            warnings_webhook_url: f('dc-webhook-warnings').value,
            redirect_uri: f('dc-redirect-uri') ? f('dc-redirect-uri').value : '',
          }),
        });
        f('dc-bot-token').value = '';
        f('dc-client-secret').value = '';
        dcStatus.textContent = cfg.configured
          ? 'Бот настроен и сохранён'
          : 'Сохранено. Для полной работы нужен токен бота и ID сервера.';
        showAlert(alertEl, 'ok', 'Настройки Discord сохранены');
      } catch (e) {
        showAlert(alertEl, 'err', e.message);
      }
    });
  }

  // ---------- Передача прав ----------
  if (isCommander(user)) {
    const transferCard = document.getElementById('transfer-card');
    transferCard.style.display = '';
    let transferTarget = null;

    document.getElementById('t-send').addEventListener('click', async () => {
      transferTarget = document.getElementById('t-username').value.trim();
      try {
        const data = await apiFetch('/api/users/me/transfer/send', {
          method: 'POST',
          body: JSON.stringify({ username: transferTarget }),
        });
        document.getElementById('t-code-row').style.display = '';
        document.getElementById('t-send').style.display = 'none';
        document.getElementById('t-confirm').style.display = '';
        showAlert(
          alertEl,
          'ok',
          data.dev && data.code
            ? `Код подтверждения (режим разработки): ${data.code}`
            : (data.channels && data.channels.includes('discord')
                ? 'Код подтверждения отправлен в личные сообщения Discord бота'
                : 'Код подтверждения отправлен')
        );
      } catch (e) {
        showAlert(alertEl, 'err', e.message);
      }
    });

    document.getElementById('t-confirm').addEventListener('click', async () => {
      const code = document.getElementById('t-code').value.trim();
      try {
        await apiFetch('/api/users/me/transfer/confirm', {
          method: 'POST',
          body: JSON.stringify({ username: transferTarget, code }),
        });
        showAlert(alertEl, 'ok', 'Права переданы. Роль обновлена.');
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        showAlert(alertEl, 'err', e.message);
      }
    });
  }
});
