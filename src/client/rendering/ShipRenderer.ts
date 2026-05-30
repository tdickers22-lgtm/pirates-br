import * as THREE from 'three';
import type { Player, Ship, ShipUpgradeType } from '../../shared/types/index.js';
import { SHIP, SHIP_STATS } from '../../shared/constants/index.js';
import { sampleWind, angleWrap, getShipBoardingLadderLocals, getMainMastLocalZ, getCrowNestStandingY, getSailStationLocal, getShipCompanionwayConfig } from '../../shared/utils/index.js';
import type { RenderQuality } from './Renderer.js';

const UPGRADE_PENNANT_COLORS: Record<ShipUpgradeType, number> = {
  hull_reinforcement: 0x67b9ff,
  charged_cannons: 0xff8459,
  swift_sails: 0xf6d360,
};

const CYLINDER_UP = new THREE.Vector3(0, 1, 0);

function woodTexture(w: number, h: number, dark = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const base = dark ? '#2E1A08' : '#5A3214';
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  const plankH = Math.floor(h / 7);
  for (let row = 0; row < 7; row++) {
    // Plank separator
    ctx.fillStyle = dark ? '#1A0D04' : '#3A1E0A';
    ctx.fillRect(0, row * plankH, w, 2);
    // Grain lines within plank
    ctx.strokeStyle = dark ? '#382012' : '#6A3C1C';
    ctx.lineWidth = 1;
    for (let i = 0; i < 10; i++) {
      const x = Math.random() * w;
      ctx.beginPath();
      ctx.moveTo(x, row * plankH + 3);
      ctx.lineTo(x + (Math.random() - 0.5) * 24, (row + 1) * plankH - 1);
      ctx.stroke();
    }
    // Knots
    if (Math.random() < 0.25) {
      const kx = Math.random() * w, ky = row * plankH + plankH * 0.5;
      ctx.fillStyle = dark ? '#2A1408' : '#4A2A10';
      ctx.beginPath();
      ctx.ellipse(kx, ky, 4, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return new THREE.CanvasTexture(canvas);
}

function sailTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#EEE0B8';
  ctx.fillRect(0, 0, 256, 256);
  // Worn patches
  ctx.fillStyle = '#D8C890';
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.arc(Math.random() * 256, Math.random() * 256, 15 + Math.random() * 28, 0, Math.PI * 2);
    ctx.fill();
  }
  // Horizontal stitch lines
  ctx.strokeStyle = '#B8A050';
  ctx.lineWidth = 1.5;
  for (let y = 28; y < 256; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y + (Math.random() - 0.5) * 4);
    ctx.lineTo(256, y + (Math.random() - 0.5) * 4);
    ctx.stroke();
  }
  return new THREE.CanvasTexture(canvas);
}

function makeHullGeometry(W: number, H: number, L: number): THREE.BufferGeometry {
  const stations = [
    { z: -L * 0.5, half: W * 0.30, chine: W * 0.26, deckY: H * 0.95, chineY: H * 0.36, keelY: H * 0.12 },
    { z: -L * 0.36, half: W * 0.50, chine: W * 0.45, deckY: H * 0.98, chineY: H * 0.3, keelY: H * 0.04 },
    { z: -L * 0.08, half: W * 0.56, chine: W * 0.50, deckY: H, chineY: H * 0.25, keelY: 0 },
    { z: L * 0.22, half: W * 0.48, chine: W * 0.42, deckY: H * 0.99, chineY: H * 0.28, keelY: H * 0.03 },
    { z: L * 0.42, half: W * 0.26, chine: W * 0.22, deckY: H * 1.04, chineY: H * 0.38, keelY: H * 0.1 },
    { z: L * 0.5, half: W * 0.055, chine: W * 0.045, deckY: H * 1.08, chineY: H * 0.5, keelY: H * 0.24 },
  ];
  const verts: number[] = [];
  const uvs: number[] = [];
  const addVertex = (x: number, y: number, z: number) => {
    verts.push(x, y, z);
    uvs.push((z / L) + 0.5, THREE.MathUtils.clamp(y / Math.max(H, 0.001), 0, 1));
  };

  for (const station of stations) {
    addVertex(-station.half, station.deckY, station.z);
    addVertex(station.half, station.deckY, station.z);
    addVertex(-station.chine, station.chineY, station.z);
    addVertex(station.chine, station.chineY, station.z);
    addVertex(0, station.keelY, station.z);
  }

  const faces: number[] = [];
  const v = (stationIndex: number, slot: number) => stationIndex * 5 + slot;
  const quad = (a: number, b: number, c: number, d: number) => {
    faces.push(a, b, c, b, d, c);
  };

  for (let i = 0; i < stations.length - 1; i++) {
    // The weather deck is built from separate slabs below. Do not cap the hull here,
    // or the companionway gets a hidden ceiling between the hold and upper deck.
    quad(v(i, 0), v(i + 1, 0), v(i, 2), v(i + 1, 2)); // port topside
    quad(v(i, 3), v(i + 1, 3), v(i, 1), v(i + 1, 1)); // starboard topside
    quad(v(i, 2), v(i + 1, 2), v(i, 4), v(i + 1, 4)); // port bilge
    quad(v(i, 4), v(i + 1, 4), v(i, 3), v(i + 1, 3)); // starboard bilge
  }

  const closeStation = (i: number, reverse: boolean) => {
    const cap = [
      [v(i, 0), v(i, 1), v(i, 2)],
      [v(i, 1), v(i, 3), v(i, 2)],
      [v(i, 2), v(i, 3), v(i, 4)],
    ];
    for (const tri of cap) {
      faces.push(...(reverse ? [tri[2], tri[1], tri[0]] : tri));
    }
  };
  closeStation(0, true);
  closeStation(stations.length - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(faces);
  geo.computeVertexNormals();
  return geo;
}

function makeStairRampGeometry(
  width: number,
  topY: number,
  bottomY: number,
  frontZ: number,
  backZ: number,
  thickness: number,
): THREE.BufferGeometry {
  const hw = width * 0.5;
  const verts = [
    -hw, topY, frontZ,
     hw, topY, frontZ,
    -hw, bottomY, backZ,
     hw, bottomY, backZ,
    -hw, topY - thickness, frontZ,
     hw, topY - thickness, frontZ,
    -hw, Math.max(0.12, bottomY - thickness), backZ,
     hw, Math.max(0.12, bottomY - thickness), backZ,
  ];
  const faces = [
    0, 1, 2, 1, 3, 2,
    4, 6, 5, 5, 6, 7,
    0, 4, 1, 1, 4, 5,
    2, 3, 6, 3, 7, 6,
    0, 2, 4, 2, 6, 4,
    1, 5, 3, 3, 5, 7,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(faces);
  geo.computeVertexNormals();
  return geo;
}

function makeBillowedSailGeometry(
  width: number,
  height: number,
  segmentsX = 8,
  segmentsY = 6,
  billowDepth = Math.min(width, height) * 0.08,
): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(width, height, segmentsX, segmentsY);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const halfW = width * 0.5;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const nx = Math.abs(x) / Math.max(halfW, 0.001);
    const ny = THREE.MathUtils.clamp((y + height * 0.5) / Math.max(height, 0.001), 0, 1);
    const centerFill = Math.max(0, 1 - nx * nx);
    const verticalFill = Math.sin(ny * Math.PI);
    pos.setZ(i, centerFill * verticalFill * billowDepth);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function makeWindowFrame(
  width: number,
  height: number,
  depth: number,
  bar: number,
  material: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const addBar = (x: number, y: number, w: number, h: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), material);
    mesh.position.set(x, y, 0);
    mesh.castShadow = true;
    g.add(mesh);
  };
  addBar(0, height * 0.5, width + bar * 2, bar);
  addBar(0, -height * 0.5, width + bar * 2, bar);
  addBar(-width * 0.5, 0, bar, height + bar * 2);
  addBar(width * 0.5, 0, bar, height + bar * 2);
  addBar(0, 0, bar * 0.62, height * 0.82);
  addBar(0, 0, width * 0.82, bar * 0.58);
  return g;
}

function makeCylinderBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  segments = 8,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(end, start);
  const length = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(length, 0.001), segments), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  if (length > 0.0001) {
    mesh.quaternion.setFromUnitVectors(CYLINDER_UP, dir.normalize());
  }
  mesh.castShadow = true;
  return mesh;
}

function makeBarrel(
  woodMat: THREE.Material,
  topColor: number,
): THREE.Group {
  const g = new THREE.Group();

  // Barrel body — rounded cylinder approximated with tapered ends
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.38, 0.38, 0.72, 10),
    woodMat,
  );
  body.castShadow = true;
  g.add(body);

  // Bulge rings (hoops)
  const hoopMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });
  for (const hy of [-0.22, 0, 0.22]) {
    const hoop = new THREE.Mesh(
      new THREE.TorusGeometry(0.4, 0.045, 6, 14),
      hoopMat,
    );
    hoop.rotation.x = Math.PI * 0.5;
    hoop.position.y = hy;
    hoop.castShadow = true;
    g.add(hoop);
  }

  // Top lid with colour indicating contents
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 0.06, 10),
    new THREE.MeshStandardMaterial({ color: topColor, roughness: 0.8 }),
  );
  lid.position.y = 0.39;
  lid.castShadow = true;
  g.add(lid);

  // Bottom cap
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 0.06, 10),
    woodMat,
  );
  cap.position.y = -0.39;
  g.add(cap);

  return g;
}

