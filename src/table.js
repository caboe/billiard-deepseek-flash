/**
 * table.js — builds the room, the table, the balls and the cue as three.js
 * objects. Everything is generated in code; there are no model or image files.
 */
import * as THREE from 'three';
import {
  BALL_RADIUS,
  CORNER_MOUTH,
  CORNER_POCKET_R,
  HALF_L,
  HALF_W,
  POCKETS,
  SIDE_MOUTH,
  SIDE_POCKET_R,
} from './physics.js';
import {
  ballTexture,
  ballRoughness,
  clothBump,
  clothTexture,
  environmentTexture,
  floorTexture,
  woodTexture,
} from './textures.js';

// --- table proportions (metres) --------------------------------------------
export const CUSHION_DEPTH = 0.052;
export const CUSHION_TOP = 0.05;
export const CUSHION_NOSE = 0.0365;
export const RAIL_WIDTH = 0.145;
export const RAIL_TOP = 0.062;
export const CLOTH_MARGIN = 0.075;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function roundedRectShape(x0, z0, x1, z1) {
  const s = new THREE.Shape();
  s.moveTo(x0, z0);
  s.lineTo(x1, z0);
  s.lineTo(x1, z1);
  s.lineTo(x0, z1);
  s.closePath();
  return s;
}

/**
 * Flat shapes are built in XY and extruded along +Z, then rotated by -90° about
 * X so the local Y axis becomes world -Z and the extrusion becomes world +Y.
 * After the rotation the slab occupies world y in [0, depth], so yBottom is
 * exactly where the underside lands.
 */
function flatExtrude(shape, depth, yBottom) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 24,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, yBottom, 0);
  geo.computeVertexNormals();
  return geo;
}

/** A closed trapezoid profile for the cushion rubber. */
function cushionProfile() {
  const s = new THREE.Shape();
  s.moveTo(CUSHION_DEPTH, 0);
  s.lineTo(CUSHION_DEPTH, CUSHION_TOP);
  s.lineTo(0.016, CUSHION_TOP);
  s.lineTo(0, CUSHION_NOSE);
  s.lineTo(0.009, 0);
  s.closePath();
  return s;
}

function sweepContains(a0, a1, target, clockwise) {
  const TAU = Math.PI * 2;
  const norm = (a) => ((a % TAU) + TAU) % TAU;
  const s = norm(a0);
  const e = norm(a1);
  const t = norm(target);
  if (clockwise) return norm(s - t) <= norm(s - e) + 1e-9;
  return norm(t - s) <= norm(e - s) + 1e-9;
}

/**
 * The inner boundary of the wooden rail frame: the rectangle of the playing
 * area expanded by the cushion depth, with a circular notch wherever a pocket
 * cuts through the rail.
 *
 * It is built as ONE clockwise path rather than a rectangular hole plus six
 * circular holes, because three.js cannot triangulate holes that overlap each
 * other — the corner-pocket circles inevitably cross the rectangle.
 */
