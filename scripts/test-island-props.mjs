#!/usr/bin/env node
// Island prop/stamp registry contract — deterministic, learnable islands.
//
// MapGenerator(seed) must be bit-identical run-to-run (ids excepted): the same
// roster island keeps the same silhouette, coast bands, caves, stamps and
// props every match. Props obey biome/slope/spacing rules, landmarks always
// land, structures sit on stamped flats, and cave volume helpers behave.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import {
  getCaveCeilingY,
  getCaveFloorY,
  getIslandMaxRadius,
  getIslandSurfaceY,
} from '../src/shared/utils/index.ts';
import { PROP_COLLIDERS, getPropSpacingRadius, resolvePropCollision } from '../src/shared/props.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const LANDMARK_TYPES = new Set(['watchtower', 'shipwreck', 'standing_stones']);
const DOCK_TYPES = new Set(['dock_mid', 'dock_end']);
const KNOWN_TYPES = new Set(Object.keys(PROP_COLLIDERS));

// Landmark identity per biome mirrors the curated roster: highland/volcanic
// ridges get watchtowers, beach/bone coasts get wrecks, lush interiors stones.
const BIOME_LANDMARKS = {
  lush: ['standing_stones', 'shipwreck'],
  palm_atoll: ['shipwreck'],
  volcanic: ['watchtower'],
  highland: ['watchtower', 'standing_stones'],
  bone: ['shipwreck'],
};

const slopeAt = (island, x, z) => {
  const e = 1.1;
  return Math.max(
    Math.abs(getIslandSurfaceY(island, x + e, z) - getIslandSurfaceY(island, x - e, z)),
    Math.abs(getIslandSurfaceY(island, x, z + e) - getIslandSurfaceY(island, x, z - e)),
  ) / (2 * e);
};

const strip = (islands) => JSON.stringify(islands.map((i) => ({
  name: i.name,
  position: i.position,
  radius: i.radius,
  profile: i.profile,
  props: i.props,
  stamps: i.stamps,
  caves: i.caves,
  dock: i.dock,
  tavern: i.tavern,
  chests: i.chests.map((c) => ({ p: c.position, buried: c.buried, mx: c.mapOffsetX, mz: c.mapOffsetZ })),
  barrels: i.barrels.map((b) => b.position),
  stations: i.upgradeStations.map((s) => ({ type: s.type, p: s.position })),
})));

console.log('Island prop registry contract');

// ── Determinism: same seed ⇒ bit-identical islands/props/stamps ──
const SEED = 101;
const islandsA = new MapGenerator(SEED).generateIslands();
const islandsB = new MapGenerator(SEED).generateIslands();
expect('Same seed produces bit-identical islands/props/stamps/caves', strip(islandsA) === strip(islandsB));
expect('The Shattered Reach is FIXED: different match seeds, identical world', strip(islandsA) === strip(new MapGenerator(SEED + 1).generateIslands()));
expect('A full roster map generated', islandsA.length >= 8, `islands=${islandsA.length}`);

