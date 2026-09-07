// THE HOLD — floor, inner skin, bulkheads, ribs, beams, hammocks, crates and
// the cargo stacks below the weather deck. Extracted verbatim from ShipRenderer
// (codehealth-03 phase 1, HULLGEO-01 slice a);
// scripts/test-ship-geometry-hash.mjs pins the move.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { registerBudgetLight } from '../LightBudget.js';

export interface StairwellHole {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

export function makeShipInterior(
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
  floorMat.name = 'hold-floor';
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(W * 0.88, 0.12, L * 0.88),
    floorMat,
  );
  floor.position.y = 0.35;
  floor.receiveShadow = true;
  g.add(floor);

  // Inner walls (port/starboard)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 1 });
  wallMat.name = 'hold-inner-wall';
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
  hammockMat.name = 'hold-hammock';
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
  crateMat.name = 'hold-crate';
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
    new THREE.MeshStandardMaterial({ color: 0xFFD66A, emissive: 0xFF8800, emissiveIntensity: 2.0 }),
  );
  holdLantern.position.set(0, H * 0.55, 0);
  g.add(holdLantern);

  // THE HOLD IS WINDOWLESS, so what the sun is doing outside is irrelevant to
  // it: this lantern burns on the middle watch and it burns at noon. It was
  // built with `visible = false` and nothing in the ship update ever turned it
  // on, so the one light source below deck never lit anything and the hold read
  // as a black box at every hour — you walked down the companionway into ink.
  //
  // Its REACH is deliberately hold-sized rather than ship-sized. The light
  // budget ranks emitters by intensity x (1 - dist/range)^2, so a 22 m lantern
  // on every hull in the anchorage would sit in the pool competing with the
  // torches and braziers you can actually see; at 8.5 m it can only win a slot
  // for someone who is standing in the hold it belongs to, which is exactly who
  // it is for.
  const holdLight = new THREE.PointLight(0xFFB060, 1.15, 8.5, 1.25);
  holdLight.position.set(0, H * 0.55, 0);
  holdLight.name = 'hold-lantern';
  registerBudgetLight(holdLight);
  holdLight.visible = true;
  g.add(holdLight);

  // Brighten the hold floor so it doesn't look like a flat brown tarp from above.
  // Replace the original drab floorMat by tweaking the existing floor mesh's material.
  // (Done by creating a new lighter material; original mesh kept in scope above.)

  return g;
}

/**
 * THE HOLD CARGO STACK — the 9000-gold race, made a thing you can walk down to
 * and look at.
 *
 * The win condition of this battle royale used to have no body: gold was a
 * number in the corner of the HUD and the hold of the ship carrying it was as
 * empty as everyone else's. This builds the crates, coin-spill and strongboxes
 * that fill that hold as the crew's cargo grows (shared/cargo.ts tiers), so
 * "who is winning" is a question you answer by looking at a ship's belly.
 *
 * Built as FOUR cumulative merged variants (tier 1 lots … tiers 1-4 lots), of
 * which exactly one is ever visible: a laden hull costs two extra draw calls,
 * an empty one costs none. Growing the stack by toggling meshes rather than
 * spawning crates keeps this off the per-frame allocation path entirely.
 */
export function makeHoldCargoStacks(
  stats: { width: number; length: number; height: number },
  crateMat: THREE.Material,
  goldMat: THREE.Material,
): { group: THREE.Group; tiers: THREE.Object3D[] } {
  const W = stats.width, L = stats.length, H = stats.height;
  const floorY = 0.41;                    // top of the hold's floor slab
  const headroom = Math.max(0.7, H - 0.45);
  const group = new THREE.Group();
  group.name = 'hold-cargo';

  /** One stowed lot: crates + a coin pile, at a spot clear of the stairwell. */
  const lots: Array<() => { crates: THREE.BufferGeometry[]; gold: THREE.BufferGeometry[] }> = [];
  const stow = (lx: number, lz: number, crateCount: number, coins: number, seed: number) => {
    lots.push(() => {
      const crates: THREE.BufferGeometry[] = [];
      const gold: THREE.BufferGeometry[] = [];
      for (let i = 0; i < crateCount; i += 1) {
        const s = 0.42 + ((seed + i * 7) % 5) * 0.045;
        const h = Math.min(s, headroom * 0.42);
        const level = Math.floor(i / 2);
        const geo = new THREE.BoxGeometry(s, h, s * 0.86);
        geo.rotateY(((seed + i * 13) % 9 - 4) * 0.06);
        geo.translate(
          lx + ((i % 2) * 2 - 1) * s * 0.56,
          Math.min(floorY + h * 0.5 + level * h * 1.02, floorY + headroom - h * 0.5),
          lz + (((seed + i) % 3) - 1) * 0.12,
        );
        crates.push(geo);
      }
      // Coin spill: flat gold discs at the crates' feet. Cheap, and the only
      // warm-metal thing below decks — it reads as money from the stairwell.
      for (let i = 0; i < coins; i += 1) {
        const r = 0.13 + ((seed + i * 3) % 4) * 0.02;
        const geo = new THREE.CylinderGeometry(r, r * 1.12, 0.055 + (i % 3) * 0.02, 8);
        const a = (i / Math.max(1, coins)) * Math.PI * 2 + seed;
        geo.translate(
          lx + Math.cos(a) * (0.32 + (i % 2) * 0.18),
          floorY + 0.03 + (i % 2) * 0.03,
          lz + Math.sin(a) * (0.3 + (i % 3) * 0.14),
        );
        gold.push(geo);
      }
      return { crates, gold };
    });
  };

  // Stowage plan: aft of the stairwell first (a crew stows heavy aft), then the
  // forward hold, then the wings. The companionway (getShipCompanionwayConfig,
  // roughly z ∈ [-L*0.05, L*0.21] near the centreline) stays walkable at every
  // tier — cargo may never wall a pirate off from their own ladder.
  stow(-W * 0.16, -L * 0.24, 3, 5, 1);
  stow(W * 0.19, -L * 0.31, 4, 6, 4);
  stow(-W * 0.20, L * 0.30, 4, 7, 7);
  stow(W * 0.17, L * 0.33, 5, 9, 2);

  const tiers: THREE.Object3D[] = [];
  const crateGeos: THREE.BufferGeometry[] = [];
  const goldGeos: THREE.BufferGeometry[] = [];
  for (const buildLot of lots) {
    const lot = buildLot();
    crateGeos.push(...lot.crates);
    goldGeos.push(...lot.gold);
    const tier = new THREE.Group();
    const crates = mergeGeometries(crateGeos.map((g) => g.clone()), false);
    const coins = mergeGeometries(goldGeos.map((g) => g.clone()), false);
    if (crates) {
      const mesh = new THREE.Mesh(crates, crateMat);
      mesh.castShadow = true;
      tier.add(mesh);
    }
    if (coins) tier.add(new THREE.Mesh(coins, goldMat));
    tier.visible = false;
    group.add(tier);
    tiers.push(tier);
  }
  for (const geo of crateGeos) geo.dispose();
  for (const geo of goldGeos) geo.dispose();

  return { group, tiers };
}