function railInnerHolePath() {
  const XL = HALF_L + CUSHION_DEPTH;
  const ZL = HALF_W + CUSHION_DEPTH;
  const P = 4 * XL + 4 * ZL;

  // clockwise arc-length parametrisation starting at the NW corner
  const sOf = (x, y) => {
    if (Math.abs(y - ZL) < 1e-6) return x + XL; // north edge
    if (Math.abs(x - XL) < 1e-6) return 2 * XL + (ZL - y); // east edge
    if (Math.abs(y + ZL) < 1e-6) return 2 * XL + 2 * ZL + (XL - x); // south edge
    return 4 * XL + 2 * ZL + (y + ZL); // west edge
  };
  const ptOf = (s) => {
    s = ((s % P) + P) % P;
    if (s <= 2 * XL) return { x: s - XL, y: ZL };
    if (s <= 2 * XL + 2 * ZL) return { x: XL, y: ZL - (s - 2 * XL) };
    if (s <= 4 * XL + 2 * ZL) return { x: XL - (s - 2 * XL - 2 * ZL), y: -ZL };
    return { x: -XL, y: -ZL + (s - 4 * XL - 2 * ZL) };
  };

  // start the walk in the middle of the east edge, where no pocket straddles
  const seam = sOf(XL, 0);
  const sPrime = (x, y) => (((sOf(x, y) - seam) % P) + P) % P;

  const features = [];
  for (const p of POCKETS) {
    const r = (p.kind === 'corner' ? CORNER_POCKET_R : SIDE_POCKET_R) * 1.06;
    const cx = p.x;
    const cy = p.z;
    const hits = [];
    for (const y of [ZL, -ZL]) {
      const dy = y - cy;
      if (Math.abs(dy) <= r) {
        const w = Math.sqrt(r * r - dy * dy);
        for (const x of [cx - w, cx + w]) {
          if (x >= -XL - 1e-9 && x <= XL + 1e-9) hits.push({ x, y });
        }
      }
    }
    for (const x of [XL, -XL]) {
      const dx = x - cx;
      if (Math.abs(dx) <= r) {
        const w = Math.sqrt(r * r - dx * dx);
        for (const y of [cy - w, cy + w]) {
          if (y >= -ZL - 1e-9 && y <= ZL + 1e-9) hits.push({ x, y });
        }
      }
    }
    if (hits.length !== 2) continue;
    const [h1, h2] = hits;
    const s1 = sPrime(h1.x, h1.y);
    const s2 = sPrime(h2.x, h2.y);
    features.push({
      entry: s1 < s2 ? h1 : h2,
      exit: s1 < s2 ? h2 : h1,
      cx,
      cy,
      r,
      s: Math.min(s1, s2),
    });
  }
  features.sort((a, b) => a.s - b.s);

  const path = new THREE.Path();
  const start = ptOf(seam);
  path.moveTo(start.x, start.y);
  for (const f of features) {
    path.lineTo(f.entry.x, f.entry.y);
    const a0 = Math.atan2(f.entry.y - f.cy, f.entry.x - f.cx);
    const a1 = Math.atan2(f.exit.y - f.cy, f.exit.x - f.cx);
    const outward = Math.atan2(f.cy, f.cx); // away from the table centre
    path.absarc(f.cx, f.cy, f.r, a0, a1, sweepContains(a0, a1, outward, true));
  }
  path.closePath();
  return path;
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

export function makeMaterials() {
  const clothMap = clothTexture('#1a6a48');
  clothMap.repeat.set(7, 4);
  const bump = clothBump();
  bump.repeat.set(70, 35);

  const cloth = new THREE.MeshStandardMaterial({
    map: clothMap,
    bumpMap: bump,
    bumpScale: 0.6,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
  });

  const cushionMap = clothTexture('#15573b');
  cushionMap.repeat.set(10, 1);
  const cushion = new THREE.MeshStandardMaterial({
    map: cushionMap,
    roughness: 0.85,
    metalness: 0,
  });

  const woodMap = woodTexture();
  woodMap.repeat.set(2.2, 1);
  const wood = new THREE.MeshStandardMaterial({
    map: woodMap,
    color: 0xffffff,
    roughness: 0.28,
    metalness: 0.05,
  });

  const woodDark = new THREE.MeshStandardMaterial({
    map: woodMap,
    color: 0x6a4a30,
    roughness: 0.5,
    metalness: 0.02,
  });

  const pocket = new THREE.MeshStandardMaterial({
    color: 0x07070a,
    roughness: 0.95,
    metalness: 0,
  });

  return { cloth, cushion, wood, woodDark, pocket };
}

// ---------------------------------------------------------------------------
// environment map for glossy ball reflections
// ---------------------------------------------------------------------------

export function setupEnvironment(renderer, scene) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const tex = environmentTexture();
  const env = pmrem.fromEquirectangular(tex).texture;
  scene.environment = env;
  tex.dispose();
  pmrem.dispose();
  return env;
}

// ---------------------------------------------------------------------------
// room + table
// ---------------------------------------------------------------------------

