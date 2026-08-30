const { app, BrowserWindow, Menu, ipcMain, shell, safeStorage, dialog, screen, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { finished } = require('stream/promises');
const { createStore } = require('./store');
const { streamChat, completeChat, listModels, ApiError } = require('./api');

const isSmokeTest = process.argv.includes('--smoke-test');

// Built-in defaults: read from the local (gitignored) config so real gateway
// credentials never land in the public repository. Fall back to the committed
// example template (empty placeholders) when config.local.js is absent.
function loadDefaultConfig() {
  try {
    return require('./config.local');
  } catch {
    try {
      return require('./config.example');
    } catch {
      return { DEFAULT_BASE_URL: '', DEFAULT_API_KEY: '' };
    }
  }
}
const { DEFAULT_BASE_URL, DEFAULT_API_KEY, DEFAULT_AUTH_URL } = loadDefaultConfig();
const DEFAULT_MODEL = 'grok-4.3-fast';

let mainWindow = null;
let settingsStore = null;
let conversationsStore = null;
let activeStream = null; // { controller, requestId }

/* ---------------- secret helpers (Windows DPAPI via safeStorage) ---------------- */

function encryptSecret(value) {
  try {
    if (value && safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(value).toString('base64');
    }
  } catch (err) {
    console.error('encrypt failed:', err.message);
  }
  return value ? 'plain:' + value : '';
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    }
    if (value.startsWith('plain:')) return value.slice(6);
  } catch (err) {
    console.error('decrypt failed:', err.message);
  }
  return value;
}

function maskSecret(value) {
  const plain = decryptSecret(value);
  if (!plain) return '';
  if (plain.length <= 8) return '****';
  return plain.slice(0, 4) + '…' + plain.slice(-4);
}

/* ---------------- auth (login server) ---------------- */

const AUTH_BASE = (DEFAULT_AUTH_URL || 'https://md-grok.de5.net').replace(/\/+$/, '');

