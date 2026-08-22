// Reproduce the PDF failure inside Electron's main-process fetch (same path
// the app uses: src/api.js streamChat), with several models.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { streamChat } = require(path.resolve(__dirname, '..', 'src', 'api'));

const pdfPath = path.resolve(__dirname, '..', '..', 'Week1_Part1.pdf');
const dataUri = `data:application/pdf;base64,${fs.readFileSync(pdfPath).toString('base64')}`;
const BASE_URL = 'http://md-grok.de5.net/v1';
const API_KEY = 'sk-mdchen';

async function tryModel(model) {
  const deltas = [];
  let usage = null;
  try {
    usage = await streamChat({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请解释一下这个 PDF 文件的内容(简要)' },
            { type: 'file', file: { data: dataUri } },
          ],
        },
      ],
      onDelta: (d) => deltas.push(d),
    });
    console.log(`PASS  ${model}: deltas=${deltas.length} chars=${deltas.join('').length} usage=${usage ? `${usage.prompt_tokens}+${usage.completion_tokens}` : 'null'}`);
  } catch (err) {
    console.log(`FAIL  ${model}: ${err.message}`);
  }
}

app.whenReady().then(async () => {
  for (const m of ['grok-4.3-fast', 'grok-4.3-medium', 'grok-4.3-high']) {
    await tryModel(m);
  }
  app.exit(0);
});
