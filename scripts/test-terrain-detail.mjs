#!/usr/bin/env node
// Terrain contract v2 — Sea-of-Thieves-depth islands.
//
// The shore is a SIGNED profile now: beach coasts ease from the interior
// through a wet-sand band and continue UNDERWATER past the footprint edge so
// swimmers can walk straight in; cliff coasts keep a tall (7-10m) plinth that
// plunges past the rim; rocky coasts sit between. Cave trenches are opt-in
// (carveCaves) — walking above a cave stands on the natural hillside.
import {
  directionToYaw,
  getCaveCeilingY,
  getCaveFloorY,
  getIslandCoastType,
  getIslandCoastWeights,
  getIslandDistRatio,
  getIslandInletCut,
  getIslandSurfacePoint,
  getIslandSurfaceY,
  isPointInsideIslandFootprint,
  isSubmergedAt,
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
    props: [],
    stamps: [],
    ...rest,
  };
}

console.log('Deterministic terrain contract v2');

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
for (let gx = -130; gx <= 130; gx += 13) {
  for (let gz = -130; gz <= 130; gz += 13) {
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

// ── Surface is always finite (incl. the underwater apron past the rim) ──
let allFinite = true;
for (let gx = -220; gx <= 220; gx += 5) {
  for (let gz = -220; gz <= 220; gz += 5) {
    if (!Number.isFinite(getIslandSurfaceY(islandA, islandA.position.x + gx, islandA.position.z + gz))) allFinite = false;
  }
}
expect('Surface height is finite everywhere (never NaN)', allFinite);

// ── Coast bands: the island splits into deterministic beach/cliff sectors ──
let bestBeach = { angle: 0, w: -1 };
let bestCliff = { angle: 0, w: -1 };
for (let s = 0; s < 256; s++) {
  const a = (s / 256) * Math.PI * 2 - Math.PI;
  const w = getIslandCoastWeights(islandA, a);
  if (w.beach > bestBeach.w) bestBeach = { angle: a, w: w.beach };
  if (w.cliff > bestCliff.w) bestCliff = { angle: a, w: w.cliff };
}
expect('Coast field produces both strong beach and strong cliff sectors', bestBeach.w > 0.9 && bestCliff.w > 0.9, `beach=${bestBeach.w.toFixed(2)} cliff=${bestCliff.w.toFixed(2)}`);

// ── Beach coasts: geometrically continuous walk-in ──
const beachDry = getIslandSurfacePoint(islandA, 0.9, bestBeach.angle, 0);
const beachWet = getIslandSurfacePoint(islandA, 0.97, bestBeach.angle, 0);
const beachDeep = getIslandSurfacePoint(islandA, 1.15, bestBeach.angle, 0);
expect('Beach: dry sand above the waterline at distRatio 0.9', beachDry.y > 0.8, `y=${beachDry.y.toFixed(2)}`);
expect('Beach: wet-sand band (~+0.4m) at distRatio 0.97', beachWet.y > 0.1 && beachWet.y < 0.9, `y=${beachWet.y.toFixed(2)}`);
expect('Beach: continues underwater to ≤ -2m by distRatio 1.15', beachDeep.y < -2.0, `y=${beachDeep.y.toFixed(2)}`);
// Walk the beach ray in 0.5m world-space steps: the profile must be smooth
// enough to wade (no plinth, no step) across the waterline.
{
  const dir = { x: Math.cos(bestBeach.angle), z: Math.sin(bestBeach.angle) };
  let prev = null;
  let maxStep = 0;
  let crossesWaterline = false;
  for (let r = 40; r <= 160; r += 0.5) {
    const y = getIslandSurfaceY(islandA, islandA.position.x + dir.x * r, islandA.position.z + dir.z * r);
    if (prev !== null) maxStep = Math.max(maxStep, Math.abs(y - prev));
    if (Math.abs(y) < 0.3) crossesWaterline = true;
    prev = y;
  }
  expect('Beach: walk-in is continuous (max 0.5m-step height change < 0.45m)', maxStep < 0.45, `maxStep=${maxStep.toFixed(3)}`);
  expect('Beach: profile crosses the waterline smoothly', crossesWaterline);
}

// ── Cliff coasts: tall dramatic plinth that stays high to the rim ──
const cliffRim = getIslandSurfacePoint(islandA, 1.0, bestCliff.angle, 0);
const cliffPast = getIslandSurfacePoint(islandA, 1.15, bestCliff.angle, 0);
expect('Cliff: rim plinth stays tall (≥ 6.5m) at distRatio 1.0', cliffRim.y > 6.5, `y=${cliffRim.y.toFixed(2)}`);
expect('Cliff: plunges underwater past the rim', cliffPast.y < -2.0, `y=${cliffPast.y.toFixed(2)}`);

// ── Inlet mouths are always beach-type (harbors) ──
const cliffyIsland = makeIsland({ profile: { coastBias: 0.9 } });
const cliffyWithInlet = makeIsland({ profile: { coastBias: 0.9, inlets: [{ angle: 0, width: 0.45, depth: 0.35 }] } });
expect(
  'Inlet mouth forces beach coast even on a cliff-biased island',
  getIslandCoastType(cliffyIsland, 0) !== 'beach' && getIslandCoastType(cliffyWithInlet, 0) === 'beach',
  `without=${getIslandCoastType(cliffyIsland, 0)} with=${getIslandCoastType(cliffyWithInlet, 0)}`,
);

// ── Interior floor: inland terrain never dips below the terrain floor ──
let floorOk = true;
for (let gx = -130; gx <= 130; gx += 4) {
  for (let gz = -130; gz <= 130; gz += 4) {
    const x = islandA.position.x + gx;
    const z = islandA.position.z + gz;
    if (getIslandDistRatio(islandA, x, z).distRatio > 0.85) continue;
    if (getIslandSurfaceY(islandA, x, z) < 0.08 - 1e-9) floorOk = false;
  }
}
expect('Interior surface (distRatio ≤ 0.85) never drops below the terrain floor', floorOk);

// ── Submersion helper: beach apron swims, hilltop does not ──
expect('isSubmergedAt: underwater beach apron is submerged', isSubmergedAt(islandA, beachDeep.x, beachDeep.z, 0));
const hillTop = getIslandSurfacePoint(islandA, 0.2, 0.7, 0);
expect('isSubmergedAt: dry hilltop is not submerged', !isSubmergedAt(islandA, hillTop.x, hillTop.z, 0));

// ── Archipelago channels: saddles dip below the waterline INSIDE the footprint ──
const archi = makeIsland({
  radius: 88,
  profile: {
    terrainStyle: 'archipelago',
    heightProfile: 0.45,
    peakBoost: 0.4,
    mesaBias: 0.15,
    secondaryHillScale: 0.85,
    tertiaryHillScale: 0.7,
    primaryHillOffset: 34,
    secondaryHillOffset: 38,
    tertiaryHillOffset: 36,
    primaryHillAngle: 0.4,
    secondaryHillAngle: 3.2,
    tertiaryHillAngle: 2.0,
    footprintX: 1.7,
    footprintZ: 1.7,
  },
});
let channelPoint = null;
let channelY = Infinity;
for (let gx = -160; gx <= 160; gx += 4) {
  for (let gz = -160; gz <= 160; gz += 4) {
    const x = archi.position.x + gx;
    const z = archi.position.z + gz;
    if (getIslandDistRatio(archi, x, z).distRatio > 0.9) continue;
    const y = getIslandSurfaceY(archi, x, z);
    if (y < channelY) { channelY = y; channelPoint = { x, z }; }
  }
}
expect('Archipelago: an in-footprint channel dips below the waterline', channelY < -0.8, `minY=${channelY.toFixed(2)}`);
expect('Archipelago: channel bed reads as submerged', channelPoint !== null && isSubmergedAt(archi, channelPoint.x, channelPoint.z, 0));

// ── Cove/bay inlets alter the shared footprint used by mesh + physics ──
const plainShoreIsland = makeIsland({ profile: { inlets: [] } });
const inletIsland = makeIsland({
  profile: {
    inlets: [{ angle: 0, width: 0.5, depth: 0.4 }],
  },
});
const oldMouthShore = getIslandSurfacePoint(plainShoreIsland, 0.9, 0, 0);
const carvedDist = getIslandDistRatio(inletIsland, oldMouthShore.x, oldMouthShore.z).distRatio;
const newMouthShore = getIslandSurfacePoint(inletIsland, 0.98, 0, 0);
const sidePlain = getIslandSurfacePoint(plainShoreIsland, 0.98, Math.PI * 0.5, 0);
const sideInlet = getIslandSurfacePoint(inletIsland, 0.98, Math.PI * 0.5, 0);
const sideDrift = Math.hypot(sidePlain.x - sideInlet.x, sidePlain.z - sideInlet.z);
const cappedIsland = makeIsland({
  profile: {
    inlets: [
      { angle: 0, width: 0.7, depth: 0.5 },
      { angle: 0, width: 0.7, depth: 0.5 },
    ],
  },
});
expect('Inlet carves the old shoreline out of the footprint', carvedDist > 1.12 && !isPointInsideIslandFootprint(inletIsland, oldMouthShore.x, oldMouthShore.z, 0), `dist=${carvedDist.toFixed(2)}`);
expect('Inlet-generated shoreline still sits inside the shared footprint', isPointInsideIslandFootprint(inletIsland, newMouthShore.x, newMouthShore.z, 1), `point=${JSON.stringify(newMouthShore)}`);
expect('Inlet falloff leaves perpendicular shoreline stable', sideDrift < 0.001, `drift=${sideDrift}`);
expect('Overlapping inlet cuts are capped before eating the island core', getIslandInletCut(cappedIsland, 0) <= 0.6, `cut=${getIslandInletCut(cappedIsland, 0).toFixed(2)}`);

// ── Structure stamps flatten discs so buildings sit level ──
const stampIsland = makeIsland();
const stampCenter = getIslandSurfacePoint(stampIsland, 0.4, 2.0, 0);
stampIsland.stamps = [{ x: stampCenter.x, z: stampCenter.z, radius: 4.0, targetY: stampCenter.y, blend: 0.45 }];
let stampDev = 0;
for (let k = 0; k < 16; k++) {
  const t = (k / 16) * Math.PI * 2;
  const inner = 4.0 * (1 - 0.45);
  const y = getIslandSurfaceY(stampIsland, stampCenter.x + Math.cos(t) * inner * 0.8, stampCenter.z + Math.sin(t) * inner * 0.8);
  stampDev = Math.max(stampDev, Math.abs(y - stampCenter.y));
}
expect('Terrain stamp flattens its inner disc (deviation < 0.05m)', stampDev < 0.05, `dev=${stampDev.toFixed(4)}`);
// Outside the stamp the terrain is untouched.
const outsideStampY = getIslandSurfaceY(stampIsland, stampCenter.x + 9, stampCenter.z);
const noStampY = getIslandSurfaceY(makeIsland(), stampCenter.x + 9, stampCenter.z);
expect('Terrain outside the stamp radius is unchanged', outsideStampY === noStampY);

// ── Caves: opt-in trench carve, natural surface above, interior helpers ──
const caveIsland = makeIsland();
const noCaveIsland = makeIsland();
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
  floorY: cavePos.y - 1.0,
  ceilingY: cavePos.y - 1.0 + 4,
};
caveIsland.caves = [cave];
// Cave-local (lx=0, lz=-3) → 3 m inside the tunnel
const insideX = cavePos.x - 3 * Math.sin(caveRotation);
const insideZ = cavePos.z - 3 * Math.cos(caveRotation);
const naturalAbove = getIslandSurfaceY(caveIsland, insideX, insideZ);
const naturalRef = getIslandSurfaceY(noCaveIsland, insideX, insideZ);
expect('Walking above a cave stands on the NATURAL hillside (no default carve)', naturalAbove === naturalRef, `above=${naturalAbove.toFixed(2)} ref=${naturalRef.toFixed(2)}`);
const carvedY = getIslandSurfaceY(caveIsland, insideX, insideZ, { carveCaves: true });
expect('Opt-in carveCaves hollows the tunnel down to the cave floor', Math.abs(carvedY - cave.floorY) < 0.05, `y=${carvedY.toFixed(2)} floorY=${cave.floorY.toFixed(2)}`);
const floorInside = getCaveFloorY(caveIsland, insideX, insideZ);
expect('getCaveFloorY returns the carved floor inside the tunnel', floorInside !== null && Math.abs(floorInside - cave.floorY) < 0.05, `floor=${floorInside}`);
expect('getCaveFloorY returns null outside every cave', getCaveFloorY(caveIsland, cavePos.x + 60, cavePos.z + 60) === null);
const ceilInside = getCaveCeilingY(caveIsland, insideX, insideZ);
expect('getCaveCeilingY returns the interior ceiling inside the tunnel', ceilInside === cave.ceilingY, `ceil=${ceilInside}`);
expect('getCaveCeilingY returns null outside every cave', getCaveCeilingY(caveIsland, cavePos.x + 60, cavePos.z + 60) === null);
expect('Cave ceiling sits height above floor', ceilInside !== null && Math.abs(ceilInside - cave.floorY - cave.height) < 1e-9);

if (failures > 0) {
  console.error(`\n${failures} terrain contract check(s) failed`);
  process.exit(1);
}
console.log('\nAll terrain contract checks passed');
