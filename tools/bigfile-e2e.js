// Verify api.js streamChat with a large base64 "PDF" over https through
// Electron's net.fetch (system proxy). Run: npx electron tools/bigfile-e2e.js
const path = require('path');
const os = require('os');
const { app } = require('electron');

app.setPath('userData', path.join(os.tmpdir(), 'grok-bf-' + Date.now()));
const { streamChat } = require(path.join(__dirname, '..', 'src', 'api'));

function makePdf(mb) {
  const buf = Buffer.alloc(mb * 1024 * 1024);
  for (let i = 0; i < buf.length; i += 4096) buf.write('%PDF-1.4 fake\n', i);
  return 'data:application/pdf;base64,' + buf.toString('base64');
}

app.whenReady().then(async () => {
  try {
    const t0 = Date.now();
    let got = 0;
    const usage = await streamChat({
      baseUrl: 'https://md-grok.de5.net/v1',
      apiKey: 'sk-mdchen',
      model: 'grok-4.3-fast',
      messages: [
        { role: 'user', content: '这个 PDF 里写了什么?简要回答。' },
        { role: 'user', content: [{ type: 'file', file: { data: makePdf(6) } }] },
      ],
      onDelta: (d) => { got += d.length; },
    });
    console.log('耗时:', ((Date.now() - t0) / 1000).toFixed(1) + 's, 收到字符:', got, 'usage:', JSON.stringify(usage));
    console.log(got > 0 ? 'BIGFILE E2E PASS' : 'BIGFILE E2E EMPTY');
    app.exit(got > 0 ? 0 : 1);
  } catch (err) {
    console.log('FAIL', err.name, err.message);
    app.exit(1);
  }
});
