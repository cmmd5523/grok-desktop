import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

const $ = (sel) => document.querySelector(sel);

const els = {
  app: $('#app'),
  convList: $('#convList'),
  newChatBtn: $('#newChatBtn'),
  settingsBtn: $('#settingsBtn'),
  convTitle: $('#convTitle'),
  statusDot: $('#statusDot'),
  scrollBody: $('#scrollBody'),
  messages: $('#messages'),
  messagesInner: $('#messagesInner'),
  emptyState: $('#emptyState'),
  keyHint: $('#keyHint'),
  composer: $('#composer'),
  composerCard: $('#composerCard'),
  attachRow: $('#attachRow'),
  inputScroll: $('#inputScroll'),
  input: $('#input'),
  cmdBtn: $('#cmdBtn'),
  cmdMenu: $('#cmdMenu'),
  permissionBtn: $('#permissionBtn'),
  permissionIcon: $('#permissionIcon'),
  permissionLabel: $('#permissionLabel'),
  permissionMenu: $('#permissionMenu'),
  modelBtn: $('#modelBtn'),
  modelLabel: $('#modelLabel'),
  modelMenu: $('#modelMenu'),
  modelCell: $('#modelCell'),
  modelCellValue: $('#modelCellValue'),
  effortCell: $('#effortCell'),
  effortCellValue: $('#effortCellValue'),
  modelSub: $('#modelSub'),
  modelSubTitle: $('#modelSubTitle'),
  modelSubList: $('#modelSubList'),
  effortSub: $('#effortSub'),
  effortSubList: $('#effortSubList'),
  contextBtn: $('#contextBtn'),
  meterFill: $('#meterFill'),
  contextPanel: $('#contextPanel'),
  ctxFigures: $('#ctxFigures'),
  ctxPercent: $('#ctxPercent'),
  ctxBar: $('#ctxBar'),
  ctxSystem: $('#ctxSystem'),
  ctxMessages: $('#ctxMessages'),
  ctxFiles: $('#ctxFiles'),
  sendBtn: $('#sendBtn'),
  stopBtn: $('#stopBtn'),
  statsLine: $('#statsLine'),
  settingsModal: $('#settingsModal'),
  baseUrlInput: $('#baseUrlInput'),
  apiKeyInput: $('#apiKeyInput'),
  apiKeyHint: $('#apiKeyHint'),
  clearKeyCheck: $('#clearKeyCheck'),
  systemPromptInput: $('#systemPromptInput'),
  settingsCancelBtn: $('#settingsCancelBtn'),
  settingsSaveBtn: $('#settingsSaveBtn'),
  checkUpdateBtn: $('#checkUpdateBtn'),
  updateVerLabel: $('#updateVerLabel'),
  updateStatus: $('#updateStatus'),
  updateDownloadBtn: $('#updateDownloadBtn'),
  updateProgressWrap: $('#updateProgressWrap'),
  updateBar: $('#updateBar'),
  updatePercent: $('#updatePercent'),
  updateInstallBtn: $('#updateInstallBtn'),
  toast: $('#toast'),
  authScreen: $('#authScreen'),
  authUserLine: $('#authUserLine'),
  logoutBtn: $('#logoutBtn'),
  authLoginEmail: $('#authLoginEmail'),
  authLoginPassword: $('#authLoginPassword'),
  authLoginHint: $('#authLoginHint'),
  authRegEmail: $('#authRegEmail'),
  authRegName: $('#authRegName'),
  authRegPassword: $('#authRegPassword'),
  authRegHint: $('#authRegHint'),
  authVerifyEmail: $('#authVerifyEmail'),
  authVerifyCode: $('#authVerifyCode'),
  authVerifyHint: $('#authVerifyHint'),
};

// Fallback list (console models excluded — the gateway drops their tools and
// they are currently unusable upstream). Refreshed live from /v1/models.
const DEFAULT_MODELS = [
  'grok-4.3-fast',
  'grok-4.3-low',
  'grok-4.3-medium',
  'grok-4.3-high',
  'grok-4.20-auto',
  'grok-4.20-expert',
  'grok-4.20-heavy',
  'grok-4.20-fast',
  'grok-4.20-0309',
  'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning',
];

const FILE_ICONS = {
  pdf: '📄',
  ppt: '📊',
  doc: '📝',
  xls: '📈',
  img: '🖼️',
  aud: '🎵',
  zip: '🗜️',
  txt: '📃',
};

const state = {
  settings: {
    baseUrl: '',
    model: 'grok-4.3-fast',
    effort: 'off',
    systemPrompt: '',
    hasApiKey: false,
    apiKeyMask: '',
  },
  permission: 'readwrite', // readonly | readwrite | full
  models: [...DEFAULT_MODELS],
  conversations: [], // summaries [{id,title,updatedAt}]
  currentId: null,
  current: null, // full conversation
  streaming: false,
  stoppedByUser: false,
  requestId: null,
  pending: null, // { msg, mdEl, raw, rafPending }
  pendingFiles: [], // [{name,size,mime,dataUri}] to attach on next send
  toastTimer: null,
  auth: { loggedIn: false, user: null },
};

const CONTEXT_WINDOW = 131072; // 128K context window for the occupancy ring

const EFFORT_LABELS = { off: '关', low: '低', medium: '中', high: '高' };

const PERMISSIONS = {
  readonly: { label: '只读', icon: '📖' },
  readwrite: { label: '读写', icon: '✏️' },
  full: { label: '完全访问', icon: '⚡' },
};

/* Map a base model + reasoning effort to the actual model id sent to the
   gateway. Effort levels map to the grok-4.3 fast/low/medium/high ladder. */
function resolveModel(base, effort) {
  if (!effort || effort === 'off') return base;
  const core = base.replace(/-(fast|low|medium|high)$/, '');
  const candidate = `${core}-${effort}`;
  return state.models.includes(candidate) ? candidate : base;
}

function currentSendModel() {
  return resolveModel(state.settings.model, state.effort);
}

/* ---------------- helpers ---------------- */

