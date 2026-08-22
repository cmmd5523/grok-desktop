// Streaming tool-call test for a grok2api model.
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8000/v1');
const KEY = (process.env.API_KEY || 'sk-placeholder');
const MODEL = process.env.MODEL || 'grok-4.3-fast';
const FORCE_TOOL = process.env.FORCE === '1';

const bashTool = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a bash command and return its output',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The bash command to run' } },
      required: ['command'],
    },
  },
};

(async () => {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'user', content: '执行 bash 命令 echo hello-from-grok 并把输出告诉我,必须使用工具。' },
      ],
      tools: [bashTool],
      tool_choice: FORCE_TOOL ? { type: 'function', function: { name: 'bash' } } : 'auto',
      stream: true,
    }),
  });
  console.log('status:', res.status);
  const text = await res.text();
  if (res.status !== 200) { console.log(text.slice(0, 400)); return; }

  let toolCalls = [];
  let content = '';
  let finish = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const p = t.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const chunk = JSON.parse(p);
      const c = chunk.choices && chunk.choices[0];
      if (!c) continue;
      const d = c.delta || {};
      if (d.content) content += d.content;
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          toolCalls[tc.index] = toolCalls[tc.index] || { id: tc.id || '', name: '', args: '' };
          if (tc.id) toolCalls[tc.index].id = tc.id;
          if (tc.function) {
            if (tc.function.name) toolCalls[tc.index].name += tc.function.name;
            if (tc.function.arguments) toolCalls[tc.index].args += tc.function.arguments;
          }
        }
      }
      if (c.finish_reason) finish = c.finish_reason;
    } catch { /* ignore */ }
  }
  console.log('finish_reason:', finish);
  console.log('content:', JSON.stringify(content.slice(0, 200)));
  console.log('tool_calls:', JSON.stringify(toolCalls.filter(Boolean)));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
