/**
 * main.js — the game itself: renderer, camera, input, aim prediction, HUD.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  BALL_RADIUS,
  HALF_L,
  HEAD_SPOT,
  PHYS,
  World,
  createRack,
  raycastBalls,
  raycastCushions,
} from './physics.js';
import { EightBallGame, SOLIDS, groupOfBall } from './rules.js';
import {
  buildBalls,
  buildCue,
  buildLights,
  buildRoom,
  buildTable,
  setupEnvironment,
} from './table.js';
import { Audio } from './audio.js';
import { ballColor, isStripe } from './textures.js';

// ---------------------------------------------------------------------------
// renderer / scene
// ---------------------------------------------------------------------------

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x090a0c);
scene.fog = new THREE.Fog(0x090a0c, 6, 16);

const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.04, 60);
camera.position.set(0, 1.72, 2.0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0.06);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.85;
controls.maxDistance = 4.6;
controls.minPolarAngle = 0.16;
controls.maxPolarAngle = 1.32;
controls.enablePan = false;
controls.mouseButtons = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.update();

setupEnvironment(renderer, scene);
buildRoom(scene);
const tableInfo = buildTable(scene);
const lights = buildLights(scene, tableInfo.lampPositions);

// ---------------------------------------------------------------------------
// game state
// ---------------------------------------------------------------------------

const audio = new Audio();
let world = new World(createRack());
let game = new EightBallGame(world, ['Player 1', 'Player 2']);
let ballMeshes = buildBalls(world);
for (const m of ballMeshes.values()) scene.add(m);

const cueStick = buildCue();
scene.add(cueStick);

const state = {
  mode: 'aim', // aim | shooting | placing | over
  aim: new THREE.Vector3(1, 0, 0),
  power: 0,
  charging: false,
  chargeStart: new THREE.Vector2(),
  chargeKey: false,
  keyChargeT: 0,
  spin: { x: 0, y: 0 }, // x = right english, y = follow/draw, fraction of R
  camMode: 'orbit',
  ghostValid: false,
  pointer: new THREE.Vector2(),
  hoverPoint: new THREE.Vector3(),
  hasHover: false,
  lastCuePos: new THREE.Vector3(HEAD_SPOT.x, BALL_RADIUS, HEAD_SPOT.z),
};

const MAX_DRAG = 0.62; // metres of table drag == full power
const MIN_SHOT = 0.42; // m/s, so a tap still nudges the ball
const MIN_CUE_ELEVATION = 0.11; // ~6°, a natural resting angle for the cue
const MAX_CUE_ELEVATION = 0.55; // ~31°, used when the cue ball is on a rail

// ---------------------------------------------------------------------------
// aim helpers / visuals
// ---------------------------------------------------------------------------

const aimGroup = new THREE.Group();
scene.add(aimGroup);

function flatPlane(w, h, color, opacity = 1) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

const aimLine = flatPlane(1, 0.0045, 0xf2f7ff, 0.55);
const aimLineSoft = flatPlane(1, 0.0032, 0x9fd6ff, 0.4);
const ghostBall = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_RADIUS, 20, 14),
  new THREE.MeshBasicMaterial({
    color: 0x9fe8ff,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  }),
);
const contactRing = new THREE.Mesh(
  new THREE.RingGeometry(BALL_RADIUS * 0.75, BALL_RADIUS * 0.95, 28),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
);
contactRing.rotation.x = -Math.PI / 2;
aimGroup.add(aimLine, aimLineSoft, ghostBall, contactRing);

const placeGhost = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_RADIUS, 24, 16),
  new THREE.MeshBasicMaterial({
    color: 0x6bff9e,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  }),
);
placeGhost.visible = false;
scene.add(placeGhost);

const raycaster = new THREE.Raycaster();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const tmpV = new THREE.Vector3();

function pointerToTable(clientX, clientY, out = new THREE.Vector3()) {
  const ndc = new THREE.Vector2(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.ray.intersectPlane(tablePlane, out);
  return hit || null;
}

/** Set the aim direction from a point on the cloth. */
function updateAimFromPoint(p) {
  const cue = world.cue;
  const dx = p.x - cue.x;
  const dz = p.z - cue.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.055) return; // too close to the cue ball to be meaningful
  state.aim.set(dx / len, 0, dz / len);
}

