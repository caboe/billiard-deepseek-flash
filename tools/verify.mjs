/**
 * tools/verify.mjs — end-to-end verification of the game in a real browser.
 *
 *   node tools/verify.mjs [url]
 *
 * Drives the actual page: waits for the scene, checks for console/network
 * errors, takes screenshots from several cameras, plays a real shot with
 * synthesised mouse input, and reports pixel statistics so the render can be
 * checked without eyeballing it.
 */
import { launch, connect, sleep } from './cdp.mjs';
import {
  decodePng, avgRect, luma, countNear, dominant, hex,
  countGreen, countYellow, countRed, countBlue, countBright,
} from './png-stats.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:8099/';
const SHOTS = 'tools/shots';
const problems = [];
const check = (ok, label, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) problems.push(label + (extra ? ': ' + extra : ''));
};


// --- shot helpers ---------------------------------------------------------

async function screenOf(session, x, z) {
  return session.evaluate(`(() => {
    const p = window.__pool;
    const v = new p.THREE.Vector3(${x}, 0, ${z}).project(p.camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
  })()`);
}

/** Aim the cue ball at a table point with real mouse input, then fire. */
async function shootAt(session, tx, tz, power) {
  const cue = await session.evaluate(
    '({x: window.__pool.world.cue.x, z: window.__pool.world.cue.z})',
  );
  const d = Math.hypot(tx - cue.x, tz - cue.z) || 1;
  const ax = cue.x + ((tx - cue.x) / d) * 0.4;
  const az = cue.z + ((tz - cue.z) / d) * 0.4;
  const aimPt = await screenOf(session, ax, az);
  const cuePt = await screenOf(session, cue.x, cue.z);
  const plus = await screenOf(session, cue.x + 0.1, cue.z);
  const pxPerM = Math.hypot(plus.x - cuePt.x, plus.y - cuePt.y) / 0.1;
  const dx = aimPt.x - cuePt.x;
  const dy = aimPt.y - cuePt.y;
  const len = Math.hypot(dx, dy) || 1;
  const pull = power * 0.62 * pxPerM;
  const back = { x: aimPt.x - (dx / len) * pull, y: aimPt.y - (dy / len) * pull };
  await session.drag([
    { x: aimPt.x, y: aimPt.y },
    { x: (aimPt.x + back.x) / 2, y: (aimPt.y + back.y) / 2 },
    back,
  ]);
  const fired = await session.evaluate(
    '({vx: +window.__pool.world.cue.vx.toFixed(2), vz: +window.__pool.world.cue.vz.toFixed(2), mode: window.__pool.state.mode})',
  );
  console.log('    fired:', JSON.stringify(fired), 'target aim', tx.toFixed(2), tz.toFixed(2));
  await session.waitFor("window.__pool.state.mode !== 'shooting'", 120000, 'shot settles');
  return session.evaluate(`({
    mode: window.__pool.state.mode,
    message: document.getElementById('message').textContent,
    detail: document.getElementById('detail').textContent,
    potted: window.__pool.world.shot.potted,
    firstHit: window.__pool.world.shot.firstHit,
  })`);
}

