const $ = selector => document.querySelector(selector);

function setConn(state, text) { const el = $('#connection'); el.dataset.state = state; el.textContent = text; }
function loginError(message = '') { const el = $('#login-error'); if (!el) return; el.textContent = message; el.hidden = !message; }

(async () => {
  // Check if already logged in via session cookie — skip straight to the workspace.
  try {
    const response = await fetch('/api/session');
    if (response.ok) {
      const session = await response.json();
      if (session.token) { window.location.href = '/'; return; }
    }
  } catch { /* server not ready yet */ }
  setConn('auth', '请登录');
  $('#login-username')?.focus();

  $('#login-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    const button = $('#login-submit');
    if (!username || !password) { loginError('请输入账号和密码'); return; }
    button.disabled = true;
    loginError();
    try {
      const response = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(session.error?.message ?? `登录失败 (${response.status})`), { status: response.status });
      // Session cookie is set automatically; go to the task page.
      window.location.href = '/';
    } catch (reason) {
      loginError(reason.status === 401 ? '账号或密码不正确' : reason.message);
    } finally { button.disabled = false; }
  });
})();
