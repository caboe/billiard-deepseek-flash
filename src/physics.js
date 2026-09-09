/**
 * physics.js — 3D pool/billiard physics on a flat table plane.
 *
 * Coordinate system (matches three.js): +X along the long axis of the table,
 * +Z across it, +Y up. The cloth surface is the y = 0 plane, so a ball at rest
 * has its centre at y = BALL_RADIUS.
 *
 * The model is a proper rigid-body simulation, not a "bounce the velocities"
 * toy:
 *   - each ball has linear velocity v and angular velocity w
 *   - sliding friction acts on the contact patch and converts slide into roll
 *   - rolling resistance decelerates a rolling ball
 *   - ball/ball impacts use a normal impulse (restitution) plus a tangential
 *     friction impulse, so balls can "throw" each other
 *   - cushion impacts likewise use a normal + tangential impulse, so side spin
 *     genuinely changes the rebound angle
 *
 * This module has zero dependencies on three.js or the DOM so it can be
 * unit-tested in plain node.
 */

// ---------------------------------------------------------------------------
// Table + ball constants (metres, kilograms, seconds — a 9ft table)
// ---------------------------------------------------------------------------

export const BALL_RADIUS = 0.028575; // 2.25in diameter
export const BALL_MASS = 0.17;

export const TABLE_LENGTH = 2.54; // 9ft playing surface, along X
export const TABLE_WIDTH = 1.27; // 4.5ft, along Z
export const HALF_L = TABLE_LENGTH / 2;
export const HALF_W = TABLE_WIDTH / 2;

// Pocket mouth sizes measured along the cushion line.
export const CORNER_MOUTH = 0.076;
export const SIDE_MOUTH = 0.059;

// Pocket capture circles, centred on the cushion lines.
export const CORNER_POCKET_R = 0.084;
export const SIDE_POCKET_R = 0.079;

export const POCKETS = [
  { id: 0, x: -HALF_L, z: -HALF_W, r: CORNER_POCKET_R, kind: 'corner' },
  { id: 1, x: 0, z: -HALF_W, r: SIDE_POCKET_R, kind: 'side' },
  { id: 2, x: HALF_L, z: -HALF_W, r: CORNER_POCKET_R, kind: 'corner' },
  { id: 3, x: -HALF_L, z: HALF_W, r: CORNER_POCKET_R, kind: 'corner' },
  { id: 4, x: 0, z: HALF_W, r: SIDE_POCKET_R, kind: 'side' },
  { id: 5, x: HALF_L, z: HALF_W, r: CORNER_POCKET_R, kind: 'corner' },
];

// Spots.
export const FOOT_SPOT = { x: TABLE_LENGTH / 4, z: 0 };
export const HEAD_SPOT = { x: -TABLE_LENGTH / 4, z: 0 };

// ---------------------------------------------------------------------------
// Tunable physics parameters
// ---------------------------------------------------------------------------

export const PHYS = {
  g: 9.81,
  muSlide: 0.2, // cloth sliding friction
  muRoll: 0.0105, // rolling resistance
  ballRestitution: 0.95,
  ballFriction: 0.06, // throw between balls
  cushionRestitution: 0.74,
  cushionFriction: 0.19,
  spinDecay: 2.6, // vertical-axis spin bleed-off (1/s)
  slideToRoll: 0.02, // |contact velocity| below which we snap to rolling
  sleepSpeed: 0.006, // m/s — below this a rolling ball is stopped
  sleepSpin: 0.35, // rad/s
  maxShotSpeed: 8.6, // m/s (~19 mph, a hard break)
  fixedStep: 1 / 960,
  maxStepsPerFrame: 60,
};

const INV_I = 1 / (0.4 * BALL_MASS * BALL_RADIUS * BALL_RADIUS); // 2/5 m r^2
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Ball factory
// ---------------------------------------------------------------------------