function updateAimVisuals() {
  const cue = world.cue;
  const dir = state.aim;
  const active = state.mode === 'aim' && cue.active;
  aimGroup.visible = active;
  cueStick.visible = active;
  if (!active) return;

  const cuePos = new THREE.Vector3(cue.x, BALL_RADIUS, cue.z);

  // --- what does the cue ball hit first? ---
  const ballHit = raycastBalls(world.balls, cue.x, cue.z, dir.x, dir.z, 0);
  const wallT = raycastCushions(cue.x, cue.z, dir.x, dir.z);
  let endT = Math.min(wallT, 6);
  let contactPoint = null;
  let objectDir = null;

  if (ballHit && ballHit.t < wallT) {
    endT = ballHit.t;
    contactPoint = new THREE.Vector3(ballHit.cx, BALL_RADIUS, ballHit.cz);
    const od = new THREE.Vector3(
      ballHit.ball.x - ballHit.cx,
      0,
      ballHit.ball.z - ballHit.cz,
    );
    if (od.lengthSq() > 1e-9) objectDir = od.normalize();
  }

  // aim line
  const mid = cuePos.clone().addScaledVector(dir, endT / 2);
  aimLine.position.copy(mid).setY(0.0022);
  aimLine.scale.set(endT, 1, 1);
  aimLine.rotation.z = -Math.atan2(dir.z, dir.x);

  if (contactPoint && objectDir) {
    ghostBall.visible = true;
    ghostBall.position.copy(contactPoint);
    contactRing.visible = true;
    contactRing.position.copy(contactPoint).setY(0.0024);

    // predicted object-ball path
    const oLen = Math.min(0.75, raycastCushions(contactPoint.x, contactPoint.z, objectDir.x, objectDir.z));
    aimLineSoft.visible = oLen > 0.02;
    if (aimLineSoft.visible) {
      aimLineSoft.position
        .copy(contactPoint)
        .addScaledVector(objectDir, oLen / 2)
        .setY(0.0021);
      aimLineSoft.scale.set(oLen, 1, 1);
      aimLineSoft.rotation.z = -Math.atan2(objectDir.z, objectDir.x);
    }
  } else {
    ghostBall.visible = false;
    contactRing.visible = false;
    aimLineSoft.visible = false;
  }

  // --- cue stick ---
  // The stick is elevated at the butt so it clears the cushion and rail
  // instead of passing through them. The closer the cue ball sits to a rail
  // behind the shot, the steeper the cue has to be held — exactly like a real
  // player cueing off the cushion.
  const right = new THREE.Vector3(-dir.z, 0, dir.x);
  const tipY = cueStick.userData.tipY;
  const pull = 0.055 + state.power * 0.34;
  const tipOffset = state.spin.x * BALL_RADIUS * 0.8;
  const tipHeight = state.spin.y * BALL_RADIUS * 0.8;
  const offsetLen = Math.hypot(tipOffset, tipHeight);
  const alongBall = Math.sqrt(Math.max(0, BALL_RADIUS * BALL_RADIUS - offsetLen * offsetLen));

  // distance from the cue ball back to the rail along the butt direction
  const backDist = raycastCushions(cue.x, cue.z, -dir.x, -dir.z);
  const clearHeight = 0.062 + 0.012 - BALL_RADIUS; // rail top plus a little air
  const elev = Math.max(
    MIN_CUE_ELEVATION,
    Math.min(MAX_CUE_ELEVATION, Math.atan(clearHeight / Math.max(0.09, backDist))),
  );

  // axis runs from the butt up to the tip, tilted down by `elev`
  const axis = new THREE.Vector3(
    dir.x * Math.cos(elev),
    -Math.sin(elev),
    dir.z * Math.cos(elev),
  ).normalize();

  // where the tip touches the ball, then step back along the axis to the butt
  const tipPos = cuePos
    .clone()
    .addScaledVector(dir, -(alongBall + pull))
    .addScaledVector(right, tipOffset);
  tipPos.y = BALL_RADIUS + tipHeight;

  cueStick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  cueStick.position.copy(tipPos).addScaledVector(axis, -tipY);
}