// ── Per-island prop rules across two seeds ──
let totalCaves = 0;
for (const seed of [SEED, 20260702]) {
  const islands = new MapGenerator(seed).generateIslands();
  let landmarksOk = true;
  let biomeLandmarkOk = true;
  let typesOk = true;
  let underwaterOk = true;
  let wreckBandOk = true;
  let palmSlopeOk = true;
  let boulderSlopeOk = true;
  let spacingOk = true;
  let stampsFlatOk = true;
  let dockFlatOk = true;
  let tavernFlatOk = true;
  let countsOk = true;
  let cavesOk = true;
  let detail = '';

  for (const island of islands) {
    const props = island.props ?? [];
    totalCaves += island.caves.length;

    // Every roster island has ≥1 landmark POI, of a type its biome allows.
    const landmarks = props.filter((p) => LANDMARK_TYPES.has(p.type));
    if (landmarks.length < 1) { landmarksOk = false; detail = `${island.name}: no landmark`; }
    const allowed = BIOME_LANDMARKS[island.profile.biome] ?? [];
    for (const lm of landmarks) {
      if (!allowed.includes(lm.type)) { biomeLandmarkOk = false; detail = `${island.name} (${island.profile.biome}): ${lm.type}`; }
    }

    // Density scales with radius: big islands are 40-120 props, all bounded.
    if (island.radius >= 90 && props.length < 40) { countsOk = false; detail = `${island.name}: ${props.length} props`; }
    if (props.length < 8 || props.length > 200) { countsOk = false; detail = `${island.name}: ${props.length} props`; }

    for (const p of props) {
      if (!KNOWN_TYPES.has(p.type)) { typesOk = false; detail = `unknown type ${p.type}`; }
      const y = getIslandSurfaceY(island, p.x, p.z);
      if (p.type === 'shipwreck') {
        // Wrecks MAY be half-beached — hull at the waterline, never fully sunk.
        if (y < -2.2 || y > 1.6) { wreckBandOk = false; detail = `${island.name}: wreck y=${y.toFixed(2)}`; }
      } else if (!DOCK_TYPES.has(p.type)) {
        // Everything else stands on dry land (dock modules span open water).
        if (y < 0.05) { underwaterOk = false; detail = `${island.name}: ${p.type} y=${y.toFixed(2)}`; }
      }
      if (p.type.startsWith('palm') && slopeAt(island, p.x, p.z) > 1.45) { palmSlopeOk = false; detail = `${island.name}: palm slope`; }
      if (p.type.startsWith('boulder') && slopeAt(island, p.x, p.z) > 2.45) { boulderSlopeOk = false; detail = `${island.name}: boulder slope`; }
    }

    // Pairwise spacing: no two blocking props interpenetrate.
    for (let i = 0; i < props.length; i++) {
      const ri = getPropSpacingRadius(props[i].type, props[i].scale);
      if (ri <= 0) continue;
      for (let j = i + 1; j < props.length; j++) {
        const rj = getPropSpacingRadius(props[j].type, props[j].scale);
        if (rj <= 0) continue;
        const d = Math.hypot(props[i].x - props[j].x, props[i].z - props[j].z);
        if (d < ri + rj - 1e-6) { spacingOk = false; detail = `${island.name}: ${props[i].type}/${props[j].type} d=${d.toFixed(2)}`; }
      }
    }

    // Stamps flatten their inner disc to targetY.
    for (const s of island.stamps ?? []) {
      const inner = s.radius * (1 - Math.min(0.95, Math.max(0.05, s.blend)));
      for (let k = 0; k < 12; k++) {
        const t = (k / 12) * Math.PI * 2;
        const y = getIslandSurfaceY(island, s.x + Math.cos(t) * inner * 0.8, s.z + Math.sin(t) * inner * 0.8);
        if (Math.abs(y - s.targetY) > 0.05) { stampsFlatOk = false; detail = `${island.name}: stamp dev=${Math.abs(y - s.targetY).toFixed(3)}`; }
      }
    }

    // Dock shore end and tavern sit on stamped flats.
    if (island.dock) {
      const d = island.dock;
      const fx = Math.sin(d.rotation);
      const fz = Math.cos(d.rotation);
      const shoreX = d.position.x - fx * d.length * 0.42;
      const shoreZ = d.position.z - fz * d.length * 0.42;
      const y0 = getIslandSurfaceY(island, shoreX, shoreZ);
      if (y0 < 0.55) { dockFlatOk = false; detail = `${island.name}: dock shore y=${y0.toFixed(2)}`; }
      for (let k = 0; k < 8; k++) {
        const t = (k / 8) * Math.PI * 2;
        const y = getIslandSurfaceY(island, shoreX + Math.cos(t) * 1.8, shoreZ + Math.sin(t) * 1.8);
        if (Math.abs(y - y0) > 0.05) { dockFlatOk = false; detail = `${island.name}: dock shore dev=${Math.abs(y - y0).toFixed(3)}`; }
      }
    }
    if (island.tavern) {
      const t0 = island.tavern;
      const y0 = getIslandSurfaceY(island, t0.position.x, t0.position.z);
      if (Math.abs(y0 - t0.position.y) > 0.02) { tavernFlatOk = false; detail = `${island.name}: tavern y off by ${Math.abs(y0 - t0.position.y).toFixed(3)}`; }
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const y = getIslandSurfaceY(island, t0.position.x + Math.cos(a) * 2.5, t0.position.z + Math.sin(a) * 2.5);
        if (Math.abs(y - y0) > 0.05) { tavernFlatOk = false; detail = `${island.name}: tavern dev=${Math.abs(y - y0).toFixed(3)}`; }
      }
    }

    // Cave volumes: roofed hillsides, sane ceiling helper, null outside.
    for (const cave of island.caves) {
      const midX = cave.position.x - Math.sin(cave.rotation) * cave.length * 0.6;
      const midZ = cave.position.z - Math.cos(cave.rotation) * cave.length * 0.6;
      const ceil = getCaveCeilingY(island, midX, midZ);
      if (ceil === null || ceil !== cave.ceilingY) { cavesOk = false; detail = `${island.name}: ceiling helper ${ceil}`; }
      if (cave.ceilingY - cave.floorY < 3.0) { cavesOk = false; detail = `${island.name}: cave too low`; }
      const deepX = cave.position.x - Math.sin(cave.rotation) * cave.length;
      const deepZ = cave.position.z - Math.cos(cave.rotation) * cave.length;
      if (getIslandSurfaceY(island, deepX, deepZ) < cave.ceilingY + 2 - 1e-6) { cavesOk = false; detail = `${island.name}: roof thinner than 2m`; }
      const floor = getCaveFloorY(island, midX, midZ);
      if (floor === null || Math.abs(floor - cave.floorY) > 0.6) { cavesOk = false; detail = `${island.name}: cave floor ${floor}`; }
      const farX = island.position.x + getIslandMaxRadius(island) * 2;
      if (getCaveCeilingY(island, farX, island.position.z) !== null) { cavesOk = false; detail = `${island.name}: ceiling outside`; }
      if (getCaveFloorY(island, farX, island.position.z) !== null) { cavesOk = false; detail = `${island.name}: floor outside`; }
    }
  }

  console.log(`  seed ${seed}:`);
  expect('Every island has ≥1 landmark POI', landmarksOk, detail);
  expect('Landmark types match island biomes', biomeLandmarkOk, detail);
  expect('All prop types are known GLB assets', typesOk, detail);
  expect('No prop stands underwater (docks/wrecks excepted)', underwaterOk, detail);
  expect('Shipwrecks are half-beached at the waterline', wreckBandOk, detail);
  expect('Palms respect the slope limit', palmSlopeOk, detail);
  expect('Boulders respect the slope limit', boulderSlopeOk, detail);
  expect('Props respect pairwise spacing (no interpenetration)', spacingOk, detail);
  expect('Prop density scales with island size (big islands ≥ 40)', countsOk, detail);
  expect('Structure stamps flatten to targetY (< 0.05m deviation)', stampsFlatOk, detail);
  expect('Dock shore ends sit on dry stamped flats', dockFlatOk, detail);
  expect('Taverns sit on stamped flats at their stated height', tavernFlatOk, detail);
  expect('Cave volumes are roofed and helpers behave', cavesOk, detail);
}
expect('Caves generate across the roster (hillside placement finds sites)', totalCaves > 0, `caves=${totalCaves}`);

