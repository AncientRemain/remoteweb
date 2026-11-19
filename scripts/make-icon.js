// Draws the Beam Remote icon (flat blue tile, white monitor outline, cursor arrow) and
// writes assets/icon.png (256 px), icon-512.png and icon.ico (16-256 px). Run: npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
const TILE = [58, 122, 254];   // #3a7afe, the default accent
const WHITE = [255, 255, 255];
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

function roundedRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// Signed distance to a polygon (negative inside).
function polygon(px, py, pts) {
  let d = Infinity, s = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    const ex = xj - xi, ey = yj - yi, wx = px - xi, wy = py - yi;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey));
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= yi, c2 = py < yj, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

// Classic pointer, tip at the origin, scaled and moved onto the screen.
const ARROW = [[0, 0], [0, 13], [3.2, 10], [5.6, 15.2], [7.7, 14.3], [5.3, 9.2], [9.6, 9.2]].map(([x, y]) => [13.2 + x * 0.6, 9.6 + y * 0.6]);

function draw(size) {
  const s = size / 32;
  const aa = 0.5 / s;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / s, py = (y + 0.5) / s;
      const cover = d => clamp(0.5 - d / (2 * aa));
      let col = [0, 0, 0], alpha = 0;
      const over = (c, a) => { col = col.map((v, i) => v * (1 - a) + c[i] * a); alpha = alpha * (1 - a) + a; };
      over(TILE, cover(roundedRect(px, py, 16, 16, 15, 15, 7.2)));
      // monitor: outline ring plus stand
      const outer = roundedRect(px, py, 15.2, 14, 10.6, 7.6, 2.4);
      const inner = roundedRect(px, py, 15.2, 14, 8.6, 5.6, 0.9);
      over(WHITE, cover(Math.max(outer, -inner)));
      over(WHITE, cover(roundedRect(px, py, 15.2, 23.3, 1.3, 1.7, 0.3)));
      over(WHITE, cover(roundedRect(px, py, 15.2, 25.3, 4.8, 0.95, 0.95)));
      // pointer, sitting inside the screen
      over(WHITE, cover(polygon(px, py, ARROW)));
      const i = (y * size + x) * 4;
      const al = alpha || 1;
      rgba[i] = Math.round(col[0] / al * (alpha ? 1 : 0)); rgba[i + 1] = Math.round(col[1] / al * (alpha ? 1 : 0));
      rgba[i + 2] = Math.round(col[2] / al * (alpha ? 1 : 0)); rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const rgba = draw(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((size, i) => {
  const e = Buffer.alloc(16);
  e[0] = size === 256 ? 0 : size; e[1] = size === 256 ? 0 : size;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
fs.writeFileSync(path.join(OUT, 'icon.png'), images[sizes.length - 1]);
fs.writeFileSync(path.join(OUT, 'icon-512.png'), png(512));
fs.writeFileSync(path.join(OUT, 'icon-32.png'), images[2]);
console.log(`Wrote ${path.join(OUT, 'icon.ico')}, icon.png, icon-512.png and icon-32.png`);
