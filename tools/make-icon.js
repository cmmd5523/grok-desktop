// Generate a Grok-style app icon: dark rounded-square + white 8-point star.
// Renders each size on an offscreen canvas, then assembles a multi-size ICO.
// Usage: npx electron tools/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.resolve(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function starPath(cx, cy, R, r, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = rot + (i * Math.PI) / 8;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
    .join(' ')
    .concat(' Z');
}

function buildIco(pngBuffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngBuffers.length, 4);
  const entries = [];
  let offset = 6 + pngBuffers.length * 16;
  pngBuffers.forEach((buf, i) => {
    const size = SIZES[i];
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
  });
  return Buffer.concat([header, ...entries, ...pngBuffers]);
}

const DRAW_FN = `
(async (size) => {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  // Dark rounded-square background with a subtle vertical gradient.
  const r = size * 0.225;
  const grd = ctx.createLinearGradient(0, 0, 0, size);
  grd.addColorStop(0, '#26262b');
  grd.addColorStop(1, '#0b0b0d');
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fillStyle = grd;
  ctx.fill();

  // Grok 8-point star, slightly above center.
  const path = ${JSON.stringify('__STAR__')};
  const pts = path.replace(/[MLZ]/g, ' ').trim().split(/\\s+/).map(Number);
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(255,255,255,0.35)';
  ctx.shadowBlur = size * 0.05;
  ctx.fill();
  ctx.shadowBlur = 0;

  // Subtle inner glow band behind the star for depth.
  return c.toDataURL('image/png');
})
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL('about:blank');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pngs = [];
  for (const size of SIZES) {
    const fn = DRAW_FN.replace('__STAR__', starPath(size / 2, size * 0.52, size * 0.4, size * 0.145));
    const dataUrl = await win.webContents.executeJavaScript(`${fn}(${size})`, true);
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    pngs.push(buf);
    fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), buf);
  }
  // 512px master
  const fn512 = DRAW_FN.replace('__STAR__', starPath(256, 266, 205, 74));
  const png512 = Buffer.from(
    (await win.webContents.executeJavaScript(`${fn512}(512)`, true)).split(',')[1],
    'base64'
  );
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);

  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(pngs));
  console.log('icons written:', OUT_DIR);
  app.exit(0);
});
