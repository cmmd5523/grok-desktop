// UI verification harness: launch the app, exercise the new composer
// toolbar via executeJavaScript, report pass/fail, quit.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHECKS = [];

function check(name, ok, detail) {
  CHECKS.push({ name, ok, detail });
}

// Minimal IPC stubs so the renderer's init calls resolve (the real app
// registers these in src/main.js; here we only need the UI surface).
ipcMain.handle('settings:get', () => ({
  baseUrl: (process.env.BASE_URL || 'http://127.0.0.1:8000/v1'),
  model: 'grok-4.3-fast',
  effort: 'off',
  systemPrompt: '',
  hasApiKey: true,
  apiKeyMask: '…chen',
}));
ipcMain.handle('settings:set', () => ({}));

// In-memory conversation store so save -> reload round-trips are testable.
const savedConvs = new Map();
ipcMain.handle('conversations:list', () =>
  [...savedConvs.values()]
    .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
);
ipcMain.handle('conversations:get', (_e, id) => savedConvs.get(id) || null);
ipcMain.handle('conversations:save', (_e, conv) => {
  savedConvs.set(conv.id, JSON.parse(JSON.stringify(conv)));
  return true;
});
ipcMain.handle('conversations:delete', (_e, id) => {
  savedConvs.delete(id);
  return true;
});
ipcMain.handle('models:list', () => [
  'grok-4.3-fast', 'grok-4.3-low', 'grok-4.3-medium', 'grok-4.3-high',
  'grok-4.20-auto', 'grok-4.20-expert', 'grok-4.20-fast', 'grok-4.20-0309',
  'grok-4.20-heavy',
]);
ipcMain.handle('chat:start', (event, payload) => {
  // Simulate a real streaming response: a few deltas, then resolve with usage.
  const chunks = ['这是', '第一段', '回复内容', '。', '可以正常保存。'];
  const send = (i) => {
    if (i >= chunks.length) return;
    event.sender.send('chat:delta', { requestId: payload.requestId, delta: chunks[i] });
    setTimeout(() => send(i + 1), 25);
  };
  setTimeout(() => send(0), 25);
  return new Promise((resolve) =>
    setTimeout(() => resolve({ usage: { prompt_tokens: 12, completion_tokens: 64 } }), 300)
  );
});
ipcMain.handle('stopChat', () => true);
ipcMain.handle('files:select', () => []);
ipcMain.handle('chat:compact', () => ({ summary: 'x' }));
ipcMain.handle('conversation:export', () => ({ canceled: true }));
// Auth stubs: pretend already logged in so the app enters the main UI.
ipcMain.handle('auth:status', () => ({ loggedIn: true, user: { email: 'test@demo.com', name: '测试', role: 'user' } }));
ipcMain.handle('auth:register', () => ({ email: 'x@demo.com', demoCode: '123456' }));
ipcMain.handle('auth:verify', () => ({ token: 't', user: { email: 'x@demo.com', role: 'user' } }));
ipcMain.handle('auth:login', () => ({ token: 't', user: { email: 'test@demo.com', role: 'user' } }));
ipcMain.handle('auth:logout', () => ({ ok: true }));
ipcMain.handle('usage:report', () => ({ ok: true }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const run = (code) => win.webContents.executeJavaScript(code, true);
  try {
    // Elements exist
    const ids = await run(
      `(() => {
        const need = ['composerCard','cmdBtn','permissionBtn','modelBtn','contextBtn','sendBtn','stopBtn','cmdMenu','permissionMenu','modelMenu','contextPanel','statsLine'];
        const missing = need.filter((id) => !document.getElementById(id));
        return missing;
      })()`
    );
    check('composer toolbar elements present', ids.length === 0, ids.join(','));

    // Layout: toolbar row inside card, trailing after tools
    const layout = await run(
      `(() => {
        const card = document.getElementById('composerCard');
        const row = card.querySelector('.toolbar-row');
        const tools = card.querySelector('.tools');
        const trailing = card.querySelector('.trailing');
        const kids = [...row.children];
        const trailKids = [...trailing.children];
        const lastTwo = trailKids.slice(-2).map((e) => e.id).join(',');
        return { hasRow: !!row, hasTools: !!tools, hasTrailing: !!trailing,
                 trailingAfterTools: kids.indexOf(tools) >= 0 && kids.indexOf(trailing) > kids.indexOf(tools),
                 toolsFirst: kids[0] === tools,
                 sendStopLast: lastTwo === 'sendBtn,stopBtn' };
      })()`
    );
    check('toolbar row layout', layout.hasRow && layout.hasTools && layout.hasTrailing && layout.trailingAfterTools && layout.sendStopLast, JSON.stringify(layout));

    // Menus initially hidden
    const hidden = await run(
      `(() => ['cmdMenu','permissionMenu','modelMenu','contextPanel'].every((id) => document.getElementById(id).classList.contains('hidden')))()`
    );
    check('menus initially hidden', hidden === true);

    // Click + opens command menu
    await run(`document.getElementById('cmdBtn').click()`);
    const cmdOpen = await run(`!document.getElementById('cmdMenu').classList.contains('hidden')`);
    check('+ opens command menu', cmdOpen === true);

    // Click model chip opens model menu with two cells
    await run(`document.getElementById('modelBtn').click()`);
    const modelOpen = await run(
      `(() => {
        const m = document.getElementById('modelMenu');
        return !m.classList.contains('hidden') && !!document.getElementById('modelCell') && !!document.getElementById('effortCell');
      })()`
    );
    check('model chip opens model menu (Model + Effort)', modelOpen === true);

    // Model cell drill-in shows grouped list
    await run(`document.getElementById('modelCell').click()`);
    const modelList = await run(
      `(() => {
        const list = document.getElementById('modelSubList');
        const items = list.querySelectorAll('.menu-item').length;
        const groups = list.querySelectorAll('.group-title').length;
        return { items, groups };
      })()`
    );
    check('model sub-list populated (grouped)', modelList.items > 0 && modelList.groups > 0, JSON.stringify(modelList));

    // Effort cell drill-in shows off/low/medium/high
    await run(`document.getElementById('effortCell').click()`);
    const effort = await run(
      `(() => {
        const list = document.getElementById('effortSubList');
        const vals = [...list.querySelectorAll('[data-effort]')].map((b) => b.dataset.effort);
        return vals.join(',');
      })()`
    );
    check('effort levels off/low/medium/high', effort === 'off,low,medium,high', effort);

    // Context meter ring + panel
    await run(`document.getElementById('contextBtn').click()`);
    const ctxOpen = await run(`!document.getElementById('contextPanel').classList.contains('hidden')`);
    check('context ring opens panel', ctxOpen === true);
    const meter = await run(
      `(() => {
        const fill = document.getElementById('meterFill');
        return { hasDash: !!fill.getAttribute('stroke-dasharray'), figures: document.getElementById('ctxFigures').textContent };
      })()`
    );
    check('meter ring configured', meter.hasDash === true && /K/.test(meter.figures), JSON.stringify(meter));

    // Permission menu has 3 options
    await run(`document.getElementById('permissionBtn').click()`);
    const perms = await run(
      `(() => [...document.querySelectorAll('#permissionMenu [data-perm]')].map((b) => b.dataset.perm).join(','))()`
    );
    check('permission options readonly/readwrite/full', perms === 'readonly,readwrite,full', perms);

    // Brand marks use the Grok star SVG
    const star = await run(
      `(() => {
        const inSidebar = !!document.querySelector('.brand-mark svg path');
        const inHero = !!document.querySelector('.hero-mark svg path');
        return { inSidebar, inHero };
      })()`
    );
    check('Grok star marks (sidebar + hero)', star.inSidebar === true && star.inHero === true, JSON.stringify(star));

    // Incremental send flow: typing + clicking send appends user bubble and an
    // assistant bubble without full history re-render.
    await run(`(() => {
      const t = document.getElementById('input');
      t.value = '你好,介绍一下你自己';
      t.dispatchEvent(new Event('input'));
      document.getElementById('sendBtn').click();
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    const sendState = await run(
      `(() => {
        const msgs = [...document.querySelectorAll('#messages .msg')];
        return {
          userBubbles: msgs.filter((m) => m.classList.contains('user')).length,
          assistantBubbles: msgs.filter((m) => m.classList.contains('assistant')).length,
          hasUserText: msgs.some((m) => m.classList.contains('user') && m.textContent.includes('你好,介绍一下你自己')),
          assistantText: msgs.filter((m) => m.classList.contains('assistant')).map((m) => m.textContent).join('|').slice(0, 120),
          title: document.getElementById('convTitle').textContent,
          inputCleared: document.getElementById('input').value === '',
        };
      })()`
    );
    check(
      'incremental send flow',
      sendState.userBubbles >= 1 && sendState.assistantBubbles >= 1 && sendState.hasUserText && sendState.inputCleared,
      JSON.stringify(sendState)
    );

    // Regression: the assistant reply must be persisted with its content and
    // survive "new conversation -> reopen the old one".
    const persisted = [...savedConvs.values()][0];
    const assistantMsg = persisted && (persisted.messages || []).find((m) => m.role === 'assistant');
    const savedContent = assistantMsg ? assistantMsg.content : '';
    const okPersist = !!savedContent && savedContent.includes('回复内容');
    console.log(`[debug] assistantText=${JSON.stringify(sendState.assistantText)} savedContent=${JSON.stringify(savedContent)} msgs=${persisted ? persisted.messages.length : 0}`);
    const reopen = await run(`(async () => {
      const id = ${JSON.stringify(persisted ? persisted.id : '')};
      document.getElementById('newChatBtn').click();
      await new Promise((r) => setTimeout(r, 120));
      const item = document.querySelector('.conv-item[data-id="' + id + '"]');
      if (!item) return { text: '__NO_ITEM__' };
      item.click();
      await new Promise((r) => setTimeout(r, 250));
      const bodies = [...document.querySelectorAll('#messages .msg.assistant .md-body')];
      return { text: bodies.map((b) => b.textContent).join('|') };
    })()`);
    const okReopen = reopen.text.includes('回复内容') && reopen.text.includes('可以正常保存');
    check(
      'assistant reply survives save + reopen',
      okPersist && okReopen,
      `saved=${JSON.stringify(savedContent).slice(0, 80)} dom=${JSON.stringify(reopen.text).slice(0, 80)}`
    );

    // Regression: after a completed conversation, "new conversation" + a new
    // question must go into a NEW conversation, never leak into the old one.
    const before = [...savedConvs.values()];
    const firstId = before[0] ? before[0].id : '';
    await run(`(async () => {
      document.getElementById('newChatBtn').click();
      await new Promise((r) => setTimeout(r, 120));
      const t = document.getElementById('input');
      t.value = '第二个问题,应该进新会话';
      t.dispatchEvent(new Event('input'));
      document.getElementById('sendBtn').click();
    })()`);
    await new Promise((r) => setTimeout(r, 1000));
    const convsAfter = [...savedConvs.values()];
    const newConv = convsAfter.find((c) => c.id !== firstId);
    const oldConv = convsAfter.find((c) => c.id === firstId);
    const newHasOwnQuestion = newConv && (newConv.messages || []).some((m) => m.content.includes('第二个问题'));
    const oldUnchanged = oldConv && !(oldConv.messages || []).some((m) => m.content.includes('第二个问题'));
    const convCount = convsAfter.length;
    // UI layer: the visible message list must NOT contain the old conversation's
    // content mixed in with the new question (the "串到旧会话" bug).
    const uiLeak = await run(
      `(() => {
        const text = document.getElementById('messages').textContent;
        const msgs = [...document.querySelectorAll('#messages .msg')];
        return {
          hasOldQuestion: text.includes('你好,介绍一下你自己'),
          hasNewQuestion: text.includes('第二个问题'),
          userBubbles: msgs.filter((m) => m.classList.contains('user')).length,
          assistantBubbles: msgs.filter((m) => m.classList.contains('assistant')).length,
        };
      })()`
    );
    const noUiLeak = !uiLeak.hasOldQuestion && uiLeak.hasNewQuestion && uiLeak.userBubbles === 1 && uiLeak.assistantBubbles === 1;
    check(
      'new conversation stays separate',
      convCount === 2 && !!newConv && !!oldConv && newHasOwnQuestion && oldUnchanged,
      `count=${convCount} newHasQ=${!!newHasOwnQuestion} oldUnchanged=${!!oldUnchanged}`
    );
    check('no stale bubbles leak into new conversation', noUiLeak, JSON.stringify(uiLeak));

    // Escape closes all menus
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    const allClosed = await run(
      `(() => ['cmdMenu','permissionMenu','modelMenu','contextPanel'].every((id) => document.getElementById(id).classList.contains('hidden')))()`
    );
    check('Escape closes all menus', allClosed === true);
  } catch (err) {
    check('harness execution', false, err.message);
  }

  check('no renderer console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  let failed = 0;
  for (const c of CHECKS) {
    if (!c.ok) failed += 1;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`);
  }
  console.log(failed === 0 ? 'ALL UI CHECKS PASS' : `${failed} UI CHECKS FAILED`);
  app.exit(failed === 0 ? 0 : 1);
});