function fileKind(mime, name) {
  if (mime.startsWith('image/')) return 'img';
  if (mime.startsWith('audio/')) return 'aud';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (['ppt', 'pptx'].includes(ext)) return 'ppt';
  if (['doc', 'docx'].includes(ext)) return 'doc';
  if (['xls', 'xlsx'].includes(ext)) return 'xls';
  if (['zip', 'rar', '7z'].includes(ext)) return 'zip';
  return 'txt';
}

function fileIcon(mime, name) {
  return FILE_ICONS[fileKind(mime, name)] || '📎';
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function makeTitle(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 28) || '新对话';
}

/* ---------------- session stats ---------------- */

// Estimate tokens for mixed CJK/Latin text (grok-style tokenizer ballpark):
// CJK chars ~1 token each, Latin ~4 chars per token.
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) || // compat
      (code >= 0x3040 && code <= 0x30ff) || // kana
      (code >= 0xac00 && code <= 0xd7af) // hangul
    ) {
      cjk += 1;
    } else if (/[\x20-\x7e]/.test(ch)) {
      latin += 1;
    }
  }
  return Math.ceil(cjk + latin / 4 + 1);
}

function computeSessionStats(conv) {
  const msgs = (conv && conv.messages) || [];
  let rounds = 0;
  let genMs = 0;
  let firstTokenSum = 0;
  let firstTokenCount = 0;
  let inTokens = 0;
  let outTokens = 0;
  let realCount = 0;
  let assistantCount = 0;
  for (const m of msgs) {
    if (m.role === 'user') rounds += 1;
    if (m.role === 'assistant' && m.metrics) {
      assistantCount += 1;
      genMs += m.metrics.genMs || 0;
      inTokens += m.metrics.inTokens || 0;
      outTokens += m.metrics.outTokens || 0;
      if (m.metrics.real) realCount += 1;
      if (m.metrics.firstTokenMs) {
        firstTokenSum += m.metrics.firstTokenMs;
        firstTokenCount += 1;
      }
    }
  }
  return {
    rounds,
    messages: msgs.length,
    genMs,
    avgFirstTokenMs: firstTokenCount ? firstTokenSum / firstTokenCount : 0,
    inTokens,
    outTokens,
    speedTokPerSec: genMs ? Math.round((outTokens * 1000) / genMs) : 0,
    // Real token counts only when the gateway reported usage for every turn.
    allReal: assistantCount > 0 && realCount === assistantCount,
  };
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m > 0) return `${m}m${r}s`;
  return `${r}s`;
}

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function renderStatsLine() {
  const conv = state.current;
  if (!conv) {
    els.statsLine.classList.add('hidden');
    return;
  }
  const st = computeSessionStats(conv);
  if (!st.rounds && !st.outTokens) {
    els.statsLine.classList.add('hidden');
    return;
  }
  const sep = '<span class="stats-sep">|</span>';
  const approx = st.allReal ? '' : '≈';
  const parts = [
    `${st.rounds} 轮 · ${st.messages} 条`,
    `生成 ${fmtDuration(st.genMs)} · 首 token ${st.avgFirstTokenMs ? (st.avgFirstTokenMs / 1000).toFixed(1) + 's' : '—'}`,
    `均值 ${st.speedTokPerSec} tok/s`,
    `输入 ${approx}${fmtTokens(st.inTokens)} tok · 输出 ${approx}${fmtTokens(st.outTokens)} tok`,
  ];
  els.statsLine.innerHTML = parts.join(sep);
  els.statsLine.classList.remove('hidden');
}

/* ---------------- composer menus ---------------- */

const MENU_ELS = ['cmdMenu', 'permissionMenu', 'modelMenu', 'contextPanel'];

function closeMenus(except) {
  for (const key of MENU_ELS) {
    if (key === except) continue;
    els[key].classList.add('hidden');
  }
  els.modelSub.classList.add('hidden');
  els.effortSub.classList.add('hidden');
  els.cmdBtn.classList.remove('chip-open');
  els.permissionBtn.classList.remove('chip-open');
  els.modelBtn.classList.remove('chip-open');
  els.contextBtn.classList.remove('chip-open');
}

function toggleMenu(key, btnKey) {
  const el = els[key];
  const isOpen = !el.classList.contains('hidden');
  closeMenus(key);
  if (!isOpen) {
    el.classList.remove('hidden');
    if (btnKey) els[btnKey].classList.add('chip-open');
  }
}

function applyPermissionUI() {
  const p = PERMISSIONS[state.permission] || PERMISSIONS.readwrite;
  els.permissionIcon.textContent = p.icon;
  els.permissionLabel.textContent = p.label;
  const canFiles = state.permission !== 'readonly';
  const canExport = state.permission !== 'readonly';
  for (const item of els.cmdMenu.querySelectorAll('[data-cmd]')) {
    const disabled = (item.dataset.cmd === 'files' && !canFiles) || (item.dataset.cmd === 'export' && !canExport);
    item.disabled = disabled;
    item.style.opacity = disabled ? '0.5' : '';
    item.style.cursor = disabled ? 'default' : '';
  }
}

function setPermission(perm) {
  state.permission = perm;
  applyPermissionUI();
}

/* ---------------- model chip & menu ---------------- */

function modelGroups() {
  const groups = [];
  const g43 = state.models.filter((m) => m.startsWith('grok-4.3'));
  const g420 = state.models.filter((m) => m.startsWith('grok-4.20'));
  const other = state.models.filter(
    (m) => !m.startsWith('grok-4.3') && !m.startsWith('grok-4.20')
  );
  if (g43.length) groups.push(['grok-4.3 系列', g43]);
  if (g420.length) groups.push(['grok-4.20 系列', g420]);
  if (other.length) groups.push(['其他模型', other]);
  return groups;
}

function renderModelChip() {
  const base = state.settings.model;
  const effort = state.effort;
  const resolved = resolveModel(base, effort);
  if (effort === 'off') {
    els.modelLabel.textContent = resolved;
  } else {
    const core = base.replace(/-(fast|low|medium|high)$/, '');
    els.modelLabel.textContent = `${core} · ${EFFORT_LABELS[effort]}`;
  }
  els.modelLabel.title = `发送模型:${resolved}`;
}

