// Verify compact path: completeChat (non-stream) against the gateway,
// plus the effort->model resolution logic used by the model selector.
const { completeChat } = require('../src/api');

function resolveModel(base, effort, models) {
  if (!effort || effort === 'off') return base;
  const core = base.replace(/-(fast|low|medium|high)$/, '');
  const candidate = `${core}-${effort}`;
  return models.includes(candidate) ? candidate : base;
}

const MODELS = [
  'grok-4.3-fast', 'grok-4.3-low', 'grok-4.3-medium', 'grok-4.3-high',
  'grok-4.20-auto', 'grok-4.20-expert', 'grok-4.20-fast', 'grok-4.20-0309',
];

// Resolution checks
const cases = [
  ['grok-4.3-fast', 'medium', 'grok-4.3-medium'],
  ['grok-4.3-fast', 'high', 'grok-4.3-high'],
  ['grok-4.3-medium', 'low', 'grok-4.3-low'],
  ['grok-4.20-0309', 'high', 'grok-4.20-0309'], // unsupported -> stays
  ['grok-4.20-fast', 'low', 'grok-4.20-fast'], // unsupported -> stays
  ['grok-4.3-fast', 'off', 'grok-4.3-fast'],
];
let ok = true;
for (const [base, effort, expect] of cases) {
  const got = resolveModel(base, effort, MODELS);
  const pass = got === expect;
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} resolve(${base}, ${effort}) = ${got}${pass ? '' : ` (expected ${expect})`}`);
}

(async () => {
  try {
    const summary = await completeChat({
      baseUrl: 'http://md-grok.de5.net/v1',
      apiKey: 'sk-mdchen',
      model: 'grok-4.3-fast',
      messages: [
        { role: 'system', content: '你是会话压缩器。请把给定的对话历史压缩成简洁中文摘要,只输出摘要正文。' },
        { role: 'user', content: '用户: 帮我写个Windows桌面应用\n助手: 好的,用Electron,需要什么功能?\n用户: 要能上传PDF\n助手: 可以,已加入文件上传功能,单文件上限25MB' },
      ],
    });
    console.log('compact summary:', JSON.stringify(summary && summary.slice(0, 200)));
    if (!summary || !summary.trim()) { ok = false; console.log('FAIL: empty summary'); }
  } catch (e) {
    ok = false;
    console.error('FAIL: completeChat error:', e.message);
  }
  console.log(ok ? 'ALL PASS' : 'SOME FAIL');
  process.exit(ok ? 0 : 1);
})();
