let resendTimer = null;

function startResendTimer() {
  const btn = document.getElementById('resend-btn');
  const timer = document.getElementById('resend-timer');
  if (!btn || !timer) return;
  btn.disabled = true;
  let left = 60;
  timer.textContent = `(${left} c)`;
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendTimer);
      resendTimer = null;
      btn.disabled = false;
      timer.textContent = '';
    } else {
      timer.textContent = `(${left} c)`;
    }
  }, 1000);
}

document.addEventListener('DOMContentLoaded', async () => {
  await initHeader();
  const alertEl = document.getElementById('alert');

  if (SITE.me) {
    window.location.href = '/';
    return;
  }

  const usernameInput = document.getElementById('a-username');
  const sendBtn = document.getElementById('send-code-btn');
  usernameInput.addEventListener('input', () => {
    sendBtn.disabled = !usernameInput.value.trim();
  });

  const sendCode = async () => {
    clearAlert(alertEl);
    const username = usernameInput.value.trim();
    if (!username) {
      showAlert(alertEl, 'err', 'Введите логин');
      return;
    }
    sendBtn.disabled = true;
    const original = sendBtn.textContent;
    sendBtn.textContent = 'Отправляем…';
    try {
      const res = await apiFetch('/api/auth/forgot/send', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      document.getElementById('code-row').style.display = '';
      sendBtn.style.display = 'none';
      document.getElementById('resend-row').style.display = '';
      startResendTimer();
      if (res.hasQuestion) {
        document.getElementById('q-row').style.display = '';
        document.getElementById('q-label').textContent = 'Контрольный вопрос: ' + res.question;
      }
      if (res.dev && res.code) {
        showAlert(alertEl, 'info', `Код (режим разработки): ${res.code}`);
      } else {
        showAlert(alertEl, 'ok', 'Код отправлен в личные сообщения Discord бота «О.Б.Р — сайт». Проверьте ЛС.');
      }
      document.getElementById('a-code').focus();
    } catch (err) {
      showAlert(alertEl, 'err', err.message);
      sendBtn.disabled = false;
      sendBtn.textContent = original;
    }
  };

  sendBtn.addEventListener('click', sendCode);
  const resendBtn = document.getElementById('resend-btn');
  if (resendBtn) {
    resendBtn.addEventListener('click', sendCode);
  }

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAlert(alertEl);
    const password = document.getElementById('a-password').value;
    if (password !== document.getElementById('a-password2').value) {
      showAlert(alertEl, 'err', 'Пароли не совпадают');
      return;
    }
    const btn = document.getElementById('reset-btn');
    btn.disabled = true;
    const username = usernameInput.value.trim();
    try {
      await apiFetch('/api/auth/forgot/reset', {
        method: 'POST',
        body: JSON.stringify({
          username,
          code: document.getElementById('a-code').value.trim(),
          answer: document.getElementById('a-answer').value.trim(),
          password,
        }),
      });
      showAlert(alertEl, 'ok', 'Пароль успешно изменён! Войдите в систему.');
      setTimeout(() => (window.location.href = '/login.html'), 1200);
    } catch (err) {
      showAlert(alertEl, 'err', err.message);
      btn.disabled = false;
    }
  });
});