export function createBall(id, x, z, opts = {}) {
  return {
    id,
    x,
    y: BALL_RADIUS,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    wx: 0,
    wy: 0,
    wz: 0,
    active: true, // still on the table
    potted: false, // pocketed at some point
    pocket: -1, // pocket id it fell into
    sinkY: 0, // render-only: extra fall distance
    sinkT: 0, // render-only: seconds since it dropped
    isCue: !!opts.isCue,
    ...opts,
  };
}

/** Standard 8-ball rack, apex ball on the foot spot. */
export const RACK_ORDER = [
  [1],
  [11, 2],
  [3, 8, 10],
  [9, 7, 14, 4],
  [5, 13, 15, 6, 12],
];

export function rackPositions() {
  const gap = BALL_RADIUS * 2 + 0.0004; // a hair of air between balls
  const rowDx = gap * (Math.sqrt(3) / 2);
  const out = [];
  for (let row = 0; row < RACK_ORDER.length; row++) {
    const balls = RACK_ORDER[row];
    const x = FOOT_SPOT.x + row * rowDx;
    for (let i = 0; i < balls.length; i++) {
      const z = FOOT_SPOT.z + (i - (balls.length - 1) / 2) * gap;
      out.push({ id: balls[i], x, z });
    }
  }
  return out;
}

/** Fresh rack: cue ball on the head spot, 15 object balls in the triangle. */
export function createRack() {
  const balls = [createBall(0, HEAD_SPOT.x, HEAD_SPOT.z, { isCue: true })];
  for (const p of rackPositions()) balls.push(createBall(p.id, p.x, p.z));
  return balls;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const speedOf = (b) => Math.hypot(b.vx, b.vy, b.vz);
export const spinOf = (b) => Math.hypot(b.wx, b.wy, b.wz);

/** True if a ball centre is outside the cushion lines (i.e. in a pocket mouth). */
function outsidePlayingArea(x, z) {
  return Math.abs(x) > HALF_L || Math.abs(z) > HALF_W;
}

/** Which pocket's mouth circle contains this point (pure geometry). */
export function pocketAt(x, z) {
  for (const p of POCKETS) {
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz < p.r * p.r) return p;
  }
  return null;
}

/**
 * Which pocket actually swallows a ball at this position. A ball can only be
 * captured once its centre has crossed the cushion line, which it can only do
 * through a mouth — that is what stops a ball resting in the corner of the
 * playing surface from being "pocketed".
 */
export function pocketCaptureAt(x, z) {
  if (!outsidePlayingArea(x, z)) return null;
  return pocketAt(x, z);
}

/**
 * Can a ball legally sit here? Used for ball-in-hand placement.
 */
