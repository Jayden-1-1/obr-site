document.addEventListener('DOMContentLoaded', async () => {
  await initHeader();
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

  const discordParam = params.get('discord');
  if (discordParam === 'not_configured') {
    showAlert(alertEl, 'err', 'Discord-авторизация ещё не настроена командованием.');
  } else if (discordParam === 'error_state') {
    showAlert(alertEl, 'err', 'Сессия авторизации Discord истекла или недействительна. Попробуйте снова.');
  } else if (discordParam === 'token_error') {
    showAlert(alertEl, 'err', 'Не удалось обменять токен Discord. Проверьте соединение.');
  } else if (discordParam === 'me_error') {
    showAlert(alertEl, 'err', 'Не удалось получить данные профиля Discord.');
  } else if (discordParam === 'taken') {
    showAlert(alertEl, 'err', 'Этот Discord аккаунт уже привязан к другому пользователю.');
  } else if (discordParam === 'db_error') {
    showAlert(alertEl, 'err', 'Ошибка при создании учётной записи в базе данных.');
  } else if (discordParam === 'session_error') {
    showAlert(alertEl, 'err', 'Ошибка сессии авторизации. Попробуйте снова.');
  }

  const loginForm = document.getElementById('auth-form');
  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(alertEl);
    const username = document.getElementById('a-username')?.value.trim() || '';
    const password = document.getElementById('a-password')?.value || '';

    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    const originalText = btn ? btn.textContent : '';
    if (btn) btn.textContent = 'Вход…';

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
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  });
});