// ---------------------------------------------------------------------------
// shooting
// ---------------------------------------------------------------------------

function canShoot() {
  return state.mode === 'aim' && world.cue.active && state.power > 0.02;
}

function shoot() {
  if (!canShoot()) {
    state.power = 0;
    state.charging = false;
    return;
  }
  const p = Math.max(state.power, 0.02);
  const speed = Math.max(MIN_SHOT, p * PHYS.maxShotSpeed);
  world.strike(state.aim.x, state.aim.z, speed, state.spin.y, state.spin.x);
  audio.strike(p);
  state.mode = 'shooting';
  state.power = 0;
  state.charging = false;
  state.chargeKey = false;
  aimGroup.visible = false;
  cueStick.visible = false;
  updateHUD();
}

function resolveShot() {
  const result = game.evaluateShot();
  if (game.gameOver) {
    state.mode = 'over';
    showOverlay();
  } else if (game.ballInHand) {
    state.mode = 'placing';
  } else {
    state.mode = 'aim';
  }
  updateHUD();
  return result;
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

function panFromPoint(p) {
  return Math.max(-1, Math.min(1, p.x / (HALF_L + 0.4)));
}

function onPointerDown(e) {
  audio.resume();
  if (e.button !== 0) {
    if (state.camMode === 'follow') {
      state.camMode = 'orbit';
      controls.enabled = true;
      controls.target.set(0, 0, 0.06);
      controls.update();
    }
    return;
  }
  const p = pointerToTable(e.clientX, e.clientY);
  if (!p) return;
  state.pointer.set(p.x, p.z);

  if (state.mode === 'placing') {
    tryPlaceCue(p);
    return;
  }
  if (state.mode !== 'aim') return;

  updateAimFromPoint(p);
  state.charging = true;
  state.chargeStart.set(p.x, p.z);
  state.power = 0;
  controls.enabled = false;
}

function onPointerMove(e) {
  const p = pointerToTable(e.clientX, e.clientY);
  if (!p) return;
  state.hoverPoint.copy(p);
  state.hasHover = true;

  if (state.mode === 'placing') {
    const ok = game.canPlaceCue(p.x, p.z);
    state.ghostValid = ok;
    placeGhost.position.set(p.x, BALL_RADIUS, p.z);
    placeGhost.material.color.setHex(ok ? 0x6bff9e : 0xff6b6b);
    return;
  }
  if (state.mode !== 'aim') return;

  if (state.charging) {
    // pull the mouse away from the aim direction to build power
    const dx = state.chargeStart.x - p.x;
    const dz = state.chargeStart.y - p.z;
    const pull = dx * state.aim.x + dz * state.aim.z;
    state.power = Math.max(0, Math.min(1, pull / MAX_DRAG));
  } else {
    updateAimFromPoint(p);
  }
}

function onPointerUp(e) {
  if (state.camMode === 'orbit') controls.enabled = true;
  if (state.mode === 'aim' && state.charging) {
    if (state.power > 0.02) shoot();
    else state.power = 0;
    state.charging = false;
  }
}

function tryPlaceCue(p) {
  if (!game.canPlaceCue(p.x, p.z)) {
    audio.ui(220);
    return;
  }
  world.placeCueBall(p.x, p.z);
  game.ballInHand = false;
  game.ballInHandKitchen = false;
  state.mode = 'aim';
  placeGhost.visible = false;
  audio.ui(880);
  updateHUD();
}

renderer.domElement.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// keyboard ------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  audio.resume();
  if (e.code === 'Space') {
    e.preventDefault();
    if (state.mode === 'aim' && !state.chargeKey) {
      state.chargeKey = true;
      state.keyChargeT = 0;
      state.charging = true;
      state.chargeStart.set(world.cue.x, world.cue.z);
    }
  } else if (e.code === 'KeyC') {
    cycleCamera();
  } else if (e.code === 'KeyM') {
    audio.setMuted(!audio.muted);
    updateHUD();
  } else if (e.code === 'KeyR') {
    resetGame();
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    if (state.mode !== 'aim') return;
    const step = (e.shiftKey ? 0.002 : 0.012) * (e.code === 'ArrowLeft' ? 1 : -1);
    const a = Math.atan2(state.aim.z, state.aim.x) + step;
    state.aim.set(Math.cos(a), 0, Math.sin(a));
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    state.chargeKey = false;
    if (state.mode === 'aim' && state.charging) {
      if (state.power > 0.02) shoot();
      else {
        state.power = 0;
        state.charging = false;
      }
    }
  }
});

