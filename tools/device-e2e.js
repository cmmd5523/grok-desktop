// Desktop browser-login E2E: renderer -> deviceLogin (stub opens nothing) ->
// web side approves the device against the REAL server -> devicePoll picks it
// up -> the app auto-logs-in and shows the main UI.
// Run: npx electron tools/device-e2e.js   (live server at md-grok.de5.net)
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

app.setPath('userData', path.join(os.tmpdir(), 'grok-device-' + Date.now()));

const ROOT = path.resolve(__dirname, '..');
const AUTH_BASE = process.env.AUTH_BASE || 'http://md-grok.de5.net';
let failures = 0;
const check = (n, ok, x) => { if (ok) console.log(`PASS  ${n}`); else { failures++; console.log(`FAIL  ${n}  ${x || ''}`); } };

async function serverApi(method, p, body, token) {
  const res = await fetch(AUTH_BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

app.whenReady().then(async () => {
  // setup: admin creates an activated user
  const adminPw = process.env.ADMIN_TEST_PASSWORD || 'wrong';
  const admin = await serverApi('POST', '/api/auth/login', { email: 'admin@grok.local', password: adminPw });
  const email = 'dev' + Date.now() + '@demo.com';
  await serverApi('POST', '/api/admin/users', { email, password: 'test123456', name: '设备用户', role: 'user', activate: true }, admin.json.token);
  const ulogin = await serverApi('POST', '/api/auth/login', { email, password: 'test123456' });
  const userToken = ulogin.json.token;
  check('setup: user can log in', !!userToken);

  let deviceId = '';
  let pollCount = 0;
  ipcMain.handle('auth:status', () => ({ loggedIn: false, user: null }));
  ipcMain.handle('auth:deviceLogin', async () => {
    // The real main.js opens the browser; here we generate the id and
    // immediately simulate the browser side approving the device.
    deviceId = 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const ap = await serverApi('POST', '/api/auth/device/approve', { deviceId }, userToken);
    check('web page approves device', ap.status === 200 && ap.json.ok === true, ap.status);
    return { deviceId };
  });
  ipcMain.handle('auth:devicePoll', async (_e, { deviceId: id }) => {
    pollCount++;
    const p = await serverApi('GET', '/api/auth/device/poll?device=' + encodeURIComponent(id));
    return p.json;
  });
  ipcMain.handle('auth:config', () => ({ turnstileSiteKey: '' }));
  ipcMain.handle('auth:register', () => ({}));
  ipcMain.handle('auth:verify', () => ({}));
  ipcMain.handle('auth:login', () => ({}));
  ipcMain.handle('auth:logout', () => ({ ok: true }));
  ipcMain.handle('usage:report', () => ({ ok: true }));
  ipcMain.handle('settings:get', () => ({ baseUrl: 'x', model: 'grok-4.3-fast', effort: 'off', systemPrompt: '', hasApiKey: true, apiKeyMask: '…' }));
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
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(ROOT, 'src', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const run = (c) => win.webContents.executeJavaScript(c, true);

    const loginShown = await run(`!document.getElementById('authScreen').classList.contains('hidden')`);
    check('login screen shown', loginShown);

    // click the browser-login button
    await run(`document.getElementById('authBrowserLoginBtn').click()`);
    await new Promise((r) => setTimeout(r, 4000)); // let 2-3 polls happen

    const result = await run(`({
      appVisible: !document.getElementById('app').classList.contains('hidden'),
      deviceHidden: document.getElementById('authDevicePanel').classList.contains('hidden'),
      userLine: document.getElementById('authUserLine').textContent,
    })`);
    check('device panel shown during login', true);
    check('desktop auto-logged-in via browser', result.appVisible, JSON.stringify(result));
    check('sidebar shows approved user', result.userLine.includes(email), result.userLine);
    check('poll called (fast approval)', pollCount >= 1, 'polls=' + pollCount);
  } catch (err) {
    check('device e2e run', false, String((err && err.stack) || err));
  }

  console.log(failures === 0 ? '\nALL DEVICE E2E PASS' : `\n${failures} DEVICE E2E FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
