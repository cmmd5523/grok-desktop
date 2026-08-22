// Pixel sanity check for the generated icon PNGs.
const fs = require('fs');
const zlib = require('zlib');

function decodePng(buf) {
  // Minimal PNG decoder: IHDR + IDAT (unfiltered or basic filters) -> RGBA rows.
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let rowStart = 0;
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[rowStart];
    const line = raw.slice(rowStart + 1, rowStart + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 255;
      cur[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      out[d] = cur[s];
      out[d + 1] = bpp > 1 ? cur[s + 1] : cur[s];
      out[d + 2] = bpp > 2 ? cur[s + 2] : cur[s];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    prev.set(cur);
    rowStart += 1 + stride;
  }
  return { width, height, pixels: out };
}

const file = process.argv[2];
const buf = fs.readFileSync(file);
const { width, height, pixels } = decodePng(buf);
const px = (x, y) => {
  const i = (y * width + x) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
};
const corner = px(1, 1);
const center = px(Math.floor(width / 2), Math.floor(height * 0.52));
const mid = px(Math.floor(width / 2), Math.floor(height / 2));
console.log(`${file}: ${width}x${height}`);
console.log('corner(1,1)  =', corner.join(','), corner[0] < 60 ? 'DARK ✓' : 'NOT DARK ✗');
console.log('center(.5,.52)=', center.join(','), center[0] > 200 ? 'WHITE ✓' : 'NOT WHITE ✗');
console.log('mid(.5,.5)   =', mid.join(','), mid[0] > 200 ? 'WHITE ✓' : 'other');