// camera --------------------------------------------------------------------

const CAM_PRESETS = {
  orbit: { pos: new THREE.Vector3(0, 1.72, 2.0), target: new THREE.Vector3(0, 0, 0.06) },
  overhead: { pos: new THREE.Vector3(0, 3.05, 0.62), target: new THREE.Vector3(0, 0, 0.06) },
};

function cycleCamera() {
  if (state.camMode === 'orbit') {
    state.camMode = 'overhead';
    controls.enabled = false;
    flyTo(CAM_PRESETS.overhead.pos, CAM_PRESETS.overhead.target);
  } else if (state.camMode === 'overhead') {
    state.camMode = 'follow';
    controls.enabled = false;
  } else {
    state.camMode = 'orbit';
    controls.enabled = true;
    controls.target.set(0, 0, 0.06);
    flyTo(CAM_PRESETS.orbit.pos, CAM_PRESETS.orbit.target);
  }
  updateHUD();
}

const fly = { active: false, t: 0, fromPos: new THREE.Vector3(), fromTarget: new THREE.Vector3(), toPos: new THREE.Vector3(), toTarget: new THREE.Vector3() };

function flyTo(pos, target) {
  fly.active = true;
  fly.t = 0;
  fly.fromPos.copy(camera.position);
  fly.fromTarget.copy(controls.target);
  fly.toPos.copy(pos);
  fly.toTarget.copy(target);
}

function updateCamera(dt) {
  if (fly.active) {
    fly.t = Math.min(1, fly.t + dt * 1.8);
    const e = 1 - Math.pow(1 - fly.t, 3);
    camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
    controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e);
    if (fly.t >= 1) fly.active = false;
    camera.lookAt(controls.target);
    return;
  }

  if (state.camMode === 'follow') {
    // the camera drives itself in this mode, whether aiming or watching a shot
    const cue = world.cue;
    const dir = state.aim;
    const desired = new THREE.Vector3(cue.x, 0.5, cue.z).addScaledVector(dir, -0.62);
    const look = new THREE.Vector3(cue.x, BALL_RADIUS, cue.z).addScaledVector(dir, 0.9);
    const k = Math.min(1, dt * 6);
    camera.position.lerp(desired, k);
    controls.target.lerp(look, k);
    camera.lookAt(controls.target);
  } else {
    controls.update();
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);

function ballChip(id, small = false) {
  const d = document.createElement('div');
  d.className = 'chip' + (small ? ' chip-sm' : '');
  const stripe = isStripe(id);
  d.style.background = stripe
    ? `linear-gradient(#f4f2ec 0 26%, ${ballColor(id)} 26% 74%, #f4f2ec 74% 100%)`
    : ballColor(id);
  d.textContent = id === 0 ? '' : id;
  if (id === 0) d.style.background = '#f4f2ec';
  return d;
}

