import * as THREE from 'three';
import type { Player, Ship, ShipUpgradeType } from '../../shared/types/index.js';
import { SHIP, SHIP_STATS } from '../../shared/constants/index.js';
import { sampleWind, angleWrap, getShipBoardingLadderLocals, getMainMastLocalZ, getCrowNestStandingY, getSailStationLocal } from '../../shared/utils/index.js';

const UPGRADE_PENNANT_COLORS: Record<ShipUpgradeType, number> = {
  hull_reinforcement: 0x67b9ff,
  charged_cannons: 0xff8459,
  swift_sails: 0xf6d360,
};

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

function makeShipInterior(stats: { width: number; length: number; height: number }, woodMat: THREE.Material, darkMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const W = stats.width, L = stats.length, H = stats.height;

  // Hold floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x2e1a08, roughness: 1 });
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

  // Deck underside around the hatch opening so first-person views below deck feel enclosed.
  const ceilingY = H - 0.12;
  const ceilingMat = darkMat;
  const ceilingSegments = [
    { x: 0, z: -L * 0.21, w: W * 0.82, l: L * 0.28 },
    { x: 0, z: L * 0.28, w: W * 0.82, l: L * 0.2 },
    { x: -W * 0.24, z: L * 0.08, w: W * 0.26, l: L * 0.24 },
    { x: W * 0.24, z: L * 0.08, w: W * 0.26, l: L * 0.24 },
    { x: -W * 0.36, z: -L * 0.05, w: W * 0.11, l: L * 0.7 },
    { x: W * 0.36, z: -L * 0.05, w: W * 0.11, l: L * 0.7 },
  ];
  for (const segment of ceilingSegments) {
    const ceiling = new THREE.Mesh(
      new THREE.BoxGeometry(segment.w, 0.08, segment.l),
      ceilingMat,
    );
    ceiling.position.set(segment.x, ceilingY, segment.z);
    g.add(ceiling);
  }

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

  // Deck beams (visible from below)
  const beamMat = darkMat;
  const beamCount = Math.round(L * 0.1);
  for (let b = 0; b < beamCount; b++) {
    const bz = -L * 0.38 + b * (L * 0.76 / Math.max(beamCount - 1, 1));
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

  // Crates stacked in hold
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a3818, roughness: 1, map: woodMat instanceof THREE.MeshStandardMaterial ? woodMat.map : null });
  const crateCount = Math.max(2, Math.round(L / 10));
  for (let c = 0; c < crateCount; c++) {
    const cz = -L * 0.2 - c * (L * 0.12);
    const cGrp = new THREE.Group();
    cGrp.position.set(W * 0.22, 0.35, cz);

    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 0.8), crateMat);
    crate.position.y = 0.35;
    crate.castShadow = true;
    cGrp.add(crate);

    // Crate straps
    const strapMat = new THREE.MeshStandardMaterial({ color: 0x1a1206, roughness: 0.6 });
    for (const sy of [0.15, 0.55]) {
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.05, 0.06), strapMat);
      strap.position.set(0, sy, 0.41);
      cGrp.add(strap);
    }

    g.add(cGrp);
  }

  // Lantern mesh
  const holdLantern = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.22, 0.15),
    new THREE.MeshStandardMaterial({ color: 0xFFCC44, emissive: 0xFF8800, emissiveIntensity: 1.2 }),
  );
  holdLantern.position.set(0, H * 0.55, 0);
  g.add(holdLantern);

  return g;
}

interface CannonMeshGroup {
  root: THREE.Group;
  yawPivot: THREE.Group;
  pitchPivot: THREE.Group;
}

interface ShipMeshGroup {
  root: THREE.Group;
  sails: THREE.Mesh[];
  pennants: THREE.Mesh[];
  upgradePennants: Record<ShipUpgradeType, THREE.Mesh>;
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
  private woodTex!: THREE.CanvasTexture;
  private darkWoodTex!: THREE.CanvasTexture;
  private sailTex!: THREE.CanvasTexture;
  private readonly tempShipPos = new THREE.Vector3();
  private readonly tempCannonPos = new THREE.Vector3();