async function authFetch(path, { body, token, method = 'POST' } = {}) {
  if (!AUTH_BASE) throw new Error('未配置登录服务器地址');
  const res = await fetch(AUTH_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error((json && json.error) || `服务器错误(${res.status})`);
  return json;
}

function authToken() {
  return decryptSecret(settingsStore.get().authTokenEnc || '');
}
function authUser() {
  const raw = settingsStore.get().authUser;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function saveAuth(token, user) {
  settingsStore.set({
    ...settingsStore.get(),
    authTokenEnc: encryptSecret(token || ''),
    authUser: user ? JSON.stringify(user) : '',
  });
}

ipcMain.handle('auth:status', () => {
  const user = authUser();
  return { loggedIn: !!authToken() && !!user, user };
});

ipcMain.handle('auth:register', async (_event, { email, password, name, turnstileToken }) => {
  const json = await authFetch('/api/auth/register', { body: { email, password, name, turnstileToken } });
  return { message: json.message, demoCode: json.demoCode, email: json.email };
});

ipcMain.handle('auth:config', async () => {
  try {
    const json = await authFetch('/api/auth/config', { method: 'GET' });
    return { turnstileSiteKey: json.turnstileSiteKey || '' };
  } catch {
    return { turnstileSiteKey: '' };
  }
});

ipcMain.handle('auth:openRegister', async () => {
  const url = (AUTH_BASE || 'https://md-grok.de5.net').replace(/\/+$/, '');
  try {
    await shell.openExternal(url + '/#/register');
  } catch (err) {
    console.error('openExternal failed:', err);
  }
  return { ok: true };
});

// Browser login: open the web login page with a one-time device id; the user
// logs in (or is already logged in) there and the page approves the device.
// The renderer polls auth:devicePoll until the session is granted.
ipcMain.handle('auth:deviceLogin', async () => {
  const deviceId = crypto.randomUUID();
  const url = (AUTH_BASE || 'https://md-grok.de5.net').replace(/\/+$/, '') + '/#/login?device=' + deviceId;
  try {
    await shell.openExternal(url);
  } catch (err) {
    console.error('openExternal failed:', err);
    throw new Error('无法打开浏览器,请手动访问 ' + url);
  }
  return { deviceId };
});

ipcMain.handle('auth:devicePoll', async (_event, { deviceId }) => {
  if (!deviceId) return { approved: false };
  const json = await authFetch(`/api/auth/device/poll?device=${encodeURIComponent(deviceId)}`, { method: 'GET' });
  if (json && json.approved && json.token && json.user) {
    saveAuth(json.token, json.user);
    return { approved: true, user: json.user };
  }
  return { approved: false };
});

ipcMain.handle('auth:verify', async (_event, { email, code }) => {
  const json = await authFetch('/api/auth/verify', { body: { email, code } });
  if (json.token && json.user) saveAuth(json.token, json.user);
  return { user: json.user, token: json.token };
});

ipcMain.handle('auth:login', async (_event, { email, password }) => {
  const json = await authFetch('/api/auth/login', { body: { email, password } });
  if (json.token && json.user) saveAuth(json.token, json.user);
  return { user: json.user, token: json.token };
});

ipcMain.handle('auth:logout', () => {
  saveAuth('', null);
  return { ok: true };
});

ipcMain.handle('usage:report', async (_event, { model, inTokens, outTokens }) => {
  const token = authToken();
  if (!token) return { ok: false };
  try {
    await authFetch('/api/me/usage/report', {
      token,
      body: { model: String(model || ''), inTokens: Number(inTokens) || 0, outTokens: Number(outTokens) || 0, source: 'desktop' },
    });
  } catch (err) {
    console.error('usage report failed:', err.message);
  }
  return { ok: true };
});

/* ---------------- file helpers ---------------- */

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
// Base64 data URIs larger than this are NOT persisted (keeps conversations.json
// from ballooning); the file stays usable for the current session only.
const MAX_PERSIST_DATA_URI = 4 * 1024 * 1024;

const MIME_MAP = {
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.rtf': 'application/rtf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.zip': 'application/zip',
};

function mimeOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function sanitizeContent(content) {
  if (!Array.isArray(content)) return String(content || '');
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const t = b.type;
    if (t === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
    else if (t === 'file' && b.file && typeof b.file.data === 'string')
      out.push({ type: 'file', file: { data: b.file.data } });
    else if (t === 'image_url' && b.image_url && typeof b.image_url.url === 'string')
      out.push({ type: 'image_url', image_url: { url: b.image_url.url } });
    else if (t === 'input_audio' && b.input_audio && typeof b.input_audio.data === 'string')
      out.push({ type: 'input_audio', input_audio: { data: b.input_audio.data } });
  }
  return out;
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildMarkdownExport(conv) {
  const lines = [];
  lines.push(`# ${conv.title || 'Grok 对话'}`);
  lines.push('');
  const created = conv.createdAt ? new Date(conv.createdAt).toLocaleString('zh-CN') : '';
  lines.push(
    `> 导出时间:${new Date().toLocaleString('zh-CN')}${created ? ` · 创建于 ${created}` : ''}`
  );
  lines.push('');
  for (const m of conv.messages || []) {
    const role = m.role === 'user' ? '🧑 你' : '🤖 Grok';
    lines.push(`## ${role}`);
    lines.push('');
    if (Array.isArray(m.attachments) && m.attachments.length) {
      for (const a of m.attachments) {
        lines.push(`- 📎 ${a.name}${a.size ? ` (${formatBytes(a.size)})` : ''}`);
      }
      lines.push('');
    }
    lines.push(m.content || '(仅附件)');
    lines.push('');
  }
  return lines.join('\n');
}

/* ---------------- window & menu ---------------- */

function createWindow() {
  const devIcon = path.join(__dirname, '..', 'build', 'icon.png');
  const bounds = restoreWindowBounds();
  mainWindow = new BrowserWindow({
    width: bounds.width || 1240,
    height: bounds.height || 820,
    ...(bounds.x !== undefined && Number.isFinite(bounds.x) ? { x: bounds.x } : {}),
    ...(bounds.y !== undefined && Number.isFinite(bounds.y) ? { y: bounds.y } : {}),
    minWidth: 920,
    minHeight: 620,
    backgroundColor: '#0e1013',
    title: 'Grok 桌面客户端',
    show: false,
    ...(fs.existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow.on('close', () => saveWindowBounds(mainWindow));

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (/^https?:/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[smoke] renderer loaded OK');
      setTimeout(() => app.quit(), 1500);
    });
  }
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- window bounds memory ---------------- */

function restoreWindowBounds() {
  const b = settingsStore.get().windowBounds;
  if (!b || typeof b !== 'object') return {};
  const { width, height } = b;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return {};
  const out = { width: Math.max(920, Math.round(width)), height: Math.max(620, Math.round(height)) };
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    // Keep the position only if the window would land on a visible display.
    const onScreen = screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return b.x < wa.x + wa.width - 80 && b.y < wa.y + wa.height - 80 && b.x + 80 > wa.x && b.y + 80 > wa.y;
    });
    if (onScreen) {
      out.x = Math.round(b.x);
      out.y = Math.round(b.y);
    }
  }
  return out;
}

function saveWindowBounds(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  settingsStore.set({ ...settingsStore.get(), windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
}

/* ---------------- auto update (GitHub Releases) ---------------- */

const UPDATE_REPO = 'cmmd5523/grok-desktop';

function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Pick the right installer asset for this platform/arch from a GitHub release.
function pickUpdateAsset(assets) {
  if (!Array.isArray(assets)) return null;
  if (process.platform === 'win32') {
    return assets.find((a) => /Setup.*\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name)) || null;
  }
  if (process.platform === 'darwin') {
    const isArm = process.arch === 'arm64';
    const dmg = assets.find((a) => a.name.endsWith('.dmg') && (isArm ? a.name.includes('arm64') : !a.name.includes('arm64')));
    if (dmg) return dmg;
    return assets.find((a) => a.name.endsWith('.dmg')) || null;
  }
  return null;
}

ipcMain.handle('update:check', async () => {
  const res = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { 'User-Agent': 'GrokDesktop-Updater', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('检查更新失败(HTTP ' + res.status + ')');
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const current = app.getVersion();
  const asset = pickUpdateAsset(rel.assets || []);
  return {
    current,
    latest,
    hasUpdate: semverGt(latest, current),
    assetName: asset ? asset.name : '',
    assetUrl: asset ? asset.browser_download_url : '',
    assetSize: asset ? asset.size : 0,
    releaseUrl: rel.html_url || '',
  };
});

ipcMain.handle('update:download', async (_event, { url, fileName }) => {
  const dest = path.join(app.getPath('temp'), fileName);
  const part = dest + '.part';
  fs.rmSync(part, { force: true });
  const res = await net.fetch(url);
  if (!res.ok) throw new Error('下载失败(HTTP ' + res.status + ')');
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const file = fs.createWriteStream(part);
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!file.write(Buffer.from(value))) {
      await new Promise((resolve) => file.once('drain', resolve));
    }
    received += value.length;
    if (mainWindow) {
      mainWindow.webContents.send('update:progress', {
        percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
        received,
        total,
      });
    }
  }
  file.end();
  await finished(file);
  fs.renameSync(part, dest);
  return { path: dest, size: received };
});

ipcMain.handle('update:install', async (_event, { path: p }) => {
  if (!p || !fs.existsSync(p)) throw new Error('安装包不存在,请重新下载');
  const r = await shell.openPath(p);
  if (r) throw new Error('启动安装程序失败:' + r);
  return { ok: true };
});

// Open the release asset download URL in the default browser. The browser's
// download manager is far more reliable for ~100MB installers (proxy support,
// resume, no renderer timeout), which is why we prefer it over in-app fetch.
ipcMain.handle('update:openDownload', async (_event, url) => {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('下载链接无效');
  await shell.openExternal(url);
  return { ok: true };
});

/* ---------------- IPC ---------------- */

ipcMain.handle('settings:get', () => {
  const cur = settingsStore.get();
  return {
    baseUrl: cur.baseUrl || DEFAULT_BASE_URL,
    model: cur.model || DEFAULT_MODEL,
    effort: cur.effort || 'off',
    systemPrompt: cur.systemPrompt || '',
    hasApiKey: !!cur.apiKeyEnc,
    apiKeyMask: maskSecret(cur.apiKeyEnc),
  };
});

ipcMain.handle('settings:set', (_event, patch) => {
  const cur = settingsStore.get();
  const next = { ...cur };
  if (typeof patch.baseUrl === 'string') {
    const url = patch.baseUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
    next.baseUrl = url || DEFAULT_BASE_URL;
  }
  if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
  if (typeof patch.effort === 'string' && ['off', 'low', 'medium', 'high'].includes(patch.effort)) {
    next.effort = patch.effort;
  }
  if (typeof patch.systemPrompt === 'string') next.systemPrompt = patch.systemPrompt;
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    next.apiKeyEnc = encryptSecret(patch.apiKey.trim());
  }
  if (patch.clearApiKey) next.apiKeyEnc = '';
  settingsStore.set(next);
  return {
    baseUrl: next.baseUrl || DEFAULT_BASE_URL,
    model: next.model || DEFAULT_MODEL,
    effort: next.effort || 'off',
    systemPrompt: next.systemPrompt || '',
    hasApiKey: !!next.apiKeyEnc,
    apiKeyMask: maskSecret(next.apiKeyEnc),
  };
});

// Cloud conversation sync (SSO mode): conversations live on the login server
// so desktop and web share the same history. Local store remains as fallback.
function ssoOrigin() {
  try {
    return new URL(settingsStore.get().baseUrl || DEFAULT_BASE_URL).origin;
  } catch {
    return '';
  }
}
async function ssoConvFetch(path, method, body) {
  const token = authToken();
  const origin = ssoOrigin();
  if (!token || !origin) return null;
  try {
    const res = await net.fetch(`${origin}/api/conversations${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('sso conv fetch failed:', err.message);
    return null;
  }
}

ipcMain.handle('conversations:list', async () => {
  const remote = await ssoConvFetch('', 'GET');
  const local = conversationsStore.get().items || [];
  if (remote && Array.isArray(remote.conversations)) {
    // Merge local + cloud so pre-sync local history stays visible.
    const map = new Map();
    for (const c of local) map.set(c.id, { id: c.id, title: c.title || '新对话', createdAt: Number(c.createdAt) || 0, updatedAt: Number(c.updatedAt) || 0 });
    for (const c of remote.conversations) map.set(c.id, { id: c.id, title: c.title || '新对话', createdAt: Number(c.createdAt) || 0, updatedAt: Number(c.updatedAt) || 0 });
    return Array.from(map.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return local.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
});

ipcMain.handle('conversations:get', async (_event, id) => {
  const remote = await ssoConvFetch('/' + encodeURIComponent(String(id)), 'GET');
  if (remote && remote.conversation) return remote.conversation;
  const items = conversationsStore.get().items || [];
  return items.find((c) => c.id === id) || null;
});

ipcMain.handle('conversations:save', async (_event, conv) => {
  if (!conv || typeof conv.id !== 'string' || !conv.id) throw new Error('无效的会话数据');
  const cleanMessages = (Array.isArray(conv.messages) ? conv.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => {
      const clean = { role: m.role, content: String(m.content || ''), ts: Number(m.ts) || Date.now() };
      if (Array.isArray(m.attachments) && m.attachments.length) {
        clean.attachments = m.attachments
          .filter((a) => a && typeof a.name === 'string')
          .map((a) => ({
            name: String(a.name),
            size: Number(a.size) || 0,
            mime: String(a.mime || 'application/octet-stream'),
            dataUri:
              typeof a.dataUri === 'string' && a.dataUri.length <= MAX_PERSIST_DATA_URI
                ? a.dataUri
                : '',
          }));
      }
      if (m.metrics && typeof m.metrics === 'object') {
        const mm = m.metrics;
        clean.metrics = {
          firstTokenMs: Number(mm.firstTokenMs) || 0,
          genMs: Number(mm.genMs) || 0,
          inTokens: Number(mm.inTokens) || 0,
          outTokens: Number(mm.outTokens) || 0,
          real: !!mm.real,
        };
      }
      return clean;
    });
  const cleaned = {
    id: conv.id,
    title: String(conv.title || '新对话').slice(0, 60),
    createdAt: Number(conv.createdAt) || Date.now(),
    updatedAt: Number(conv.updatedAt) || Date.now(),
    messages: cleanMessages,
  };
  const state = conversationsStore.get();
  const items = state.items || [];
  const idx = items.findIndex((c) => c.id === conv.id);
  if (idx >= 0) items[idx] = cleaned;
  else items.push(cleaned);
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  conversationsStore.set({ items });
  // Cloud sync (SSO): mirror to the login server for web/desktop sharing.
  await ssoConvFetch('/' + encodeURIComponent(cleaned.id), 'PUT', {
    title: cleaned.title,
    messages: cleaned.messages,
    model: String(conv.model || 'grok-4.3-fast'),
  }).catch(() => {});
  return true;
});

ipcMain.handle('conversations:delete', async (_event, id) => {
  const state = conversationsStore.get();
  conversationsStore.set({ items: (state.items || []).filter((c) => c.id !== id) });
  await ssoConvFetch('/' + encodeURIComponent(String(id)), 'DELETE').catch(() => {});
  return true;
});

/* Compress older conversation history into a summary (non-streaming). */
ipcMain.handle('chat:compact', async (_event, payload) => {
  const cur = settingsStore.get();
  const apiKey = decryptSecret(cur.apiKeyEnc || '');
  if (!apiKey) throw new Error('未配置 API Key');
  const model = payload && payload.model ? String(payload.model) : DEFAULT_MODEL;
  const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
  if (!messages.length) throw new Error('没有可压缩的历史');
  const compactPrompt = [
    {
      role: 'system',
      content:
        '你是会话压缩器。请把给定的对话历史压缩成一份简洁的中文摘要,保留所有关键信息(数字、结论、决定、用户需求、已执行的动作),删除寒暄与重复。只输出摘要正文,不要任何开场白或标题。',
    },
    {
      role: 'user',
      content: messages
        .map((m) => {
          const who = m.role === 'user' ? '用户' : '助手';
          const body = Array.isArray(m.content) ? JSON.stringify(m.content) : String(m.content || '');
          return `${who}: ${body}`;
        })
        .join('\n\n'),
    },
  ];
  const summary = await completeChat({
    baseUrl: cur.baseUrl || DEFAULT_BASE_URL,
    apiKey,
    model,
    messages: compactPrompt,
  });
  const text = String(summary || '').trim();
  if (!text) throw new Error('压缩失败:空响应');
  return { summary: text };
});

/* Export a conversation as Markdown via a save dialog. */
ipcMain.handle('conversation:export', async (_event, conv) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const title = (conv && conv.title) || '对话';
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'conversation';
  const result = await dialog.showSaveDialog(win, {
    title: '导出会话',
    defaultPath: `${safe}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, buildMarkdownExport(conv || {}), 'utf8');
  return { ok: true, path: result.filePath };
});

ipcMain.handle('models:list', async () => {
  // SSO mode: fetch model list from the login server (JWT-validated).
  const token = authToken();
  let ssoOrigin = '';
  try {
    const cur0 = settingsStore.get();
    ssoOrigin = new URL(cur0.baseUrl || DEFAULT_BASE_URL).origin;
  } catch {}
  if (token && ssoOrigin) {
    try {
      const res = await net.fetch(`${ssoOrigin}/api/chat/models`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const j = await res.json();
      const list = (j.data || []).map((m) => m.id).filter((id) => id && !/console/i.test(id));
      if (list.length) return list;
    } catch (err) {
      console.error('models:list (sso) failed:', err.message);
    }
    return [];
  }
  const cur = settingsStore.get();
  const apiKey = decryptSecret(cur.apiKeyEnc || '');
  if (!apiKey) return [];
  try {
    const models = await listModels(cur.baseUrl || DEFAULT_BASE_URL, apiKey);
    // Exclude console-tier models (free SSO tier, no client tool support here).
    return models.filter((id) => !/console/i.test(id));
  } catch (err) {
    console.error('models:list failed:', err.message);
    return [];
  }
});

ipcMain.handle('files:select', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return [];
  const result = await dialog.showOpenDialog(win, {
    title: '选择要上传的文件(可多选)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文档', extensions: ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md', 'csv', 'json', 'rtf'] },
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
      { name: '音频', extensions: ['mp3', 'wav', 'm4a', 'ogg'] },
      { name: '压缩包', extensions: ['zip'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return [];
  const files = [];
  for (const p of result.filePaths) {
    try {
      const stat = fs.statSync(p);
      if (stat.size > MAX_FILE_BYTES) {
        files.push({ error: true, name: path.basename(p), message: '文件超过 25MB 限制' });
        continue;
      }
      const buf = fs.readFileSync(p);
      const mime = mimeOf(p);
      files.push({
        name: path.basename(p),
        size: stat.size,
        mime,
        dataUri: `data:${mime};base64,${buf.toString('base64')}`,
      });
    } catch (err) {
      files.push({ error: true, name: path.basename(p), message: err.message });
    }
  }
  return files;
});

ipcMain.handle('chat:start', async (event, payload) => {
  const { requestId, model, messages } = payload || {};
  if (!requestId) throw new Error('缺少 requestId');
  const ssoToken = authToken();
  if (!ssoToken) throw new Error('请先登录后再使用(Grok 需要邮箱验证登录)');
  const cur = settingsStore.get();
  // SSO mode needs no local API key (the login server holds the gateway key).
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('消息为空');
  if (!model) throw new Error('未选择模型');

  const win = BrowserWindow.fromWebContents(event.sender);
  const controller = new AbortController();
  activeStream = { controller, requestId };

  const fullMessages = [];
  const systemPrompt = (cur.systemPrompt || '').trim();
  if (systemPrompt) fullMessages.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    fullMessages.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: sanitizeContent(m.content),
    });
  }

  try {
    const resolvedBaseUrl = cur.baseUrl || DEFAULT_BASE_URL;
    if (!resolvedBaseUrl) {
      throw new Error('未配置 API 地址,请先在「设置」中填写网关地址');
    }
    // SSO mode: chat through the login server's /api/chat with the session
    // JWT as the bearer token. The server validates the login and forwards
    // to grok2api internally, so no raw API key ever leaves the machine.
    // The SSO origin follows the configured base URL (direct server IP or
    // https domain), so users on direct-IP setups don't depend on CF.
    let ssoOrigin = '';
    try {
      ssoOrigin = new URL(resolvedBaseUrl).origin;
    } catch {}
    const ssoUrl = ssoToken && ssoOrigin ? `${ssoOrigin}/api/chat` : '';
    const usage = await streamChat({
      baseUrl: resolvedBaseUrl,
      apiKey: ssoUrl ? ssoToken : decryptSecret(cur.apiKeyEnc || ''),
      url: ssoUrl || undefined,
      model,
      messages: fullMessages,
      signal: controller.signal,
      onDelta: (delta) => {
        if (win && !win.isDestroyed()) win.webContents.send('chat:delta', { requestId, delta });
      },
    });
    return { ok: true, usage: usage || null, sso: !!ssoUrl };
  } catch (err) {
    throw friendlyNetError(err);
  } finally {
    if (activeStream && activeStream.requestId === requestId) activeStream = null;
  }
});

ipcMain.handle('chat:stop', () => {
  if (activeStream) {
    const { controller } = activeStream;
    activeStream = null;
    controller.abort();
  }
  return true;
});

// Translate raw Chromium/undici network errors into actionable Chinese hints.
function friendlyNetError(err) {
  const raw = String((err && err.message) || '');
  const net = (raw.match(/net::([A-Z_]+)/) || [])[1] || '';
  if (net === 'ERR_CONNECTION_TIMED_OUT' || /ERR_CONNECTION_TIMED_OUT/.test(raw)) {
    return new Error('无法连接 API 服务器(连接超时)。请检查:网络是否正常、代理(Clash)是否开启且节点可用;若使用代理,确认已开启系统代理或 TUN 模式。');
  }
  if (net === 'ERR_NAME_NOT_RESOLVED' || /ERR_NAME_NOT_RESOLVED/.test(raw)) {
    return new Error('无法解析 API 服务器域名(DNS 失败),请检查网络或 DNS 设置。');
  }
  if (net === 'ERR_CONNECTION_REFUSED' || net === 'ERR_CONNECTION_RESET' || net === 'ERR_EMPTY_RESPONSE') {
    return new Error('连接被拒绝或重置,请检查网络/代理是否稳定,稍后重试。');
  }
  if (net === 'ERR_CERT_AUTHORITY_INVALID' || net === 'ERR_CERT_INVALID' || net === 'ERR_CERT_COMMON_NAME_INVALID') {
    return new Error('HTTPS 证书校验失败,请检查系统时间或网络环境。');
  }
  if (net) return new Error(`网络错误(${net}),请检查网络或代理后重试。`);
  return err;
}

/* ---------------- app lifecycle ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    settingsStore = createStore(path.join(dataDir, 'settings.json'), {
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      systemPrompt: '',
      apiKeyEnc: '',
    });
    // Seed the built-in API key on first run, stored encrypted (DPAPI).
    const seeded = settingsStore.get();
    if (!seeded.apiKeyEnc && DEFAULT_API_KEY) {
      settingsStore.set({ apiKeyEnc: encryptSecret(DEFAULT_API_KEY) });
    }
    conversationsStore = createStore(path.join(dataDir, 'conversations.json'), { items: [] });
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    if (activeStream) activeStream.controller.abort();
  });
}