function populateModelList() {
  els.modelSubList.innerHTML = '';
  for (const [title, ids] of modelGroups()) {
    const g = document.createElement('div');
    g.className = 'group-title';
    g.textContent = title;
    els.modelSubList.appendChild(g);
    for (const id of ids) {
      const btn = document.createElement('button');
      btn.className = 'menu-item' + (id === state.settings.model ? ' active' : '');
      btn.dataset.modelId = id;
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = id;
      const check = document.createElement('span');
      check.className = 'check-mark';
      check.textContent = id === state.settings.model ? '✓' : '';
      btn.appendChild(name);
      btn.appendChild(check);
      btn.addEventListener('click', () => {
        if (state.effort !== 'off' && resolveModel(id, state.effort) === id) {
          state.effort = 'off';
          showToast('该模型不支持此推理等级,已切换为「关」');
        }
        state.settings.model = id;
        window.grokAPI.setSettings({ model: id, effort: state.effort }).catch(() => {});
        els.modelCellValue.textContent = id;
        renderModelChip();
        populateModelList();
        closeMenus();
      });
      els.modelSubList.appendChild(btn);
    }
  }
}

function showModelSub() {
  els.effortSub.classList.add('hidden');
  els.modelSubTitle.textContent = '选择模型';
  els.modelSub.classList.remove('hidden');
  populateModelList();
}

function showEffortSub() {
  els.modelSub.classList.add('hidden');
  els.effortSub.classList.remove('hidden');
  for (const item of els.effortSubList.querySelectorAll('[data-effort]')) {
    const val = item.dataset.effort;
    const active = val === state.effort;
    item.classList.toggle('active', active);
    let check = item.querySelector('.check-mark');
    if (active && !check) {
      check = document.createElement('span');
      check.className = 'check-mark';
      check.textContent = '✓';
      item.appendChild(check);
    } else if (!active && check) {
      check.remove();
    }
  }
}

function selectEffort(val) {
  state.effort = val;
  window.grokAPI.setSettings({ model: state.settings.model, effort: val }).catch(() => {});
  els.effortCellValue.textContent = EFFORT_LABELS[val];
  renderModelChip();
  closeMenus();
}

function openModelMenu() {
  const isOpen = !els.modelMenu.classList.contains('hidden');
  closeMenus('modelMenu');
  if (isOpen) return;
  els.modelMenu.classList.remove('hidden');
  els.modelBtn.classList.add('chip-open');
  els.modelSub.classList.add('hidden');
  els.effortSub.classList.add('hidden');
  els.modelCellValue.textContent = state.settings.model;
  els.effortCellValue.textContent = EFFORT_LABELS[state.effort];
}

/* ---------------- context meter ---------------- */

function updateContextMeter() {
  const conv = state.current;
  let used = 0;
  if (conv && conv.messages) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.role === 'assistant' && m.metrics && m.metrics.inTokens) {
        used = m.metrics.inTokens;
        break;
      }
    }
  }
  const frac = Math.min(1, used / CONTEXT_WINDOW);
  const C = 2 * Math.PI * 7.5;
  els.meterFill.style.strokeDashoffset = String(C * (1 - frac));
  els.meterFill.style.stroke = frac > 0.9 ? 'var(--red-400)' : 'var(--label-tertiary)';

  els.ctxFigures.textContent = `${fmtTokens(used)} / ${fmtTokens(CONTEXT_WINDOW)}`;
  els.ctxPercent.textContent = `${Math.round(frac * 100)}%`;

  // Heuristic composition breakdown (~4 chars/token, signposted with ~)
  const sys = estimateTokens(state.settings.systemPrompt || '');
  let msg = 0;
  let fil = 0;
  for (const m of conv ? conv.messages : []) {
    msg += estimateTokens(m.content || '');
    for (const a of m.attachments || []) {
      if (a && a.dataUri) fil += estimateTokens(a.dataUri);
    }
  }
  els.ctxSystem.textContent = `~${fmtTokens(sys)} tok`;
  els.ctxMessages.textContent = `~${fmtTokens(msg)} tok`;
  els.ctxFiles.textContent = `~${fmtTokens(fil)} tok`;

  const seg = (v, cls) => {
    const w = Math.round((v / CONTEXT_WINDOW) * 100);
    return w > 0 ? `<div class="seg ${cls}" style="width:${Math.min(w, 100)}%"></div>` : '';
  };
  els.ctxBar.innerHTML = seg(sys, 'seg-system') + seg(msg, 'seg-messages') + seg(fil, 'seg-files');
}

/* ---------------- commands (compact / export) ---------------- */

async function compactConversation() {
  if (state.streaming) return;
  const conv = state.current;
  if (!conv || !conv.messages || conv.messages.length < 4) {
    showToast('对话太短,无需压缩');
    return;
  }
  const keep = conv.messages.slice(-4);
  const old = conv.messages.slice(0, -4);
  setStatus('busy', '正在压缩历史…');
  try {
    const res = await window.grokAPI.compactChat({
      model: currentSendModel(),
      messages: old.map((m) => ({ role: m.role, content: m.content })),
    });
    const summary = (res && res.summary) || '';
    if (!summary) throw new Error('压缩失败:空响应');
    conv.messages = [
      {
        role: 'assistant',
        content: `🗜 **已压缩历史**(${old.length} 条消息)\n\n${summary}`,
        ts: Date.now(),
      },
      ...keep,
    ];
    conv.updatedAt = Date.now();
    persistConversation(conv);
    renderConversation();
    showToast(`已压缩 ${old.length} 条历史消息`);
  } catch (err) {
    console.error('compact failed:', err);
    showToast(err && err.message ? err.message : '压缩失败');
  } finally {
    setStatus('idle', '空闲');
  }
}

async function exportConversation() {
  if (!state.current) {
    showToast('没有可导出的对话');
    return;
  }
  try {
    const res = await window.grokAPI.exportConversation(state.current);
    if (res && res.ok) showToast(`已导出:${res.path}`);
  } catch (err) {
    console.error('export failed:', err);
    showToast(err && err.message ? err.message : '导出失败');
  }
}

function scrollToBottom() {
  els.scrollBody.scrollTop = els.scrollBody.scrollHeight;
}

function showToast(msg) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  state.toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
}

function setStatus(mode, title) {
  els.statusDot.className = `status-dot ${mode}`;
  els.statusDot.title = title || '';
}