function renderPlayerCard(side, player, active) {
  const card = el(side === 'left' ? 'player1' : 'player2');
  card.classList.toggle('active', active);
  el(side === 'left' ? 'name1' : 'name2').textContent = player.name;

  const badge = el(side === 'left' ? 'group1' : 'group2');
  if (!player.group || game.openTable) {
    badge.textContent = 'Open table';
    badge.className = 'badge open';
  } else {
    badge.textContent = player.group === SOLIDS ? 'Solids 1–7' : 'Stripes 9–15';
    badge.className = 'badge ' + player.group;
  }

  const tray = el(side === 'left' ? 'tray1' : 'tray2');
  tray.innerHTML = '';
  if (player.group && !game.openTable) {
    const remaining = world.balls.filter(
      (b) => b.active && groupOfBall(b.id) === player.group,
    );
    for (const b of remaining) tray.appendChild(ballChip(b.id, true));
    if (remaining.length === 0) {
      const c = document.createElement('div');
      c.className = 'chip chip-sm eight';
      c.textContent = '8';
      tray.appendChild(c);
    }
  }
}

function updateHUD() {
  renderPlayerCard('left', game.players[0], game.turn === 0);
  renderPlayerCard('right', game.players[1], game.turn === 1);

  el('message').textContent = game.message;
  el('detail').textContent = game.detail;

  const turn = el('turnLabel');
  turn.textContent =
    state.mode === 'placing'
      ? `${game.currentPlayer.name}: ball in hand — click the table to place`
      : `${game.currentPlayer.name} to shoot`;

  el('hint').textContent =
    state.mode === 'placing'
      ? 'Click a legal spot to drop the cue ball'
      : state.camMode === 'follow'
        ? 'Drag to aim · pull back and release to shoot · C for camera · M mute'
        : 'Move to aim · press and drag back to charge · release to shoot · Space also charges · C camera · R reset';

  el('camLabel').textContent = `Camera: ${state.camMode}`;
  el('muteBtn').textContent = audio.muted ? '🔇' : '🔊';

  // potted tray
  const potted = el('potted');
  potted.innerHTML = '';
  const down = world.balls.filter((b) => b.potted && b.id !== 0);
  if (down.length === 0) {
    potted.innerHTML = '<span class="muted">No balls pocketed yet</span>';
  } else {
    for (const b of down) potted.appendChild(ballChip(b.id));
  }

  const powerFill = el('powerFill');
  powerFill.style.width = `${Math.round(state.power * 100)}%`;
  el('powerPct').textContent = `${Math.round(state.power * 100)}%`;

  el('englishDot').style.left = `${50 + state.spin.x * 100}%`;
  el('englishDot').style.top = `${50 - state.spin.y * 100}%`;

  document.body.classList.toggle('placing', state.mode === 'placing');
}

// english widget
const englishPad = el('englishPad');
let englishDrag = false;
function setEnglishFromEvent(e) {
  const r = englishPad.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 2 - 1;
  const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
  const len = Math.hypot(x, y);
  const k = len > 1 ? 1 / len : 1;
  state.spin.x = Math.max(-0.5, Math.min(0.5, x * k * 0.5));
  state.spin.y = Math.max(-0.5, Math.min(0.5, y * k * 0.5));
  updateHUD();
}
englishPad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  englishDrag = true;
  englishPad.setPointerCapture(e.pointerId);
  setEnglishFromEvent(e);
});
englishPad.addEventListener('pointermove', (e) => {
  if (englishDrag) setEnglishFromEvent(e);
});
englishPad.addEventListener('pointerup', (e) => {
  englishDrag = false;
  try {
    englishPad.releasePointerCapture(e.pointerId);
  } catch {}
});
el('englishReset').addEventListener('click', () => {
  state.spin.x = 0;
  state.spin.y = 0;
  updateHUD();
});

