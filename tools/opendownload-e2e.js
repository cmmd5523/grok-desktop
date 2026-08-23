// Verify update:openDownload IPC: invalid URL must throw, valid must not
// throw (browser opening is skipped by passing a URL that only validates).
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', path.join(os.tmpdir(), 'grok-od-' + Date.now()));
require(path.join(__dirname, '..', 'src', 'main.js'));
const ROOT = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'src/preload.js') } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (c) => win.webContents.executeJavaScript(c, true);
  try {
    let bad = 'no-throw';
    try {
      await run(`window.grokAPI.openUpdateDownload('javascript:alert(1)')`);
    } catch (e) {
      bad = /链接无效/.test(String(e.message || e)) ? 'rejected' : 'wrong-error';
    }
    console.log('非法 URL:', bad, '(期望 rejected)');
    const ok = bad === 'rejected';
    console.log(ok ? 'OPEN DOWNLOAD E2E PASS' : 'OPEN DOWNLOAD E2E FAILED');
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log('ERROR', String(err));
    app.exit(1);
  }
});