export function buildRoom(scene) {
  const floorMap = floorTexture();
  floorMap.repeat.set(14, 14);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.MeshStandardMaterial({ map: floorMap, roughness: 0.95, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.72;
  floor.receiveShadow = true;
  scene.add(floor);

  // soft glow under the table so the room does not read as a black void
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 48),
    new THREE.MeshBasicMaterial({
      color: 0x2a2018,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -0.715;
  scene.add(glow);

  return floor;
}

export function buildTable(scene) {
  const mats = makeMaterials();
  const group = new THREE.Group();
  scene.add(group);

  // ---- cloth bed with pocket holes ---------------------------------------
  const bedShape = roundedRectShape(
    -HALF_L - CLOTH_MARGIN,
    -HALF_W - CLOTH_MARGIN,
    HALF_L + CLOTH_MARGIN,
    HALF_W + CLOTH_MARGIN,
  );
  for (const p of POCKETS) {
    const hole = new THREE.Path();
    hole.absarc(p.x, p.z, p.r * 0.82, 0, Math.PI * 2, true);
    bedShape.holes.push(hole);
  }
  const bed = new THREE.Mesh(flatExtrude(bedShape, 0.06, -0.06), mats.cloth);
  bed.receiveShadow = true;
  bed.castShadow = false;
  group.add(bed);

  // ---- pocket wells -------------------------------------------------------
  for (const p of POCKETS) {
    const r = p.r * 0.82;
    const well = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r * 0.96, 0.34, 28, 1, true),
      mats.pocket,
    );
    well.position.set(p.x, -0.15, p.z);
    group.add(well);

    const bottom = new THREE.Mesh(new THREE.CircleGeometry(r * 0.94, 24), mats.pocket);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(p.x, -0.34, p.z);
    group.add(bottom);

    // a dark collar so the hole reads as a real pocket from a low camera
    const collar = new THREE.Mesh(
      new THREE.TorusGeometry(r * 1.02, 0.006, 8, 28),
      mats.pocket,
    );
    collar.rotation.x = -Math.PI / 2;
    collar.position.set(p.x, 0.001, p.z);
    group.add(collar);
  }

  // ---- cushions -----------------------------------------------------------
  const profile = cushionProfile();
  const longFrom = -HALF_L + CORNER_MOUTH;
  const longTo = HALF_L - CORNER_MOUTH;
  const sideGap = SIDE_MOUTH;
  const shortFrom = -HALF_W + CORNER_MOUTH;
  const shortTo = HALF_W - CORNER_MOUTH;

  /** Build one cushion segment: `axis` is the direction it runs along. */
  function addCushion(axis, sign, from, to) {
    const len = to - from;
    if (len <= 1e-4) return;
    const geo = new THREE.ExtrudeGeometry(profile, {
      depth: len,
      bevelEnabled: false,
      curveSegments: 1,
    });
    if (axis === 'x') {
      if (sign > 0) {
        geo.rotateY(-Math.PI / 2);
        geo.translate(to, 0, HALF_W);
      } else {
        geo.rotateY(Math.PI / 2);
        geo.translate(from, 0, -HALF_W);
      }
    } else {
      if (sign > 0) {
        geo.translate(HALF_L, 0, from);
      } else {
        geo.rotateY(Math.PI);
        geo.translate(-HALF_L, 0, to);
      }
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mats.cushion);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  for (const sign of [1, -1]) {
    // long rails, split by the side pocket
    addCushion('x', sign, longFrom, -sideGap);
    addCushion('x', sign, sideGap, longTo);
    // short rails
    addCushion('z', sign, shortFrom, shortTo);
  }

  // ---- wooden rail frame --------------------------------------------------
  const railShape = roundedRectShape(
    -HALF_L - RAIL_WIDTH,
    -HALF_W - RAIL_WIDTH,
    HALF_L + RAIL_WIDTH,
    HALF_W + RAIL_WIDTH,
  );
  railShape.holes.push(railInnerHolePath());
  const rail = new THREE.Mesh(flatExtrude(railShape, RAIL_TOP + 0.03, -0.03), mats.wood);
  rail.castShadow = true;
  rail.receiveShadow = true;
  group.add(rail);

  // ---- body / skirt -------------------------------------------------------
  // The body needs the pocket holes too, otherwise its top face shows as bare
  // wood when you look down into a pocket. The holes are a touch wider than the
  // well so the dark liner always wins the depth test.
  const bodyShape = roundedRectShape(
    -HALF_L - RAIL_WIDTH,
    -HALF_W - RAIL_WIDTH,
    HALF_L + RAIL_WIDTH,
    HALF_W + RAIL_WIDTH,
  );
  for (const p of POCKETS) {
    const hole = new THREE.Path();
    hole.absarc(p.x, p.z, p.r * 0.82 + 0.006, 0, Math.PI * 2, true);
    bodyShape.holes.push(hole);
  }
  const body = new THREE.Mesh(flatExtrude(bodyShape, 0.33, -0.36), mats.woodDark);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // legs
  const legGeo = new THREE.BoxGeometry(0.16, 0.42, 0.16);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, mats.woodDark);
      leg.position.set(
        sx * (HALF_L + RAIL_WIDTH - 0.1),
        -0.36 - 0.2,
        sz * (HALF_W + RAIL_WIDTH - 0.1),
      );
      leg.castShadow = true;
      group.add(leg);
    }
  }

  // ---- lamp shades over the table ----------------------------------------
  const shadeMat = new THREE.MeshStandardMaterial({
    color: 0x1b1b20,
    roughness: 0.5,
    metalness: 0.35,
    side: THREE.DoubleSide,
  });
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff2d8 });
  const lampPositions = [-0.85, 0, 0.85];
  for (const x of lampPositions) {
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.2, 32, 1, true), shadeMat);
    shade.position.set(x, 1.42, 0);
    shade.rotation.x = Math.PI;
    group.add(shade);

    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), bulbMat);
    bulb.position.set(x, 1.34, 0);
    group.add(bulb);

    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, 1.0, 8),
      shadeMat,
    );
    cord.position.set(x, 1.95, 0);
    group.add(cord);
  }

  return { group, materials: mats, lampPositions };
}