const { proc, base } = await launch({ port: 9333 + Math.floor(Math.random() * 200) });
let session;
try {
  session = await connect(base);
  await session.goto(URL);

  console.log('\n— boot ————————————————————————————');
  await session.waitFor('window.__pool', 40000, 'game bootstrap');
  await sleep(1500);

  const boot = await session.evaluate(`(() => {
    const p = window.__pool;
    const r = p.renderer;
    return {
      balls: p.world.balls.length,
      active: p.world.balls.filter(b => b.active).length,
      mode: p.state.mode,
      meshes: p.scene.children.length,
      drawCalls: r.info.render.calls,
      triangles: r.info.render.triangles,
      textures: r.info.memory.textures,
      canvasW: r.domElement.width,
      canvasH: r.domElement.height,
      message: document.getElementById('message').textContent,
      turn: document.getElementById('turnLabel').textContent,
      hint: document.getElementById('hint').textContent,
    };
  })()`);
  console.log(boot);
  check(boot.balls === 16 && boot.active === 16, 'rack built with 16 active balls');
  check(boot.triangles > 20000, 'scene is actually being rendered', `${boot.triangles} triangles`);
  check(boot.drawCalls > 20, 'draw calls look sane', String(boot.drawCalls));
  check(boot.canvasW > 1000, 'canvas sized', `${boot.canvasW}x${boot.canvasH}`);

  console.log('\n— console / network ————————————————');
  const ignorable = (e) => /favicon|AudioContext encountered an error/i.test(e);
  const fatal = session.errors.filter((e) => !ignorable(e));
  check(fatal.length === 0, 'no console errors', fatal.slice(0, 3).join(' | '));
  check(session.failures.length === 0, 'no failed requests', session.failures.slice(0, 3).join(' | '));

  console.log('\n— rendered image ———————————————————');
  const shot1 = await session.screenshot(`${SHOTS}/01-default.png`);
  const img1 = decodePng(shot1);
  const centre = avgRect(img1, img1.width / 2 - 260, img1.height / 2 - 60, 520, 160);
  const hudLeft = avgRect(img1, 18, 18, 210, 70);
  console.log(`  centre avg ${hex(centre)} (luma ${luma(centre).toFixed(1)})`);
  console.log(`  hud avg ${hex(hudLeft)}`);
  console.log('  dominant', dominant(img1, 5).map((d) => `${hex(d.color)}:${d.count}`).join(' '));

  // the cloth is a saturated green; there should be a lot of it on screen
  const green = countGreen(img1);
  check(green > img1.width * img1.height * 0.05, 'green cloth is visible', `${green}px`);
  check(luma(centre) > 20, 'table is lit, not black', `luma ${luma(centre).toFixed(1)}`);
  check(luma(hudLeft) > 12, 'HUD panel is drawn', `luma ${luma(hudLeft).toFixed(1)}`);

  // ball colours present on screen
  check(countBright(img1) > 150, 'cue ball / white highlights', `${countBright(img1)}px`);
  check(countYellow(img1) > 100, 'yellow balls rendered', `${countYellow(img1)}px`);
  check(countBlue(img1) > 100, 'blue balls rendered', `${countBlue(img1)}px`);
  check(countRed(img1) > 100, 'red balls rendered', `${countRed(img1)}px`);

  console.log('\n— overhead view ————————————————————');
  await session.evaluate(`(() => {
    const p = window.__pool;
    p.camera.position.set(0, 3.05, 0.62);
    p.camera.lookAt(0, 0, 0.06);
    p.state.camMode = 'overhead';
    p.renderer.render(p.scene, p.camera);
  })()`);
  await sleep(700);
  const shot2 = await session.screenshot(`${SHOTS}/02-overhead.png`);
  const img2 = decodePng(shot2);
  const green2 = countGreen(img2);
  check(green2 > img2.width * img2.height * 0.08, 'overhead: large cloth area', `${green2}px`);
  console.log('  dominant', dominant(img2, 6).map((d) => `${hex(d.color)}:${d.count}`).join(' '));

  console.log('\n— top-down structural probe —————————');
  // orthographic camera over exactly the table, then sample known world points
  const probe = await session.evaluate(`(() => {
    const p = window.__pool;
    const T = p.THREE;
    // a thin ortho slab just above the cloth so the hanging lamps do not occlude
    const cam = new T.OrthographicCamera(-1.5, 1.5, 0.9, -0.9, 0.9, 1.5);
    cam.position.set(0, 1.2, 0);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    // hide the aiming helpers so only the table and balls are measured
    const aimWas = p.aimGroup.visible, cueWas = p.cueStick.visible;
    p.aimGroup.visible = false;
    p.cueStick.visible = false;
    p.renderer.render(p.scene, cam);
    const W = p.renderer.domElement.width, H = p.renderer.domElement.height;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(p.renderer.domElement, 0, 0);
    const img = ctx.getImageData(0, 0, W, H).data;
    const at = (x, z) => {
      const v = new T.Vector3(x, 0, z).project(cam);
      const sx = Math.round((v.x * 0.5 + 0.5) * W);
      const sy = Math.round((-v.y * 0.5 + 0.5) * H);
      const i = (sy * W + sx) * 4;
      return { x, z, sx, sy, rgb: [img[i], img[i+1], img[i+2]] };
    };
    // the top of a ball always carries a blown-out specular highlight, so pick
    // the most saturated pixel in a small disc instead of the centre pixel
    const ballColour = (x, z) => {
      const v = new T.Vector3(x, 0, z).project(cam);
      const cx = Math.round((v.x * 0.5 + 0.5) * W);
      const cy = Math.round((-v.y * 0.5 + 0.5) * H);
      // the key light comes from above/right, so the lower-left of the ball is
      // body colour rather than specular highlight
      const i = ((cy + 7) * W + (cx - 7)) * 4;
      return [img[i], img[i+1], img[i+2]];
    };
    const balls = p.world.balls.map(b => ({ id: b.id, ...at(b.x, b.z), colour: ballColour(b.x, b.z) }));
    const points = {
      clothCentre: at(0, 0.35),
      clothNearRail: at(0.5, 0.58),
      cushionTop: at(0.5, 0.66),
      rail: at(0, 0.76),
      cornerPocket: at(1.27, 0.635),
      sidePocket: at(0, -0.635),
      cornerOfTable: at(1.42, 0.79),
    };
    p.aimGroup.visible = aimWas;
    p.cueStick.visible = cueWas;
    return { W, H, points, balls };
  })()`);
  for (const [k, v] of Object.entries(probe.points)) {
    console.log(`  ${k.padEnd(14)} world(${v.x.toFixed(2)},${v.z.toFixed(2)}) px(${v.sx},${v.sy}) rgb(${v.rgb.join(',')})`);
  }
  const P = probe.points;
  const isGreen = ([r, g, b]) => g > 40 && g > r * 1.25 && g > b * 1.05;
  const isDark = ([r, g, b]) => r + g + b < 140;
  const isWood = ([r, g, b]) => r > 60 && r > g * 1.2 && g >= b;
  check(isGreen(P.clothCentre.rgb), 'cloth renders green at table centre', P.clothCentre.rgb.join(','));
  check(isGreen(P.clothNearRail.rgb), 'cloth green right up to the cushion', P.clothNearRail.rgb.join(','));
  check(isDark(P.cornerPocket.rgb), 'corner pocket is a dark hole', P.cornerPocket.rgb.join(','));
  check(isDark(P.sidePocket.rgb), 'side pocket is a dark hole', P.sidePocket.rgb.join(','));
  check(isWood(P.rail.rgb), 'wooden rail at the table edge', P.rail.rgb.join(','));
  check(isGreen(P.cushionTop.rgb) || isWood(P.cushionTop.rgb), 'cushion band present', P.cushionTop.rgb.join(','));

  console.log('  ball colours sampled at their exact positions:');
  const ballRgb = new Map(probe.balls.map((b) => [b.id, b.colour]));
  const near = (rgb, target, tol) =>
    Math.abs(rgb[0] - target[0]) < tol && Math.abs(rgb[1] - target[1]) < tol && Math.abs(rgb[2] - target[2]) < tol;
  const ballChecks = [
    [0, 'cue ball white', (c) => c[0] > 150 && c[1] > 150 && c[2] > 140],
    [1, '1-ball yellow', (c) => c[0] > 140 && c[1] > 120 && c[2] < c[1] * 0.8],
    [2, '2-ball blue', (c) => c[2] > 90 && c[2] > c[0] * 1.25],
    [3, '3-ball red', (c) => c[0] > 110 && c[0] > c[1] * 1.6 && c[0] > c[2] * 1.6],
    [5, '5-ball orange', (c) => c[0] > 140 && c[1] > 60 && c[1] < c[0] * 0.85 && c[2] < c[1] * 0.6],
    [8, '8-ball black', (c) => Math.max(...c) < 130],
  ];
  for (const [id, label, pred] of ballChecks) {
    const rgb = ballRgb.get(id);
    console.log(`    ${label.padEnd(16)} rgb(${rgb.join(',')})`);
    check(pred(rgb), `${label} is the right colour on the table`, rgb.join(','));
  }
  // every ball must be inside the playing area
  const outside = probe.balls.filter((b) => Math.abs(b.x) > 1.27 || Math.abs(b.z) > 0.635);
  check(outside.length === 0, 'all balls inside the playing area', JSON.stringify(outside.map((b) => b.id)));

  console.log('\n— aim prediction ———————————————————');
  const aim = await session.evaluate(`(() => {
    const p = window.__pool;
    p.state.camMode = 'orbit';
    p.camera.position.set(0, 1.72, 2.0);
    p.camera.lookAt(0, 0, 0.06);
    // aim the cue ball straight at the rack apex (ball 1)
    const cue = p.world.cue, apex = p.world.ball(1);
    const dx = apex.x - cue.x, dz = apex.z - cue.z;
    const l = Math.hypot(dx, dz);
    p.state.aim.set(dx / l, 0, dz / l);
    return { aim: [p.state.aim.x, p.state.aim.z], mode: p.state.mode };
  })()`);
  console.log(aim);
  await sleep(400);
  const shot3 = await session.screenshot(`${SHOTS}/03-aiming.png`);
  const img3 = decodePng(shot3);
  const brightLine = countNear(img3, [242, 247, 255], 30);
  check(brightLine > 100, 'aim line drawn on the cloth', `${brightLine}px`);

  console.log('\n— play a real shot (mouse input) ————');
  const before = await session.evaluate(
    `window.__pool.world.balls.map(b => ({id:b.id, x:+b.x.toFixed(4), z:+b.z.toFixed(4)}))`,
  );
  // screen position of the cue ball, then drag backwards to charge
  const geom = await session.evaluate(`(() => {
    const p = window.__pool;
    const v = new (p.world.cue.constructor)(); // not used; project manually
    const cue = p.world.cue;
    const vec = { x: cue.x, y: 0.028575, z: cue.z };
    // project through the live camera
    const THREE_V = p.camera.position.clone();
    return { cue: vec, cam: {x:p.camera.position.x,y:p.camera.position.y,z:p.camera.position.z} };
  })()`);
  const screen = await session.evaluate(`(() => {
    const p = window.__pool;
    const cue = p.world.cue;
    const pos = new p.camera.position.constructor(cue.x, 0.028575, cue.z);
    pos.project(p.camera);
    return { x: (pos.x * 0.5 + 0.5) * window.innerWidth, y: (-pos.y * 0.5 + 0.5) * window.innerHeight };
  })()`);
  console.log('  cue ball at screen', screen);

  // aim towards the rack: pick a screen point along the aim direction
  const aimScreen = await session.evaluate(`(() => {
    const p = window.__pool;
    const cue = p.world.cue;
    const t = new p.camera.position.constructor(
      cue.x + p.state.aim.x * 0.7, 0.028575, cue.z + p.state.aim.z * 0.7);
    t.project(p.camera);
    return { x: (t.x * 0.5 + 0.5) * window.innerWidth, y: (-t.y * 0.5 + 0.5) * window.innerHeight };
  })()`);

  // start on the cue ball, drag away from the target to charge, release
  const dirx = aimScreen.x - screen.x;
  const diry = aimScreen.y - screen.y;
  const len = Math.hypot(dirx, diry);
  const back = { x: screen.x - (dirx / len) * 300, y: screen.y - (diry / len) * 300 };
  await session.drag([
    { x: screen.x, y: screen.y },
    { x: (screen.x + back.x) / 2, y: (screen.y + back.y) / 2 },
    back,
  ]);
  await sleep(400);

  const afterDrag = await session.evaluate(
    `({ mode: window.__pool.state.mode, power: +window.__pool.state.power.toFixed(3) })`,
  );
  console.log('  after drag:', afterDrag);
  check(afterDrag.mode === 'shooting', 'mouse drag started a shot', JSON.stringify(afterDrag));

  // let the shot play out (headless software rendering is slow, so be patient)
  const t0 = Date.now();
  const e0 = await session.evaluate('window.__pool.world.elapsed');
  await session.waitFor(
    `window.__pool.state.mode !== 'shooting'`,
    240000,
    'shot resolves',
  );
  const wall = (Date.now() - t0) / 1000;
  const e1 = await session.evaluate('window.__pool.world.elapsed');
  console.log(`  shot took ${wall.toFixed(1)}s wall / ${(e1 - e0).toFixed(1)}s simulated`);
  check(e1 - e0 < 40, 'shot simulation terminated', `${(e1 - e0).toFixed(1)}s`);
  const afterShot = await session.evaluate(`(() => {
    const p = window.__pool;
    const moved = p.world.balls.filter(b => b.active).length;
    return {
      mode: p.state.mode,
      message: document.getElementById('message').textContent,
      detail: document.getElementById('detail').textContent,
      turn: document.getElementById('turnLabel').textContent,
      firstHit: p.world.shot.firstHit,
      potted: p.world.shot.potted,
      activeBalls: moved,
      elapsed: +p.world.elapsed.toFixed(2),
    };
  })()`);
  console.log(afterShot);

  const movedCount = await session.evaluate(`(() => {
    const p = window.__pool;
    const before = ${JSON.stringify(before)};
    let n = 0;
    for (const b of p.world.balls) {
      const o = before.find(x => x.id === b.id);
      if (!o) continue;
      if (Math.hypot(b.x - o.x, b.z - o.z) > 0.01) n++;
    }
    return n;
  })()`);
  check(movedCount >= 5, 'break scattered the rack', `${movedCount} balls moved`);
  check(afterShot.firstHit !== null, 'cue ball contacted the rack', String(afterShot.firstHit));
  check(afterShot.mode === 'aim' || afterShot.mode === 'placing', 'shot resolved cleanly', afterShot.mode);
  check(/break|pocket|foul|continue|up|spot|no pot/i.test(afterShot.message), 'HUD message updated', afterShot.message);

  const shot4 = await session.screenshot(`${SHOTS}/04-after-break.png`);
  const img4 = decodePng(shot4);
  check(countGreen(img4) > img4.width * img4.height * 0.05, 'table still renders after the shot');

  console.log('\n— potting a ball end to end ————————');
  await session.evaluate(`(() => {
    const p = window.__pool;
    p.resetGame();
    const w = p.world;
    // straight-in shot: cue ball, object ball and the corner pocket in a line
    for (const b of w.balls) if (b.id !== 0 && b.id !== 1) b.active = false;
    const pocket = { x: 1.27, z: 0.635 };
    const dir = { x: -0.8944, z: -0.4472 };
    w.ball(1).x = pocket.x + dir.x * 0.42;
    w.ball(1).z = pocket.z + dir.z * 0.42;
    w.cue.x = w.ball(1).x + dir.x * 0.36;
    w.cue.z = w.ball(1).z + dir.z * 0.36;
    for (const b of w.balls) { b.vx = b.vz = b.wx = b.wy = b.wz = 0; }
    p.state.mode = 'aim';
    p.state.camMode = 'orbit';
    p.camera.position.set(0, 1.72, 2.0);
    p.camera.lookAt(0, 0, 0.06);
    p.game.breakDone = true;
    p.game.message = 'Test shot ready';
  })()`);
  await sleep(500);
  const pot = await shootAt(session, 1.27, 0.635, 0.42);
  console.log(pot);
  check(pot.firstHit === 1, 'cue ball hit the object ball first', String(pot.firstHit));
  check(pot.potted.includes(1), 'object ball dropped in the corner pocket', JSON.stringify(pot.potted));
  check(/pockets|pocket/i.test(pot.message), 'HUD reports the pot', pot.message);
  const afterPot = await session.evaluate(`({
    group: window.__pool.game.players[0].group,
    group2: window.__pool.game.players[1].group,
    turn: window.__pool.game.turn,
    open: window.__pool.game.openTable,
    ballInHand: window.__pool.game.ballInHand,
    badge1: document.getElementById('group1').textContent,
    badge2: document.getElementById('group2').textContent,
    card1: document.getElementById('player1').classList.contains('active'),
    card2: document.getElementById('player2').classList.contains('active'),
  })`);
  console.log('  hud after pot:', afterPot);
  check(afterPot.group === 'solids' && afterPot.turn === 0, 'shooter keeps shooting on solids', JSON.stringify(afterPot));
  check(/solids/i.test(afterPot.badge1), 'left badge shows the shooter\'s group', afterPot.badge1);
  check(/stripes/i.test(afterPot.badge2), 'right badge shows the opponent\'s group', afterPot.badge2);
  check(afterPot.card1 && !afterPot.card2, 'shooter stays highlighted, opponent is not');
  check(afterPot.ballInHand === false, 'a legal pot does not give ball in hand');

  console.log('\n— ball in hand after a scratch ——————');
  await session.evaluate(`(() => {
    const p = window.__pool;
    p.resetGame();
    const w = p.world;
    p.game.breakDone = true;
    // drop the cue ball straight into a pocket to force a scratch
    w.cue.x = 0; w.cue.z = 0.5; w.cue.vx = 0; w.cue.vz = 1.6;
    w.beginShot();
    p.state.mode = 'shooting';
  })()`);
  await session.waitFor("window.__pool.state.mode !== 'shooting'", 60000, 'scratch resolves');
  const scratch = await session.evaluate(`({
    mode: window.__pool.state.mode,
    ballInHand: window.__pool.game.ballInHand,
    cueActive: window.__pool.world.cue.active,
    turn: window.__pool.game.turn,
    message: document.getElementById('message').textContent,
  })`);
  console.log(scratch);
  check(scratch.mode === 'placing', 'scratch puts the game in placement mode', scratch.mode);
  check(scratch.ballInHand === true && scratch.cueActive === true, 'cue ball is back with ball in hand');
  const held = await session.evaluate(`(() => {
    const p = window.__pool;
    const meshes = [];
    p.scene.traverse(o => { if (o.isMesh && o.userData.ballId !== undefined && o.visible) meshes.push(o.userData.ballId); });
    return { visibleBalls: meshes.length, cueMeshVisible: p.ballMeshes.get(0).visible };
  })()`);
  console.log('  while placing:', held);
  check(held.cueMeshVisible === false, 'cue ball is held in hand, not lying on the cloth too');

  // the same must hold for a foul where the cue ball was never potted
  await session.evaluate(`(() => {
    const p = window.__pool;
    p.resetGame();
    p.game.breakDone = true;
    p.game.ballInHand = true;
    p.state.mode = 'placing';
  })()`);
  await sleep(400);
  const held2 = await session.evaluate(`(() => {
    const p = window.__pool;
    return { cuePotted: p.world.cue.potted, cueMeshVisible: p.ballMeshes.get(0).visible };
  })()`);
  console.log('  foul without scratch:', held2);
  check(held2.cueMeshVisible === false, 'unpotted cue ball is lifted off the cloth while in hand');
  const placePt = await screenOf(session, -0.5, 0.25);
  await session.mouse('mouseMoved', placePt.x, placePt.y, 'none');
  await sleep(200);
  await session.mouse('mousePressed', placePt.x, placePt.y, 'left');
  await session.mouse('mouseReleased', placePt.x, placePt.y, 'left');
  await sleep(400);
  const placed = await session.evaluate(`({
    mode: window.__pool.state.mode,
    x: +window.__pool.world.cue.x.toFixed(3),
    z: +window.__pool.world.cue.z.toFixed(3),
    ballInHand: window.__pool.game.ballInHand,
  })`);
  console.log(placed);
  check(placed.mode === 'aim' && placed.ballInHand === false, 'clicking a legal spot places the cue ball');
  check(Math.abs(placed.x - -0.5) < 0.05 && Math.abs(placed.z - 0.25) < 0.05, 'cue ball landed where clicked', JSON.stringify(placed));

  // regression: a re-placed cue ball used to stay invisible after sinking
  const cueVisible = await session.evaluate(`(() => {
    const p = window.__pool, T = p.THREE;
    const mesh = p.ballMeshes.get(0);
    p.renderer.render(p.scene, p.camera);
    const W = p.renderer.domElement.width, H = p.renderer.domElement.height;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(p.renderer.domElement, 0, 0);
    const v = new T.Vector3(p.world.cue.x, 0.0286, p.world.cue.z).project(p.camera);
    const d = ctx.getImageData(Math.round((v.x*0.5+0.5)*W), Math.round((-v.y*0.5+0.5)*H), 1, 1).data;
    return { meshVisible: mesh.visible, pixel: [d[0], d[1], d[2]] };
  })()`);
  console.log('  re-placed cue ball:', cueVisible);
  check(cueVisible.meshVisible, 're-placed cue ball mesh is visible again');
  check(Math.min(...cueVisible.pixel) > 150, 're-placed cue ball actually renders', cueVisible.pixel.join(','));

  console.log('\n— rules engine through the UI ————————');
  const rules = await session.evaluate(`(() => {
    const p = window.__pool;
    // force a deterministic scenario: pot a solid, expect group assignment
    const w = p.world;
    const g = p.game;
    g.reset(w);
    g.breakDone = true;
    w.beginShot();
    w.shot.firstHit = 3;
    w.shot.railAfterContact = true;
    w.shot.potted = [3];
    w.ball(3).active = false; w.ball(3).potted = true;
    const res = g.evaluateShot();
    return {
      foul: res.foul,
      group0: g.players[0].group,
      turn: g.turn,
      continueTurn: res.continueTurn,
    };
  })()`);
  console.log(rules);
  check(rules.foul === false && rules.group0 === 'solids', 'group assigned to the shooter');
  check(rules.continueTurn === true && rules.turn === 0, 'shooter keeps the table after potting');

  console.log('\n— cue stick clearance ————————————————');
  const stickCases = [
    { label: 'mid-table', x: 0, z: 0, ax: 1, az: 0, minElev: 4, maxElev: 12 },
    { label: 'frozen to rail, cueing across it', x: -0.9, z: 0.6064, ax: 0, az: -1, minElev: 20, maxElev: 40 },
    { label: 'in the corner, cueing out', x: -1.2, z: 0.6, ax: 1, az: 0, minElev: 20, maxElev: 40 },
  ];
  for (const c of stickCases) {
    await session.evaluate(`(() => {
      const p = window.__pool;
      p.state.mode = 'aim';
      p.state.camMode = 'orbit';
      p.world.cue.x = ${c.x}; p.world.cue.z = ${c.z};
      p.world.cue.vx = p.world.cue.vz = 0;
      p.state.aim.set(${c.ax}, 0, ${c.az}).normalize();
    })()`);
    await sleep(300);
    const r = await session.evaluate(`(() => {
      const p = window.__pool, T = p.THREE;
      const st = p.cueStick;
      const axis = new T.Vector3(0, 1, 0).applyQuaternion(st.quaternion);
      const tip = new T.Vector3(0, st.userData.tipY, 0).applyQuaternion(st.quaternion).add(st.position);
      return {
        buttY: +st.position.y.toFixed(3),
        tipY: +tip.y.toFixed(3),
        tipDist: +Math.hypot(tip.x - p.world.cue.x, tip.z - p.world.cue.z).toFixed(3),
        elevDeg: +(Math.asin(-axis.y) * 180 / Math.PI).toFixed(1),
      };
    })()`);
    console.log(`  ${c.label.padEnd(32)} buttY=${r.buttY} tipY=${r.tipY} tipDist=${r.tipDist} elev=${r.elevDeg}°`);
    check(
      r.elevDeg >= c.minElev && r.elevDeg <= c.maxElev,
      `cue elevation is sensible (${c.label})`,
      `${r.elevDeg}°`,
    );
    check(r.buttY > 0.062, `cue butt clears the rail (${c.label})`, `buttY=${r.buttY}`);
    check(Math.abs(r.tipY - 0.0286) < 0.02, `cue tip still meets the ball (${c.label})`, `tipY=${r.tipY}`);

    // regression: the cue must be drawn back along its own axis, never sideways
    const tipAt = async (power) => {
      await session.evaluate(`window.__pool.state.power = ${power}`);
      await sleep(220);
      return session.evaluate(`(() => {
        const p = window.__pool, T = p.THREE;
        const st = p.cueStick;
        const axis = new T.Vector3(0, 1, 0).applyQuaternion(st.quaternion).normalize();
        const tip = new T.Vector3(0, st.userData.tipY, 0).applyQuaternion(st.quaternion).add(st.position);
        return { tip: [tip.x, tip.y, tip.z], axis: [axis.x, axis.y, axis.z] };
      })()`);
    };
    const p0 = await tipAt(0);
    const p1 = await tipAt(1);
    const d = [p1.tip[0] - p0.tip[0], p1.tip[1] - p0.tip[1], p1.tip[2] - p0.tip[2]];
    const ax = p0.axis;
    const moved = Math.hypot(...d);
    const along = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
    const sideways = Math.sqrt(Math.max(0, moved * moved - along * along));
    console.log(
      `    pull-back: moved ${moved.toFixed(4)}m, along axis ${along.toFixed(4)}m, sideways ${sideways.toFixed(5)}m`,
    );
    check(moved > 0.25, `cue pulls back a visible distance (${c.label})`, `${moved.toFixed(3)}m`);
    check(sideways < 0.002, `cue pulls back along its own axis (${c.label})`, `sideways=${sideways.toFixed(5)}m`);
    await session.evaluate('window.__pool.state.power = 0');
    await sleep(150);
  }

  console.log('\n— camera modes & re-rack —————————————');
  await session.key('KeyC', 'keyDown');
  await session.key('KeyC', 'keyUp');
  await sleep(1400);
  const camMode = await session.evaluate(`window.__pool.state.camMode`);
  check(camMode === 'overhead', 'C cycles the camera', camMode);
  await session.screenshot(`${SHOTS}/05-camera.png`);

  // follow camera should end up behind the cue ball
  await session.key('KeyC', 'keyDown');
  await session.key('KeyC', 'keyUp');
  await sleep(1500);
  const follow = await session.evaluate(`(() => {
    const p = window.__pool;
    const cue = p.world.cue;
    const d = Math.hypot(p.camera.position.x - cue.x, p.camera.position.z - cue.z);
    return { mode: p.state.camMode, dist: +d.toFixed(3), y: +p.camera.position.y.toFixed(3) };
  })()`);
  console.log('  follow camera:', follow);
  check(follow.mode === 'follow', 'C cycles on to the follow camera', follow.mode);
  check(follow.dist < 1.0 && follow.y > 0.2, 'follow camera sits behind the cue ball', JSON.stringify(follow));

  // english widget: dragging it must move the tip offset
  const padBox = await session.evaluate(`(() => {
    const r = document.getElementById('englishPad').getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5, w: r.width, h: r.height };
  })()`);
  await session.mouse('mouseMoved', padBox.x + padBox.w * 0.32, padBox.y - padBox.h * 0.3, 'none');
  await session.mouse('mousePressed', padBox.x + padBox.w * 0.32, padBox.y - padBox.h * 0.3, 'left');
  await session.mouse('mouseReleased', padBox.x + padBox.w * 0.32, padBox.y - padBox.h * 0.3, 'left');
  await sleep(300);
  const spin = await session.evaluate(
    '({x: +window.__pool.state.spin.x.toFixed(3), y: +window.__pool.state.spin.y.toFixed(3)})',
  );
  console.log('  english widget:', spin);
  check(spin.x > 0.05 && spin.y > 0.05, 'english widget sets tip offset', JSON.stringify(spin));
  await session.evaluate(`document.getElementById('englishReset').click()`);
  await sleep(200);

  await session.evaluate(`window.__pool.resetGame()`);
  await sleep(600);
  const reset = await session.evaluate(`(() => {
    const p = window.__pool;
    return {
      active: p.world.balls.filter(b => b.active).length,
      potted: p.world.balls.filter(b => b.potted).length,
      mode: p.state.mode,
      openTable: p.game.openTable,
      visible: [...document.querySelectorAll('#tray1 .chip')].length,
    };
  })()`);
  console.log(reset);
  check(reset.active === 16 && reset.potted === 0, 're-rack restores all 16 balls');
  check(reset.mode === 'aim', 're-rack returns to aiming');

  console.log('\n— final screenshot ————————————————');
  await session.evaluate(`(() => {
    const p = window.__pool;
    p.state.camMode = 'orbit';
    p.camera.position.set(1.15, 1.35, 1.55);
    p.camera.lookAt(0, 0, 0.06);
    p.renderer.render(p.scene, p.camera);
  })()`);
  await sleep(800);
  await session.screenshot(`${SHOTS}/06-final.png`);

  console.log('\n— errors collected —————————————————');
  const errs = session.errors.filter((e) => !ignorable(e));
  check(errs.length === 0, 'still no console errors', errs.slice(0, 5).join(' | '));
} finally {
  session?.close();
  proc.kill('SIGKILL');
}

console.log('\n==============================');
if (problems.length) {
  console.log(`${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(' - ' + p);
  process.exit(1);
} else {
  console.log('ALL CHECKS PASSED');
}
