/**
 * Node test suite for the physics + rules modules.
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BALL_RADIUS,
  HALF_L,
  HALF_W,
  PHYS,
  POCKETS,
  World,
  createBall,
  createRack,
  pocketAt,
  pocketCaptureAt,
  rackPositions,
  raycastBalls,
  speedOf,
} from '../src/physics.js';
import { EightBallGame, SOLIDS, STRIPES, groupOfBall } from '../src/rules.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function runUntilSettled(world, maxSeconds = 40) {
  const dt = 1 / 60;
  let t = 0;
  while (t < maxSeconds) {
    world.advance(dt);
    world.updateSinking(dt);
    t += dt;
    if (world.isSettled() && world.settleTime > 0.25) break;
  }
  return t;
}

function assertFinite(world) {
  for (const b of world.balls) {
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'wx', 'wy', 'wz']) {
      assert.ok(Number.isFinite(b[k]), `ball ${b.id} has non-finite ${k}: ${b[k]}`);
    }
  }
}

function assertOnTable(world, tol = 1e-3) {
  for (const b of world.balls) {
    if (!b.active) continue;
    assert.ok(
      Math.abs(b.x) <= HALF_L + tol,
      `ball ${b.id} escaped in x: ${b.x.toFixed(4)}`,
    );
    assert.ok(
      Math.abs(b.z) <= HALF_W + tol,
      `ball ${b.id} escaped in z: ${b.z.toFixed(4)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// rack / setup
// ---------------------------------------------------------------------------

test('rack has 16 balls with no overlaps and inside the table', () => {
  const rack = createRack();
  assert.equal(rack.length, 16);
  assert.equal(rack[0].isCue, true);
  const ids = new Set(rack.map((b) => b.id));
  assert.equal(ids.size, 16);

  for (let i = 0; i < rack.length; i++) {
    for (let j = i + 1; j < rack.length; j++) {
      const d = Math.hypot(rack[i].x - rack[j].x, rack[i].z - rack[j].z);
      assert.ok(d >= 2 * BALL_RADIUS - 1e-6, `balls ${rack[i].id}/${rack[j].id} overlap (${d})`);
    }
    assert.ok(Math.abs(rack[i].x) < HALF_L - BALL_RADIUS);
    assert.ok(Math.abs(rack[i].z) < HALF_W - BALL_RADIUS);
  }

  // apex ball on the foot spot, 8-ball in the middle of row 3
  const apex = rack.find((b) => b.id === 1);
  assert.ok(Math.abs(apex.x - rackPositions()[0].x) < 1e-9);
  const eight = rack.find((b) => b.id === 8);
  assert.ok(Math.abs(eight.z) < 1e-9, '8-ball should be centred in the rack');
});

test('pocket detection only fires outside the cushion lines', () => {
  // a ball resting in the corner of the playing area must NOT be pocketed
  const r = BALL_RADIUS;
  assert.equal(pocketCaptureAt(HALF_L - r, HALF_W - r), null);
  assert.equal(pocketCaptureAt(-HALF_L + r, HALF_W - r), null);
  assert.equal(pocketCaptureAt(0, HALF_W - r), null);
  // a ball that has crossed the cushion line inside the mouth must be
  assert.ok(pocketCaptureAt(HALF_L + 0.001, HALF_W - 0.06));
  assert.ok(pocketCaptureAt(0, HALF_W + 0.001));
  // but the mouth circle still reports the geometry for placement checks
  assert.ok(pocketAt(HALF_L, HALF_W));
});

// ---------------------------------------------------------------------------
// motion
// ---------------------------------------------------------------------------

test('a struck ball rolls, slows down and stops', () => {
  const w = new World([createBall(0, -0.8, 0, { isCue: true })]);
  w.strike(1, 0, 3);
  const cue = w.cue;
  assert.ok(Math.abs(speedOf(cue) - 3) < 1e-9, 'initial speed');

  let sawRolling = false;
  const dt = 1 / 120;
  for (let i = 0; i < 2000; i++) {
    w.advance(dt);
    // rolling means the contact patch velocity is ~0
    const u = Math.hypot(cue.vx + BALL_RADIUS * cue.wz, cue.vz - BALL_RADIUS * cue.wx);
    if (speedOf(cue) > 0.05 && u < 1e-2) sawRolling = true;
  }
  assert.ok(sawRolling, 'ball never settled into a rolling state');
  assert.equal(speedOf(cue), 0, 'ball did not come to rest');
  assertFinite(w);
});

test('rolling is locked to velocity (no slip while rolling)', () => {
  const w = new World([createBall(0, 0, 0, { isCue: true })]);
  w.strike(1, 0, 1.5, 0.4); // 0.4R above centre == immediate roll
  const cue = w.cue;
  w.advance(1 / 60);
  for (let i = 0; i < 30; i++) {
    w.advance(1 / 120);
    const u = Math.hypot(cue.vx + BALL_RADIUS * cue.wz, cue.vz - BALL_RADIUS * cue.wx);
    assert.ok(u < 0.05, `contact slip too large while rolling: ${u}`);
  }
});

test('backspin (draw) reverses the cue ball', () => {
  const w = new World([createBall(0, 0, 0, { isCue: true })]);
  w.strike(1, 0, 3.5, -0.55);
  const cue = w.cue;
  let reversed = false;
  for (let i = 0; i < 600; i++) {
    w.advance(1 / 240);
    if (cue.vx < -0.05) reversed = true;
  }
  assert.ok(reversed, 'heavy draw shot never came back');
});

test('follow shot keeps going forward after the slide phase', () => {
  const w = new World([createBall(0, 0, 0, { isCue: true })]);
  w.strike(1, 0, 3, 0.55);
  const cue = w.cue;
  // 0.3s is well before the ball reaches the far cushion
  for (let i = 0; i < 72; i++) w.advance(1 / 240);
  assert.ok(cue.vx > 0, 'follow shot stopped/reversed unexpectedly');
  assert.ok(cue.x > 0.5, 'follow shot did not travel forward');
});

test('a ball bounced off a cushion comes back and stays in bounds', () => {
  const w = new World([createBall(0, 0, 0, { isCue: true })]);
  w.strike(1, 0, 4);
  runUntilSettled(w, 40);
  assertFinite(w);
  assertOnTable(w);
  assert.ok(w.cue.vx === 0 && w.cue.vz === 0, 'cue ball still moving');
});

test('cushion restitution is in a sane range', () => {
  const w = new World([createBall(0, 0, 0, { isCue: true })]);
  w.strike(1, 0, 4);
  const cue = w.cue;
  // step until it turns around
  let impact = 0;
  for (let i = 0; i < 4000 && impact === 0; i++) {
    const before = cue.vx;
    w.advance(1 / 960);
    if (before > 0 && cue.vx < 0) impact = before;
  }
  assert.ok(impact > 0, 'never reached the cushion');
  const rebound = Math.abs(cue.vx);
  const ratio = rebound / impact;
  assert.ok(ratio > 0.4 && ratio < 0.9, `unexpected rebound ratio ${ratio.toFixed(3)}`);
});

test('head-on collision transfers momentum to the target ball', () => {
  const w = new World([createBall(0, -0.3, 0, { isCue: true }), createBall(1, 0, 0)]);
  w.strike(1, 0, 3, 0.4); // 0.4R = immediate roll, no draw
  const target = w.ball(1);
  let peak = 0;
  for (let i = 0; i < 2400; i++) {
    w.advance(1 / 960);
    peak = Math.max(peak, speedOf(target));
  }
  // a stun/follow shot should hand almost all the speed to the object ball
  assert.ok(peak > 2.4, `object ball only reached ${peak.toFixed(2)} m/s`);
  assert.ok(speedOf(w.cue) < 0.6, `cue ball kept ${speedOf(w.cue).toFixed(2)} m/s`);
  assert.equal(target.potted, false);
});

test('a collision never adds energy', () => {
  const w = new World([createBall(0, -0.2, 0, { isCue: true }), createBall(1, 0.2, 0.01)]);
  w.strike(1, 0.02, 4);
  const ke = () =>
    w.balls.reduce((s, b) => s + 0.5 * (b.vx * b.vx + b.vz * b.vz), 0);
  let prev = ke();
  let worst = 0;
  for (let i = 0; i < 2400; i++) {
    w.advance(1 / 960);
    const now = ke();
    worst = Math.max(worst, now - prev);
    prev = now;
  }
  assert.ok(worst < 1e-6, `kinetic energy jumped by ${worst}`);
});

test('a thin cut leaves both balls moving', () => {
  const w = new World([createBall(0, -0.3, 0, { isCue: true }), createBall(1, 0, 0.045)]);
  w.strike(1, 0, 3, 0.4);
  for (let i = 0; i < 400; i++) w.advance(1 / 960);
  assert.ok(speedOf(w.ball(1)) > 0.2, 'object ball should be nudged');
  assert.ok(speedOf(w.cue) > 0.2, 'cue ball should keep going on a cut');
  assert.ok(w.shot.firstHit === 1, 'the cut is recorded as the first contact');
});

// ---------------------------------------------------------------------------
// break + stability
// ---------------------------------------------------------------------------

test('a full break scatters the rack, stays in bounds and settles', () => {
  const w = new World(createRack());
  const before = w.balls.map((b) => ({ x: b.x, z: b.z }));
  w.strike(1, 0, 8.0, 0.1, 0);
  const seconds = runUntilSettled(w, 45);

  assertFinite(w);
  assertOnTable(w);
  assert.ok(seconds < 45, 'table never settled');

  // most of the rack must actually move
  let moved = 0;
  for (let i = 1; i < w.balls.length; i++) {
    const b = w.balls[i];
    if (!b.active) continue;
    if (Math.hypot(b.x - before[i].x, b.z - before[i].z) > 0.05) moved++;
  }
  assert.ok(moved >= 10, `only ${moved} object balls moved on the break`);

  // nothing may be faster than the cue ball was
  for (const b of w.balls) {
    assert.ok(speedOf(b) <= PHYS.maxShotSpeed + 1e-6, `ball ${b.id} faster than the cue`);
  }

  // at least one ball reached a rail
  assert.ok(w.shot.railBalls.size > 0, 'no ball touched a rail on the break');
  assert.ok(w.shot.firstHit !== null, 'cue ball never reached the rack');
});

test('every ball eventually comes to rest from many random breaks', () => {
  for (let trial = 0; trial < 12; trial++) {
    const w = new World(createRack());
    const ang = (trial / 12) * Math.PI * 2;
    w.strike(Math.cos(ang), Math.sin(ang) * 0.35, 4 + (trial % 5), (trial % 3) - 1, 0);
    runUntilSettled(w, 60);
    assertFinite(w);
    assertOnTable(w);
    assert.ok(w.isSettled(), `trial ${trial} never settled`);
  }
});

test('no ball tunnels through a cushion at maximum speed', () => {
  const w = new World([createBall(0, -HALF_L + 0.1, 0, { isCue: true })]);
  w.strike(1, 0, PHYS.maxShotSpeed);
  for (let i = 0; i < 6000; i++) {
    w.advance(1 / 960);
    if (w.cue.active) {
      assert.ok(Math.abs(w.cue.x) <= HALF_L + 1e-6, `tunnelled to x=${w.cue.x}`);
      assert.ok(Math.abs(w.cue.z) <= HALF_W + 1e-6, `tunnelled to z=${w.cue.z}`);
    }
  }
});

// ---------------------------------------------------------------------------
// pockets
// ---------------------------------------------------------------------------

test('a ball aimed into a corner pocket is potted', () => {
  const w = new World([createBall(0, 0.9, 0, { isCue: true })]);
  const target = POCKETS[5]; // (+HALF_L, +HALF_W)
  const dx = target.x - w.cue.x;
  const dz = target.z - w.cue.z;
  const len = Math.hypot(dx, dz);
  w.strike(dx / len, dz / len, 2.2);
  runUntilSettled(w, 20);
  assert.equal(w.cue.active, false, 'ball did not drop in the corner pocket');
  assert.equal(w.cue.potted, true);
  assert.equal(w.cue.pocket, 5);
  assert.ok(w.shot.potted.includes(0));
});

test('a ball aimed into a side pocket is potted', () => {
  const w = new World([createBall(0, 0, 0.5, { isCue: true })]);
  w.strike(0, 1, 1.8);
  runUntilSettled(w, 20);
  assert.equal(w.cue.potted, true, 'ball did not drop in the side pocket');
  assert.equal(w.cue.pocket, 4);
});

test('a ball rolling along the rail past a pocket mouth is not falsely pocketed', () => {
  // aimed just inside the cushion, parallel to the long rail
  const w = new World([createBall(0, -0.9, HALF_W - BALL_RADIUS, { isCue: true })]);
  w.strike(1, 0, 1.2);
  for (let i = 0; i < 1200; i++) {
    w.advance(1 / 240);
    if (w.cue.active && Math.abs(w.cue.x) > HALF_L - 0.4) break;
  }
  assert.equal(w.cue.potted, false, 'cue ball was wrongly pocketed rolling along the rail');
});

// ---------------------------------------------------------------------------
// aim prediction
// ---------------------------------------------------------------------------

test('raycast finds the first ball on the aim line', () => {
  const balls = [createBall(0, 0, 0, { isCue: true }), createBall(1, 0.5, 0), createBall(2, 1.0, 0)];
  const hit = raycastBalls(balls, 0, 0, 1, 0, 0);
  assert.ok(hit);
  assert.equal(hit.ball.id, 1);
  assert.ok(Math.abs(hit.t - (0.5 - 2 * BALL_RADIUS)) < 1e-9);
  // a ray pointing away finds nothing
  assert.equal(raycastBalls(balls, 0, 0, -1, 0, 0), null);
  // a ray that just misses finds nothing
  assert.equal(raycastBalls(balls, 0, 0, 1, 0.2, 0), null);
});

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

function freshGame() {
  const w = new World(createRack());
  const g = new EightBallGame(w, ['A', 'B']);
  return { w, g };
}

test('groups are assigned by the first legal pot after the break', () => {
  const { w, g } = freshGame();
  // fake a legal break that pots nothing
  w.shot = { firstHit: 1, railAfterContact: true, railBalls: new Set([1, 2, 3, 4]), potted: [], contacts: 3 };
  g.evaluateShot();
  assert.equal(g.openTable, true, 'table should still be open after the break');
  assert.equal(g.turn, 1, 'turn should pass after a dry break');

  // player 2 pots a stripe
  w.shot = { firstHit: 11, railAfterContact: false, railBalls: new Set(), potted: [11], contacts: 2 };
  const r = g.evaluateShot();
  assert.equal(r.foul, false);
  assert.equal(g.players[1].group, STRIPES);
  assert.equal(g.players[0].group, SOLIDS);
  assert.equal(g.turn, 1, 'potting a ball keeps the shooter at the table');
});

test('potting the ball you hit first is not a foul (regression)', () => {
  // The shot is judged after it finished, when the ball that was struck first
  // is already off the table. That must not be mistaken for a wrong-ball foul.
  const { w, g } = freshGame();
  g.breakDone = true;
  g.players[0].group = SOLIDS;
  g.players[1].group = STRIPES;
  g.openTable = false;
  const b3 = w.ball(3);
  b3.active = false;
  b3.potted = true;
  w.shot = {
    firstHit: 3,
    railAfterContact: true,
    railBalls: new Set([3]),
    potted: [3],
    contacts: 1,
  };
  const r = g.evaluateShot();
  assert.equal(r.foul, false, r.foulReason);
  assert.equal(r.continueTurn, true);
  assert.equal(g.turn, 0, 'the shooter keeps the table');
  assert.equal(g.ballInHand, false, 'no ball in hand for a legal pot');
});

test('the first pot still assigns groups when it is the ball struck first', () => {
  const { w, g } = freshGame();
  g.breakDone = true;
  const b3 = w.ball(3);
  b3.active = false;
  b3.potted = true;
  w.shot = {
    firstHit: 3,
    railAfterContact: true,
    railBalls: new Set([3]),
    potted: [3],
    contacts: 1,
  };
  const r = g.evaluateShot();
  assert.equal(r.foul, false);
  assert.equal(g.players[0].group, SOLIDS, 'shooter takes solids');
  assert.equal(g.players[1].group, STRIPES);
  assert.equal(g.turn, 0);
  assert.equal(r.continueTurn, true);
});

test('potting your last group ball and the 8 on one stroke loses', () => {
  const { w, g } = freshGame();
  g.breakDone = true;
  g.players[0].group = SOLIDS;
  g.players[1].group = STRIPES;
  g.openTable = false;
  for (const b of w.balls) if (groupOfBall(b.id) === SOLIDS) b.active = false;
  const seven = w.ball(7);
  seven.active = false;
  seven.potted = true;
  const eight = w.ball(8);
  eight.active = false;
  eight.potted = true;
  w.shot = {
    firstHit: 7,
    railAfterContact: true,
    railBalls: new Set([7]),
    potted: [7, 8],
    contacts: 2,
  };
  g.evaluateShot();
  assert.equal(g.gameOver, true);
  assert.equal(g.winner, 1, 'the opponent wins');
});

test('hitting an opponent ball first and potting your own is still a foul', () => {
  const { w, g } = freshGame();
  g.breakDone = true;
  g.players[0].group = SOLIDS;
  g.players[1].group = STRIPES;
  g.openTable = false;
  const b3 = w.ball(3);
  b3.active = false;
  b3.potted = true;
  w.shot = {
    firstHit: 11, // a stripe was contacted first
    railAfterContact: true,
    railBalls: new Set([11, 3]),
    potted: [3],
    contacts: 2,
  };
  const r = g.evaluateShot();
  assert.equal(r.foul, true);
  assert.equal(g.turn, 1);
  assert.equal(g.ballInHand, true);
});

test('hitting the wrong group first is a foul and gives ball in hand', () => {
  const { w, g } = freshGame();
  g.players[0].group = SOLIDS;
  g.players[1].group = STRIPES;
  g.openTable = false;
  g.breakDone = true;
  w.shot = { firstHit: 11, railAfterContact: true, railBalls: new Set([11]), potted: [], contacts: 1 };
  const r = g.evaluateShot();
  assert.equal(r.foul, true);
  assert.equal(g.turn, 1);
  assert.equal(g.ballInHand, true);
});

test('hitting nothing is a foul', () => {
  const { w, g } = freshGame();
  g.breakDone = true;
  w.shot = { firstHit: null, railAfterContact: false, railBalls: new Set(), potted: [], contacts: 0 };
  const r = g.evaluateShot();
  assert.equal(r.foul, true);
  assert.equal(g.ballInHand, true);
  assert.equal(g.turn, 1);
});

test('no rail and no pot after contact is a foul', () => {
  const { w, g } = freshGame();
  g.breakDone = true;
  w.shot = { firstHit: 1, railAfterContact: false, railBalls: new Set(), potted: [], contacts: 1 };
  const r = g.evaluateShot();
  assert.equal(r.foul, true);
});

test('a scratch gives the opponent ball in hand and the cue ball comes back', () => {
  const { w, g } = freshGame();
  g.breakDone = true;
  g.players[0].group = SOLIDS;
  g.players[1].group = STRIPES;
  g.openTable = false;
  const cue = w.cue;
  cue.active = false;
  cue.potted = true;
  cue.pocket = 4;
  w.shot = { firstHit: 3, railAfterContact: true, railBalls: new Set([3]), potted: [3, 0], contacts: 2 };
  const r = g.evaluateShot();
  assert.equal(r.foul, true);
  assert.equal(g.ballInHand, true);
  assert.equal(w.cue.active, true, 'cue ball was not returned to the table');
  assert.equal(g.turn, 1);
});

test('potting the 8 early loses the game', () => {
  const { w, g } = freshGame();
  g.breakDone = true;
  g.players[0].group = SOLIDS;
  g.players[1].group = STRIPES;
  g.openTable = false;
  const eight = w.ball(8);
  eight.active = false;
  eight.potted = true;
  w.shot = { firstHit: 1, railAfterContact: true, railBalls: new Set([1]), potted: [1, 8], contacts: 2 };
  g.evaluateShot();
  assert.equal(g.gameOver, true);
  assert.equal(g.winner, 1, 'opponent should win');
});

test('potting the 8 after clearing the group wins', () => {
  const { w, g } = freshGame();
  g.breakDone = true;
  g.players[0].group = SOLIDS;
  g.players[1].group = STRIPES;
  g.openTable = false;
  // remove every solid except the 8 from the table
  for (const b of w.balls) if (groupOfBall(b.id) === SOLIDS) b.active = false;
  const eight = w.ball(8);
  eight.active = false;
  eight.potted = true;
  w.shot = { firstHit: 8, railAfterContact: true, railBalls: new Set([8]), potted: [8], contacts: 1 };
  g.evaluateShot();
  assert.equal(g.gameOver, true);
  assert.equal(g.winner, 0);
});

test('potting the 8 on the break re-spots it instead of ending the game', () => {
  const { w, g } = freshGame();
  const eight = w.ball(8);
  eight.active = false;
  eight.potted = true;
  w.shot = { firstHit: 1, railAfterContact: true, railBalls: new Set([1, 2, 3, 4]), potted: [8], contacts: 4 };
  g.evaluateShot();
  assert.equal(g.gameOver, false);
  assert.equal(eight.active, true, '8-ball should be re-spotted');
  assert.equal(g.breakDone, true);
});

test('potting an opponent ball is not a foul but passes the turn', () => {
  const { w, g } = freshGame();
  g.breakDone = true;
  g.players[0].group = SOLIDS;
  g.players[1].group = STRIPES;
  g.openTable = false;
  w.shot = { firstHit: 1, railAfterContact: false, railBalls: new Set(), potted: [11], contacts: 1 };
  const r = g.evaluateShot();
  assert.equal(r.foul, false);
  assert.equal(r.continueTurn, false);
  assert.equal(g.turn, 1);
});

test('ball in hand placement respects overlaps and the table edge', () => {
  const { w, g } = freshGame();
  assert.equal(g.canPlaceCue(0.68, 0), false, 'cannot place the cue ball inside the rack');
  assert.equal(g.canPlaceCue(-1.0, 0), true);
  assert.equal(g.canPlaceCue(HALF_L, 0), false, 'cannot place outside the cushions');
  g.ballInHandKitchen = true;
  assert.equal(g.canPlaceCue(0.5, 0), false, 'must be behind the head string');
  assert.equal(g.canPlaceCue(-0.8, 0), true);
});

test('a break that fails to spread the rack is a foul', () => {
  const { w, g } = freshGame();
  w.shot = { firstHit: 1, railAfterContact: true, railBalls: new Set([1]), potted: [], contacts: 1 };
  const r = g.evaluateShot();
  assert.equal(r.foul, true);
  assert.equal(g.ballInHand, true);
});