// buttons
el('resetBtn').addEventListener('click', resetGame);
el('muteBtn').addEventListener('click', () => {
  audio.resume();
  audio.setMuted(!audio.muted);
  updateHUD();
});
el('camBtn').addEventListener('click', cycleCamera);
el('playAgain').addEventListener('click', () => {
  el('overlay').classList.remove('show');
  resetGame();
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

function resetGame() {
  const fresh = createRack();
  for (const nb of fresh) {
    const b = world.ball(nb.id);
    b.x = nb.x;
    b.z = nb.z;
    b.y = BALL_RADIUS;
    b.vx = b.vy = b.vz = 0;
    b.wx = b.wy = b.wz = 0;
    b.active = true;
    b.potted = false;
    b.pocket = -1;
    b.sinkT = 0;
    b.sinkY = 0;
    const m = ballMeshes.get(nb.id);
    m.visible = true;
    m.position.set(b.x, b.y, b.z);
    m.quaternion.identity();
  }
  world.beginShot();
  world.accumulator = 0;
  world.elapsed = 0;
  game.reset(world);
  state.mode = 'aim';
  state.power = 0;
  state.charging = false;
  state.spin.x = 0;
  state.spin.y = 0;
  state.aim.set(1, 0, 0);
  el('overlay').classList.remove('show');
  updateHUD();
  audio.ui(660);
}

function showOverlay() {
  const o = el('overlay');
  el('overlayTitle').textContent = `${game.players[game.winner].name} wins!`;
  el('overlayText').textContent =
    game.winner === 0
      ? 'The 8-ball drops and the table is yours.'
      : 'Tough luck — rack them up and go again.';
  o.classList.add('show');
}

// ---------------------------------------------------------------------------
// frame loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
let hudAccum = 0;

function syncBalls(dt) {
  for (const ball of world.balls) {
    const mesh = ballMeshes.get(ball.id);
    if (!mesh) continue;
    if (ball.potted) {
      mesh.position.set(ball.x, BALL_RADIUS + ball.sinkY, ball.z);
      if (ball.sinkT > 0.42) mesh.visible = false;
      continue;
    }
    // a ball that was pocketed and then put back on the table must reappear
    if (!mesh.visible) mesh.visible = true;
    mesh.position.set(ball.x, ball.y, ball.z);
    const w = Math.hypot(ball.wx, ball.wy, ball.wz);
    if (w > 1e-4) {
      const angle = w * dt;
      if (angle > 1e-5) {
        tmpV.set(ball.wx / w, ball.wy / w, ball.wz / w);
        const q = new THREE.Quaternion().setFromAxisAngle(tmpV, angle);
        mesh.quaternion.premultiply(q);
      }
    }
  }
}

function handleEvents(events) {
  for (const ev of events) {
    if (ev.type === 'ball') {
      audio.ballHit(ev.speed, panFromPoint(ev));
    } else if (ev.type === 'cushion') {
      audio.cushionHit(ev.speed, panFromPoint(ev));
    } else if (ev.type === 'pocket') {
      audio.pocket();
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // keyboard power charging
  if (state.chargeKey && state.mode === 'aim') {
    state.keyChargeT += dt;
    state.power = Math.min(1, state.keyChargeT / 1.1);
  }

  if (state.mode === 'shooting') {
    const events = world.advance(dt);
    handleEvents(events);
    world.updateSinking(dt);
    // safety net: never let a stuck ball freeze the game
    if (world.elapsed > 32) {
      for (const b of world.balls) {
        b.vx = b.vy = b.vz = 0;
        b.wx = b.wy = b.wz = 0;
      }
    }
    if (world.isSettled() && world.settleTime > 0.28) resolveShot();
  }

  syncBalls(dt);
  updateAimVisuals();
  updateCamera(dt);

  hudAccum += dt;
  if (hudAccum > 0.05) {
    hudAccum = 0;
    el('powerFill').style.width = `${Math.round(state.power * 100)}%`;
    el('powerPct').textContent = `${Math.round(state.power * 100)}%`;
  }

  if (state.mode === 'placing') {
    placeGhost.visible = true;
    if (!state.hasHover) placeGhost.position.set(HEAD_SPOT.x, BALL_RADIUS, HEAD_SPOT.z);
  } else {
    placeGhost.visible = false;
  }

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------

updateHUD();
animate();

// expose a little of the internals for debugging from the console
window.__pool = { world, game, state, scene, camera, renderer, resetGame, shoot, THREE, aimGroup, cueStick, ballMeshes };
