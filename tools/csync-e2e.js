// Desktop cloud-conversation sync E2E: after login, save/list/get must hit
// the server (SSO), so the web client sees the same history.
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(os.tmpdir(), 'grok-csync-' + Date.now()));
require(path.join(__dirname, '..', 'src', 'main.js'));
const ROOT = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'src/preload.js') } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (c) => win.webContents.executeJavaScript(c, true);
  try {
    // Use the server IP direct path so sync does not depend on Cloudflare.
    await run(`window.grokAPI.setSettings({ baseUrl: 'http://154.9.253.182/v1' })`);
    const login = await run(`window.grokAPI.authLogin({ email: 'admin@grok.local', password: 'cmd13590675523' })`);
    const cid = 'dsync-' + Date.now();
    const saved = await run(`window.grokAPI.saveConversation({
      id: '${cid}',
      title: '桌面同步测试',
      model: 'grok-4.3-fast',
      createdAt: Date.now(), updatedAt: Date.now(),
      messages: [{ role: 'user', content: '你好', ts: Date.now() }, { role: 'assistant', content: '你好,来自桌面端', ts: Date.now() }],
    })`);
    const list = await run(`window.grokAPI.listConversations()`);
    console.log('LIST 返回:', JSON.stringify(list));
    const found = list.some((c) => c.id === cid);
    const got = await run(`window.grokAPI.getConversation('${cid}')`);
    const msgs = got && got.messages ? got.messages.length : 0;
    console.log('登录:', login && login.user ? 'ok' : 'fail', '| 保存:', saved, '| 列表含:', found, '| 消息数:', msgs);
    // cleanup
    await run(`window.grokAPI.deleteConversation('${cid}')`);
    const ok = login && login.user && saved === true && found && msgs === 2;
    console.log(ok ? 'DESKTOP CLOUD SYNC PASS' : 'DESKTOP CLOUD SYNC FAILED');
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log('ERROR', String(err));
    app.exit(1);
  }
});