function setHeroMode() {
  const hero = !state.current;
  els.app.classList.toggle('hero', hero);
}

/* ---------------- markdown ---------------- */

function renderMarkdown(text) {
  const html = marked.parse(text || '');
  const clean = DOMPurify.sanitize(html);
  const container = document.createElement('div');
  container.innerHTML = clean;
  container.querySelectorAll('a').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  container.querySelectorAll('pre').forEach((pre) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code');
      const text = (code && code.textContent) || pre.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '已复制';
      } catch {
        btn.textContent = '复制失败';
      }
      setTimeout(() => {
        btn.textContent = '复制';
      }, 1500);
    });
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
    wrapper.appendChild(btn);
  });
  return container;
}

/* ---------------- conversation rendering ---------------- */

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function renderConvList() {
  els.convList.innerHTML = '';
  for (const c of state.conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.currentId ? ' active' : '');
    item.dataset.id = c.id;

    const title = document.createElement('span');
    title.className = 'conv-item-title';
    title.textContent = c.title || '新对话';

    const time = document.createElement('span');
    time.className = 'conv-item-time';
    time.textContent = formatTime(c.updatedAt);

    const del = document.createElement('button');
    del.className = 'conv-item-del';
    del.type = 'button';
    del.title = '删除对话';
    del.textContent = '×';

    item.appendChild(title);
    item.appendChild(time);
    item.appendChild(del);
    els.convList.appendChild(item);
  }
}

