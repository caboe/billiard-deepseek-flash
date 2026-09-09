/**
 * textures.js — procedural canvas textures. No image assets, so the whole game
 * is a handful of text files.
 */
import * as THREE from 'three';

const BALL_COLORS = {
  1: '#f0c419',
  2: '#1b56b0',
  3: '#d52a2a',
  4: '#6f2c91',
  5: '#e8790f',
  6: '#12803f',
  7: '#8d2020',
  8: '#17171c',
  9: '#f0c419',
  10: '#1b56b0',
  11: '#d52a2a',
  12: '#6f2c91',
  13: '#e8790f',
  14: '#12803f',
  15: '#8d2020',
};

export const ballColor = (id) => BALL_COLORS[id] || '#ffffff';
export const isStripe = (id) => id >= 9 && id <= 15;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Fine weave + fibre noise for the cloth. */
export function clothTexture(color = '#1b6b47') {
  const size = 512;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);

  // weave: two sets of fine lines
  g.globalAlpha = 0.055;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1;
  for (let i = 0; i < size; i += 3) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, size);
    g.stroke();
  }
  g.strokeStyle = '#000000';
  g.globalAlpha = 0.07;
  for (let i = 0; i < size; i += 3) {
    g.beginPath();
    g.moveTo(0, i);
    g.lineTo(size, i);
    g.stroke();
  }

  // speckle
  g.globalAlpha = 1;
  for (let i = 0; i < 26000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const l = Math.random();
    g.fillStyle = l > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
    g.fillRect(x, y, 1.4, 1.4);
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Bump map for the cloth (same noise, greyscale). */
export function clothBump() {
  const size = 256;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#808080';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 20000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const v = 128 + (Math.random() * 60 - 30);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, y, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Dark polished wood for rails and the table frame. */
export function woodTexture() {
  const w = 512;
  const h = 512;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const base = g.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, '#4a2c17');
  base.addColorStop(0.45, '#5c3820');
  base.addColorStop(1, '#3a2112');
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);

  // grain
  for (let i = 0; i < 260; i++) {
    const y = Math.random() * h;
    const amp = 4 + Math.random() * 16;
    g.strokeStyle = `rgba(${20 + Math.random() * 40},${10 + Math.random() * 20},0,${0.06 + Math.random() * 0.12})`;
    g.lineWidth = 0.6 + Math.random() * 2.2;
    g.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const yy = y + Math.sin((x / w) * Math.PI * 2 + i) * amp;
      x === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
    }
    g.stroke();
  }
  // knots
  for (let i = 0; i < 7; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    for (let r = 3; r < 26; r += 3) {
      g.strokeStyle = `rgba(30,15,5,${0.05 + Math.random() * 0.08})`;
      g.lineWidth = 1.2;
      g.beginPath();
      g.ellipse(x, y, r, r * 0.5, Math.random(), 0, Math.PI * 2);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Dark floor for the room. */
export function floorTexture() {
  const size = 512;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#12100e';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 9000; i++) {
    const v = 10 + Math.random() * 26;
    g.fillStyle = `rgba(${v},${v - 2},${v - 4},0.5)`;
    g.fillRect(Math.random() * size, Math.random() * size, 3, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Equirectangular environment for reflections: dark room with three lamp
 * hotspots and a soft floor bounce.
 */
export function environmentTexture() {
  const w = 1024;
  const h = 512;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#20242c');
  grad.addColorStop(0.45, '#14161a');
  grad.addColorStop(0.55, '#0c0d10');
  grad.addColorStop(1, '#191512');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // lamp pools
  const lamps = [
    [w * 0.25, h * 0.22],
    [w * 0.5, h * 0.18],
    [w * 0.75, h * 0.22],
  ];
  for (const [lx, ly] of lamps) {
    const r = 150;
    const lg = g.createRadialGradient(lx, ly, 0, lx, ly, r);
    lg.addColorStop(0, 'rgba(255,244,224,1)');
    lg.addColorStop(0.25, 'rgba(255,236,200,0.55)');
    lg.addColorStop(1, 'rgba(255,230,190,0)');
    g.fillStyle = lg;
    g.beginPath();
    g.arc(lx, ly, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The face of a pool ball, drawn as an equirectangular map.
 * Solids get a coloured body, stripes get a white body with a colour band.
 * The number sits in a white patch at two opposite longitudes so it is
 * readable from either side.
 */
export function ballTexture(id) {
  const W = 1024;
  const H = 512;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');

  if (id === 0) {
    // cue ball: white with six red measle dots
    g.fillStyle = '#f7f5ef';
    g.fillRect(0, 0, W, H);
    const dots = [
      [0.5, 0.5],
      [0.25, 0.35],
      [0.75, 0.35],
      [0.0, 0.5],
      [0.5, 0.2],
      [0.5, 0.8],
    ];
    for (const [u, v] of dots) {
      g.fillStyle = '#c0392b';
      g.beginPath();
      g.arc(u * W, (1 - v) * H, 14, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    const col = ballColor(id);
    const stripe = isStripe(id);
    g.fillStyle = stripe ? '#f7f5ef' : col;
    g.fillRect(0, 0, W, H);
    if (stripe) {
      // a band around the equator
      g.fillStyle = col;
      g.fillRect(0, H * 0.29, W, H * 0.42);
    }
    // subtle shading so the texture is not flat
    const shade = g.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(0,0,0,0.16)');
    shade.addColorStop(0.5, 'rgba(255,255,255,0.06)');
    shade.addColorStop(1, 'rgba(0,0,0,0.16)');
    g.fillStyle = shade;
    g.fillRect(0, 0, W, H);
  }

  // number patches
  if (id > 0) {
    for (const u of [0.25, 0.75]) {
      const cx = u * W;
      const cy = H * 0.5;
      const r = 62;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fillStyle = '#f7f5ef';
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,0.10)';
      g.stroke();
      g.fillStyle = '#141414';
      g.font = `bold ${r * 1.28}px "Helvetica Neue", Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(id), cx, cy + 2);
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Roughness map that makes the number patches slightly less glossy. */
export function ballRoughness() {
  const size = 256;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#2e2e2e';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 4000; i++) {
    const v = 40 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