// ── Prop collider metadata + resolver ──
{
  const island = islandsA.find((i) => (i.props ?? []).some((p) => p.type.startsWith('boulder')));
  const boulder = island.props.find((p) => p.type.startsWith('boulder'));
  const col = PROP_COLLIDERS[boulder.type];
  const groundY = getIslandSurfaceY(island, boulder.x, boulder.z);
  const inside = resolvePropCollision({ x: boulder.x + 0.05, y: groundY + 0.5, z: boulder.z }, 0.35, island);
  const clearance = Math.hypot(inside.x - boulder.x, inside.z - boulder.z);
  expect('resolvePropCollision pushes a player out of a boulder', inside.pushed && clearance >= col.radius * boulder.scale + 0.35 - 1e-6, `clearance=${clearance.toFixed(2)}`);
  const above = resolvePropCollision({ x: boulder.x + 0.05, y: groundY + col.height * boulder.scale + 1.0, z: boulder.z }, 0.35, island);
  expect('resolvePropCollision ignores props the player is above', !above.pushed);
  const far = resolvePropCollision({ x: island.position.x + getIslandMaxRadius(island) * 3, y: 0, z: island.position.z }, 0.35, island);
  expect('resolvePropCollision leaves clear positions untouched', !far.pushed);
  expect('Every prop type has collider metadata', Object.keys(PROP_COLLIDERS).length === 18);
}

// ── Chest map offsets reconstruct the true world position ──
{
  let offsetsOk = true;
  let detail = '';
  for (const island of islandsA) {
    const maxR = getIslandMaxRadius(island);
    for (const chest of island.chests) {
      const rx = island.position.x + chest.mapOffsetX * maxR;
      const rz = island.position.z + chest.mapOffsetZ * maxR;
      if (Math.hypot(rx - chest.position.x, rz - chest.position.z) > 1e-6) { offsetsOk = false; detail = `${island.name}: offset drift`; }
      if (Math.abs(chest.mapOffsetX) > 1 || Math.abs(chest.mapOffsetZ) > 1) { offsetsOk = false; detail = `${island.name}: offset out of range`; }
    }
  }
  expect('Chest map offsets are true normalized surface-point offsets', offsetsOk, detail);
}

if (failures > 0) {
  console.error(`\n${failures} island prop check(s) failed`);
  process.exit(1);
}
console.log('\nAll island prop checks passed');
