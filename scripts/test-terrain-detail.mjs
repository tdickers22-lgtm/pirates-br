#!/usr/bin/env node
import {
  directionToYaw,
  getIslandSurfacePoint,
  getIslandSurfaceY,
  terrainFbm,
  terrainRidge,
} from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

function makeIsland(overrides = {}) {
  const { position, profile, ...rest } = overrides;
  return {
    id: 'island-test',
    name: 'Test Isle',
    position: { x: 120, y: 0, z: -340, ...(position ?? {}) },
    radius: 72,
    profile: {
      islandHeading: 0.8,
      footprintX: 1.3,
      footprintZ: 1.2,
      heightProfile: 0.8,
      beachSpread: 1.15,
      ridgeAxis: 0.9,
      ridgeBias: 0.1,
      mesaBias: 0.4,
      primaryHillAngle: 0.7,
      secondaryHillAngle: 3.4,
      tertiaryHillAngle: 2.2,
      primaryHillOffset: 18,
      secondaryHillOffset: 16,
      tertiaryHillOffset: 12,
      secondaryHillScale: 0.6,
      tertiaryHillScale: 0.3,
      peakBoost: 1.2,
      terrainStyle: 'mountain',
      ...(profile ?? {}),
    },
    dock: null,
    tavern: null,
    caves: [],
    chests: [],
    barrels: [],
    upgradeStations: [],
    npcs: [],
    ...rest,
  };
}

console.log('Deterministic terrain detail contract');

// ── Noise primitives ──
expect('terrainFbm is deterministic across calls', terrainFbm(12.3, -45.6) === terrainFbm(12.3, -45.6));
let ridgeInRange = true;
for (let i = 0; i < 200; i++) {
  const v = terrainRidge(i * 0.73 - 50, i * -1.31 + 20);
  if (!(v >= 0 && v <= 1)) ridgeInRange = false;
}
expect('terrainRidge stays in [0, 1]', ridgeInRange);

// ── Server/client agreement: identical islands, bit-identical heights ──
const islandA = makeIsland();
const islandB = makeIsland();
let mismatch = false;
for (let gx = -60; gx <= 60; gx += 12) {
  for (let gz = -60; gz <= 60; gz += 12) {
    const ya = getIslandSurfaceY(islandA, islandA.position.x + gx, islandA.position.z + gz);
    const yb = getIslandSurfaceY(islandB, islandB.position.x + gx, islandB.position.z + gz);
    if (ya !== yb) mismatch = true;
  }
}
expect('Identical islands produce bit-identical surface heights', !mismatch);

// ── World-space noise gives identical profiles distinct relief ──
const islandC = makeIsland({ position: { x: -512, z: 410 } });
let maxProfileDiff = 0;
for (let gx = -30; gx <= 30; gx += 6) {
  for (let gz = -30; gz <= 30; gz += 6) {
    const ya = getIslandSurfaceY(islandA, islandA.position.x + gx, islandA.position.z + gz);
    const yc = getIslandSurfaceY(islandC, islandC.position.x + gx, islandC.position.z + gz);
    maxProfileDiff = Math.max(maxProfileDiff, Math.abs(ya - yc));
  }
}
expect('Same profile at a different world position gets distinct detail', maxProfileDiff > 0.2, `maxDiff=${maxProfileDiff.toFixed(3)}`);

// ── Shoreline stays smooth (detail masked out near the beach) ──
let shoreMin = Infinity;
let shoreMax = -Infinity;
for (let s = 0; s < 64; s++) {
  const angle = (s / 64) * Math.PI * 2;
  const p = getIslandSurfacePoint(islandA, 1.0, angle, 0);
  shoreMin = Math.min(shoreMin, p.y);
  shoreMax = Math.max(shoreMax, p.y);
}
expect('Shoreline height band stays narrow', shoreMax - shoreMin < 3.0, `spread=${(shoreMax - shoreMin).toFixed(2)}`);
expect('Shoreline stays above the water shelf', shoreMin > 3.2, `min=${shoreMin.toFixed(2)}`);

// ── Terrain floor is respected everywhere ──
let floorOk = true;
for (let gx = -110; gx <= 110; gx += 11) {
  for (let gz = -110; gz <= 110; gz += 11) {
    const y = getIslandSurfaceY(islandA, islandA.position.x + gx, islandA.position.z + gz);
    if (y < 0.08 - 1e-9) floorOk = false;
  }
}
expect('Surface never drops below the terrain floor', floorOk);

// ── Cave hollowing still wins over noise detail ──
const caveIsland = makeIsland();
const caveAngle = 1.1;
const cavePos = getIslandSurfacePoint(caveIsland, 0.6, caveAngle, 0);
const caveRotation = directionToYaw(Math.cos(caveAngle), Math.sin(caveAngle));
const cave = {
  position: cavePos,
  rotation: caveRotation,
  width: 6,
  height: 4,
  length: 10,
  interiorRadius: 3,
  floorY: cavePos.y - 0.4,
};
caveIsland.caves = [cave];
// Cave-local (lx=0, lz=-3) → 3 m inside the tunnel
const insideX = cavePos.x - 3 * Math.sin(caveRotation);
const insideZ = cavePos.z - 3 * Math.cos(caveRotation);
const insideY = getIslandSurfaceY(caveIsland, insideX, insideZ);
expect('Cave tunnel floor still hollows out the heightmap', Math.abs(insideY - cave.floorY) < 0.05, `y=${insideY.toFixed(2)} floorY=${cave.floorY.toFixed(2)}`);

if (failures > 0) {
  console.error(`\n${failures} terrain detail check(s) failed`);
  process.exit(1);
}
console.log('\nAll terrain detail checks passed');
