// Reproduce the web /api/chat streaming inside a real Chromium (Electron)
// page context, exactly like the user's browser (same network stack + CF).
const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
app.setPath('userData', path.join(os.tmpdir(), 'grok-wc-' + Date.now()));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  let loadState = 'pending';
  const consoleMsgs = [];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    consoleMsgs.push(`[${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => { loadState = 'fail:' + code + ':' + desc; });
  win.webContents.on('did-finish-load', () => { loadState = 'loaded'; });
  await win.loadURL('https://md-grok.de5.net/').catch((e) => { loadState = 'loadErr:' + String(e); });
  await new Promise((r) => setTimeout(r, 3000));
  console.log('页面加载状态:', loadState);
  console.log('页面控制台:', consoleMsgs.slice(0, 6).join(' | ') || '(无)');
  try {
    const out = await win.webContents.executeJavaScript(`
      (async () => {
        try {
        const login = await (await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'admin@grok.local', password: 'cmd13590675523' }),
        })).json();
        if (!login.token) return { error: 'login failed', login };
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token },
          body: JSON.stringify({ model: 'grok-4.3-fast', messages: [{ role: 'user', content: '用三句话介绍你自己' }] }),
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '', content = '', chunks = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks++;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (data === '[DONE]') continue;
            try { const obj = JSON.parse(data); content += obj.choices?.[0]?.delta?.content || ''; } catch {}
          }
        }
        return { status: res.status, chunks, len: content.length, head: content.slice(0, 80) };
        } catch (e) { return { threw: String(e && e.stack || e) }; }
      })()
    `, true);
    console.log('浏览器环境结果:', JSON.stringify(out));
    const ok = out && out.status === 200 && out.len > 20 && out.chunks > 3;
    console.log(ok ? 'BROWSER STREAM OK' : 'BROWSER STREAM BROKEN (reproduces user issue)');
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log('ERROR', String(err));
    app.exit(1);
  }
});
