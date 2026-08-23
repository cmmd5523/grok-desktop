// Desktop SSO E2E: login against the real server, then chat:start must go
// through /api/chat with the session JWT (result.sso === true) and stream.
// Run: npx electron tools/sso-e2e.js
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', path.join(os.tmpdir(), 'grok-sso-' + Date.now()));
process.argv = [process.argv[0], path.join(__dirname, '..', 'src', 'main.js')];
require(path.join(__dirname, '..', 'src', 'main.js'));
const ROOT = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'src/preload.js') } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (c) => win.webContents.executeJavaScript(c, true);
  try {
    const login = await run(`window.grokAPI.authLogin({ email: 'admin@grok.local', password: 'cmd13590675523' })`);
    console.log('登录:', login && login.ok ? 'ok' : JSON.stringify(login).slice(0, 120));

    const result = await run(`window.grokAPI.startChat({
      requestId: 'e2e-' + Date.now(),
      model: 'grok-4.3-fast',
      messages: [{ role: 'user', content: '用一句话介绍你自己' }],
    })`);
    console.log('chat:start 返回:', JSON.stringify({ ok: result.ok, sso: result.sso, usage: !!(result.usage && result.usage.total_tokens) }));

    // models via SSO
    const models = await run(`window.grokAPI.listModels()`);
    console.log('models:', models.length, '个, 含 fast:', models.includes('grok-4.3-fast'));

    const ok = login && login.user && result.ok && result.sso === true && models.includes('grok-4.3-fast');
    console.log(ok ? 'ALL SSO E2E PASS' : 'SSO E2E FAILED');
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log('ERROR', String(err));
    app.exit(1);
  }
});
