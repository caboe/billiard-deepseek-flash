/**
 * tools/png-stats.mjs — decode a PNG (zlib is built into node) and report pixel
 * statistics. Used to verify what the game actually renders without a human
 * looking at the image.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit png supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported color type ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      switch (filter) {
        case 0:
          break;
        case 1:
          v = v + a;
          break;
        case 2:
          v = v + b;
          break;
        case 3:
          v = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error('bad filter ' + filter);
      }
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

export function pixel(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Average colour of a rectangle. */
export function avgRect(img, x0, y0, w, h) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const [pr, pg, pb] = pixel(img, x, y);
      r += pr;
      g += pg;
      b += pb;
      n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

export function luma([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Count pixels close to a target colour, with an optional region. */
export function countNear(img, target, tol = 42, region) {
  const [x0, y0, w, h] = region || [0, 0, img.width, img.height];
  let n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const [r, g, b] = pixel(img, x, y);
      if (
        Math.abs(r - target[0]) <= tol &&
        Math.abs(g - target[1]) <= tol &&
        Math.abs(b - target[2]) <= tol
      ) {
        n++;
      }
    }
  }
  return n;
}

/** Count pixels matching an arbitrary predicate on [r,g,b]. */
export function countPredicate(img, pred, region) {
  const [x0, y0, w, h] = region || [0, 0, img.width, img.height];
  let n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const p = pixel(img, x, y);
      if (pred(p[0], p[1], p[2])) n++;
    }
  }
  return n;
}

/** Saturated cloth green, robust to exposure changes. */
export const countGreen = (img, region) =>
  countPredicate(img, (r, g, b) => g > 42 && g > r * 1.35 && g > b * 1.12, region);

export const countYellow = (img, region) =>
  countPredicate(img, (r, g, b) => r > 110 && g > 85 && b < 95 && r > b * 1.7 && g > b * 1.3, region);

export const countRed = (img, region) =>
  countPredicate(img, (r, g, b) => r > 95 && r > g * 1.7 && r > b * 1.7, region);

export const countBlue = (img, region) =>
  countPredicate(img, (r, g, b) => b > 80 && b > r * 1.35 && b > g * 1.12, region);

export const countBright = (img, region) =>
  countPredicate(img, (r, g, b) => r > 205 && g > 205 && b > 205, region);

/** Overall histogram of coarse colour buckets, most common first. */
export function dominant(img, buckets = 8, region) {
  const [x0, y0, w, h] = region || [0, 0, img.width, img.height];
  const map = new Map();
  const step = 4;
  for (let y = y0; y < y0 + h; y += step) {
    for (let x = x0; x < x0 + w; x += step) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const [r, g, b] = pixel(img, x, y);
      const key = `${(r >> 5) << 5},${(g >> 5) << 5},${(b >> 5) << 5}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, buckets)
    .map(([k, v]) => ({ color: k.split(',').map(Number), count: v }));
}

export const hex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

if (process.argv[1] && process.argv[1].endsWith('png-stats.mjs')) {
  const file = process.argv[2];
  const img = decodePng(file);
  console.log(`${file}: ${img.width}x${img.height}, channels=${img.channels}`);
  console.log('dominant:', dominant(img, 8));
  console.log('centre avg:', hex(avgRect(img, img.width / 2 - 200, img.height / 2 - 120, 400, 240)));
  console.log('top-left avg:', hex(avgRect(img, 0, 0, 300, 140)));
}