interface StairwellHole {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

function makeShipInterior(
  stats: { width: number; length: number; height: number },
  woodMat: THREE.Material,
  darkMat: THREE.Material,
  hole: StairwellHole,
): THREE.Group {
  const g = new THREE.Group();
  const W = stats.width, L = stats.length, H = stats.height;

  // Hold floor — warmer brown with a touch of wood grain so it reads as an actual
  // floor (not a flat dark tarp) when the player peers down through the stairwell.
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x4a2e15, roughness: 0.85 });
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(W * 0.88, 0.12, L * 0.88),
    floorMat,
  );
  floor.position.y = 0.35;
  floor.receiveShadow = true;
  g.add(floor);

  // Inner walls (port/starboard)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 1 });
  const wallH = H * 0.75;
  for (const sx of [-1, 1]) {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, wallH, L * 0.82),
      wallMat,
    );
    wall.position.set(sx * W * 0.42, wallH * 0.5 + 0.35, 0);
    g.add(wall);
  }

  // Bow/stern bulkheads so the hold reads as an enclosed room instead of an open box.
  const bulkheadW = W * 0.84;
  const bulkheadD = 0.14;
  const bowBulkhead = new THREE.Mesh(
    new THREE.BoxGeometry(bulkheadW, wallH, bulkheadD),
    wallMat,
  );
  bowBulkhead.position.set(0, wallH * 0.5 + 0.35, L * 0.39);
  g.add(bowBulkhead);

  const sternBulkhead = new THREE.Mesh(
    new THREE.BoxGeometry(bulkheadW, wallH, bulkheadD),
    wallMat,
  );
  sternBulkhead.position.set(0, wallH * 0.5 + 0.35, -L * 0.39);
  g.add(sternBulkhead);

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const cornerPost = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, wallH, 0.16),
        darkMat,
      );
      cornerPost.position.set(sx * W * 0.38, wallH * 0.5 + 0.35, sz * L * 0.39);
      cornerPost.castShadow = true;
      g.add(cornerPost);
    }
  }

  // Low angled bilge planks close the bottom corners that were visible from the hold.
  for (const sx of [-1, 1] as const) {
    const bilge = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, H * 0.34, L * 0.72),
      darkMat,
    );
    bilge.position.set(sx * W * 0.34, 0.52, 0);
    bilge.rotation.z = -sx * Math.PI * 0.12;
    g.add(bilge);
  }

  // Deck underside — 4 box slabs surrounding the stairwell so the hole is real
  // geometry (no fragile ShapeGeometry hole-punching). Looking up from the hold
  // through the stairwell now reveals the open sky / weather deck above.
  const ceilingY = H - 0.12;
  const cw = W * 0.44;
  const cln = L * 0.46;
  const cThickness = 0.08;
  const addCeilingSlab = (cx: number, cz: number, bw: number, bd: number) => {
    if (bw <= 0.05 || bd <= 0.05) return;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(bw, cThickness, bd),
      darkMat,
    );
    slab.position.set(cx, ceilingY, cz);
    slab.receiveShadow = true;
    g.add(slab);
  };
  const cHoleZMin = hole.cz - hole.halfZ;
  const cHoleZMax = hole.cz + hole.halfZ;
  const cHoleXMin = hole.cx - hole.halfX;
  const cHoleXMax = hole.cx + hole.halfX;
  // Stern slab (south of hole, full width)
  const cSternDepth = Math.max(0, cHoleZMin - (-cln));
  if (cSternDepth > 0) addCeilingSlab(0, -cln + cSternDepth * 0.5, cw * 2, cSternDepth);
  // Bow slab (north of hole, full width)
  const cBowDepth = Math.max(0, cln - cHoleZMax);
  if (cBowDepth > 0) addCeilingSlab(0, cHoleZMax + cBowDepth * 0.5, cw * 2, cBowDepth);
  // Port mid slab (west of hole, between hole's z bounds)
  const cMidDepth = Math.max(0, cHoleZMax - cHoleZMin);
  const cPortWidth = Math.max(0, cHoleXMin - (-cw));
  if (cPortWidth > 0 && cMidDepth > 0) addCeilingSlab(-cw + cPortWidth * 0.5, hole.cz, cPortWidth, cMidDepth);
  const cStarWidth = Math.max(0, cw - cHoleXMax);
  if (cStarWidth > 0 && cMidDepth > 0) addCeilingSlab(cHoleXMax + cStarWidth * 0.5, hole.cz, cStarWidth, cMidDepth);

  // Ribs break up the box silhouette and make the hull interior feel more ship-shaped.
  const ribCount = Math.max(4, Math.round(L / 5));
  for (let r = 0; r < ribCount; r++) {
    const rz = -L * 0.26 + r * (L * 0.52 / Math.max(ribCount - 1, 1));
    for (const sx of [-1, 1]) {
      const rib = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, wallH * 0.92, 0.12),
        darkMat,
      );
      rib.position.set(sx * W * 0.31, wallH * 0.5 + 0.38, rz);
      rib.rotation.z = sx * Math.PI * 0.1;
      g.add(rib);
    }
  }

  // Deck beams (visible from below) — skip the stairwell band so the companionway stays open above.
  const beamMat = darkMat;
  const beamCount = Math.max(2, Math.round(L * 0.1));
  for (let b = 0; b < beamCount; b++) {
    const bz = -L * 0.38 + b * (L * 0.76 / Math.max(beamCount - 1, 1));
    if (bz > hole.cz - hole.halfZ - 0.18 && bz < hole.cz + hole.halfZ + 0.18) continue;
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.86, 0.12, 0.18),
      beamMat,
    );
    beam.position.set(0, H - 0.25, bz);
    g.add(beam);
  }

  // Hammocks
  const hammockMat = new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 0.9, side: THREE.DoubleSide });
  const hammockCount = Math.max(2, Math.round(L / 8));
  for (let h = 0; h < hammockCount; h++) {
    const hz = L * 0.3 - h * (L * 0.6 / Math.max(hammockCount - 1, 1));
    const sx = h % 2 === 0 ? 1 : -1;
    const hammock = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 1.4),
      hammockMat,
    );
    hammock.position.set(sx * W * 0.28, H * 0.42, hz);
    hammock.rotation.set(Math.PI * 0.08, 0, Math.PI * 0.5);
    g.add(hammock);
  }

  // Crates along port/starboard bilge — keep the stairwell / centerline clear so nothing blocks the view down.
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a3818, roughness: 1, map: woodMat instanceof THREE.MeshStandardMaterial ? woodMat.map : null });
  const crateCount = Math.max(2, Math.round(L / 12));
  for (let c = 0; c < crateCount; c++) {
    const cz = -L * 0.2 - c * (L * 0.1);
    for (const sx of [-1, 1] as const) {
      const cGrp = new THREE.Group();
      cGrp.position.set(sx * W * 0.28, 0.35, cz);

      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 0.72), crateMat);
      crate.position.y = 0.31;
      crate.castShadow = true;
      cGrp.add(crate);

      const strapMat = new THREE.MeshStandardMaterial({ color: 0x1a1206, roughness: 0.6 });
      for (const sy of [0.12, 0.48]) {
        const strap = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.045, 0.055), strapMat);
        strap.position.set(0, sy, 0.37);
        cGrp.add(strap);
      }

      g.add(cGrp);
    }
  }

  // Lantern + actual point light so the hold is visibly illuminated when peering
  // through the stairwell. Without a real light, the dark brown floor reads as a
  // featureless "tarp".
  const holdLantern = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.28, 0.18),
    new THREE.MeshStandardMaterial({ color: 0xFFD66A, emissive: 0xFF8800, emissiveIntensity: 1.6 }),
  );
  holdLantern.position.set(0, H * 0.55, 0);
  g.add(holdLantern);

  const holdLight = new THREE.PointLight(0xFFB060, 1.4, Math.max(W, L) * 1.6, 1.4);
  holdLight.position.set(0, H * 0.55, 0);
  holdLight.visible = false;
  g.add(holdLight);

  // Brighten the hold floor so it doesn't look like a flat brown tarp from above.
  // Replace the original drab floorMat by tweaking the existing floor mesh's material.
  // (Done by creating a new lighter material; original mesh kept in scope above.)

  return g;
}

interface CannonMeshGroup {
  root: THREE.Group;
  yawPivot: THREE.Group;
  pitchPivot: THREE.Group;
}

interface ShipMeshGroup {
  root: THREE.Group;
  detailRoot: THREE.Group;
  proxyRoot: THREE.Group;
  proxySails: THREE.Mesh[];
  sails: THREE.Mesh[];
  furledSails: THREE.Mesh[];
  pennants: THREE.Mesh[];
  upgradePennants: Record<ShipUpgradeType, THREE.Mesh>;
  upgradeVisuals: Record<ShipUpgradeType, THREE.Object3D[]>;
  fireParticles: THREE.Points | null;
  damageMeshes: THREE.Mesh[];
  hullHoles: Record<'bow' | 'stern' | 'port' | 'starboard', THREE.Group>;
  cannonMeshes: CannonMeshGroup[];
  lanterns: THREE.PointLight[];
  wheel: THREE.Object3D;
  compassNeedle: THREE.Object3D;
  anchor: THREE.Group;
  anchorChain: THREE.Mesh;
  anchorCapstan: THREE.Group;
  wake: THREE.Mesh;
}

export class ShipRenderer {
  private shipMeshes: Map<string, ShipMeshGroup> = new Map();
  private scene!: THREE.Scene;
  private quality: RenderQuality = 'balanced';
  private woodTex!: THREE.CanvasTexture;
  private darkWoodTex!: THREE.CanvasTexture;
  private sailTex!: THREE.CanvasTexture;
  private readonly tempShipPos = new THREE.Vector3();
  private readonly tempCannonPos = new THREE.Vector3();
  private readonly cannonOperators = new Map<string, Player>();

  init(scene: THREE.Scene, quality: RenderQuality = 'balanced') {
    this.scene = scene;
    this.quality = quality;
    this.woodTex     = woodTexture(256, 128, false);
    this.darkWoodTex = woodTexture(256, 128, true);
    this.sailTex     = sailTexture();
  }

  clear() {
    for (const mesh of this.shipMeshes.values()) {
      this.scene.remove(mesh.root);
    }
    this.shipMeshes.clear();
  }

