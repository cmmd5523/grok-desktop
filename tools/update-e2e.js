// Update feature E2E: loads the real main.js (registers update IPC), then
// checks update against REAL GitHub API and the settings-modal UI flow.
// Run: npx electron tools/update-e2e.js
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', path.join(os.tmpdir(), 'grok-upd-' + Date.now()));
process.argv = [process.argv[0], path.join(__dirname, '..', 'src', 'main.js')];
require(path.join(__dirname, '..', 'src', 'main.js'));

const ROOT = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2500)); // let main create its window
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'src/preload.js') } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (c) => win.webContents.executeJavaScript(c, true);
  try {
    const info = await run('window.grokAPI.checkUpdate()');
    console.log('checkUpdate:', JSON.stringify({ current: info.current, latest: info.latest, hasUpdate: info.hasUpdate, assetName: info.assetName }));
    const okShape =
      typeof info.current === 'string' && typeof info.latest === 'string' &&
      typeof info.hasUpdate === 'boolean' && (/\.(exe|dmg)$/.test(info.assetName) || info.assetName === '');

    await run(`window.grokAPI.onUpdateProgress(() => {}); true`);

    await run(`document.getElementById('settingsBtn').click()`);
    await new Promise((r) => setTimeout(r, 3000));
    const verText = await run(`document.getElementById('updateVerLabel').textContent`);
    console.log('settings ver label:', verText);
    const modalShown = await run(`!document.getElementById('settingsModal').classList.contains('hidden')`);
    const btnVisible = await run(`!!document.getElementById('checkUpdateBtn')`);

    await run(`document.getElementById('checkUpdateBtn').click()`);
    await new Promise((r) => setTimeout(r, 3000));
    const status = await run(`document.getElementById('updateStatus').textContent`);
    console.log('check status:', status);

    // download pipeline with a small real file (README) through the same IPC
    const dl = await run(`window.grokAPI.downloadUpdate({ url: 'https://raw.githubusercontent.com/cmmd5523/grok-desktop/main/README.md', fileName: 'upd-test-readme.md' })`);
    console.log('download:', dl.path, dl.size + ' bytes');
    const dlOk = dl.size > 100;

    const ok = okShape && modalShown && btnVisible && verText.includes('当前版本') && dlOk;
    console.log(ok ? 'ALL UPDATE CHECKS PASS' : 'UPDATE CHECKS FAILED');
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log('ERROR', String(err));
    app.exit(1);
  }
});