function renderAttachmentChips(list) {
  const wrap = document.createElement('div');
  wrap.className = 'attach-chip-list';
  for (const a of list) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.title = a.name;
    const icon = document.createElement('span');
    icon.textContent = fileIcon(a.mime, a.name);
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = a.name;
    const size = document.createElement('span');
    size.className = 'chip-size';
    size.textContent = formatSize(a.size);
    chip.appendChild(icon);
    chip.appendChild(name);
    chip.appendChild(size);
    if (!a.dataUri) {
      const warn = document.createElement('span');
      warn.className = 'chip-warn';
      warn.textContent = '⚠ 未保存';
      warn.title = '文件较大,内容未随会话保存;重新打开后需重新上传';
      chip.appendChild(warn);
    }
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderPendingFiles() {
  els.attachRow.innerHTML = '';
  if (!state.pendingFiles.length) {
    els.attachRow.classList.add('hidden');
    return;
  }
  els.attachRow.classList.remove('hidden');
  const wrap = document.createElement('div');
  wrap.className = 'attach-chip-list';
  for (const a of state.pendingFiles) {
    const chip = document.createElement('span');
    chip.className = 'pending-chip';
    chip.title = a.name;
    const icon = document.createElement('span');
    icon.textContent = fileIcon(a.mime, a.name);
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = a.name;
    const size = document.createElement('span');
    size.className = 'chip-size';
    size.textContent = formatSize(a.size);
    const x = document.createElement('button');
    x.className = 'chip-x';
    x.type = 'button';
    x.textContent = '×';
    x.title = '移除';
    x.addEventListener('click', () => {
      state.pendingFiles = state.pendingFiles.filter((f) => f !== a);
      renderPendingFiles();
    });
    chip.appendChild(icon);
    chip.appendChild(name);
    chip.appendChild(size);
    chip.appendChild(x);
    wrap.appendChild(chip);
  }
  els.attachRow.appendChild(wrap);
}

function appendUserMessageEl(content, attachments) {
  const msg = document.createElement('div');
  msg.className = 'msg user';
  const stack = document.createElement('div');
  stack.className = 'user-stack';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (attachments && attachments.length) {
    bubble.appendChild(renderAttachmentChips(attachments));
  }
  const text = document.createElement('div');
  text.textContent = content;
  bubble.appendChild(text);

  stack.appendChild(bubble);
  msg.appendChild(stack);
  return msg;
}

function appendAssistantMessageEl(content) {
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  const body = document.createElement('div');
  body.className = 'md-body';
  const contentEl = renderMarkdown(content);
  body.innerHTML = contentEl.innerHTML;
  msg.appendChild(body);
  return { msg, md: body };
}

function showEmptyState() {
  els.messages.classList.add('hidden');
  els.emptyState.classList.remove('hidden');
  // Clear any leftover bubbles from the previous conversation, otherwise the
  // next incremental render would show the old conversation's messages again.
  els.messagesInner.innerHTML = '';
  els.convTitle.textContent = '新对话';
  document.title = 'Grok 桌面客户端';
  els.keyHint.textContent = state.settings.hasApiKey
    ? `已配置 API Key${state.settings.apiKeyMask ? `(${state.settings.apiKeyMask})` : ''}`
    : '⚠ 尚未配置 API Key,请点击「设置」填写';
  setHeroMode();
  renderStatsLine();
  updateContextMeter();
}

function renderConversation() {
  const conv = state.current;
  els.emptyState.classList.add('hidden');
  els.messages.classList.remove('hidden');
  els.messagesInner.innerHTML = '';

  if (!conv) {
    showEmptyState();
    return;
  }

  els.convTitle.textContent = conv.title || '新对话';
  document.title = `${conv.title || '新对话'} · Grok`;

  for (const m of conv.messages || []) {
    if (m.role === 'user') {
      els.messagesInner.appendChild(appendUserMessageEl(m.content, m.attachments));
    } else if (m.role === 'assistant') {
      const { msg } = appendAssistantMessageEl(m.content);
      els.messagesInner.appendChild(msg);
    }
  }
  renderConvList();
  setHeroMode();
  scrollToBottom();
  renderStatsLine();
  updateContextMeter();
}

/* ---------------- conversation actions ---------------- */

async function refreshConversations() {
  try {
    state.conversations = await window.grokAPI.listConversations();
  } catch (err) {
    console.error('listConversations failed:', err);
  }
  renderConvList();
}

async function openConversation(id) {
  if (state.streaming) stopStreaming();
  try {
    const conv = await window.grokAPI.getConversation(id);
    if (!conv) return;
    state.currentId = id;
    state.current = conv;
    renderConversation();
  } catch (err) {
    console.error('getConversation failed:', err);
    showToast('读取对话失败');
  }
}

function newConversation() {
  if (state.streaming) stopStreaming();
  state.currentId = null;
  state.current = null;
  state.pending = null;
  showEmptyState();
  renderConvList();
}

function persistConversation(conv) {
  window.grokAPI.saveConversation(conv).catch((err) => {
    console.error('saveConversation failed:', err);
  });
}

async function deleteConversation(id) {
  const conv = state.conversations.find((c) => c.id === id);
  const title = conv ? conv.title : '该对话';
  if (!window.confirm(`确定删除「${title}」吗?此操作不可恢复。`)) return;
  try {
    await window.grokAPI.deleteConversation(id);
    if (state.currentId === id) newConversation();
    await refreshConversations();
  } catch (err) {
    console.error('deleteConversation failed:', err);
    showToast('删除失败');
  }
}

/* ---------------- attachments ---------------- */

async function selectFiles() {
  if (state.permission === 'readonly') {
    showToast('当前为只读权限,无法上传文件');
    return;
  }
  try {
    const files = await window.grokAPI.selectFiles();
    for (const f of files || []) {
      if (f && f.error) {
        showToast(`${f.name}:${f.message || '读取失败'}`);
        continue;
      }
      if (f && f.dataUri) state.pendingFiles.push(f);
    }
    renderPendingFiles();
  } catch (err) {
    console.error('selectFiles failed:', err);
    showToast('选择文件失败');
  }
}

/* ---------------- send / stream ---------------- */

function ensureConversation(text) {
  if (state.current) return;
  const now = Date.now();
  state.current = {
    id: crypto.randomUUID(),
    title: makeTitle(text),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  state.currentId = state.current.id;
  renderConvList();
}

// Build gateway payload messages: user messages with attachments become
// OpenAI-style content blocks; everything else stays a plain string.
function buildPayloadMessages(conv) {
  return conv.messages.map((m) => {
    if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) {
      const content = [{ type: 'text', text: m.content || '' }];
      for (const a of m.attachments) {
        if (!a || !a.dataUri) continue;
        if ((a.mime || '').startsWith('image/')) {
          content.push({ type: 'image_url', image_url: { url: a.dataUri } });
        } else if ((a.mime || '').startsWith('audio/')) {
          content.push({ type: 'input_audio', input_audio: { data: a.dataUri } });
        } else {
          content.push({ type: 'file', file: { data: a.dataUri } });
        }
      }
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content || '' };
  });
}

async function send() {
  const text = els.input.value.trim();
  if ((!text && !state.pendingFiles.length) || state.streaming) return;
  if (!state.auth.loggedIn) {
    showToast('请先登录后再使用');
    showAuthScreen();
    return;
  }
  if (!state.settings.hasApiKey) {
    showToast('未配置 API Key,请在设置中填写');
    openSettings();
    return;
  }

  ensureConversation(text || '文件对话');
  const conv = state.current;
  const userMsg = { role: 'user', content: text, ts: Date.now() };
  if (state.pendingFiles.length) {
    userMsg.attachments = state.pendingFiles.slice();
  }
  conv.messages.push(userMsg);
  conv.title = makeTitle(text || '文件对话');
  conv.updatedAt = Date.now();

  state.pendingFiles = [];
  renderPendingFiles();
  els.input.value = '';
  resizeInput();
  updateComposerButtons();

  // Incremental render: append the new user bubble instead of re-rendering
  // the whole history (large conversations re-render slowly on every turn).
  els.emptyState.classList.add('hidden');
  els.messages.classList.remove('hidden');
  if (conv.messages.length === 1) {
    // Fresh conversation: drop any stale bubbles left by a previous one.
    els.messagesInner.innerHTML = '';
  }
  els.messagesInner.appendChild(appendUserMessageEl(userMsg.content, userMsg.attachments));
  els.convTitle.textContent = conv.title || '新对话';
  document.title = `${conv.title || '新对话'} · Grok`;
  renderConvList();
  setHeroMode();
  scrollToBottom();
  renderStatsLine();
  updateContextMeter();
  persistConversation(conv);

  await streamReply(conv);
  await refreshConversations();
}

function appendMetaLine(msgEl, text) {
  const note = document.createElement('div');
  note.className = 'meta-note';
  note.textContent = text;
  msgEl.appendChild(note);
}

// Throttle markdown re-renders during streaming. Normal replies re-render per
// animation frame; very long replies (>20K chars) drop to a 250ms interval so
// repeated full-markdown parses don't jank the window.
function schedulePendingRender(p) {
  if (p.raw.length > 20000) {
    if (!p.slowTimer) {
      p.slowTimer = setInterval(() => {
        if (state.pending === p) {
          p.md.innerHTML = renderMarkdown(p.raw).innerHTML;
          scrollToBottom();
        }
      }, 250);
    }
    return;
  }
  if (!p.rafPending) {
    p.rafPending = true;
    requestAnimationFrame(() => {
      p.rafPending = false;
      if (state.pending === p) {
        p.md.innerHTML = renderMarkdown(p.raw).innerHTML;
        scrollToBottom();
      }
    });
  }
}

async function streamReply(conv) {
  state.streaming = true;
  state.stoppedByUser = false;
  const requestId = crypto.randomUUID();
  state.requestId = requestId;

  setStreamingUI(true);

  const assistantMsg = { role: 'assistant', content: '', ts: Date.now() };
  conv.messages.push(assistantMsg);

  const { msg, md } = appendAssistantMessageEl('');
  els.messagesInner.appendChild(msg);
  md.innerHTML = '<span class="typing">正在思考…</span>';
  const t0 = performance.now();
  const pending = { msg, md, raw: '', rafPending: false, slowTimer: null, t0, firstTokenAt: 0, assistantMsg };
  state.pending = pending;
  scrollToBottom();

  const payload = buildPayloadMessages(conv);
  const inTokens = estimateTokens(JSON.stringify(payload));
  const hasFiles = payload.some((m) =>
    Array.isArray(m.content) && m.content.some((c) => c && (c.type === 'file' || c.type === 'image_url' || c.type === 'input_audio'))
  );
  if (hasFiles) {
    md.innerHTML = '<span class="typing">正在上传文件(大文件可能需要 1-2 分钟)…</span>';
  }

  let usage = null;
  try {
    const result = await window.grokAPI.startChat({
      requestId,
      model: currentSendModel(),
      messages: payload,
    });
    usage = result && result.usage ? result.usage : null;
    state.pending = null;
  } catch (err) {
    const stopped = state.stoppedByUser;
    state.pending = null;
    if (stopped) {
      appendMetaLine(msg, '⏹ 已停止生成');
    } else {
      const message = (err && err.message) || '请求失败,请重试';
      appendMetaLine(msg, `⚠ ${message}`);
      showToast(message);
    }
  } finally {
    if (pending.slowTimer) {
      clearInterval(pending.slowTimer);
      pending.slowTimer = null;
    }
    // Final full render so the tail of a throttled reply is always shown.
    if (pending.raw) {
      md.innerHTML = renderMarkdown(pending.raw).innerHTML;
    }
    const now = performance.now();
    const u = usage && typeof usage === 'object' ? usage : null;
    const realIn = u && Number(u.prompt_tokens) > 0 ? Number(u.prompt_tokens) : 0;
    const realOut = u && Number(u.completion_tokens) > 0 ? Number(u.completion_tokens) : 0;
    assistantMsg.metrics = {
      firstTokenMs: pending.firstTokenAt ? pending.firstTokenAt - t0 : 0,
      genMs: now - t0,
      inTokens: realIn || inTokens,
      outTokens: realOut || estimateTokens(assistantMsg.content),
      real: !!(realIn && realOut),
    };
    state.streaming = false;
    state.requestId = null;
    setStreamingUI(false);
    persistConversation(conv);
    // Report usage to the login server (silent; for the web admin panel).
    window.grokAPI
      .reportUsage({
        model: currentSendModel(),
        inTokens: assistantMsg.metrics.inTokens,
        outTokens: assistantMsg.metrics.outTokens,
      })
      .catch(() => {});
    scrollToBottom();
    renderStatsLine();
  }
}

function stopStreaming() {
  if (!state.streaming) return;
  state.stoppedByUser = true;
  window.grokAPI.stopChat().catch(() => {});
}

function setStreamingUI(streaming) {
  els.sendBtn.classList.toggle('hidden', streaming);
  els.stopBtn.classList.toggle('hidden', !streaming);
  els.cmdBtn.disabled = streaming;
  els.permissionBtn.disabled = streaming;
  els.modelBtn.disabled = streaming;
  els.contextBtn.disabled = streaming;
  els.input.disabled = streaming;
  updateComposerButtons();
  if (streaming) setStatus('busy', '正在生成…');
  else setStatus('idle', '空闲');
}

/* ---------------- models ---------------- */

function applyModels(models) {
  if (models && models.length) {
    state.models = models.slice();
    if (!state.models.includes(state.settings.model) && state.models.length) {
      state.settings.model = state.models[0];
      window.grokAPI.setSettings({ model: state.settings.model }).catch(() => {});
    }
  }
  renderModelChip();
  populateModelList();
}

async function refreshModels(silent) {
  if (!state.settings.hasApiKey) {
    setStatus('idle', '未配置 API Key');
    return;
  }
  try {
    const models = await window.grokAPI.listModels();
    if (models && models.length) {
      applyModels(models);
      setStatus('online', '已连接网关');
    } else if (!silent) {
      showToast('未能获取模型列表,请检查 API Key');
    }
  } catch (err) {
    setStatus('offline', '无法连接网关');
    if (!silent) showToast(`无法连接 API:${err && err.message ? err.message : '网络错误'}`);
  }
}

/* ---------------- auto update ---------------- */

let updaterInfo = null; // last update:check result
let updateDownloadedPath = null;

function updateUi(status, cls) {
  els.updateStatus.textContent = status || '';
  els.updateStatus.className = 'update-status' + (cls ? ' ' + cls : '');
}

function resetUpdateUi() {
  els.updateProgressWrap.classList.add('hidden');
  els.updateInstallBtn.classList.add('hidden');
  els.updateDownloadBtn.classList.add('hidden');
  els.updateDownloadBtn.disabled = false;
  updaterInfo = null;
  updateDownloadedPath = null;
  updateUi('');
}

async function runUpdateCheck({ silent } = {}) {
  resetUpdateUi();
  updateUi('检查中…');
  try {
    const info = await window.grokAPI.checkUpdate();
    updaterInfo = info;
    els.updateVerLabel.textContent = `当前版本 v${info.current} · 最新版本 v${info.latest}`;
    if (info.hasUpdate) {
      updateUi(`发现新版本 v${info.latest}(${info.assetName})`, 'warn');
      els.updateDownloadBtn.classList.remove('hidden');
    } else {
      updateUi('已是最新版本 ✅');
    }
  } catch (err) {
    updateUi((err && err.message) || '检查更新失败,请检查网络', 'err');
    if (!silent) showToast('检查更新失败:' + ((err && err.message) || '网络错误'));
  }
}

async function downloadUpdate() {
  if (!updaterInfo || !updaterInfo.hasUpdate || !updaterInfo.assetUrl) return;
  els.updateDownloadBtn.disabled = true;
  updateUi('正在下载 ' + updaterInfo.assetName + ' …');
  els.updateProgressWrap.classList.remove('hidden');
  els.updateBar.style.width = '0%';
  els.updatePercent.textContent = '0%';
  try {
    const r = await window.grokAPI.downloadUpdate({ url: updaterInfo.assetUrl, fileName: updaterInfo.assetName });
    updateDownloadedPath = r.path;
    updateUi('下载完成 ✅');
    els.updateDownloadBtn.classList.add('hidden');
    els.updateInstallBtn.classList.remove('hidden');
    els.updateInstallBtn.textContent = process.platform === 'darwin' ? '打开安装包' : '下载完成,立即安装';
  } catch (err) {
    els.updateDownloadBtn.disabled = false;
    updateUi((err && err.message) || '下载失败', 'err');
    showToast('下载更新失败:' + ((err && err.message) || '网络错误'));
  }
}

async function installUpdate() {
  if (!updateDownloadedPath) return;
  try {
    await window.grokAPI.installUpdate({ path: updateDownloadedPath });
    if (process.platform === 'darwin') {
      updateUi('已打开安装包,请将 GrokDesktop 拖入「应用程序」后重新打开', 'ok');
      showToast('请将 App 拖入应用程序文件夹');
    } else {
      updateUi('安装程序已启动,安装完成后重新打开即可(旧版数据会保留)');
      showToast('安装程序已启动,请按提示完成安装');
    }
  } catch (err) {
    updateUi((err && err.message) || '启动安装失败', 'err');
  }
}

/* ---------------- settings ---------------- */

function openSettings() {
  els.baseUrlInput.value = state.settings.baseUrl || '';
  els.apiKeyInput.value = '';
  els.clearKeyCheck.checked = false;
  els.systemPromptInput.value = state.settings.systemPrompt || '';
  els.apiKeyHint.textContent = state.settings.hasApiKey
    ? `已保存 Key(${state.settings.apiKeyMask || '…'}),留空保持不变`
    : '留空则使用内置默认 Key';
  els.settingsModal.classList.remove('hidden');
  els.apiKeyInput.focus();
  // 静默刷新版本号(不弹提示)
  window.grokAPI.checkUpdate().then((info) => {
    els.updateVerLabel.textContent = `当前版本 v${info.current} · 最新版本 v${info.latest}`;
    if (info.hasUpdate) {
      updaterInfo = info;
      updateUi(`发现新版本 v${info.latest}(${info.assetName})`, 'warn');
      els.updateDownloadBtn.classList.remove('hidden');
    }
  }).catch(() => {
    /* 网络不可用时静默,不打扰设置 */
  });
}

function closeSettings() {
  els.settingsModal.classList.add('hidden');
}

async function saveSettings() {
  const patch = { systemPrompt: els.systemPromptInput.value };
  const baseUrl = els.baseUrlInput.value.trim();
  if (baseUrl) patch.baseUrl = baseUrl;
  const key = els.apiKeyInput.value.trim();
  if (key) patch.apiKey = key;
  if (els.clearKeyCheck.checked) patch.clearApiKey = true;
  try {
    const saved = await window.grokAPI.setSettings(patch);
    state.settings = { ...state.settings, ...saved };
    closeSettings();
    showToast('设置已保存');
    refreshModels(false);
    renderModelChip();
    updateContextMeter();
    showEmptyState();
    renderConvList();
  } catch (err) {
    console.error('saveSettings failed:', err);
    showToast(err && err.message ? err.message : '保存设置失败');
  }
}

/* ---------------- input ---------------- */

function resizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 336) + 'px';
}