  private buildShipProxy(
    ship: Ship,
    stats: typeof SHIP_STATS[keyof typeof SHIP_STATS],
    proxySails: THREE.Mesh[],
  ) {
    const W = stats.width;
    const L = stats.length;
    const H = stats.height;
    const group = new THREE.Group();
    group.name = 'ship-proxy';

    const teamColor = new THREE.Color(ship.teamColor);
    const hullMat = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.9, metalness: 0 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x241407, roughness: 0.95 });
    const sailMat = new THREE.MeshStandardMaterial({ color: 0xeadfbf, roughness: 0.8, side: THREE.DoubleSide });

    const hull = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, H * 0.48, L * 0.86), hullMat);
    hull.position.y = H * 0.42;
    group.add(hull);

    const deck = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, H * 0.08, L * 0.72), darkMat);
    deck.position.y = H * 0.9;
    group.add(deck);

    const mastCount = stats.mastCount;
    const mastSpacing = L * 0.55 / Math.max(mastCount - 1, 1);
    const mastStartZ = L * 0.22;
    for (let m = 0; m < mastCount; m++) {
      const mastZ = mastStartZ - m * mastSpacing;
      const mastH = H * (mastCount === 1 ? 3.25 : 2.85);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, mastH, 5), darkMat);
      mast.position.set(0, H + mastH * 0.5, mastZ);
      group.add(mast);

      const sail = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.05, H * 1.02), sailMat);
      sail.position.set(0, H + mastH * 0.58, mastZ);
      sail.rotation.y = 0;
      group.add(sail);
      proxySails.push(sail);
    }

    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.48),
      new THREE.MeshStandardMaterial({
        color: ship.teamColor,
        emissive: ship.teamColor,
        emissiveIntensity: 0.12,
        side: THREE.DoubleSide,
        roughness: 0.85,
      }),
    );
    flag.position.set(0.38, H * 3.9, mastStartZ);
    group.add(flag);

    return group;
  }

  buildShip(ship: Ship): THREE.Group {
    const stats = SHIP_STATS[ship.type];
    const group = new THREE.Group();
    group.name = `ship_${ship.id}`;
    const proxySails: THREE.Mesh[] = [];

    const hullMat = new THREE.MeshStandardMaterial({
      map: this.woodTex,
      roughness: 0.9,
      metalness: 0.0,
      color: new THREE.Color(ship.teamColor),
      side: THREE.DoubleSide,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      map: this.darkWoodTex,
      roughness: 0.95,
      metalness: 0.0,
    });
    const deckMat = new THREE.MeshStandardMaterial({
      map: this.woodTex,
      roughness: 0.85,
      color: 0x8B6914,
    });
    const sailMat = new THREE.MeshStandardMaterial({
      map: this.sailTex,
      color: 0xf5edd2,
      roughness: 0.62,
      emissive: 0x221a08,
      emissiveIntensity: 0.04,
      side: THREE.DoubleSide,
    });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x484848, roughness: 0.45, metalness: 0.85 });
    const brassHardwareMat = new THREE.MeshStandardMaterial({ color: 0x9A6E28, roughness: 0.5, metalness: 0.8 });
    const ropeCoilMat = new THREE.MeshStandardMaterial({ color: 0x9a8050, roughness: 1 });
    const barrelWoodMat = new THREE.MeshStandardMaterial({ map: this.darkWoodTex, roughness: 0.95 });

    const W = stats.width, L = stats.length, H = stats.height;
    const upgradeVisuals: Record<ShipUpgradeType, THREE.Object3D[]> = {
      hull_reinforcement: [],
      charged_cannons: [],
      swift_sails: [],
    };

    // ── Hull ─────────────────────────────────────────────────
    const hullGeo = makeHullGeometry(W, H, L);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.castShadow = true;
    hull.receiveShadow = true;
    group.add(hull);

    const holeMat = new THREE.MeshStandardMaterial({
      color: 0x07080a,
      roughness: 1,
      metalness: 0,
      emissive: 0x06243a,
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide,
    });
    const addHole = (x: number, y: number, z: number, rotX: number, rotY: number) => {
      const hm = new THREE.Group();
      hm.position.set(x, y, z);
      hm.rotation.set(rotX, rotY, 0);
      hm.visible = false;
      const opening = new THREE.Mesh(new THREE.CircleGeometry(0.4, 16), holeMat);
      hm.add(opening);
      const rim = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.52, 16),
        new THREE.MeshStandardMaterial({ color: 0x20120a, roughness: 0.95, side: THREE.DoubleSide }),
      );
      hm.add(rim);
      group.add(hm);
      return hm;
    };
    const hullHoles = {
      bow: addHole(0, H * 0.42, L * 0.5 + 0.018, 0, 0),
      stern: addHole(0, H * 0.42, -L * 0.5 - 0.018, 0, Math.PI),
      port: addHole(-W * 0.5 - 0.018, H * 0.42, 0, 0, Math.PI / 2),
      starboard: addHole(W * 0.5 + 0.018, H * 0.42, 0, 0, -Math.PI / 2),
    };

    // Hull planking detail strips (port + starboard waterlines)
    for (const sx of [-1, 1]) {
      for (let strip = 0; strip < 3; strip++) {
        const stripMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.06, H * 0.055, L * 0.7),
          darkMat,
        );
        stripMesh.position.set(sx * (W * 0.485), H * (0.25 + strip * 0.21), -L * 0.04);
        stripMesh.rotation.z = -sx * 0.05;
        group.add(stripMesh);
      }
    }

    // Hull-reinforcement upgrade: actual bolted armor belts, ribs, and bow/stern plates.
    {
      const armor = new THREE.Group();
      armor.name = 'upgrade-hull-reinforcement';
      armor.visible = false;
      const armorMat = new THREE.MeshStandardMaterial({
        color: 0x6f7e86,
        roughness: 0.34,
        metalness: 0.78,
        emissive: 0x0b1f2e,
        emissiveIntensity: 0.08,
      });
      const darkArmorMat = new THREE.MeshStandardMaterial({
        color: 0x2d3940,
        roughness: 0.5,
        metalness: 0.85,
      });
      for (const sx of [-1, 1] as const) {
        const mainBelt = new THREE.Mesh(new THREE.BoxGeometry(0.095, H * 0.19, L * 0.73), armorMat);
        mainBelt.position.set(sx * (W * 0.535), H * 0.43, -L * 0.04);
        mainBelt.rotation.z = -sx * 0.045;
        mainBelt.castShadow = true;
        armor.add(mainBelt);

        const upperBelt = new THREE.Mesh(new THREE.BoxGeometry(0.075, H * 0.11, L * 0.62), darkArmorMat);
        upperBelt.position.set(sx * (W * 0.515), H * 0.68, -L * 0.02);
        upperBelt.rotation.z = -sx * 0.038;
        upperBelt.castShadow = true;
        armor.add(upperBelt);
      }
      for (const z of [-L * 0.34, -L * 0.08, L * 0.2, L * 0.39]) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(W * 1.04, H * 0.13, 0.07), darkArmorMat);
        rib.position.set(0, H * 0.52, z);
        rib.castShadow = true;
        armor.add(rib);
      }
      const bowPlate = new THREE.Mesh(new THREE.BoxGeometry(W * 0.48, H * 0.34, 0.08), armorMat);
      bowPlate.position.set(0, H * 0.52, L * 0.535);
      bowPlate.castShadow = true;
      armor.add(bowPlate);
      const sternPlate = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, H * 0.28, 0.08), armorMat);
      sternPlate.position.set(0, H * 0.52, -L * 0.565);
      sternPlate.castShadow = true;
      armor.add(sternPlate);

      const rivetGeo = new THREE.SphereGeometry(0.045, 6, 4);
      const rivets = new THREE.InstancedMesh(rivetGeo, darkArmorMat, 36);
      const matrix = new THREE.Matrix4();
      let index = 0;
      for (const sx of [-1, 1] as const) {
        for (let i = 0; i < 9; i++) {
          const z = -L * 0.36 + (i / 8) * L * 0.72;
          for (const y of [H * 0.36, H * 0.52]) {
            matrix.makeTranslation(sx * (W * 0.59), y, z);
            rivets.setMatrixAt(index++, matrix);
          }
        }
      }
      rivets.count = index;
      rivets.instanceMatrix.needsUpdate = true;
      rivets.castShadow = true;
      armor.add(rivets);
      group.add(armor);
      upgradeVisuals.hull_reinforcement.push(armor);
    }

    // Bow stem and bowsprit replace the old blocky wedge so the silhouette reads like a real pirate hull.
    const bowStem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.13, H * 0.92, 8), darkMat);
    bowStem.position.set(0, H * 0.68, L * 0.505);
    bowStem.rotation.x = -0.12;
    bowStem.castShadow = true;
    group.add(bowStem);

    const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, L * 0.33, 8), darkMat);
    bowsprit.rotation.x = Math.PI * 0.5;
    bowsprit.rotation.z = -0.04;
    bowsprit.position.set(0, H + 0.48, L * 0.61);
    bowsprit.castShadow = true;
    group.add(bowsprit);

    const figureheadMat = new THREE.MeshStandardMaterial({
      color: 0xc49235,
      roughness: 0.54,
      metalness: 0.45,
      emissive: 0x2a1500,
      emissiveIntensity: 0.08,
    });
    const figurehead = new THREE.Group();
    figurehead.position.set(0, H * 0.74, L * 0.555);
    const figureTorso = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.34, 8), figureheadMat);
    figureTorso.rotation.x = Math.PI;
    figureTorso.castShadow = true;
    figurehead.add(figureTorso);
    const figureHead = new THREE.Mesh(new THREE.SphereGeometry(0.105, 10, 8), figureheadMat);
    figureHead.position.y = 0.22;
    figureHead.castShadow = true;
    figurehead.add(figureHead);
    group.add(figurehead);

    const sternTransom = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.92, H * 0.78, 0.16),
      darkMat,
    );
    sternTransom.position.set(0, H * 0.56, -L * 0.51);
    sternTransom.castShadow = true;
    sternTransom.receiveShadow = true;
    group.add(sternTransom);

    const bowCap = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.34, H * 0.18, 0.12),
      hullMat,
    );
    bowCap.position.set(0, H * 0.78, L * 0.49);
    bowCap.castShadow = true;
    group.add(bowCap);

    // Keel
    const keel = new THREE.Mesh(new THREE.BoxGeometry(W * 0.25, H * 0.25, L * 0.95), darkMat);
    keel.position.y = 0;
    group.add(keel);

    // ── Stairwell hole (shared by the weather deck above and the interior ceiling below) ────────
    const halfDeckZ = L * 0.45;
    const companionway = getShipCompanionwayConfig(stats);
    const stairCenterX = companionway.cx;
    const voidHalfX = companionway.halfX;
    const voidHalfZ = companionway.halfZ;
    const holeCx = companionway.cx;
    const holeCz = companionway.cz;

    // ── Ship Interior (below deck) ────────────────────────────
    const interior = makeShipInterior(stats, deckMat, darkMat, {
      cx: holeCx,
      cz: holeCz,
      halfX: voidHalfX,
      halfZ: voidHalfZ,
    });
    group.add(interior);

    // ── Weather deck (split around stairwell — no hatch lids; open companionway like Sea of Thieves)

    // Weather deck: 4 box slabs around the stairwell so the hole is *real* geometry
    // (no fragile ShapeGeometry hole-punching). The bulwarks/rails added later hide
    // the rectangular outer edge.
    const deckTopY = H + 0.084;
    const addDeckSlab = (cx: number, cz: number, bw: number, bd: number) => {
      if (bw <= 0.05 || bd <= 0.05) return;
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.25, bw), 0.15, Math.max(0.25, bd)),
        deckMat,
      );
      slab.position.set(cx, deckTopY, cz);
      slab.receiveShadow = true;
      slab.castShadow = true;
      group.add(slab);
    };

    const zSternEdge = -halfDeckZ;
    const zBowEdge = halfDeckZ;
    const zHoleMin = holeCz - voidHalfZ;
    const zHoleMax = holeCz + voidHalfZ;
    const sternDepth = Math.max(0, zHoleMin - zSternEdge);
    if (sternDepth > 0) addDeckSlab(0, zSternEdge + sternDepth * 0.5, W * 0.95, sternDepth);
    const bowDepth = Math.max(0, zBowEdge - zHoleMax);
    if (bowDepth > 0) addDeckSlab(0, zHoleMax + bowDepth * 0.5, W * 0.95, bowDepth);

    const midDepth = Math.max(0, zHoleMax - zHoleMin);
    const xPortOuter = -W * 0.475;
    const xStarOuter = W * 0.475;
    const xHoleMin = holeCx - voidHalfX;
    const xHoleMax = holeCx + voidHalfX;
    const portMidW = Math.max(0, xHoleMin - xPortOuter);
    if (portMidW > 0 && midDepth > 0) addDeckSlab(xPortOuter + portMidW * 0.5, holeCz, portMidW, midDepth);
    const starMidW = Math.max(0, xStarOuter - xHoleMax);
    if (starMidW > 0 && midDepth > 0) addDeckSlab(xHoleMax + starMidW * 0.5, holeCz, starMidW, midDepth);

    // Trim coamings around the companionway (no hatch — just raised lip)
    const coamingMat = darkMat;
    for (const sx of [-1, 1] as const) {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, midDepth + 0.08), coamingMat);
      lip.position.set(holeCx + sx * (voidHalfX + 0.05), H + 0.08, holeCz);
      lip.castShadow = true;
      group.add(lip);
    }
    for (const sz of [-1, 1] as const) {
      const endLip = new THREE.Mesh(new THREE.BoxGeometry(voidHalfX * 2 + 0.24, 0.1, 0.12), coamingMat);
      endLip.position.set(holeCx, H + 0.07, holeCz + sz * (voidHalfZ + 0.05));
      endLip.castShadow = true;
      group.add(endLip);
    }

    // Stairwell down to the hold: a single solid run with broad treads, so there
    // is no floating plank gap or invisible divider between decks.
    const stairTopY = H + 0.03;
    const stairBottomY = 0.43;
    const stairFrontZ = companionway.stairFrontZ - Math.max(0.16, L * 0.012);
    const stairBackZ = companionway.stairBackZ;
    const stairWidth = companionway.stairHalfWidth * 2 - 0.18;
    const stairRun = Math.max(0.5, stairFrontZ - stairBackZ);
    const stairBody = new THREE.Mesh(
      makeStairRampGeometry(stairWidth, stairTopY, stairBottomY, stairFrontZ, stairBackZ, 0.22),
      deckMat,
    );
    stairBody.position.x = stairCenterX;
    stairBody.castShadow = true;
    stairBody.receiveShadow = true;
    group.add(stairBody);

    const stairStepCount = ship.type === 'sloop' ? 6 : ship.type === 'brigantine' ? 7 : 8;
    const treadDepth = Math.min(0.72, stairRun / stairStepCount * 0.82);
    for (let step = 0; step < stairStepCount; step++) {
      const stepMesh = new THREE.Mesh(
        new THREE.BoxGeometry(stairWidth, 0.09, treadDepth),
        deckMat,
      );
      const progress = step / Math.max(1, stairStepCount - 1);
      const y = stairTopY + (stairBottomY - stairTopY) * progress;
      const z = stairFrontZ + (stairBackZ - stairFrontZ) * progress;
      stepMesh.position.set(
        stairCenterX,
        y + 0.035,
        z,
      );
      stepMesh.castShadow = true;
      stepMesh.receiveShadow = true;
      group.add(stepMesh);
    }

    for (const sx of [-1, 1] as const) {
      const railX = stairCenterX + sx * (stairWidth * 0.5 + 0.13);
      const railStart = new THREE.Vector3(railX, stairTopY + 0.42, stairFrontZ - 0.06);
      const railEnd = new THREE.Vector3(railX, stairBottomY + 0.5, stairBackZ + 0.08);
      const handrail = makeCylinderBetween(railStart, railEnd, 0.036, darkMat, 8);
      group.add(handrail);
      for (let p = 0; p < 4; p++) {
        const progress = p / 3;
        const z = THREE.MathUtils.lerp(stairFrontZ - 0.08, stairBackZ + 0.08, progress);
        const baseY = THREE.MathUtils.lerp(stairTopY - 0.01, stairBottomY + 0.03, progress);
        const topY = THREE.MathUtils.lerp(railStart.y, railEnd.y, progress);
        const post = makeCylinderBetween(
          new THREE.Vector3(railX, baseY, z),
          new THREE.Vector3(railX, topY, z),
          0.027,
          darkMat,
          7,
        );
        group.add(post);
      }
    }

    // ── Railings ─────────────────────────────────────────────
    const railH = 0.58, railThick = 0.07;
    const addRail = (x: number, z: number, rw: number, rl: number) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(rw, railH, rl), darkMat);
      r.position.set(x, H + railH * 0.5, z);
      group.add(r);
    };
    addRail( W * 0.5 - railThick, 0, railThick * 2, L * 0.82);
    addRail(-W * 0.5 + railThick, 0, railThick * 2, L * 0.82);
    addRail(0, -L * 0.41, W * 0.95, railThick * 2);

    // Bulwarks keep the upper deck feeling like a proper enclosed ship instead of an open raft.
    const bulwarkH = 0.34;
    for (const sx of [-1, 1]) {
      const bulwark = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, bulwarkH, L * 0.78),
        deckMat,
      );
      bulwark.position.set(sx * (W * 0.44), H + bulwarkH * 0.5, 0);
      bulwark.castShadow = true;
      bulwark.receiveShadow = true;
      group.add(bulwark);
    }
    const bowBreastwork = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.72, bulwarkH, 0.16),
      deckMat,
    );
    bowBreastwork.position.set(0, H + bulwarkH * 0.5, L * 0.36);
    group.add(bowBreastwork);
    for (const sx of [-1, 1]) {
      const quarterBulwark = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, bulwarkH, L * 0.18),
        deckMat,
      );
      quarterBulwark.position.set(sx * (W * 0.33), H + bulwarkH * 0.5, -L * 0.31);
      group.add(quarterBulwark);
    }

    for (const sx of [-1, 1] as const) {
      const capRail = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.1, L * 0.86),
        darkMat,
      );
      capRail.position.set(sx * W * 0.48, H + bulwarkH + 0.05, 0);
      capRail.castShadow = true;
      group.add(capRail);
    }
    const sternCapRail = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.1, 0.22), darkMat);
    sternCapRail.position.set(0, H + bulwarkH + 0.05, -L * 0.42);
    sternCapRail.castShadow = true;
    group.add(sternCapRail);

    // Railing stanchions
    const stanchionCount = Math.max(4, Math.round(L / 3));
    for (let s = 0; s < stanchionCount; s++) {
      const sz = L * 0.41 - s * (L * 0.82 / stanchionCount);
      for (const sx of [-1, 1]) {
        const stanchion = new THREE.Mesh(
          new THREE.CylinderGeometry(0.045, 0.045, railH, 6),
          darkMat,
        );
        stanchion.position.set(sx * (W * 0.5 - railThick), H + railH * 0.5, sz);
        group.add(stanchion);
      }
    }

    // Boarding ladders on both sides
    const ladderTop = H + 0.42;
    const ladderBottom = 0.35;
    const ladderHeight = ladderTop - ladderBottom;
    const ladderRopeMat = ropeCoilMat;
    const ladderRungMat = darkMat;
    for (const ladder of getShipBoardingLadderLocals(ship.type)) {
      for (const ropeOffset of [-0.14, 0.14]) {
        const rope = new THREE.Mesh(
          new THREE.CylinderGeometry(0.018, 0.018, ladderHeight, 6),
          ladderRopeMat,
        );
        rope.position.set(ladder.x, ladderBottom + ladderHeight * 0.5, ladder.z + ropeOffset);
        group.add(rope);
      }
      for (let rung = 0; rung < 6; rung++) {
        const rungY = ladderBottom + 0.2 + rung * (ladderHeight - 0.4) / 5;
        const rungMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.022, 0.34, 6),
          ladderRungMat,
        );
        rungMesh.rotation.x = Math.PI * 0.5;
        rungMesh.position.set(ladder.x, rungY, ladder.z);
        group.add(rungMesh);
      }
    }

    // ── Stern castle ─────────────────────────────────────────
    const sternW = W * 0.88, sternH = H * 0.28, sternL = L * 0.22;
    const stern = new THREE.Mesh(new THREE.BoxGeometry(sternW, sternH, sternL), darkMat);
    stern.position.set(0, H + sternH * 0.5, -L * 0.37);
    stern.castShadow = true;
    group.add(stern);

    // Stern windows. Keep the glass on the aft face, with separate bars instead of
    // one solid brass rectangle covering the pane.
    const windowMat = new THREE.MeshStandardMaterial({
      color: 0x8fc7d8,
      roughness: 0.08,
      metalness: 0.15,
      emissive: 0x24465a,
      emissiveIntensity: 0.18,
      transparent: true,
      opacity: 0.78,
    });
    const windowCount = Math.max(2, Math.round(W / 2.5));
    const sternFaceZ = -L * 0.51 - 0.085;
    for (let w = 0; w < windowCount; w++) {
      const wx = -sternW * 0.35 + w * (sternW * 0.7 / Math.max(windowCount - 1, 1));
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.05), windowMat);
      win.position.set(wx, H + sternH * 0.55, sternFaceZ - 0.012);
      group.add(win);
      const winFrame = makeWindowFrame(0.5, 0.35, 0.055, 0.045, brassHardwareMat);
      winFrame.position.set(wx, H + sternH * 0.55, sternFaceZ - 0.04);
      group.add(winFrame);
    }

    const galleryRailY = H + sternH * 0.24;
    const galleryRail = new THREE.Group();
    galleryRail.position.set(0, galleryRailY, sternFaceZ - 0.16);
    const galleryTop = new THREE.Mesh(new THREE.BoxGeometry(sternW * 0.72, 0.06, 0.07), brassHardwareMat);
    galleryTop.position.y = 0.28;
    galleryRail.add(galleryTop);
    for (let p = 0; p < windowCount + 1; p++) {
      const px = -sternW * 0.36 + p * (sternW * 0.72 / windowCount);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.36, 6), brassHardwareMat);
      post.position.set(px, 0.1, 0);
      post.castShadow = true;
      galleryRail.add(post);
    }
    group.add(galleryRail);

    // Helm wheel
    const wheelPost = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 1.06, 8), darkMat);
    wheelPost.position.set(0, H + 0.56, -L * 0.315);
    wheelPost.castShadow = true;
    group.add(wheelPost);

    const wheelGroup = new THREE.Group();
    wheelGroup.position.set(0, H + 1.16, -L * 0.315);
    group.add(wheelGroup);

    const wheelBase = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.13, 8), metalMat);
    wheelBase.rotation.x = Math.PI * 0.5;
    wheelBase.castShadow = true;
    wheelGroup.add(wheelBase);

    const wheelRim = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.055, 8, 18), metalMat);
    wheelRim.castShadow = true;
    wheelGroup.add(wheelRim);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.2, 8), metalMat);
    hub.rotation.x = Math.PI * 0.5;
    hub.castShadow = true;
    wheelGroup.add(hub);

    for (let spoke = 0; spoke < 8; spoke++) {
      const spokeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.58, 0.042), darkMat);
      spokeMesh.rotation.z = (spoke / 8) * Math.PI * 2;
      wheelGroup.add(spokeMesh);

      // Handle pegs on alternating spokes
      if (spoke % 2 === 0) {
        const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 6), darkMat);
        peg.rotation.x = Math.PI * 0.5;
        peg.position.set(Math.cos((spoke / 8) * Math.PI * 2) * 0.36, Math.sin((spoke / 8) * Math.PI * 2) * 0.36, 0.06);
        wheelGroup.add(peg);
      }
    }

    // Compass binnacle next to helm, close enough to read while steering.
    const compassX = W * 0.19;
    const compassZ = -L * 0.318;
    const binnacle = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.72, 10), darkMat);
    binnacle.position.set(compassX, H + 0.48, compassZ);
    binnacle.castShadow = true;
    group.add(binnacle);
    const compassTop = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.08, 18), brassHardwareMat);
    compassTop.position.set(compassX, H + 0.87, compassZ);
    group.add(compassTop);
    const compassFace = new THREE.Mesh(
      new THREE.CircleGeometry(0.225, 24),
      new THREE.MeshStandardMaterial({ color: 0xf4e0ad, roughness: 0.72, metalness: 0.05, side: THREE.DoubleSide }),
    );
    compassFace.rotation.x = -Math.PI * 0.5;
    compassFace.position.set(compassX, H + 0.916, compassZ);
    group.add(compassFace);
    const compassNeedle = new THREE.Group();
    compassNeedle.position.set(compassX, H + 0.928, compassZ);
    const northNeedle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.018, 0.29), new THREE.MeshStandardMaterial({ color: 0xc52f24, roughness: 0.5 }));
    northNeedle.position.z = 0.072;
    const southNeedle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.016, 0.22), new THREE.MeshStandardMaterial({ color: 0x253044, roughness: 0.5 }));
    southNeedle.position.z = -0.055;
    compassNeedle.add(northNeedle, southNeedle);
    group.add(compassNeedle);
    for (let tick = 0; tick < 8; tick++) {
      const mark = new THREE.Mesh(
        new THREE.BoxGeometry(tick % 2 === 0 ? 0.018 : 0.012, 0.012, tick % 2 === 0 ? 0.07 : 0.045),
        new THREE.MeshStandardMaterial({ color: tick === 0 ? 0xb7241f : 0x263147, roughness: 0.6 }),
      );
      const angle = (tick / 8) * Math.PI * 2;
      mark.position.set(compassX + Math.sin(angle) * 0.16, H + 0.932, compassZ + Math.cos(angle) * 0.16);
      mark.rotation.y = angle;
      group.add(mark);
    }

    // Bow anchor capstan: a clear manual wheel station for dropping / raising anchor.
    const anchorCapstan = new THREE.Group();
    anchorCapstan.position.set(0, H + 0.1, L * 0.42);
    const capstanPost = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 0.78, 12), darkMat);
    capstanPost.position.y = 0.39;
    capstanPost.castShadow = true;
    anchorCapstan.add(capstanPost);
    const capstanBand = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.12, 12), brassHardwareMat);
    capstanBand.position.y = 0.66;
    capstanBand.castShadow = true;
    anchorCapstan.add(capstanBand);
    const capstanWheel = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.055, 8, 30), brassHardwareMat);
    capstanWheel.rotation.x = Math.PI * 0.5;
    capstanWheel.position.y = 0.88;
    capstanWheel.castShadow = true;
    anchorCapstan.add(capstanWheel);
    for (let spoke = 0; spoke < 8; spoke++) {
      const angle = (spoke / 8) * Math.PI * 2;
      const handle = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.075, 0.095), darkMat);
      handle.position.y = 0.88;
      handle.rotation.y = angle;
      handle.castShadow = true;
      anchorCapstan.add(handle);
      for (const sign of [-1, 1]) {
        const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 8), brassHardwareMat);
        knob.position.set(Math.cos(angle) * sign * 0.72, 0.88, -Math.sin(angle) * sign * 0.72);
        knob.rotation.z = Math.PI * 0.5;
        knob.castShadow = true;
        anchorCapstan.add(knob);
      }
    }

    const anchorChain = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 2.15, 6),
      metalMat,
    );
    anchorChain.position.set(0, -0.78, 0.36);
    anchorChain.castShadow = true;
    anchorCapstan.add(anchorChain);

    group.add(anchorCapstan);

    const anchor = new THREE.Group();
    const buildAnchor = (side: -1 | 1) => {
      const g = new THREE.Group();
      const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 1.65, 6), metalMat);
      shank.castShadow = true;
      g.add(shank);

      const stock = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.92, 6), metalMat);
      stock.rotation.z = Math.PI * 0.5;
      stock.position.y = 0.58;
      g.add(stock);

      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 6, 12), metalMat);
      ring.position.y = 0.88;
      ring.rotation.x = Math.PI * 0.5;
      g.add(ring);

      for (const armSide of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.84, 6), metalMat);
        arm.position.set(armSide * 0.18, -0.32, 0);
        arm.rotation.z = armSide * Math.PI * 0.36;
        g.add(arm);

        const fluke = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 6), metalMat);
        fluke.position.set(armSide * 0.34, -0.73, 0);
        fluke.rotation.z = armSide * Math.PI * 0.14 - Math.PI * 0.18;
        g.add(fluke);
      }

      g.position.set(side * (W * 0.46), 0, L * 0.44);
      g.rotation.z = side * Math.PI * 0.33;
      g.rotation.y = side * Math.PI * 0.06;
      return g;
    };
    anchor.add(buildAnchor(-1));
    anchor.add(buildAnchor(1));
    anchor.position.y = H + 0.34;
    group.add(anchor);

    // Rope coil near anchor
    const ropeCoil = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.065, 6, 12), ropeCoilMat);
    ropeCoil.rotation.x = Math.PI * 0.5;
    ropeCoil.position.set(-0.24, H + 0.08, L * 0.38);
    group.add(ropeCoil);

    // ── Masts ────────────────────────────────────────────────
    const sails: THREE.Mesh[] = [];
    const furledSails: THREE.Mesh[] = [];
    const pennants: THREE.Mesh[] = [];
    const mastCount = stats.mastCount;
    const mastSpacing = L * 0.55 / Math.max(mastCount - 1, 1);
    const mastStartZ = L * 0.22;

    for (let m = 0; m < mastCount; m++) {
      const mastZ = mastStartZ - m * mastSpacing;
      const mastH = H * (mastCount === 1 ? 3.6 : 3.1);
      const mastR = 0.075 + (ship.type === 'galleon' ? 0.045 : ship.type === 'brigantine' ? 0.025 : 0);

      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(mastR * 0.8, mastR * 1.4, mastH, 8),
        darkMat,
      );
      mast.position.set(0, H + mastH * 0.5, mastZ);
      mast.castShadow = true;
      group.add(mast);

      // Mast top cap
      const mastCap = new THREE.Mesh(new THREE.CylinderGeometry(mastR * 1.5, mastR * 1.2, 0.2, 8), darkMat);
      mastCap.position.set(0, H + mastH, mastZ);
      group.add(mastCap);

      const pennant = new THREE.Mesh(
        new THREE.PlaneGeometry(1.15 - m * 0.12, 0.26),
        new THREE.MeshStandardMaterial({
          color: m === 0 ? ship.teamColor : 0xe8d8aa,
          emissive: m === 0 ? ship.teamColor : 0x000000,
          emissiveIntensity: m === 0 ? 0.18 : 0,
          roughness: 0.9,
          metalness: 0,
          side: THREE.DoubleSide,
        }),
      );
      pennant.position.set(0, H + mastH - 0.35, mastZ);
      group.add(pennant);
      pennants.push(pennant);

      // Crow's nest on main/top mast
      if (m === 0 && mastH > 6) {
        const nestY = H + mastH * 0.72;
        const nestFloor = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.5, 0.14, 8), darkMat);
        nestFloor.position.set(0, nestY, mastZ);
        group.add(nestFloor);
        const nestRail = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.05, 6, 12), darkMat);
        nestRail.rotation.x = Math.PI * 0.5;
        nestRail.position.set(0, nestY + 0.45, mastZ);
        group.add(nestRail);
      }

      // Boom / yardarm
      const yardW = W * (1.2 - m * 0.1);
      const yard = new THREE.Mesh(
        new THREE.CylinderGeometry(0.042, 0.042, yardW, 6),
        darkMat,
      );
      yard.rotation.z = Math.PI * 0.5;
      yard.position.set(0, H + mastH * 0.82, mastZ);
      group.add(yard);

      // Rigging lines from yardarm to deck
      const rigMat = new THREE.LineBasicMaterial({ color: 0x6a5030 });
      for (const sx of [-1, 1]) {
        const rigPoints = [
          new THREE.Vector3(sx * yardW * 0.48, H + mastH * 0.82, mastZ),
          new THREE.Vector3(sx * W * 0.44, H + 0.15, mastZ - L * 0.04),
        ];
        const rigGeo = new THREE.BufferGeometry().setFromPoints(rigPoints);
        group.add(new THREE.Line(rigGeo, rigMat));
      }

      const ratlineMat = new THREE.LineBasicMaterial({ color: 0x4b3520 });
      const addRigLine = (a: THREE.Vector3, b: THREE.Vector3) => {
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), ratlineMat));
      };
      for (const sx of [-1, 1] as const) {
        const topA = new THREE.Vector3(sx * mastR * 1.8, H + mastH * 0.78, mastZ - L * 0.025);
        const topB = new THREE.Vector3(sx * mastR * 1.8, H + mastH * 0.72, mastZ + L * 0.025);
        const baseA = new THREE.Vector3(sx * W * 0.43, H + 0.42, mastZ - L * 0.09);
        const baseB = new THREE.Vector3(sx * W * 0.43, H + 0.42, mastZ + L * 0.08);
        addRigLine(topA, baseA);
        addRigLine(topB, baseB);
        const rungCount = 6;
        for (let rung = 1; rung < rungCount; rung++) {
          const tRung = rung / rungCount;
          addRigLine(
            new THREE.Vector3().lerpVectors(topA, baseA, tRung),
            new THREE.Vector3().lerpVectors(topB, baseB, tRung),
          );
        }
      }

      // Square-rigged sail — hangs from the yardarm. PlaneGeometry's default frame is
      // exactly what we want: width along X (matches yardarm direction), height along Y
      // (drops toward deck), normal along +Z (faces forward when "square" to wind).
      // The sail trim animation rotates around Y by `ship.sailAngle`.
      const sailGeo = makeBillowedSailGeometry(yardW * 0.92, mastH * 0.72, 10, 7);
      const sail = new THREE.Mesh(sailGeo, sailMat.clone());
      sail.rotation.order = 'YXZ';
      sail.rotation.y = 0;
      sail.position.set(0, H + mastH * 0.55, mastZ);
      sail.userData.hoistTopY = H + mastH * 0.82;
      sail.userData.hoistHeight = mastH * 0.72;
      sail.userData.hoistCentered = true;
      sail.userData.sailKind = 'square';
      sail.castShadow = false;
      sail.receiveShadow = false;
      this.addSwiftSailTrim(sail, yardW * 0.92, mastH * 0.72, upgradeVisuals.swift_sails);
      group.add(sail);
      sails.push(sail);

      const furled = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.1, yardW * 0.86, 9),
        sailMat.clone(),
      );
      furled.rotation.z = Math.PI * 0.5;
      furled.position.set(0, H + mastH * 0.79, mastZ - 0.03);
      furled.scale.y = 1;
      furled.castShadow = true;
      group.add(furled);
      furledSails.push(furled);
    }

    // Crow's nest ladder — vertical rails hug the main mast pole (x=0), not offset toward the rail edge
    {
      const mainMastZ = getMainMastLocalZ(stats);
      const mastR = 0.075 + (ship.type === 'galleon' ? 0.045 : ship.type === 'brigantine' ? 0.025 : 0);
      const nestY = getCrowNestStandingY(stats);
      const ladderBottom = H + 0.2;
      const ladderTop = nestY + 0.02;
      const ladderH = Math.max(0.4, ladderTop - ladderBottom);
      const railMat = new THREE.MeshStandardMaterial({ map: this.darkWoodTex, roughness: 0.95 });
      const railW = 0.07;
      const mastOuter = mastR * 1.35 + 0.012;
      const railCenterX = mastOuter + railW * 0.5 + 0.018;
      for (const side of [-1, 1] as const) {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(railW, ladderH + 0.12, 0.075),
          railMat,
        );
        rail.position.set(side * railCenterX, ladderBottom + ladderH * 0.5, mainMastZ + side * 0.015);
        rail.rotation.y = side * 0.06;
        rail.castShadow = true;
        group.add(rail);
      }
      const rungCount = 8;
      const rungSpan = railCenterX * 2 + railW * 0.45;
      for (let r = 0; r <= rungCount; r++) {
        const ry = ladderBottom + (r / rungCount) * ladderH;
        const rung = new THREE.Mesh(
          new THREE.BoxGeometry(rungSpan, 0.05, 0.088),
          deckMat,
        );
        rung.position.set(0, ry, mainMastZ);
        rung.castShadow = true;
        group.add(rung);
      }
    }

    // Shared centerline sail ring, separated from side cannon click zones and anchor capstan.
    {
      const markerMat = new THREE.MeshStandardMaterial({ color: 0x3d2814, roughness: 1, side: THREE.DoubleSide });
      const brassMat = new THREE.MeshStandardMaterial({ color: 0xa8792a, roughness: 0.55, metalness: 0.55 });
      const sailRing = getSailStationLocal(stats);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.82, 32), markerMat);
      ring.rotation.x = -Math.PI * 0.5;
      ring.position.set(sailRing.x, H + 0.08, sailRing.z);
      ring.receiveShadow = true;
      group.add(ring);
      const ringCore = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 0.038, 16),
        new THREE.MeshStandardMaterial({ color: 0x78a9cf, roughness: 0.68 }),
      );
      ringCore.position.set(sailRing.x, H + 0.115, sailRing.z);
      group.add(ringCore);

      const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.12, 0.16), brassMat);
      cleat.position.set(sailRing.x - 0.34, H + 0.22, sailRing.z);
      cleat.castShadow = true;
      group.add(cleat);
      for (const sx of [-0.28, 0.28]) {
        const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 8), brassMat);
        horn.rotation.z = Math.PI * 0.5;
        horn.position.set(sailRing.x - 0.34 + sx, H + 0.31, sailRing.z);
        group.add(horn);
      }

      const trimWheel = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.038, 8, 20), brassMat);
      trimWheel.rotation.x = Math.PI * 0.5;
      trimWheel.position.set(sailRing.x + 0.38, H + 0.35, sailRing.z);
      trimWheel.castShadow = true;
      group.add(trimWheel);
      const trimPost = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.42, 8), darkMat);
      trimPost.position.set(sailRing.x + 0.38, H + 0.2, sailRing.z);
      trimPost.castShadow = true;
      group.add(trimPost);
    }

    // Forward jib tied to the bowsprit; this gives the bow a proper pirate-ship profile from side view.
    const jibShape = new THREE.Shape();
    jibShape.moveTo(0, 0);
    jibShape.lineTo(L * 0.24, H * 0.34);
    jibShape.lineTo(0.02, H * 1.18);
    jibShape.lineTo(0, 0);
    const jib = new THREE.Mesh(new THREE.ShapeGeometry(jibShape), sailMat.clone());
    jib.rotation.order = 'YXZ';
    // Jib is a stay-sail running on the centerline (YZ plane), so its plane normal
    // points sideways. It does NOT trim with the yardarm sails — fixed yaw.
    jib.rotation.y = Math.PI * 0.5;
    jib.position.set(0, H + 0.68, L * 0.56);
    jib.userData.hoistTopY = H + 0.68 + H * 1.18;
    jib.userData.hoistHeight = H * 1.18;
    jib.userData.hoistCentered = false;
    jib.userData.sailKind = 'stay';
    jib.userData.fixedYaw = Math.PI * 0.5;
    jib.castShadow = false;
    jib.receiveShadow = false;
    this.addSwiftSailTrim(jib, L * 0.24, H * 1.18, upgradeVisuals.swift_sails, true);
    group.add(jib);
    sails.push(jib);
    const furledJib = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, L * 0.22, 8), sailMat.clone());
    furledJib.rotation.x = Math.PI * 0.5;
    furledJib.rotation.z = -0.18;
    furledJib.position.set(0, H + 1.02, L * 0.66);
    furledJib.castShadow = true;
    group.add(furledJib);
    furledSails.push(furledJib);

    // Fore-stay rigging (bowsprit to foremast)
    const stayMat = new THREE.LineBasicMaterial({ color: 0x6a5030 });
    const foreMastZ = mastStartZ;
    const stayPoints = [
      new THREE.Vector3(0, H + H * 2.15, foreMastZ),
      new THREE.Vector3(0, H + 0.55, L * 0.76),
    ];
    const stayGeo = new THREE.BufferGeometry().setFromPoints(stayPoints);
    group.add(new THREE.Line(stayGeo, stayMat));
    for (const sx of [-1, 1] as const) {
      const bowLine = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(sx * W * 0.18, H + 0.52, L * 0.74),
        new THREE.Vector3(0, H + H * 1.95, foreMastZ),
      ]);
      group.add(new THREE.Line(bowLine, stayMat));
    }

    // ── Cannons ──────────────────────────────────────────────
    const cannonGroups: CannonMeshGroup[] = [];
    const cannonCount = stats.cannonCount;
    const cannonsPerSide = cannonCount / 2;
    const cannonSpacing = L * 0.5 / Math.max(cannonsPerSide - 1, 1);

    // Bigger, more visibly detailed cannons. Material highlights:
    // - Dark iron barrel with three brass reinforcing bands
    // - Brass muzzle bell at the front so the gun reads clearly even from far
    // - Beefier oak carriage with iron-banded wheels and trunnion caps
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb48335, roughness: 0.45, metalness: 0.7 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.55, metalness: 0.55 });
    const oakMat = new THREE.MeshStandardMaterial({ color: 0x4f3520, roughness: 0.95 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x261810, roughness: 0.95 });
    const ironBandMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.5, metalness: 0.7 });
    void darkMat; void metalMat;
    const barrelLen = 1.5;
    const barrelR = 0.18;
    for (let side = 0; side < 2; side++) {
      const sideX = (side === 0 ? 1 : -1) * (W * 0.5 + 0.06);
      for (let c = 0; c < cannonsPerSide; c++) {
        const cz = L * 0.2 - c * cannonSpacing;
        const cg = new THREE.Group();
        const yawPivot = new THREE.Group();
        const pitchPivot = new THREE.Group();
        cg.add(yawPivot);
        yawPivot.add(pitchPivot);
        pitchPivot.position.set(0, 0.18, 0);

        // Main barrel — taper from breech (back) to muzzle (front)
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 0.95, barrelR * 1.2, barrelLen, 14),
          ironMat,
        );
        barrel.rotation.z = Math.PI * 0.5;
        barrel.position.x = barrelLen * 0.5 - 0.1;
        barrel.castShadow = true;
        pitchPivot.add(barrel);

        // Brass reinforcing bands at three positions along the barrel
        for (const offset of [0.05, 0.55, 0.95] as const) {
          const band = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 1.2, barrelR * 1.25, 0.08, 14),
            brassMat,
          );
          band.rotation.z = Math.PI * 0.5;
          band.position.x = -0.1 + offset * barrelLen;
          pitchPivot.add(band);
        }

        // Brass muzzle bell — flared at the front so the gun reads clearly
        const muzzle = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 1.45, barrelR * 1.0, 0.18, 14),
          brassMat,
        );
        muzzle.rotation.z = Math.PI * 0.5;
        muzzle.position.x = barrelLen - 0.1 + 0.06;
        muzzle.castShadow = true;
        pitchPivot.add(muzzle);

        // Dark muzzle bore (interior)
        const bore = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 0.65, barrelR * 0.65, 0.06, 12),
          new THREE.MeshBasicMaterial({ color: 0x040404 }),
        );
        bore.rotation.z = Math.PI * 0.5;
        bore.position.x = barrelLen - 0.1 + 0.13;
        pitchPivot.add(bore);

        const chargeGroup = new THREE.Group();
        chargeGroup.name = 'upgrade-charged-cannon';
        chargeGroup.visible = false;
        const chargedMetalMat = new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.charged_cannons,
          emissive: 0xff3200,
          emissiveIntensity: 1.15,
          roughness: 0.3,
          metalness: 0.62,
        });
        const chargedGlowMat = new THREE.MeshBasicMaterial({
          color: 0xff6c22,
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        for (const offset of [0.26, 0.7, 1.05] as const) {
          const chargeBand = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 1.34, barrelR * 1.38, 0.035, 14),
            chargedMetalMat,
          );
          chargeBand.rotation.z = Math.PI * 0.5;
          chargeBand.position.x = -0.1 + offset * barrelLen;
          chargeGroup.add(chargeBand);
        }
        const muzzleGlow = new THREE.Mesh(
          new THREE.SphereGeometry(barrelR * 0.72, 10, 8),
          chargedGlowMat,
        );
        muzzleGlow.position.x = barrelLen - 0.1 + 0.2;
        muzzleGlow.scale.set(1.35, 0.72, 0.72);
        chargeGroup.add(muzzleGlow);
        pitchPivot.add(chargeGroup);
        upgradeVisuals.charged_cannons.push(chargeGroup);

        // Cascabel (round knob at the back of the breech)
        const cascabel = new THREE.Mesh(
          new THREE.SphereGeometry(barrelR * 0.6, 10, 8),
          ironMat,
        );
        cascabel.position.x = -0.18;
        pitchPivot.add(cascabel);

        // Touch hole on top of the breech
        const touchHole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8),
          ironMat,
        );
        touchHole.position.set(0.06, barrelR * 1.0, 0);
        pitchPivot.add(touchHole);

        // Trunnion caps (the bumps that let the barrel pivot)
        for (const sz of [-1, 1] as const) {
          const trunnion = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 0.45, barrelR * 0.45, 0.16, 10),
            ironMat,
          );
          trunnion.rotation.x = Math.PI * 0.5;
          trunnion.position.set(0.42, 0, sz * (barrelR * 1.25));
          pitchPivot.add(trunnion);
        }

        // Cannon mount (wheeled oak carriage)
        const mount = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, 0.32, 0.55),
          oakMat,
        );
        mount.position.set(0.18, 0.0, 0);
        mount.castShadow = true;
        cg.add(mount);

        // Diagonal step planks on the carriage cheeks
        for (const sz of [-1, 1] as const) {
          const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 0.06), oakMat);
          cheek.position.set(0.18, 0.05, sz * 0.305);
          cheek.castShadow = true;
          cg.add(cheek);
        }

        // Carriage wheels — slightly larger
        for (const wz of [-0.27, 0.27] as const) {
          for (const wx of [-0.18, 0.42] as const) {
            const wheel = new THREE.Mesh(
              new THREE.CylinderGeometry(0.18, 0.18, 0.08, 12),
              wheelMat,
            );
            wheel.rotation.x = Math.PI * 0.5;
            wheel.position.set(wx, -0.18, wz);
            wheel.castShadow = true;
            cg.add(wheel);
            // Iron rim
            const rim = new THREE.Mesh(
              new THREE.TorusGeometry(0.18, 0.022, 6, 16),
              ironBandMat,
            );
            rim.rotation.x = Math.PI * 0.5;
            rim.position.set(wx, -0.18, wz);
            cg.add(rim);
          }
        }

        // Lashing rope on the back of the carriage (visual flair)
        const lashing = new THREE.Mesh(
          new THREE.TorusGeometry(0.1, 0.025, 6, 12),
          new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 }),
        );
        lashing.rotation.y = Math.PI * 0.5;
        lashing.position.set(-0.16, 0.05, 0);
        cg.add(lashing);

        const sideSign = side === 0 ? 1 : -1;
        // Bigger gunport so the barrel reads through the hull
        const gunportFrame = new THREE.Mesh(
          new THREE.BoxGeometry(0.09, 0.7, 0.85),
          oakMat,
        );
        gunportFrame.position.set(sideSign * (W * 0.505), H * 0.58, cz);
        gunportFrame.castShadow = true;
        group.add(gunportFrame);
        const gunportOpening = new THREE.Mesh(
          new THREE.BoxGeometry(0.095, 0.46, 0.62),
          holeMat,
        );
        gunportOpening.position.set(sideSign * (W * 0.515), H * 0.59, cz);
        gunportOpening.castShadow = false;
        group.add(gunportOpening);
        // Hinged gunport door, flapped open
        const gunportDoor = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.46, 0.62), oakMat);
        gunportDoor.position.set(sideSign * (W * 0.55), H * 0.86, cz);
        gunportDoor.rotation.z = sideSign * 0.5;
        gunportDoor.castShadow = true;
        group.add(gunportDoor);

        cg.position.set(sideX, H + 0.18, cz);
        cg.rotation.y = side === 0 ? 0 : Math.PI;
        group.add(cg);
        cannonGroups.push({ root: cg, yawPivot, pitchPivot });
      }
    }

    // ── Barrels on Deck ──────────────────────────────────────
    const barrelConfigs: Array<{ x: number; z: number; color: number; label: string }> = [];

    // Barrel cluster near stern (water/supplies)
    barrelConfigs.push({ x: -W * 0.28, z: -L * 0.28, color: 0x3a6ab0, label: 'water' });
    barrelConfigs.push({ x: -W * 0.28, z: -L * 0.38, color: 0x3a6ab0, label: 'water' });

    // Cannon ordnance — port quarter, away from mast / rigging ring
    barrelConfigs.push({ x: -W * 0.38, z: -L * 0.26, color: 0x282828, label: 'powder' });
    if (cannonCount >= 4) {
      barrelConfigs.push({ x: -W * 0.38, z: -L * 0.36, color: 0x282828, label: 'powder' });
    }
    barrelConfigs.push({ x: -W * 0.3, z: -L * 0.2, color: 0x3a3530, label: 'chain' });

    // Food/banana barrel (gold lid) — forward port, clear of mast
    barrelConfigs.push({ x: -W * 0.32, z: L * 0.18, color: 0xc8a030, label: 'food' });

    // Rum barrel (dark brown lid)
    if (ship.type !== 'sloop') {
      barrelConfigs.push({ x: -W * 0.34, z: -L * 0.32, color: 0x6a2808, label: 'rum' });
    }

    for (const bc of barrelConfigs) {
      const barrel = makeBarrel(barrelWoodMat, bc.color);
      barrel.position.set(bc.x, H + 0.36, bc.z);
      barrel.rotation.y = Math.random() * Math.PI * 2;
      group.add(barrel);
    }

    // Stacked shot (port quarter with ordnance — not over the main deck / companionway)
    const ballMat = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.9 });
    const ballPositions = [
      [0, 0], [0.28, 0], [-0.28, 0], [0.14, 0.24], [-0.14, 0.24],
    ];
    const shotRackX = -W * 0.42;
    const shotRackZ = -L * 0.34;
    for (const [bx, by] of ballPositions) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), ballMat);
      ball.position.set(shotRackX + bx * 0.06, H + 0.14 + by, shotRackZ);
      ball.castShadow = true;
      group.add(ball);
    }

    // Rope coil near stern
    const sternRope = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.055, 6, 10), ropeCoilMat);
    sternRope.rotation.x = Math.PI * 0.5;
    sternRope.position.set(W * 0.3, H + 0.08, -L * 0.26);
    group.add(sternRope);

    // ── Lanterns ─────────────────────────────────────────────
    const lanterns: THREE.PointLight[] = [];
    const lanternPositions = [
      { x: 0, y: H + 0.85, z: -L * 0.44 },
    ];
    for (const lp of lanternPositions) {
      const light = new THREE.PointLight(0xFFAA44, 0.9, 18);
      light.position.set(lp.x, lp.y, lp.z);
      light.visible = this.quality === 'high';
      group.add(light);
      lanterns.push(light);

      // Lantern housing
      const lanternGeo = new THREE.BoxGeometry(0.22, 0.32, 0.22);
      const lanternMesh = new THREE.Mesh(
        lanternGeo,
        new THREE.MeshStandardMaterial({ color: 0xFFCC66, emissive: 0xFFAA00, emissiveIntensity: 1.6 }),
      );
      lanternMesh.position.set(lp.x, lp.y, lp.z);
      group.add(lanternMesh);

      // Lantern hook chain
      const chain = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6),
        metalMat,
      );
      chain.position.set(lp.x, lp.y + 0.28, lp.z);
      group.add(chain);
    }

    // ── Flag ─────────────────────────────────────────────────
    const flagGeo = new THREE.PlaneGeometry(0.85, 0.52);
    const flagMat = new THREE.MeshStandardMaterial({
      color: ship.teamColor,
      emissive: ship.teamColor,
      emissiveIntensity: 0.08,
      side: THREE.DoubleSide,
      roughness: 0.8,
    });
    const flag = new THREE.Mesh(flagGeo, flagMat);
    const topMast = H + SHIP_STATS[ship.type].height * 3;
    flag.position.set(0.42, topMast, mastStartZ);
    group.add(flag);

    // Skull and crossbones on flag (very small detail meshes)
    const skullMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, side: THREE.DoubleSide });
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), skullMat);
    skull.position.set(0.44, topMast + 0.04, mastStartZ);
    group.add(skull);
    for (const boneAngle of [-0.62, 0.62]) {
      const bone = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.035), skullMat);
      bone.position.set(0.44, topMast - 0.07, mastStartZ + 0.002);
      bone.rotation.z = boneAngle;
      group.add(bone);
      for (const end of [-1, 1] as const) {
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), skullMat);
        knob.position.set(
          0.44 + Math.cos(boneAngle) * end * 0.17,
          topMast - 0.07 + Math.sin(boneAngle) * end * 0.17,
          mastStartZ + 0.004,
        );
        group.add(knob);
      }
    }

    const upgradePennants = {
      hull_reinforcement: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.hull_reinforcement,
          emissive: UPGRADE_PENNANT_COLORS.hull_reinforcement,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
      charged_cannons: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.charged_cannons,
          emissive: UPGRADE_PENNANT_COLORS.charged_cannons,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
      swift_sails: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.swift_sails,
          emissive: UPGRADE_PENNANT_COLORS.swift_sails,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
    } satisfies Record<ShipUpgradeType, THREE.Mesh>;
    const upgradePennantEntries = [
      { type: 'hull_reinforcement' as const, x: 0.34, y: topMast - 0.72, z: mastStartZ + 0.12 },
      { type: 'charged_cannons' as const, x: 0.34, y: topMast - 0.98, z: mastStartZ + 0.02 },
      { type: 'swift_sails' as const, x: 0.34, y: topMast - 1.24, z: mastStartZ - 0.08 },
    ];
    for (const { type, x, y, z } of upgradePennantEntries) {
      const pennant = upgradePennants[type];
      pennant.position.set(x, y, z);
      pennant.visible = false;
      group.add(pennant);
    }

    // ── Wake foam ─────────────────────────────────────────────
    const wake = this.createWakeMesh(W, L);
    group.add(wake);

    const detailRoot = new THREE.Group();
    detailRoot.name = 'ship-detail-root';
    while (group.children.length > 0) {
      detailRoot.add(group.children[0]);
    }
    group.add(detailRoot);

    const proxyRoot = this.buildShipProxy(ship, stats, proxySails);
    proxyRoot.visible = false;
    group.add(proxyRoot);

    group.position.set(ship.position.x, ship.position.y, ship.position.z);
    group.rotation.y = ship.rotation;
    this.scene.add(group);

    this.shipMeshes.set(ship.id, {
      root: group,
      detailRoot,
      proxyRoot,
      proxySails,
      sails,
      furledSails,
      pennants,
      upgradePennants,
      upgradeVisuals,
      fireParticles: null,
      damageMeshes: [],
      hullHoles,
      cannonMeshes: cannonGroups,
      lanterns,
      wheel: wheelGroup,
      compassNeedle,
      anchor,
      anchorChain,
      anchorCapstan,
      wake,
    });

    return group;
  }

  private addSwiftSailTrim(
    sail: THREE.Mesh,
    width: number,
    height: number,
    targets: THREE.Object3D[],
    staySail = false,
  ) {
    const trimGroup = new THREE.Group();
    trimGroup.name = 'upgrade-swift-sail-trim';
    trimGroup.visible = false;
    const trimMat = new THREE.MeshBasicMaterial({
      color: 0xf9d85b,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0x56b7ff,
      transparent: true,
      opacity: 0.68,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const addStripe = (
      w: number,
      h: number,
      x: number,
      y: number,
      rotZ = 0,
      material: THREE.Material = trimMat,
    ) => {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
      stripe.position.set(x, y, 0.035);
      stripe.rotation.z = rotZ;
      stripe.renderOrder = 4;
      trimGroup.add(stripe);
    };

    if (staySail) {
      addStripe(width * 0.11, height * 0.78, width * 0.44, height * 0.48, -0.42);
      addStripe(width * 0.08, height * 0.62, width * 0.7, height * 0.42, -0.42, edgeMat);
    } else {
      addStripe(width * 0.055, height * 0.96, -width * 0.43, 0, 0, edgeMat);
      addStripe(width * 0.055, height * 0.96, width * 0.43, 0, 0, edgeMat);
      addStripe(width * 0.78, height * 0.06, 0, height * 0.43);
      addStripe(width * 0.065, height * 0.92, -width * 0.08, 0, 0.42);
      addStripe(width * 0.065, height * 0.92, width * 0.08, 0, -0.42);
    }

    sail.add(trimGroup);
    targets.push(trimGroup);
  }

  private updateUpgradeVisuals(mesh: ShipMeshGroup, activeUpgrades: Set<ShipUpgradeType>) {
    for (const [type, visuals] of Object.entries(mesh.upgradeVisuals) as Array<[ShipUpgradeType, THREE.Object3D[]]>) {
      const active = activeUpgrades.has(type);
      for (const visual of visuals) visual.visible = active;
    }

    const swift = activeUpgrades.has('swift_sails');
    for (const sail of mesh.sails) this.setSailUpgradeMaterial(sail, swift, false);
    for (const sail of mesh.furledSails) this.setSailUpgradeMaterial(sail, swift, true);
    for (const sail of mesh.proxySails) this.setSailUpgradeMaterial(sail, swift, false);
  }

  private setSailUpgradeMaterial(sail: THREE.Mesh, swift: boolean, furled: boolean) {
    const material = sail.material;
    if (!(material instanceof THREE.MeshStandardMaterial)) return;
    material.color.set(swift ? (furled ? 0xd8b954 : 0xffefb2) : 0xf5edd2);
    material.emissive.set(swift ? 0x4c3300 : 0x221a08);
    material.emissiveIntensity = swift ? (furled ? 0.14 : 0.1) : 0.04;
    material.roughness = swift ? 0.48 : 0.62;
  }

  update(ships: Ship[], players: Player[], t: number, dt = 1 / 60, snapshotAge = 0, cameraPosition?: THREE.Vector3, localPlayerId?: string) {
    const wind = sampleWind(t);
    const positionAlpha = 1 - Math.exp(-18 * dt);
    const rotationAlpha = 1 - Math.exp(-20 * dt);
    const cannonOperators = this.cannonOperators;
    cannonOperators.clear();
    for (const player of players) {
      if (!player.atCannon || !player.onShipId) continue;
      const key = `${player.onShipId}:${player.cannonIndex}`;
      cannonOperators.set(key, player);
    }

    for (const ship of ships) {
      let mesh = this.shipMeshes.get(ship.id);
      if (!mesh) {
        this.buildShip(ship);
        mesh = this.shipMeshes.get(ship.id)!;
      }

      if (!ship.alive) {
        mesh.root.visible = false;
        mesh.detailRoot.visible = false;
        mesh.proxyRoot.visible = false;
        continue;
      }

      mesh.root.visible = true;
      const activeUpgrades = new Set(ship.upgrades.map(upgrade => upgrade.type));
      this.updateUpgradeVisuals(mesh, activeUpgrades);
      const detailDistance = this.quality === 'low' ? 170 : this.quality === 'balanced' ? 285 : 380;
      const distSq = cameraPosition
        ? (ship.position.x - cameraPosition.x) ** 2 + (ship.position.z - cameraPosition.z) ** 2
        : 0;
      const localCrewShip = !!localPlayerId && ship.crewIds.includes(localPlayerId);
      const detailNear = !cameraPosition || localCrewShip || distSq < detailDistance * detailDistance;
      mesh.detailRoot.visible = detailNear;
      mesh.proxyRoot.visible = !detailNear;
      const extrapolation = Math.min(0.14, snapshotAge + dt * 0.5);
      this.tempShipPos.set(
        ship.position.x + ship.velocity.x * extrapolation,
        ship.position.y,
        ship.position.z + ship.velocity.z * extrapolation,
      );
      if (mesh.root.position.distanceToSquared(this.tempShipPos) > 75 * 75) {
        mesh.root.position.copy(this.tempShipPos);
      } else {
        mesh.root.position.lerp(this.tempShipPos, positionAlpha);
      }
      const targetRotation = ship.rotation + ship.angularVelocity * extrapolation;
      mesh.root.rotation.y += angleWrap(targetRotation - mesh.root.rotation.y) * rotationAlpha;
      for (const sail of mesh.proxySails) {
        sail.visible = !detailNear && ship.sailHeight > 0.06;
        sail.rotation.y = THREE.MathUtils.lerp(sail.rotation.y, ship.sailAngle * 0.6, 1 - Math.exp(-8 * dt));
        sail.scale.y = THREE.MathUtils.lerp(sail.scale.y, Math.max(0.18, ship.sailHeight), 1 - Math.exp(-8 * dt));
      }
      if (!detailNear) {
        const visualSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
        const motionPhase = t * 0.9 + ship.id.charCodeAt(0) * 0.37;
        const wavePitch = Math.sin(motionPhase) * 0.012 + Math.sin(t * 0.47 + ship.position.x * 0.006) * 0.007;
        const steerRoll = THREE.MathUtils.clamp(-ship.angularVelocity * 0.09, -0.05, 0.05);
        const sailLean = THREE.MathUtils.clamp(ship.sailHeight * 0.014 + visualSpeed * 0.0015, 0, 0.035);
        const rollTarget = Math.sin(motionPhase * 1.18 + ship.position.z * 0.004) * (0.01 + sailLean) + steerRoll;
        if (ship.sinking) {
          mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch * 0.5, 1 - Math.exp(-4 * dt));
          mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, ship.sinkProgress * Math.PI * 0.36, 1 - Math.exp(-6 * dt));
          mesh.root.position.y = THREE.MathUtils.lerp(mesh.root.position.y, ship.position.y - ship.sinkProgress * 4.5, 1 - Math.exp(-9 * dt));
        } else {
          mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch, 1 - Math.exp(-3 * dt));
          mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, rollTarget, 1 - Math.exp(-3 * dt));
        }
        continue;
      }
      mesh.wheel.rotation.z -= ship.angularVelocity * 0.22;
      mesh.compassNeedle.rotation.y = -mesh.root.rotation.y;

      const anchorRaiseProgress = THREE.MathUtils.clamp(ship.anchorRaiseProgress ?? 0, 0, 1);
      const anchorDrop = ship.anchored ? 1 - anchorRaiseProgress : 0;
      if (ship.anchored && anchorRaiseProgress > 0) {
        mesh.anchorCapstan.rotation.y += dt * (3.6 + anchorRaiseProgress * 4.8);
      } else {
        mesh.anchorCapstan.rotation.y += dt * 0.08;
      }
      const anchorAlpha = 1 - Math.exp(-10 * dt);
      mesh.anchor.position.y = THREE.MathUtils.lerp(
        mesh.anchor.position.y,
        SHIP_STATS[ship.type].height + 0.34 - anchorDrop * 2.75,
        anchorAlpha,
      );
      mesh.anchor.rotation.z = THREE.MathUtils.lerp(mesh.anchor.rotation.z, ship.anchored ? 0.1 * anchorDrop : 0, anchorAlpha);
      // Chain hangs from windlass drum (child of windlass); only length changes
      mesh.anchorChain.scale.y = THREE.MathUtils.lerp(mesh.anchorChain.scale.y, ship.anchored ? 0.52 + anchorDrop * 0.76 : 0.52, anchorAlpha);

      const visualSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
      const motionPhase = t * 0.9 + ship.id.charCodeAt(0) * 0.37;
      const wavePitch = Math.sin(motionPhase) * 0.014 + Math.sin(t * 0.47 + ship.position.x * 0.006) * 0.009;
      const steerRoll = THREE.MathUtils.clamp(-ship.angularVelocity * 0.12, -0.07, 0.07);
      const sailLean = THREE.MathUtils.clamp(ship.sailHeight * 0.018 + visualSpeed * 0.002, 0, 0.045);
      const rollTarget = Math.sin(motionPhase * 1.18 + ship.position.z * 0.004) * (0.012 + sailLean) + steerRoll;

      // Sinking tilt
      if (ship.sinking) {
        mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch * 0.6, 1 - Math.exp(-5 * dt));
        mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, ship.sinkProgress * Math.PI * 0.42, 1 - Math.exp(-8 * dt));
        mesh.root.position.y = THREE.MathUtils.lerp(mesh.root.position.y, ship.position.y - ship.sinkProgress * 5, 1 - Math.exp(-11 * dt));
      } else {
        mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch, 1 - Math.exp(-3.8 * dt));
        mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, rollTarget, 1 - Math.exp(-3.4 * dt));
      }

      // Sail state — keep canvas mostly vertical so it stays visible; tear is subtle
      const rawInt = ship.sailIntegrity ?? 1;
      const sailIntegrity = Number.isFinite(rawInt) ? Math.max(0, Math.min(1, rawInt)) : 1;
      const chainshotted = Date.now() / 1000 < ship.chainshottedUntil;
      const tornPitch = (1 - sailIntegrity) * 0.52 + (chainshotted ? 0.12 : 0);
      const sailAlpha = 1 - Math.exp(-11 * dt);
      for (const sail of mesh.sails) {
        sail.visible = ship.sailHeight > 0.05;
        const signedRelative = angleWrap(wind.direction - ship.rotation);
        const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.95;
        const trimCatch = 1 - Math.min(1, Math.abs(angleWrap(ship.sailAngle - desiredTrim)) / SHIP.MAX_SAIL_ANGLE);
        // Jibs and other stay-sails have a fixed yaw (centerline of the ship).
        // Square sails on yardarms rotate with `ship.sailAngle`.
        const fixedYaw = sail.userData.fixedYaw;
        const targetSailYaw = typeof fixedYaw === 'number' ? fixedYaw : ship.sailAngle;
        const targetSailPitch = tornPitch * (0.55 + 0.15 * Math.sin(t * 0.9 + sail.position.z * 0.2));
        const deployedHeight = Math.max(0.06, ship.sailHeight * Math.max(0.22, sailIntegrity));
        const hoistTopY = typeof sail.userData.hoistTopY === 'number' ? sail.userData.hoistTopY : sail.position.y;
        const hoistHeight = typeof sail.userData.hoistHeight === 'number' ? sail.userData.hoistHeight : 1;
        const hoistCentered = sail.userData.hoistCentered !== false;
        const targetSailY = hoistTopY - hoistHeight * deployedHeight * (hoistCentered ? 0.5 : 1);
        sail.rotation.y += angleWrap(targetSailYaw - sail.rotation.y) * sailAlpha;
        sail.rotation.x = THREE.MathUtils.lerp(sail.rotation.x, targetSailPitch, sailAlpha);
        sail.position.y = THREE.MathUtils.lerp(sail.position.y, targetSailY, sailAlpha);
        sail.scale.y = THREE.MathUtils.lerp(sail.scale.y, deployedHeight, sailAlpha);
        // Billow puffs the sail outward along its normal — that's the +Z axis in its
        // own local frame (set up at construction). scale.z grows the billow depth.
        const billow = Math.sin(t * 1.2 + sail.position.z * 0.3) * (0.12 + trimCatch * 0.2) * ship.sailHeight * sailIntegrity;
        sail.scale.z = THREE.MathUtils.lerp(sail.scale.z, 1 + billow, sailAlpha);
      }
      for (const furled of mesh.furledSails) {
        furled.visible = ship.sailHeight <= 0.12;
        furled.scale.setScalar(0.88 + Math.sin(t * 0.9 + furled.position.z) * 0.015);
      }

      const localWind = angleWrap(wind.direction - ship.rotation);
      for (const pennant of mesh.pennants) {
        pennant.rotation.y = Math.PI * 0.5 + localWind;
        pennant.rotation.z = Math.sin(t * 8 + pennant.position.z * 0.14) * 0.12;
        pennant.scale.x = 1.05 + wind.strength * 0.65 + Math.min(0.4, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.03);
      }
      for (const [type, pennant] of Object.entries(mesh.upgradePennants) as Array<[ShipUpgradeType, THREE.Mesh]>) {
        pennant.visible = activeUpgrades.has(type);
        if (!pennant.visible) continue;
        pennant.rotation.y = Math.PI * 0.5 + localWind;
        pennant.rotation.z = Math.sin(t * 9.5 + pennant.position.y * 0.3) * 0.18;
        pennant.scale.x = 1.1 + wind.strength * 0.55 + Math.min(0.35, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.025);
      }

      const cannonsPerSide = Math.max(1, SHIP_STATS[ship.type].cannonCount / 2);
      for (const [index, cannon] of mesh.cannonMeshes.entries()) {
        const operator = cannonOperators.get(`${ship.id}:${index}`);
        if (!detailNear) {
          cannon.root.visible = true;
          continue;
        }
        const localOperatorUsingThisCannon = !!operator && operator.id === localPlayerId;
        const tooCloseToCamera = localOperatorUsingThisCannon
          && !!cameraPosition
          && cannon.root.getWorldPosition(this.tempCannonPos).distanceToSquared(cameraPosition) < 1.35 * 1.35;
        cannon.root.visible = !tooCloseToCamera;
        const broadsideYaw = ship.rotation + (index < cannonsPerSide ? Math.PI * 0.5 : -Math.PI * 0.5);
        const desiredYaw = operator ? angleWrap(operator.rotation.x - broadsideYaw) : 0;
        const desiredPitch = operator ? operator.rotation.y : 0;
        const cannonAlpha = 1 - Math.exp(-18 * dt);
        cannon.yawPivot.rotation.y += angleWrap(desiredYaw - cannon.yawPivot.rotation.y) * cannonAlpha;
        cannon.pitchPivot.rotation.z = THREE.MathUtils.lerp(cannon.pitchPivot.rotation.z, desiredPitch, cannonAlpha);
      }

      // Lantern flicker
      for (const lantern of mesh.lanterns) {
        lantern.visible = this.quality === 'high' && detailNear;
        lantern.intensity = lantern.visible ? 1.3 + Math.sin(t * 8.5 + ship.id.charCodeAt(0)) * 0.3 : 0;
      }

      // Wake foam: scale opacity with ship speed
      {
        const stats = SHIP_STATS[ship.type];
        const speed = Math.hypot(ship.velocity.x, ship.velocity.z);
        const targetAlpha = ship.alive && !ship.sinking
          ? Math.min(0.75, Math.pow(Math.min(speed / (stats.maxSpeed * 0.18), 1.0), 0.55) * 0.75)
          : 0;
        const wakeMat = mesh.wake.material as THREE.MeshBasicMaterial;
        wakeMat.opacity = THREE.MathUtils.lerp(wakeMat.opacity, targetAlpha, 1 - Math.exp(-3.5 * dt));
        // Lift wake slightly above wave surface so it doesn't z-fight
        mesh.wake.position.y = 0.12 - mesh.root.position.y;
      }

      const hullSections = ['bow', 'stern', 'port', 'starboard'] as const;
      for (const s of hullSections) {
        const hp = ship.hull[s];
        const hole = mesh.hullHoles[s];
        hole.visible = hp < 0.9;
        const sc = THREE.MathUtils.clamp((1 - hp) * 2.5, 0.18, 1.45);
        hole.scale.setScalar(sc);
      }

      // Fire visual
      if (ship.onFire && !mesh.fireParticles) {
        mesh.fireParticles = this.createFireParticles();
        mesh.root.add(mesh.fireParticles);
      }
      if (!ship.onFire && mesh.fireParticles) {
        mesh.root.remove(mesh.fireParticles);
        mesh.fireParticles = null;
      }
      if (mesh.fireParticles && detailNear) {
        (mesh.fireParticles.material as THREE.PointsMaterial).size = 0.32 + Math.sin(t * 5) * 0.1;
        const positions = (mesh.fireParticles.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        for (let i = 1; i < positions.length; i += 3) {
          positions[i] += 0.05;
          if (positions[i] > 6) positions[i] = 1;
        }
        (mesh.fireParticles.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      }
    }
  }

  private createWakeMesh(W: number, L: number): THREE.Mesh {
    // V-shaped foam wake that fans out from the stern
    const sternZ  = -L * 0.42;  // local Z of stern
    const wakeLen = L * 2.4;
    const halfNear = W * 0.08;  // narrow at stern
    const halfFar  = W * 0.72;  // wide at back of wake

    // Trapezoid: narrow at stern, wide at aft end
    const verts = new Float32Array([
      -halfNear, 0, sternZ,
       halfNear, 0, sternZ,
      -halfFar,  0, sternZ - wakeLen,
       halfFar,  0, sternZ - wakeLen,
    ]);
    const uvs = new Float32Array([
      0.5, 0,   0.5, 0,
      0.0, 1,   1.0, 1,
    ]);
    const idx = new Uint16Array([0, 1, 2,  1, 3, 2]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,   2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const mat = new THREE.MeshBasicMaterial({
      color: 0xD8EEF8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    return mesh;
  }

  private createFireParticles(): THREE.Points {
    const count = 50;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 3.2;
      pos[i * 3 + 1] = Math.random() * 3.5 + 1;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 3.2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xFF6600, size: 0.32, sizeAttenuation: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    return new THREE.Points(geo, mat);
  }

  getShipGroup(shipId: string): THREE.Group | null {
    return this.shipMeshes.get(shipId)?.root ?? null;
  }

  getCannonWorldPos(shipId: string, cannonIndex: number): THREE.Vector3 | null {
    const mesh = this.shipMeshes.get(shipId);
    if (!mesh || cannonIndex >= mesh.cannonMeshes.length) return null;
    const pos = new THREE.Vector3();
    mesh.cannonMeshes[cannonIndex].root.getWorldPosition(pos);
    return pos;
  }
}
