// Test whether a grok2api model supports OpenAI-compatible tool calling.
const BASE = 'http://md-grok.de5.net/v1';
const KEY = 'sk-mdchen';
const MODEL = process.env.MODEL || 'grok-4.3-console';

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

const readTool = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a text file from disk',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

async function call(messages, extra = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: [bashTool, readTool],
      tool_choice: 'auto',
      stream: false,
      ...extra,
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

function summarize(choice) {
  const m = choice.message || {};
  const calls = (m.tool_calls || []).map((tc) => ({
    name: tc.function.name,
    args: tc.function.arguments,
  }));
  return { role: m.role, content: (m.content || '').slice(0, 100), tool_calls: calls, finish: choice.finish_reason };
}

(async () => {
  // Round 1: ask something that MUST use the bash tool
  const r1 = await call([
    { role: 'user', content: '使用 bash 工具执行命令 `echo hello-from-grok`,然后告诉我输出是什么。不要编造,必须实际调用工具。' },
  ]);
  console.log('--- ROUND 1 ---');
  console.log('status:', r1.status);
  if (r1.status !== 200) { console.log('body:', JSON.stringify(r1.json).slice(0, 500)); return; }
  const c1 = r1.json.choices[0];
  console.log(JSON.stringify(summarize(c1), null, 2));

  const calls = (c1.message.tool_calls || []).filter(Boolean);
  if (calls.length === 0) {
    console.log('=> NO tool_calls returned. Model did not call the tool.');
    return;
  }

  // Round 2: feed the tool result back
  const messages = [
    { role: 'user', content: '使用 bash 工具执行命令 `echo hello-from-grok`,然后告诉我输出是什么。' },
    c1.message,
    ...calls.map((tc) => ({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify({ stdout: 'hello-from-grok\n', exit_code: 0 }),
    })),
  ];
  const r2 = await call(messages);
  console.log('--- ROUND 2 (tool result fed back) ---');
  console.log('status:', r2.status);
  if (r2.status !== 200) { console.log('body:', JSON.stringify(r2.json).slice(0, 500)); return; }
  const c2 = r2.json.choices[0];
  console.log(JSON.stringify(summarize(c2), null, 2));
  console.log('=> full final content:', JSON.stringify(c2.message.content));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