  init(scene: THREE.Scene) {
    this.scene = scene;
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

  buildShip(ship: Ship): THREE.Group {
    const stats = SHIP_STATS[ship.type];
    const group = new THREE.Group();
    group.name = `ship_${ship.id}`;

    const hullMat = new THREE.MeshStandardMaterial({
      map: this.woodTex,
      roughness: 0.9,
      metalness: 0.0,
      color: new THREE.Color(ship.teamColor),
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

    // ── Hull ─────────────────────────────────────────────────
    const hullGeo = new THREE.BoxGeometry(W, H, L);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.position.y = H * 0.5;
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
          new THREE.BoxGeometry(0.06, H * 0.06, L * 0.88),
          darkMat,
        );
        stripMesh.position.set(sx * (W * 0.502), H * (0.25 + strip * 0.22), 0);
        group.add(stripMesh);
      }
    }

    // Bow wedge (tapers front)
    const bowGeo = new THREE.ConeGeometry(W * 0.35, H * 1.1, 4, 1);
    bowGeo.rotateX(-Math.PI * 0.5);
    bowGeo.rotateZ(Math.PI * 0.25);
    const bow = new THREE.Mesh(bowGeo, hullMat);
    bow.position.set(0, H * 0.45, L * 0.5 + H * 0.25);
    bow.castShadow = true;
    group.add(bow);

    const sternTransom = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.92, H * 0.78, 0.16),
      darkMat,
    );
    sternTransom.position.set(0, H * 0.56, -L * 0.51);
    sternTransom.castShadow = true;
    sternTransom.receiveShadow = true;
    group.add(sternTransom);

    const bowCap = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.54, H * 0.36, 0.16),
      hullMat,
    );
    bowCap.position.set(0, H * 0.62, L * 0.56);
    bowCap.castShadow = true;
    group.add(bowCap);

    // Keel
    const keel = new THREE.Mesh(new THREE.BoxGeometry(W * 0.25, H * 0.25, L * 0.95), darkMat);
    keel.position.y = 0;
    group.add(keel);

    // ── Ship Interior (below deck) ────────────────────────────
    const interior = makeShipInterior(stats, deckMat, darkMat);
    group.add(interior);

    // ── Deck ─────────────────────────────────────────────────
    const deckGeo = new THREE.BoxGeometry(W * 0.95, 0.15, L * 0.9);
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.y = H;
    deck.receiveShadow = true;
    group.add(deck);

    // Deck hatches (openings visible to interior)
    const hatchCount = Math.max(1, Math.round(L / 14));
    const hatchMat = new THREE.MeshStandardMaterial({ color: 0x1a0e04, roughness: 1 });
    for (let h = 0; h < hatchCount; h++) {
      const hz = L * 0.12 - h * (L * 0.24 / Math.max(hatchCount, 1));
      // Hatch opening frame
      const hatchFrame = new THREE.Mesh(
        new THREE.BoxGeometry(W * 0.28, 0.18, L * 0.14),
        darkMat,
      );
      hatchFrame.position.set(W * 0.12, H + 0.09, hz);
      group.add(hatchFrame);
      // Dark opening
      const hatchHole = new THREE.Mesh(
        new THREE.BoxGeometry(W * 0.22, 0.05, L * 0.10),
        hatchMat,
      );
      hatchHole.position.set(W * 0.12, H + 0.05, hz);
      group.add(hatchHole);
      // Hatch lid (open, leaning against frame)
      const lid = new THREE.Mesh(new THREE.BoxGeometry(W * 0.22, 0.06, L * 0.10), deckMat);
      lid.position.set(W * 0.12, H + 0.22, hz - L * 0.08);
      lid.rotation.x = -Math.PI * 0.35;
      lid.castShadow = true;
      group.add(lid);
    }

    // Stairwell down to the hold under the main hatch so the lower deck reads clearly.
    const stairCenterX = W * 0.12;
    const stairStartZ = L * 0.12;
    const stairStepCount = ship.type === 'sloop' ? 5 : 6;
    for (let step = 0; step < stairStepCount; step++) {
      const stepMesh = new THREE.Mesh(
        new THREE.BoxGeometry(W * 0.18, 0.08, L * 0.06),
        deckMat,
      );
      const progress = step / Math.max(1, stairStepCount - 1);
      stepMesh.position.set(
        stairCenterX,
        H - 0.08 - progress * (H - 0.5),
        stairStartZ - progress * (L * 0.26),
      );
      stepMesh.castShadow = true;
      stepMesh.receiveShadow = true;
      group.add(stepMesh);
    }

    for (const railOffset of [-W * 0.12, W * 0.12]) {
      const stairRail = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, H * 0.72, 0.04),
        darkMat,
      );
      stairRail.position.set(stairCenterX + railOffset, H * 0.55, stairStartZ - L * 0.12);
      group.add(stairRail);
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

    // Stern windows
    const windowMat = new THREE.MeshStandardMaterial({ color: 0x88AACC, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.7 });
    const windowCount = Math.max(2, Math.round(W / 2.5));
    for (let w = 0; w < windowCount; w++) {
      const wx = -sternW * 0.35 + w * (sternW * 0.7 / Math.max(windowCount - 1, 1));
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.05), windowMat);
      win.position.set(wx, H + sternH * 0.55, -L * 0.48);
      group.add(win);
      // Window frame
      const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.41, 0.04), brassHardwareMat);
      winFrame.position.set(wx, H + sternH * 0.55, -L * 0.481);
      group.add(winFrame);
    }

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
    anchorChain.rotation.z = Math.PI * 0.5;
    anchorChain.position.set(0, 0.16, 0.03);
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

      // Sail — broad canvas, clearly visible from deck (local +Z is ship forward / bow)
      const sailGeo = new THREE.PlaneGeometry(yardW * 0.92, mastH * 0.72);
      const sail = new THREE.Mesh(sailGeo, sailMat.clone());
      sail.rotation.order = 'YXZ';
      sail.rotation.y = Math.PI * 0.5;
      sail.position.set(0, H + mastH * 0.55, mastZ - 0.04);
      sail.castShadow = false;
      sail.receiveShadow = false;
      group.add(sail);
      sails.push(sail);
    }

    // Crow's nest ladder — vertical rails hug the main mast pole (x=0), not offset toward the rail edge
    {
      const mainMastZ = getMainMastLocalZ(stats);
      const mastR = 0.075 + (ship.type === 'galleon' ? 0.045 : ship.type === 'brigantine' ? 0.025 : 0);
      const nestY = getCrowNestStandingY(stats);
      const ladderBottom = H + 0.2;
      const ladderTop = nestY - 0.32;
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

    // Fore-stay rigging (bow to foremast)
    const stayMat = new THREE.LineBasicMaterial({ color: 0x6a5030 });
    const foreMastZ = mastStartZ;
    const stayPoints = [
      new THREE.Vector3(0, H + stats.mastCount * 2.2 * H * 0.55, foreMastZ),
      new THREE.Vector3(0, H + 0.4, L * 0.46),
    ];
    const stayGeo = new THREE.BufferGeometry().setFromPoints(stayPoints);
    group.add(new THREE.Line(stayGeo, stayMat));

    // ── Cannons ──────────────────────────────────────────────
    const cannonGroups: CannonMeshGroup[] = [];
    const cannonCount = stats.cannonCount;
    const cannonsPerSide = cannonCount / 2;
    const cannonSpacing = L * 0.5 / Math.max(cannonsPerSide - 1, 1);

    for (let side = 0; side < 2; side++) {
      const sideX = (side === 0 ? 1 : -1) * (W * 0.5 + 0.08);
      for (let c = 0; c < cannonsPerSide; c++) {
        const cz = L * 0.2 - c * cannonSpacing;
        const cg = new THREE.Group();
        const yawPivot = new THREE.Group();
        const pitchPivot = new THREE.Group();
        cg.add(yawPivot);
        yawPivot.add(pitchPivot);
        pitchPivot.position.set(0, 0.08, 0);

        // Cannon barrel
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.11, 0.17, 0.95, 8),
          metalMat,
        );
        barrel.rotation.z = Math.PI * 0.5;
        barrel.position.x = 0.18;
        pitchPivot.add(barrel);

        // Touch hole on top
        const touchHole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.025, 0.025, 0.06, 6),
          metalMat,
        );
        touchHole.position.set(0.04, 0.12, -0.22);
        touchHole.rotation.z = Math.PI * 0.5;
        pitchPivot.add(touchHole);

        // Cannon mount (wheeled carriage)
        const mount = new THREE.Mesh(
          new THREE.BoxGeometry(0.26, 0.22, 0.4),
          darkMat,
        );
        cg.add(mount);

        // Carriage wheels
        for (const wz of [-0.16, 0.16]) {
          const wheel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.12, 0.06, 8),
            darkMat,
          );
          wheel.rotation.x = Math.PI * 0.5;
          wheel.position.set(0, -0.09, wz);
          cg.add(wheel);
        }

        const sideSign = side === 0 ? 1 : -1;
        const gunportFrame = new THREE.Mesh(
          new THREE.BoxGeometry(0.08, 0.54, 0.7),
          darkMat,
        );
        gunportFrame.position.set(sideSign * (W * 0.505), H * 0.58, cz);
        gunportFrame.castShadow = true;
        group.add(gunportFrame);

        cg.position.set(sideX, H + 0.16, cz);
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

    // Stacked cannonball pyramid (near main mast)
    const ballMat = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.9 });
    const ballPositions = [
      [0, 0], [0.32, 0], [-0.32, 0], [0.16, 0.28], [-0.16, 0.28],
    ];
    const mainMastZ = mastStartZ;
    for (const [bx, by] of ballPositions) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), ballMat);
      ball.position.set(W * 0.3 + bx, H + 0.14 + by, mainMastZ - L * 0.06);
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

    group.position.set(ship.position.x, ship.position.y, ship.position.z);
    group.rotation.y = ship.rotation;
    this.scene.add(group);

    this.shipMeshes.set(ship.id, {
      root: group,
      sails,
      pennants,
      upgradePennants,
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

  update(ships: Ship[], players: Player[], t: number, dt = 1 / 60, snapshotAge = 0, cameraPosition?: THREE.Vector3) {
    const wind = sampleWind(t);
    const positionAlpha = 1 - Math.exp(-18 * dt);
    const rotationAlpha = 1 - Math.exp(-20 * dt);
    const cannonOperators = new Map<string, Player>();
    for (const player of players) {
      if (!player.atCannon || !player.onShipId) continue;
      cannonOperators.set(`${player.onShipId}:${player.cannonIndex}`, player);
    }

    for (const ship of ships) {
      let mesh = this.shipMeshes.get(ship.id);
      if (!mesh) {
        this.buildShip(ship);
        mesh = this.shipMeshes.get(ship.id)!;
      }

      if (!ship.alive) {
        mesh.root.visible = false;
        continue;
      }

      mesh.root.visible = true;
      const detailNear = !cameraPosition
        || (ship.position.x - cameraPosition.x) ** 2 + (ship.position.z - cameraPosition.z) ** 2 < 380 * 380;
      const extrapolation = Math.min(0.14, snapshotAge + dt * 0.5);
      mesh.root.position.lerp(
        this.tempShipPos.set(
          ship.position.x + ship.velocity.x * extrapolation,
          ship.position.y,
          ship.position.z + ship.velocity.z * extrapolation,
        ),
        positionAlpha,
      );
      const targetRotation = ship.rotation + ship.angularVelocity * extrapolation;
      mesh.root.rotation.y += angleWrap(targetRotation - mesh.root.rotation.y) * rotationAlpha;
      mesh.wheel.rotation.z -= ship.angularVelocity * 0.22;
      mesh.compassNeedle.rotation.y = -mesh.root.rotation.y;

      const anchorRaiseProgress = THREE.MathUtils.clamp(ship.anchorRaiseProgress ?? 0, 0, 1);
      const anchorDrop = ship.anchored ? 1 - anchorRaiseProgress : 0;
      if (ship.anchored && anchorRaiseProgress > 0) {
        mesh.anchorCapstan.rotation.y += dt * (3.6 + anchorRaiseProgress * 4.8);
      } else {
        mesh.anchorCapstan.rotation.y += dt * 0.08;
      }
      mesh.anchor.position.y = THREE.MathUtils.lerp(
        mesh.anchor.position.y,
        SHIP_STATS[ship.type].height + 0.34 - anchorDrop * 2.75,
        0.12,
      );
      mesh.anchor.rotation.z = THREE.MathUtils.lerp(mesh.anchor.rotation.z, ship.anchored ? 0.1 * anchorDrop : 0, 0.12);
      // Chain hangs from windlass drum (child of windlass); only length changes
      mesh.anchorChain.scale.y = THREE.MathUtils.lerp(mesh.anchorChain.scale.y, ship.anchored ? 0.52 + anchorDrop * 0.76 : 0.52, 0.12);

      const visualSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
      const motionPhase = t * 0.9 + ship.id.charCodeAt(0) * 0.37;
      const wavePitch = Math.sin(motionPhase) * 0.014 + Math.sin(t * 0.47 + ship.position.x * 0.006) * 0.009;
      const steerRoll = THREE.MathUtils.clamp(-ship.angularVelocity * 0.12, -0.07, 0.07);
      const sailLean = THREE.MathUtils.clamp(ship.sailHeight * 0.018 + visualSpeed * 0.002, 0, 0.045);
      const rollTarget = Math.sin(motionPhase * 1.18 + ship.position.z * 0.004) * (0.012 + sailLean) + steerRoll;

      // Sinking tilt
      if (ship.sinking) {
        mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch * 0.6, 0.08);
        mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, ship.sinkProgress * Math.PI * 0.42, 0.12);
        mesh.root.position.y = THREE.MathUtils.lerp(mesh.root.position.y, ship.position.y - ship.sinkProgress * 5, 0.18);
      } else {
        mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch, 1 - Math.exp(-3.8 * dt));
        mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, rollTarget, 1 - Math.exp(-3.4 * dt));
      }

      // Sail state — keep canvas mostly vertical so it stays visible; tear is subtle
      const rawInt = ship.sailIntegrity ?? 1;
      const sailIntegrity = Number.isFinite(rawInt) ? Math.max(0, Math.min(1, rawInt)) : 1;
      const chainshotted = Date.now() / 1000 < ship.chainshottedUntil;
      const tornPitch = (1 - sailIntegrity) * 0.52 + (chainshotted ? 0.12 : 0);
      for (const sail of mesh.sails) {
        sail.visible = ship.sailHeight > 0.05;
        const signedRelative = angleWrap(wind.direction - ship.rotation);
        const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.95;
        const trimCatch = 1 - Math.min(1, Math.abs(angleWrap(ship.sailAngle - desiredTrim)) / SHIP.MAX_SAIL_ANGLE);
        sail.rotation.y = Math.PI * 0.5 + ship.sailAngle;
        sail.rotation.x = tornPitch * (0.55 + 0.15 * Math.sin(t * 0.9 + sail.position.z * 0.2));
        sail.scale.y = Math.max(0.1, ship.sailHeight * Math.max(0.22, sailIntegrity));
        const billow = Math.sin(t * 1.2 + sail.position.z * 0.3) * (0.12 + trimCatch * 0.2) * ship.sailHeight * sailIntegrity;
        sail.scale.z = 1 + billow;
      }

      const localWind = angleWrap(wind.direction - ship.rotation);
      for (const pennant of mesh.pennants) {
        pennant.rotation.y = Math.PI * 0.5 + localWind;
        pennant.rotation.z = Math.sin(t * 8 + pennant.position.z * 0.14) * 0.12;
        pennant.scale.x = 1.05 + wind.strength * 0.65 + Math.min(0.4, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.03);
      }
      const activeUpgrades = new Set(ship.upgrades.map(upgrade => upgrade.type));
      for (const [type, pennant] of Object.entries(mesh.upgradePennants) as Array<[ShipUpgradeType, THREE.Mesh]>) {
        pennant.visible = activeUpgrades.has(type);
        if (!pennant.visible) continue;
        pennant.rotation.y = Math.PI * 0.5 + localWind;
        pennant.rotation.z = Math.sin(t * 9.5 + pennant.position.y * 0.3) * 0.18;
        pennant.scale.x = 1.1 + wind.strength * 0.55 + Math.min(0.35, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.025);
      }

      const cannonsPerSide = Math.max(1, SHIP_STATS[ship.type].cannonCount / 2);
      for (const [index, cannon] of mesh.cannonMeshes.entries()) {
        if (!detailNear) continue;
        const tooCloseToCamera = !!cameraPosition
          && cannon.root.getWorldPosition(this.tempCannonPos).distanceToSquared(cameraPosition) < 3.2 * 3.2;
        cannon.root.visible = !tooCloseToCamera;
        const operator = cannonOperators.get(`${ship.id}:${index}`);
        const broadsideYaw = ship.rotation + (index < cannonsPerSide ? Math.PI * 0.5 : -Math.PI * 0.5);
        const desiredYaw = operator ? angleWrap(operator.rotation.x - broadsideYaw) : 0;
        const desiredPitch = operator ? operator.rotation.y : 0;
        cannon.yawPivot.rotation.y += angleWrap(desiredYaw - cannon.yawPivot.rotation.y) * 0.28;
        cannon.pitchPivot.rotation.z = THREE.MathUtils.lerp(cannon.pitchPivot.rotation.z, desiredPitch, 0.28);
      }

      // Lantern flicker
      for (const lantern of mesh.lanterns) {
        lantern.intensity = detailNear ? 1.3 + Math.sin(t * 8.5 + ship.id.charCodeAt(0)) * 0.3 : 0;
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
