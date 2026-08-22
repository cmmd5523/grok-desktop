// Diagnose the PDF upload failure: dump every raw SSE line from the gateway
// so we can see whether it errors, returns empty chunks, or never sends usage.
const fs = require('fs');
const path = require('path');

const pdfPath = process.argv[2] || path.resolve(__dirname, '..', '..', 'Week1_Part1.pdf');
const MODEL = process.argv[3] || 'grok-4.3-fast';
const dataUri = `data:application/pdf;base64,${fs.readFileSync(pdfPath).toString('base64')}`;
console.log('PDF:', pdfPath, fs.statSync(pdfPath).size, 'bytes; dataUri length:', dataUri.length, '; model:', MODEL);

const BASE_URL = 'http://md-grok.de5.net/v1';
const API_KEY = 'sk-mdchen';

(async () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '请解释一下这个 PDF 文件的内容' },
        { type: 'file', file: { data: dataUri } },
      ],
    },
  ];
  const body = { model: MODEL, messages, stream: true };
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    console.log('REQUEST FAILED:', err.message);
    process.exit(1);
  }
  console.log('HTTP', res.status, res.statusText);
  if (!res.ok) {
    const text = await res.text();
    console.log('BODY:', text.slice(0, 1000));
    process.exit(0);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let deltaCount = 0;
  let usageSeen = false;
  let lineNo = 0;
  let errorChunk = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      lineNo++;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        console.log(`line ${lineNo}: [DONE]  (deltaCount=${deltaCount} usageSeen=${usageSeen})`);
        continue;
      }
      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        console.log(`line ${lineNo}: UNPARSEABLE: ${payload.slice(0, 200)}`);
        continue;
      }
      const ch = j.choices && j.choices[0];
      if (ch && ch.delta && typeof ch.delta.content === 'string') {
        deltaCount += ch.delta.content.length;
        if (deltaCount <= 60) console.log(`line ${lineNo}: delta content: ${JSON.stringify(ch.delta.content.slice(0, 40))}`);
      } else if (j.choices && Array.isArray(j.choices) && j.choices.length === 0) {
        console.log(`line ${lineNo}: empty-choices chunk${j.usage ? ' WITH usage' : ''}`);
        if (j.usage) { usageSeen = true; console.log('   usage:', JSON.stringify(j.usage)); }
      } else if (ch && ch.finish_reason) {
        console.log(`line ${lineNo}: finish_reason=${ch.finish_reason}`);
      } else if (ch && ch.delta && ch.delta.reasoning) {
        console.log(`line ${lineNo}: reasoning chunk (${ch.delta.reasoning.length} chars)`);
      } else if (ch && ch.delta && ch.delta.thinking) {
        console.log(`line ${lineNo}: thinking chunk`);
      } else if (j.error) {
        errorChunk = j.error;
        console.log(`line ${lineNo}: ERROR CHUNK:`, JSON.stringify(j.error));
      } else {
        const keys = Object.keys(j);
        console.log(`line ${lineNo}: other chunk keys=${keys.join(',')} choices=${JSON.stringify(j.choices).slice(0, 120)}`);
      }
    }
  }
  console.log(`SUMMARY: deltaChars=${deltaCount} usageSeen=${usageSeen} errorChunk=${errorChunk ? JSON.stringify(errorChunk) : 'none'}`);
  if (deltaCount === 0 && !usageSeen) {
    console.log('==> This is the "服务器返回了空响应" condition (deltaCount===0 && !usage)');
  } else {
    console.log('==> Stream was fine; app-side bug suspected');
  }
})().catch((e) => {
  console.log('FATAL:', e && e.message);
  process.exit(1);
});
