// End-to-end: app's own api.js streamChat now captures real usage from gateway.
const { streamChat } = require('../src/api');

(async () => {
  const deltas = [];
  const usage = await streamChat({
    baseUrl: (process.env.BASE_URL || 'http://127.0.0.1:8000/v1'),
    apiKey: (process.env.API_KEY || 'sk-placeholder'),
    model: 'grok-4.3-fast',
    messages: [{ role: 'user', content: '用三句话介绍你自己' }],
    onDelta: (d) => deltas.push(d),
  });
  const text = deltas.join('');
  console.log('deltas:', deltas.length, 'chars:', text.length);
  console.log('usage:', JSON.stringify(usage));
  if (usage && usage.prompt_tokens > 0 && usage.completion_tokens > 0 && text) {
    console.log('PASS: real usage captured, stream intact');
  } else {
    console.log('FAIL');
    process.exit(1);
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
