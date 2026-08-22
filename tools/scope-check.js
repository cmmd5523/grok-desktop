// Scope check: is the upstream 403 specific to (reasoning model + file) or
// does it also hit plain text / images on reasoning models?
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { streamChat, ApiError } = require(path.resolve(__dirname, '..', 'src', 'api'));

const pdfUri = `data:application/pdf;base64,${fs.readFileSync(path.resolve(__dirname, '..', '..', 'Week1_Part1.pdf')).toString('base64')}`;
const pngBuf = fs.readFileSync(path.resolve(__dirname, '..', '..', 'grok-desktop', 'build', 'icon-64.png'));
const pngUri = `data:image/png;base64,${pngBuf.toString('base64')}`;
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8000/v1');
const API_KEY = (process.env.API_KEY || 'sk-placeholder');

async function run(label, model, content) {
  const deltas = [];
  let usage = null;
  try {
    usage = await streamChat({
      baseUrl: BASE_URL, apiKey: API_KEY, model,
      messages: [{ role: 'user', content }],
      onDelta: (d) => deltas.push(d),
    });
    console.log(`PASS  [${label}] ${model}: chars=${deltas.join('').length} usage=${usage ? usage.prompt_tokens + '+' + usage.completion_tokens : 'null'}`);
  } catch (err) {
    const body = err && err.body && typeof err.body === 'object' ? JSON.stringify(err.body.error || err.body).slice(0, 120) : '';
    console.log(`FAIL  [${label}] ${model}: ${err.message}${body ? '  body=' + body : ''}`);
  }
}

app.whenReady().then(async () => {
  await run('plain-text', 'grok-4.3-medium', '你好,1+1=?');
  await run('pdf', 'grok-4.3-medium', [{ type: 'text', text: '解释' }, { type: 'file', file: { data: pdfUri } }]);
  await run('png', 'grok-4.3-medium', [{ type: 'text', text: '描述' }, { type: 'image_url', image_url: { url: pngUri } }]);
  await run('pdf', 'grok-4.3-high', [{ type: 'text', text: '解释' }, { type: 'file', file: { data: pdfUri } }]);
  await run('pdf', 'grok-4.20-expert', [{ type: 'text', text: '解释' }, { type: 'file', file: { data: pdfUri } }]);
  app.exit(0);
});
