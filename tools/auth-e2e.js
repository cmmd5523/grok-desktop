// Desktop app auth E2E: real renderer + preload + real login server.
// 1) Creates+activates a user via the server API, 2) drives the app's login
// form through the real IPC path, 3) asserts the main UI appears.
// Run: npx electron tools/auth-e2e.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUTH_BASE = process.env.AUTH_BASE || 'http://md-grok.de5.net';
let failures = 0;
const check = (name, ok, extra) => {
  if (ok) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}  ${extra || ''}`); }
};

async function serverApi(method, p, body, token) {
  const res = await fetch(AUTH_BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: res.status, json: j };
}

app.whenReady().then(async () => {
  // --- real auth IPC (mirrors src/main.js logic) ---
  async function authFetch(p, { body, token, method = 'POST' } = {}) {
    const res = await fetch(AUTH_BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error((j && j.error) || `服务器错误(${res.status})`);
    return j;
  }
  let storedToken = '';
  let storedUser = null;
  ipcMain.handle('auth:status', () => ({ loggedIn: !!storedToken, user: storedUser }));
  ipcMain.handle('auth:register', (_e, b) => authFetch('/api/auth/register', { body: b }));
  ipcMain.handle('auth:verify', async (_e, b) => {
    const j = await authFetch('/api/auth/verify', { body: b });
    if (j.token && j.user) { storedToken = j.token; storedUser = j.user; }
    return j;
  });
  ipcMain.handle('auth:login', async (_e, b) => {
    const j = await authFetch('/api/auth/login', { body: b });
    if (j.token && j.user) { storedToken = j.token; storedUser = j.user; }
    return j;
  });
  ipcMain.handle('auth:logout', () => { storedToken = ''; storedUser = null; return { ok: true }; });
  ipcMain.handle('auth:openRegister', () => ({ ok: true }));
  ipcMain.handle('auth:config', async () => {
    const j = await authFetch('/api/auth/config', { method: 'GET' });
    return { turnstileSiteKey: (j && j.turnstileSiteKey) || '' };
  });
  ipcMain.handle('usage:report', () => ({ ok: true }));
  // other stubs
  ipcMain.handle('settings:get', () => ({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'grok-4.3-fast', effort: 'off', systemPrompt: '', hasApiKey: true, apiKeyMask: '…chen' }));
  ipcMain.handle('settings:set', () => ({}));
  ipcMain.handle('conversations:list', () => []);
  ipcMain.handle('conversations:get', () => null);
  ipcMain.handle('conversations:save', () => true);
  ipcMain.handle('conversations:delete', () => true);
  ipcMain.handle('models:list', () => ['grok-4.3-fast']);
  ipcMain.handle('files:select', () => []);
  ipcMain.handle('chat:compact', () => ({}));
  ipcMain.handle('conversation:export', () => ({}));
  ipcMain.handle('chat:start', () => new Promise((r) => setTimeout(() => r({ usage: null }), 100)));
  ipcMain.handle('chat:stop', () => true);

  try {
    // Create an activated user via the ADMIN API (registration now requires
    // Turnstile, which is covered by grok-server/tools/turnstile-e2e.js).
    const adminEmail = process.env.AUTH_ADMIN_EMAIL || 'admin@grok.local';
    const adminPw = process.env.ADMIN_TEST_PASSWORD || 'wrong-pw';
    const adminLogin = await serverApi('POST', '/api/auth/login', { email: adminEmail, password: adminPw });
    check('admin login', adminLogin.status === 200 && !!adminLogin.json.token, adminLogin.status + ' ' + JSON.stringify(adminLogin.json).slice(0, 80));
    const email = 'desk' + Date.now() + '@demo.com';
    const mk = await serverApi('POST', '/api/admin/users', {
      email, password: 'test123456', name: '桌面用户', role: 'user', activate: true,
    }, adminLogin.json.token);
    check('admin creates activated user', mk.status === 201, mk.status + ' ' + JSON.stringify(mk.json).slice(0, 80));

    const win = new BrowserWindow({
      show: true,
      webPreferences: {
        preload: path.join(ROOT, 'src', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const run = (code) => win.webContents.executeJavaScript(code, true);
    const consoleMsgs = [];
    win.webContents.on('console-message', (e) => {
      const msg = e && (e.message !== undefined ? e.message : e);
      consoleMsgs.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    });

    // login screen shows
    const authVisible = await run(`!document.getElementById('authScreen').classList.contains('hidden') && !document.getElementById('app').classList.contains('hidden') === false`);
    check('login screen shown when logged out', authVisible);

    // desktop register tab: Turnstile is not supported under file:// (Cloudflare
    // error 110200), so we guide users to the web version for registration.
    await run(`document.querySelector('[data-atab="register"]').click()`);
    await new Promise((r) => setTimeout(r, 1200));
    const regGuide = await run(`(() => ({
      guideVisible: !!document.getElementById('openWebRegBtn') && getComputedStyle(document.getElementById('openWebRegBtn')).display !== 'none',
      regFormVisible: !document.getElementById('authFormRegister').classList.contains('hidden'),
    }))()`);
    check('desktop register shows web-registration guide', regGuide.guideVisible && regGuide.regFormVisible, JSON.stringify(regGuide));
    await run(`document.querySelector('[data-atab="login"]').click()`);

    // fill login form and submit (real IPC -> real server)
    const result = await run(`(async () => {
      const setVal = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); };
      setVal('authLoginEmail', '${email}');
      setVal('authLoginPassword', 'test123456');
      document.getElementById('authFormLogin').requestSubmit();
      await new Promise((r) => setTimeout(r, 2500));
      return {
        appVisible: !document.getElementById('app').classList.contains('hidden'),
        authHidden: document.getElementById('authScreen').classList.contains('hidden'),
        userLine: document.getElementById('authUserLine').textContent,
      };
    })()`);
    check('login enters main UI', result.appVisible && result.authHidden, JSON.stringify(result));
    check('sidebar shows logged-in user', result.userLine.includes(email), result.userLine);
  } catch (err) {
    check('auth e2e run', false, String((err && err.stack) || err));
  }

  console.log(failures === 0 ? '\nALL AUTH E2E PASS' : `\n${failures} AUTH E2E FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
