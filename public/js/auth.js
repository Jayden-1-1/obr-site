document.addEventListener('DOMContentLoaded', async () => {
  await initHeader();
  const page = document.body.dataset.auth;
  const alertEl = document.getElementById('alert');

  if (SITE.me) {
    window.location.href = '/';
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const rawNext = params.get('next') || '/';
  const isSafeNext =
    rawNext === '/' ||
    (rawNext.startsWith('/') && !rawNext.startsWith('//')) ||
    /^[\w-]+\.html$/.test(rawNext);
  const next = isSafeNext ? (rawNext.startsWith('/') ? rawNext : '/' + rawNext) : '/';

  const registerForm = page === 'register' ? document.getElementById('auth-form') : null;
  const loginForm = page === 'login' ? document.getElementById('auth-form') : null;

  let discordDone = false;
  let discordRequired = true;
  const registerBtn = document.getElementById('register-btn');

  function updateRegisterBtn() {
    if (!registerBtn) return;
    const u = document.getElementById('a-username')?.value.trim() || '';
    const p1 = document.getElementById('a-password')?.value || '';
    const p2 = document.getElementById('a-password2')?.value || '';
    const ready =
      (!discordRequired || discordDone) &&
      u.length >= 3 &&
      p1.length >= 6 &&
      p2.length >= 6 &&
      p1 === p2;
    registerBtn.disabled = !ready;
  }

  if (registerForm) {
    // Check registration requirements
    try {
      const regCfg = await apiFetch('/api/auth/register-config');
      discordRequired = !!regCfg.discordRequired;
      if (!discordRequired) {
        const discordBox = document.getElementById('discord-box');
        const discordHint = document.getElementById('discord-hint');
        if (discordHint) {
          discordHint.textContent = 'Привязка Discord в данный момент не требуется';
        }
        if (discordBox) {
          const btn = document.getElementById('discord-btn');
          if (btn) btn.style.display = 'none';
        }
      }
    } catch (_) {
      discordRequired = false;
    }

    for (const id of ['a-username', 'a-password', 'a-password2']) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updateRegisterBtn);
      }
    }

    const discordBtn = document.getElementById('discord-btn');
    const discordHint = document.getElementById('discord-hint');
    const pending = params.get('discord');

    const showDiscordDone = (username) => {
      discordDone = true;
      if (discordBtn) {
        discordBtn.classList.add('done');
        discordBtn.textContent = 'Discord привязан ✓';
      }
      if (discordHint) {
        discordHint.textContent = username ? `Привязан: ${username}` : 'Discord привязан';
      }
      updateRegisterBtn();
    };

    if (pending === 'ok') {
      try {
        const res = await apiFetch('/api/auth/pending-discord');
        if (res.pending) showDiscordDone(res.username);
        else showDiscordDone('');
      } catch (err) {
        showDiscordDone('');
      }
    } else if (pending === 'error') {
      showAlert(alertEl, 'err', 'Не удалось привязать Discord. Попробуйте ещё раз.');
    } else if (pending === 'taken') {
      showAlert(alertEl, 'err', 'Этот Discord-аккаунт уже привязан к другому пользователю.');
    }

    if (discordBtn) {
      discordBtn.addEventListener('click', async () => {
        clearAlert(alertEl);
        discordBtn.disabled = true;
        const original = discordBtn.textContent;
        discordBtn.textContent = 'Открываем Discord…';
        try {
          const res = await apiFetch('/api/discord/reg-link', { method: 'POST' });
          window.location.href = res.url;
        } catch (err) {
          showAlert(alertEl, 'err', err.message);
          discordBtn.disabled = false;
          discordBtn.textContent = original;
        }
      });
    }

    updateRegisterBtn();
  }

  registerForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(alertEl);
    const username = document.getElementById('a-username').value.trim();
    const password = document.getElementById('a-password').value;
    const password2 = document.getElementById('a-password2').value;

    if (password !== password2) {
      showAlert(alertEl, 'err', 'Пароли не совпадают');
      return;
    }

    registerBtn.disabled = true;
    const originalText = registerBtn.textContent;
    registerBtn.textContent = 'Регистрация…';

    try {
      await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      showToast('ok', 'Регистрация успешна! Добро пожаловать.');
      setTimeout(() => {
        window.location.href = next;
      }, 500);
    } catch (err) {
      showAlert(alertEl, 'err', err.message);
      registerBtn.disabled = false;
      registerBtn.textContent = originalText;
    }
  });

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(alertEl);
    const username = document.getElementById('a-username').value.trim();
    const password = document.getElementById('a-password').value;

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Вход…';

    try {
      await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      showToast('ok', 'Вход выполнен!');
      setTimeout(() => {
        window.location.href = next;
      }, 500);
    } catch (err) {
      showAlert(alertEl, 'err', err.message);
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
});