export function isValidCuePosition(balls, x, z, ignoreId = 0) {
  const m = BALL_RADIUS;
  if (Math.abs(x) > HALF_L - m || Math.abs(z) > HALF_W - m) return false;
  if (pocketAt(x, z)) return false;
  for (const b of balls) {
    if (!b.active || b.id === ignoreId) continue;
    const dx = b.x - x;
    const dz = b.z - z;
    if (dx * dx + dz * dz < (2 * m) * (2 * m)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export class World {
  constructor(balls = createRack()) {
    this.balls = balls;
    /** Per-shot bookkeeping consumed by the rules engine. */
    this.shot = newShotRecord();
    /** Impact events produced during the most recent step (for audio/FX). */
    this.events = [];
    this.accumulator = 0;
    this.elapsed = 0;
    this.settleTime = 0;
  }

  get cue() {
    return this.balls[0];
  }

  ball(id) {
    return this.balls.find((b) => b.id === id);
  }

  get activeBalls() {
    return this.balls.filter((b) => b.active);
  }

  beginShot() {
    this.shot = newShotRecord();
    this.elapsed = 0;
    this.settleTime = 0;
  }

  /** True when nothing is moving any more. */
  isSettled() {
    for (const b of this.balls) {
      if (!b.active) continue;
      if (speedOf(b) > PHYS.sleepSpeed || spinOf(b) > PHYS.sleepSpin) return false;
    }
    return true;
  }

  /**
   * Advance the simulation by dt seconds of wall time, using fixed sub-steps.
   * Returns the list of events produced this call.
   */
  advance(dt) {
    this.events = [];
    // Clamp so a stalled tab cannot explode the simulation.
    dt = Math.min(dt, 0.1);
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYS.fixedStep && steps < PHYS.maxStepsPerFrame) {
      this.step(PHYS.fixedStep);
      this.accumulator -= PHYS.fixedStep;
      steps++;
      if (this.isSettled()) {
        this.accumulator = 0;
        break;
      }
    }
    if (steps >= PHYS.maxStepsPerFrame) this.accumulator = 0;
    if (this.isSettled()) this.settleTime += dt;
    else this.settleTime = 0;
    this.elapsed += dt;
    return this.events;
  }

  /** One fixed physics sub-step. */
  step(dt) {
    const balls = this.balls;

    // 1. friction + integration
    for (const b of balls) {
      if (!b.active) continue;
      this.integrate(b, dt);
    }

    // 2. ball/ball impacts
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!a.active) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (!b.active) continue;
        this.collideBalls(a, b);
      }
    }

    // 3. cushions + pockets
    for (const b of balls) {
      if (!b.active) continue;
      this.cushions(b);
      this.checkPocket(b);
    }
  }

  // -- integration ----------------------------------------------------------

  integrate(b, dt) {
    const r = BALL_RADIUS;
    // Contact-patch velocity: u = v + w x (-r yhat) = (vx + r*wz, 0, vz - r*wx)
    const ux = b.vx + r * b.wz;
    const uz = b.vz - r * b.wx;
    const uMag = Math.hypot(ux, uz);

    if (uMag > PHYS.slideToRoll) {
      // --- sliding: kinetic friction at the contact patch -------------
      const f = PHYS.muSlide * PHYS.g;
      const ax = (-f * ux) / uMag;
      const az = (-f * uz) / uMag;
      b.vx += ax * dt;
      b.vz += az * dt;
      // alpha = -(5/(2r)) * (yhat x a)
      const k = 2.5 / r;
      b.wx += -k * az * dt;
      b.wz += k * ax * dt;
      b.wy *= Math.exp(-PHYS.spinDecay * dt);
    } else {
      // --- rolling: lock spin to velocity, apply rolling resistance ----
      const vMag = Math.hypot(b.vx, b.vz);
      if (vMag > EPS) {
        const decel = PHYS.muRoll * PHYS.g * dt;
        const scale = Math.max(0, vMag - decel) / vMag;
        b.vx *= scale;
        b.vz *= scale;
      }
      b.wx = b.vz / r;
      b.wz = -b.vx / r;
      b.wy *= Math.exp(-PHYS.spinDecay * dt);
      if (Math.hypot(b.vx, b.vz) < PHYS.sleepSpeed && Math.abs(b.wy) < PHYS.sleepSpin) {
        b.vx = b.vz = 0;
        b.wx = b.wz = 0;
        b.wy *= 0.5;
        if (Math.abs(b.wy) < 0.05) b.wy = 0;
      }
    }

    // Integrate position (mid-point style: v already updated, good enough at 1kHz)
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.y = BALL_RADIUS;
    // The table is a plane: a ball never leaves the cloth in this model, so any
    // vertical velocity picked up from a spin-driven contact impulse is absorbed.
    b.vy = 0;
  }

  // -- ball vs ball ---------------------------------------------------------

  collideBalls(a, b) {
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    let d2 = dx * dx + dz * dz;
    const minD = 2 * BALL_RADIUS;
    if (d2 > minD * minD || d2 < EPS) return;

    let d = Math.sqrt(d2);
    let nx = dx / d;
    let nz = dz / d;

    // positional separation (each moves half, they have equal mass)
    const pen = minD - d;
    a.x -= nx * pen * 0.5;
    a.z -= nz * pen * 0.5;
    b.x += nx * pen * 0.5;
    b.z += nz * pen * 0.5;

    // Contact-point velocities include spin.
    const r = BALL_RADIUS;
    // w x (r n) for ball a, contact point toward b
    const ca = crossW(a, nx * r, 0, nz * r);
    const cb = crossW(b, -nx * r, 0, -nz * r);
    const ux = a.vx + ca.x - (b.vx + cb.x);
    const uz = a.vz + ca.z - (b.vz + cb.z);
    const un = ux * nx + uz * nz;
    // n points from a to b, so the balls are closing when the relative normal
    // velocity is positive
    if (un <= 0) return; // already separating

    const invM = 1 / BALL_MASS;
    const jn = ((1 + PHYS.ballRestitution) * un) / (2 * invM);
    // apply normal impulse: a gets -jn*n, b gets +jn*n
    a.vx -= jn * invM * nx;
    a.vz -= jn * invM * nz;
    b.vx += jn * invM * nx;
    b.vz += jn * invM * nz;

    // tangential (throw) impulse
    const tx = ux - un * nx;
    const tz = uz - un * nz;
    const tMag = Math.hypot(tx, tz);
    if (tMag > 1e-4) {
      const kt = 2 * invM + 2 * BALL_RADIUS * BALL_RADIUS * INV_I;
      const jt = Math.min(PHYS.ballFriction * jn, tMag / kt);
      const jx = (-jt * tx) / tMag;
      const jz = (-jt * tz) / tMag;
      a.vx += jx * invM;
      a.vz += jz * invM;
      b.vx -= jx * invM;
      b.vz -= jz * invM;
      // spin response: dw = (r x J) / I
      const ra = { x: nx * r, y: 0, z: nz * r };
      const rb = { x: -nx * r, y: 0, z: -nz * r };
      const da = cross(ra, jx, 0, jz);
      const db = cross(rb, -jx, 0, -jz);
      a.wx += da.x * INV_I;
      a.wy += da.y * INV_I;
      a.wz += da.z * INV_I;
      b.wx += db.x * INV_I;
      b.wy += db.y * INV_I;
      b.wz += db.z * INV_I;
    }

    const impact = Math.abs(un);
    a.vy = 0;
    b.vy = 0;
    this.recordContact(a, b, impact);
    this.events.push({
      type: 'ball',
      a: a.id,
      b: b.id,
      speed: impact,
      x: a.x + nx * BALL_RADIUS,
      y: BALL_RADIUS,
      z: a.z + nz * BALL_RADIUS,
    });
  }

  recordContact(a, b, impact) {
    const s = this.shot;
    if (impact < 0.05) return;
    if (a.isCue || b.isCue) {
      const other = a.isCue ? b : a;
      if (s.firstHit === null) s.firstHit = other.id;
    }
    s.contacts++;
  }

  // -- cushions -------------------------------------------------------------

  cushions(b) {
    // Walls: [axis, sign]. Skip the segment occupied by a pocket mouth.
    const r = BALL_RADIUS;

    // long rails (z = +-HALF_W)
    for (const sign of [1, -1]) {
      const zLine = sign * HALF_W;
      const over = sign > 0 ? b.z + r - zLine : zLine - (b.z - r);
      if (over <= 0) continue;
      if (Math.abs(b.x) < SIDE_MOUTH + 1e-4) continue; // side pocket mouth
      if (Math.abs(b.x) > HALF_L - CORNER_MOUTH - 1e-4) continue; // corner mouth
      this.resolveCushion(b, 0, -sign, over, 'long');
    }

    // short rails (x = +-HALF_L)
    for (const sign of [1, -1]) {
      const xLine = sign * HALF_L;
      const over = sign > 0 ? b.x + r - xLine : xLine - (b.x - r);
      if (over <= 0) continue;
      if (Math.abs(b.z) > HALF_W - CORNER_MOUTH - 1e-4) continue; // corner mouth
      this.resolveCushion(b, -sign, 0, over, 'short');
    }
  }

  /** n = inward unit normal, pen = penetration depth. */
  resolveCushion(b, nx, nz, pen, kind) {
    // push out of the cushion
    b.x += nx * pen;
    b.z += nz * pen;

    const vn = b.vx * nx + b.vz * nz;
    if (vn >= 0) return;

    const m = BALL_MASS;
    const jn = -(1 + PHYS.cushionRestitution) * vn * m;
    b.vx += (jn / m) * nx;
    b.vz += (jn / m) * nz;

    // contact point is on the side of the ball facing the cushion
    const r = BALL_RADIUS;
    const rcx = -nx * r;
    const rcz = -nz * r;
    const c = crossW(b, rcx, 0, rcz);
    let ux = b.vx + c.x;
    let uy = b.vy + c.y;
    let uz = b.vz + c.z;
    const un = ux * nx + uz * nz;
    ux -= un * nx;
    uz -= un * nz;
    const ut = Math.hypot(ux, uy, uz);
    if (ut > 1e-4) {
      const kt = 1 / m + (r * r) * INV_I;
      const jt = Math.min(PHYS.cushionFriction * jn, ut / kt);
      const jx = (-jt * ux) / ut;
      const jy = (-jt * uy) / ut;
      const jz = (-jt * uz) / ut;
      b.vx += jx / m;
      b.vy += jy / m;
      b.vz += jz / m;
      const d = cross({ x: rcx, y: 0, z: rcz }, jx, jy, jz);
      b.wx += d.x * INV_I;
      b.wy += d.y * INV_I;
      b.wz += d.z * INV_I;
    }
    // Cushions absorb the vertical wobble we never simulate.
    b.vy = 0;

    if (this.shot.firstHit !== null) this.shot.railAfterContact = true;
    this.shot.railBalls.add(b.id);
    this.events.push({
      type: 'cushion',
      a: b.id,
      speed: Math.abs(vn),
      kind,
      x: b.x,
      y: BALL_RADIUS,
      z: b.z,
    });
  }

  // -- pockets --------------------------------------------------------------

  checkPocket(b) {
    if (!outsidePlayingArea(b.x, b.z)) return;
    const p = pocketCaptureAt(b.x, b.z);
    if (!p) {
      // Safety net: a ball that squeezed past the jaws must not escape.
      if (Math.abs(b.x) > HALF_L + 0.14 || Math.abs(b.z) > HALF_W + 0.14) {
        this.pot(b, POCKETS[0]);
      }
      return;
    }
    this.pot(b, p);
  }

  pot(b, p) {
    b.active = false;
    b.potted = true;
    b.pocket = p.id;
    b.vx = b.vy = b.vz = 0;
    b.wx = b.wy = b.wz = 0;
    b.x = p.x + (b.x - p.x) * 0.25;
    b.z = p.z + (b.z - p.z) * 0.25;
    b.sinkT = 0;
    b.sinkY = 0;
    this.shot.potted.push(b.id);
    this.shot.railAfterContact = true;
    this.events.push({ type: 'pocket', a: b.id, pocket: p.id, x: b.x, y: BALL_RADIUS, z: b.z });
  }

  /** Put the cue ball back on the table (ball in hand). */
  placeCueBall(x, z) {
    const cue = this.cue;
    cue.active = true;
    cue.potted = false;
    cue.pocket = -1;
    cue.x = x;
    cue.z = z;
    cue.y = BALL_RADIUS;
    cue.vx = cue.vy = cue.vz = 0;
    cue.wx = cue.wy = cue.wz = 0;
    cue.sinkY = 0;
    cue.sinkT = 0;
  }

  /** Advance the visual sink animation for pocketed balls. */
  updateSinking(dt) {
    for (const b of this.balls) {
      if (!b.potted || b.sinkT > 1) continue;
      b.sinkT += dt;
      const t = Math.min(1, b.sinkT / 0.42);
      b.sinkY = -(1 - (1 - t) * (1 - t)) * 0.2; // ease-out fall into the pocket
    }
  }

  /**
   * Fire the cue ball.
   * dir: unit vector in the table plane. speed: m/s.
   * spinTop/spinSide: cue tip offset as a fraction of the ball radius,
   *   positive top = follow, positive side = right english.
   */
  strike(dirX, dirZ, speed, spinTop = 0, spinSide = 0) {
    const cue = this.cue;
    const len = Math.hypot(dirX, dirZ) || 1;
    const dx = dirX / len;
    const dz = dirZ / len;
    const v = Math.min(speed, PHYS.maxShotSpeed);

    cue.vx = dx * v;
    cue.vz = dz * v;
    cue.vy = 0;

    // Follow/draw: the spin axis for a tip hit above the centre is yhat x d.
    // yhat x (dx,0,dz) = (dz, 0, -dx); magnitude 2.5*v*a/R gives pure roll at a = 0.4.
    const topK = (2.5 * v * clamp(spinTop, -0.6, 0.6)) / BALL_RADIUS;
    cue.wx = topK * dz;
    cue.wz = topK * -dx;

    // Side spin: a tip hit to the shooter's right (positive) imparts +y spin.
    cue.wy = (2.5 * v * clamp(spinSide, -0.6, 0.6)) / BALL_RADIUS;

    this.beginShot();
    this.events.push({ type: 'strike', a: cue.id, speed: v, x: cue.x, y: cue.y, z: cue.z });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function cross(a, bx, by, bz) {
  return {
    x: a.y * bz - a.z * by,
    y: a.z * bx - a.x * bz,
    z: a.x * by - a.y * bx,
  };
}

/** w x r for a ball's angular velocity and an offset r. */
function crossW(b, rx, ry, rz) {
  return {
    x: b.wy * rz - b.wz * ry,
    y: b.wz * rx - b.wx * rz,
    z: b.wx * ry - b.wy * rx,
  };
}

function newShotRecord() {
  return {
    firstHit: null, // id of first object ball the cue ball touched
    railAfterContact: false,
    railBalls: new Set(), // distinct balls that touched a cushion
    potted: [], // ids potted this shot (includes the cue ball)
    contacts: 0,
  };
}

// ---------------------------------------------------------------------------
// Aim helpers (used by the renderer for the prediction lines)
// ---------------------------------------------------------------------------

/**
 * Cast a ray from the cue ball along dir and find the first object ball hit.
 * Returns { ball, t, cx, cz, nx, nz } or null.
 */
export function raycastBalls(balls, ox, oz, dx, dz, ignoreId = 0) {
  const r = BALL_RADIUS;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  let best = null;
  for (const b of balls) {
    if (!b.active || b.id === ignoreId) continue;
    const ex = b.x - ox;
    const ez = b.z - oz;
    const proj = ex * dx + ez * dz;
    if (proj <= 0) continue;
    const perp2 = ex * ex + ez * ez - proj * proj;
    const rr = (2 * r) * (2 * r);
    if (perp2 > rr) continue;
    const t = proj - Math.sqrt(Math.max(0, rr - perp2));
    if (t < 0) continue;
    if (!best || t < best.t) {
      best = {
        ball: b,
        t,
        cx: ox + dx * t,
        cz: oz + dz * t,
      };
    }
  }
  return best;
}

/** Distance from a ray origin to the first cushion along dir. */
export function raycastCushions(ox, oz, dx, dz) {
  const r = BALL_RADIUS;
  let t = Infinity;
  const lx = HALF_L - r;
  const lz = HALF_W - r;
  if (dx > EPS) t = Math.min(t, (lx - ox) / dx);
  if (dx < -EPS) t = Math.min(t, (-lx - ox) / dx);
  if (dz > EPS) t = Math.min(t, (lz - oz) / dz);
  if (dz < -EPS) t = Math.min(t, (-lz - oz) / dz);
  return t;
}
