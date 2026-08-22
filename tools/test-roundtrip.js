// Round-trip: tool_calls -> tool result -> final answer, streaming, on grok-4.3-fast.
const BASE = 'http://md-grok.de5.net/v1';
const KEY = 'sk-mdchen';
const MODEL = 'grok-4.3-fast';

const bashTool = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a bash command and return its output',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
};

async function streamChat(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: [bashTool], tool_choice: 'auto', stream: true }),
  });
  if (res.status !== 200) return { error: (await res.text()).slice(0, 300) };
  const text = await res.text();
  let calls = [];
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
      const d = (c && c.delta) || {};
      if (d.content) content += d.content;
      if (d.tool_calls) for (const tc of d.tool_calls) {
        calls[tc.index] = calls[tc.index] || { id: tc.id || '', name: '', args: '' };
        if (tc.id) calls[tc.index].id = tc.id;
        if (tc.function) {
          if (tc.function.name) calls[tc.index].name += tc.function.name;
          if (tc.function.arguments) calls[tc.index].args += tc.function.arguments;
        }
      }
      if (c && c.finish_reason) finish = c.finish_reason;
    } catch { /* ignore */ }
  }
  return { finish, content, calls: calls.filter(Boolean) };
}

(async () => {
  const userMsg = { role: 'user', content: '执行 bash 命令 `echo hello-from-grok` 并把输出告诉我,必须使用工具。' };

  // Round 1: get tool_calls
  const r1 = await streamChat([userMsg]);
  console.log('ROUND1:', JSON.stringify(r1));
  if (!r1.calls.length) { console.log('=> no tool calls in round 1'); return; }
  const call = r1.calls[0];

  // Round 2: feed the tool result back
  const r2 = await streamChat([
    userMsg,
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] },
    { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ stdout: 'hello-from-grok\n', exit_code: 0 }) },
  ]);
  console.log('ROUND2:', JSON.stringify(r2));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