// ---------------------------------------------------------------------------
// lights
// ---------------------------------------------------------------------------

export function buildLights(scene, lampPositions = [-0.85, 0, 0.85]) {
  const hemi = new THREE.HemisphereLight(0x9fb4d8, 0x2a2018, 0.13);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff1dd, 1.0);
  key.position.set(1.6, 3.4, 1.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const cam = key.shadow.camera;
  cam.left = -1.85;
  cam.right = 1.85;
  cam.top = 1.3;
  cam.bottom = -1.3;
  cam.near = 0.5;
  cam.far = 7;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.022;
  key.shadow.radius = 2.2;
  scene.add(key);
  scene.add(key.target);
  key.target.position.set(0, 0, 0);

  const spots = [];
  for (const x of lampPositions) {
    const spot = new THREE.SpotLight(0xffe9c4, 7.0, 5.2, Math.PI / 3.1, 0.65, 2);
    spot.position.set(x, 1.33, 0);
    spot.target.position.set(x, 0, 0);
    scene.add(spot);
    scene.add(spot.target);
    spots.push(spot);
  }

  // a cool rim light from the far side keeps the balls from flattening out
  const rim = new THREE.DirectionalLight(0x9db6ff, 0.2);
  rim.position.set(-2.4, 1.6, -2.2);
  scene.add(rim);

  return { hemi, key, spots, rim };
}

// ---------------------------------------------------------------------------
// balls
// ---------------------------------------------------------------------------

export function buildBalls(world) {
  const geo = new THREE.SphereGeometry(BALL_RADIUS, 40, 28);
  const rough = ballRoughness();
  const meshes = new Map();

  for (const ball of world.balls) {
    const map = ballTexture(ball.id);
    const mat = new THREE.MeshPhysicalMaterial({
      map,
      roughness: 0.14,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.045,
      envMapIntensity: 1.15,
      roughnessMap: rough,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(ball.x, ball.y, ball.z);
    mesh.userData.ballId = ball.id;
    meshes.set(ball.id, mesh);
  }
  return meshes;
}

// ---------------------------------------------------------------------------
// cue stick
// ---------------------------------------------------------------------------

export function buildCue() {
  const group = new THREE.Group();
  const LENGTH = 1.42;

  const shaftMat = new THREE.MeshStandardMaterial({
    color: 0xd9b382,
    roughness: 0.32,
    metalness: 0.05,
  });
  const buttMat = new THREE.MeshStandardMaterial({
    color: 0x2b1a10,
    roughness: 0.28,
    metalness: 0.12,
  });
  const ferruleMat = new THREE.MeshStandardMaterial({
    color: 0xf4f1e8,
    roughness: 0.25,
  });
  const tipMat = new THREE.MeshStandardMaterial({ color: 0x2f6fb5, roughness: 0.55 });
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0xc9a227,
    roughness: 0.25,
    metalness: 0.8,
  });

  // built along +Y with the tip at the top
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0128, 1.18, 20), shaftMat);
  shaft.position.y = 0.62;
  group.add(shaft);

  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.0128, 0.0146, 0.34, 20), buttMat);
  butt.position.y = 0.14;
  group.add(butt);

  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.0132, 0.0132, 0.012, 20), ringMat);
  ring.position.y = 0.31;
  group.add(ring);

  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0062, 0.024, 20), ferruleMat);
  ferrule.position.y = 1.222;
  group.add(ferrule);

  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.0058, 0.0062, 0.014, 20), tipMat);
  tip.position.y = 1.241;
  group.add(tip);

  group.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  group.visible = false;
  group.userData.length = LENGTH;
  group.userData.tipY = 1.248;
  return group;
}