function updateComposerButtons() {
  const hasText = els.input.value.trim().length > 0 || state.pendingFiles.length > 0;
  els.sendBtn.disabled = !hasText;
}

function wireEvents() {
  els.newChatBtn.addEventListener('click', newConversation);
  els.settingsBtn.addEventListener('click', openSettings);
  els.sendBtn.addEventListener('click', send);
  els.stopBtn.addEventListener('click', stopStreaming);

  /* Command menu (＋) */
  els.cmdBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu('cmdMenu', 'cmdBtn');
  });
  els.cmdMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-cmd]');
    if (!item || item.disabled) return;
    closeMenus();
    const cmd = item.dataset.cmd;
    if (cmd === 'files') selectFiles();
    else if (cmd === 'compact') compactConversation();
    else if (cmd === 'export') exportConversation();
    else if (cmd === 'model') openModelMenu();
  });

  /* Permission menu */
  els.permissionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu('permissionMenu', 'permissionBtn');
  });
  els.permissionMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-perm]');
    if (!item) return;
    setPermission(item.dataset.perm);
    closeMenus();
  });

  /* Model menu */
  els.modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openModelMenu();
  });
  els.modelCell.addEventListener('click', (e) => {
    e.stopPropagation();
    showModelSub();
  });
  els.effortCell.addEventListener('click', (e) => {
    e.stopPropagation();
    showEffortSub();
  });
  els.effortSubList.addEventListener('click', (e) => {
    const item = e.target.closest('[data-effort]');
    if (!item) return;
    selectEffort(item.dataset.effort);
  });

  /* Context meter */
  els.contextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu('contextPanel', 'contextBtn');
  });

  /* Close any open menu/panel on outside click or Escape */
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#composerCard')) closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });

  els.input.addEventListener('input', () => {
    resizeInput();
    updateComposerButtons();
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  els.settingsCancelBtn.addEventListener('click', closeSettings);
  els.settingsSaveBtn.addEventListener('click', saveSettings);
  els.checkUpdateBtn.addEventListener('click', () => runUpdateCheck({ silent: false }));
  els.updateDownloadBtn.addEventListener('click', downloadUpdate);
  els.updateInstallBtn.addEventListener('click', installUpdate);
  window.grokAPI.onUpdateProgress((p) => {
    const pct = typeof p.percent === 'number' ? p.percent : 0;
    els.updateBar.style.width = pct + '%';
    els.updatePercent.textContent = pct + '%';
  });
  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });

  els.convList.addEventListener('click', (e) => {
    const del = e.target.closest('.conv-item-del');
    const item = e.target.closest('.conv-item');
    if (!item) return;
    if (del) {
      deleteConversation(item.dataset.id);
    } else {
      openConversation(item.dataset.id);
    }
  });

  window.grokAPI.onChatDelta(({ requestId, delta }) => {
    if (!state.pending || requestId !== state.requestId) return;
    const p = state.pending;
    if (!p.firstTokenAt) p.firstTokenAt = performance.now();
    p.assistantMsg.content += delta; // keep the data object in sync for persistence
    p.raw += delta;
    schedulePendingRender(p);
  });
}

