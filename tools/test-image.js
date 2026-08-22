// Image upload retry with a larger real PNG (8x8 gradient).
const BASE = 'http://md-grok.de5.net/v1';
const KEY = 'sk-mdchen';
const MODEL = 'grok-4.3-fast';

function makePng(width, height) {
  // Minimal valid PNG: IHDR + IDAT (raw deflate) + IEND.
  const { deflateSync } = require('zlib');
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const i = y * (1 + width * 3) + 1 + x * 3;
      raw[i] = (x * 255) / width;
      raw[i + 1] = (y * 255) / height;
      raw[i + 2] = 128;
    }
  }
  const crc = require('zlib').crc32 || null;
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    // CRC32 over type+data
    let c = ~0;
    const all = Buffer.concat([typeBuf, data]);
    for (const b of all) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    crcBuf.writeUInt32BE(~c >>> 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  const png = makePng(64, 64);
  const dataUri = 'data:image/png;base64,' + png.toString('base64');
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片大概是什么颜色渐变?简短回答。' },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
    }),
  });
  console.log('status:', res.status);
  const text = await res.text();
  if (res.status !== 200) { console.log(text.slice(0, 400)); return; }
  console.log('reply:', JSON.stringify(JSON.parse(text).choices[0].message.content));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