/* ---------------- auth (login required) ---------------- */

let turnstileToken = '';
let turnstileRendered = false;

async function maybeRenderTurnstile() {
  if (turnstileRendered) return;
  try {
    const cfg = await window.grokAPI.authConfig();
    const siteKey = cfg && cfg.turnstileSiteKey;
    if (!siteKey || typeof window.turnstile !== 'object' || typeof window.turnstile.render !== 'function') return;
    turnstileRendered = true;
    window.turnstile.render(document.getElementById('turnstileReg'), {
      sitekey: siteKey,
      theme: 'dark',
      action: 'signup',
      callback: (token) => {
        turnstileToken = token;
        const el = document.getElementById('turnstileReg');
        if (el) el.dataset.turnstileDone = token;
      },
      'expired-callback': () => { turnstileToken = ''; const el = document.getElementById('turnstileReg'); if (el) delete el.dataset.turnstileDone; },
      'error-callback': () => { turnstileToken = ''; const el = document.getElementById('turnstileReg'); if (el) delete el.dataset.turnstileDone; },
    });
  } catch {}
}

function showAuthScreen() {
  els.app.classList.add('hidden');
  els.authScreen.classList.remove('hidden');
}
function showAppScreen() {
  els.authScreen.classList.add('hidden');
  els.app.classList.remove('hidden');
  const u = state.auth.user;
  els.authUserLine.textContent = u ? `${u.email}${u.role === 'admin' ? '(管理员)' : ''}` : '';
}

function setAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.atab === tab));
  els.authLoginEmail.closest('form').classList.toggle('hidden', tab !== 'login');
  els.authRegEmail.closest('form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('authVerifyPanel').classList.add('hidden');
  if (tab === 'register') maybeRenderTurnstile();
}

function bindAuthEvents() {
  document.querySelectorAll('.auth-tab').forEach((b) =>
    b.addEventListener('click', () => setAuthTab(b.dataset.atab))
  );

  document.getElementById('authFormLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    els.authLoginHint.textContent = '登录中…';
    btn.disabled = true;
    try {
      const res = await window.grokAPI.authLogin({
        email: els.authLoginEmail.value.trim(),
        password: els.authLoginPassword.value,
      });
      if (!res || !res.token) throw new Error('登录失败');
      state.auth = { loggedIn: true, user: res.user };
      showAppScreen();
      els.authLoginHint.textContent = '';
    } catch (err) {
      els.authLoginHint.textContent = (err && err.message) || '登录失败';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('authFormRegister').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    els.authRegHint.textContent = '注册中…';
    btn.disabled = true;
    try {
      const res = await window.grokAPI.authRegister({
        email: els.authRegEmail.value.trim(),
        name: els.authRegName.value.trim(),
        password: els.authRegPassword.value,
        turnstileToken: turnstileToken || undefined,
      });
      if (!res || !res.email) throw new Error('注册失败');
      els.authVerifyEmail.value = res.email;
      els.authRegEmail.closest('form').classList.add('hidden');
      document.getElementById('authVerifyPanel').classList.remove('hidden');
      els.authRegHint.textContent = '';
    } catch (err) {
      els.authRegHint.textContent = (err && err.message) || '注册失败';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('authFormVerify').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    els.authVerifyHint.textContent = '验证中…';
    btn.disabled = true;
    try {
      const res = await window.grokAPI.authVerify({
        email: els.authVerifyEmail.value.trim(),
        code: els.authVerifyCode.value.trim(),
      });
      if (!res || !res.token) throw new Error('验证失败');
      state.auth = { loggedIn: true, user: res.user };
      showAppScreen();
      els.authVerifyHint.textContent = '';
    } catch (err) {
      els.authVerifyHint.textContent = (err && err.message) || '验证失败';
    } finally {
      btn.disabled = false;
    }
  });

  els.logoutBtn.addEventListener('click', async () => {
    try {
      await window.grokAPI.authLogout();
    } catch {}
    state.auth = { loggedIn: false, user: null };
    state.currentId = null;
    state.current = null;
    state.pending = null;
    showAuthScreen();
  });

  document.getElementById('openWebRegBtn').addEventListener('click', () => {
    window.grokAPI.authOpenRegister().catch(() => {});
  });

  // Browser login: open web login page, poll until the device is approved.
  const authDevicePanel = document.getElementById('authDevicePanel');
  let devicePollTimer = null;
  async function stopDevicePoll() {
    if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
    authDevicePanel.classList.add('hidden');
    els.authLoginEmail.closest('form').classList.remove('hidden');
  }
  document.getElementById('authBrowserLoginBtn').addEventListener('click', async () => {
    const btn = document.getElementById('authBrowserLoginBtn');
    btn.disabled = true;
    try {
      const { deviceId } = await window.grokAPI.authDeviceLogin();
      if (!deviceId) throw new Error('无法启动浏览器登录');
      els.authLoginEmail.closest('form').classList.add('hidden');
      authDevicePanel.classList.remove('hidden');
      document.getElementById('authDeviceHint').textContent = '';
      const t0 = Date.now();
      devicePollTimer = setInterval(async () => {
        try {
          const res = await window.grokAPI.authDevicePoll({ deviceId });
          if (res && res.approved && res.user) {
            stopDevicePoll();
            state.auth = { loggedIn: true, user: res.user };
            showAppScreen();
            return;
          }
        } catch {}
        if (Date.now() - t0 > 2 * 60 * 1000) {
          stopDevicePoll();
          document.getElementById('authDeviceHint').textContent = '等待超时,请重试';
          btn.disabled = false;
        }
      }, 1500);
    } catch (err) {
      els.authLoginHint.textContent = (err && err.message) || '无法启动浏览器登录';
      btn.disabled = false;
    }
  });
  document.getElementById('authDeviceCancelBtn').addEventListener('click', () => {
    stopDevicePoll();
    document.getElementById('authBrowserLoginBtn').disabled = false;
  });
}

async function checkAuth() {
  try {
    const status = await window.grokAPI.authStatus();
    state.auth = { loggedIn: !!(status && status.loggedIn), user: (status && status.user) || null };
  } catch (err) {
    console.error('authStatus failed:', err);
    state.auth = { loggedIn: false, user: null };
  }
  if (state.auth.loggedIn) showAppScreen();
  else showAuthScreen();
}

/* ---------------- init ---------------- */

async function init() {
  try {
    const s = await window.grokAPI.getSettings();
    state.settings = { ...state.settings, ...s };
  } catch (err) {
    console.error('getSettings failed:', err);
  }

  bindAuthEvents();
  await checkAuth();

  applyModels(state.models);
  wireEvents();
  applyPermissionUI();
  resizeInput();
  updateComposerButtons();
  renderModelChip();
  updateContextMeter();
  setHeroMode();

  await refreshConversations();
  if (state.conversations.length) {
    openConversation(state.conversations[0].id);
  } else {
    showEmptyState();
  }
  refreshModels(true);
}

init();
