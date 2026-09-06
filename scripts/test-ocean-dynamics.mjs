#!/usr/bin/env node
// Shared water field, its emitted shader, and actual server hull buoyancy.
// CPU only: constructing three geometry/materials creates no WebGL context.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OceanRenderer } from '../src/client/rendering/OceanRenderer.ts';
import { OceanBathymetry } from '../src/client/rendering/OceanBathymetry.ts';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import {
  gerstnerHeight, gerstnerVerticalVelocity, getOceanRoughness,
  getStormWaveIntensity, WAVE_PARAMS,
  getIslandSurfacePoint, getIslandMaxRadius,
} from '../src/shared/utils/index.ts';

const wave = [{ amplitude: 1, wavelength: 40, direction: { x: 1, y: 0 }, dirX: 1, dirY: 0, speed: 5 }];
let mean = 0;
for (let i = 0; i < 1024; i++) mean += gerstnerHeight(i * 40 / 1024, 0, 0, wave) / 1024;
const crest = gerstnerHeight(10, 0, 0, wave);
const trough = gerstnerHeight(30, 0, 0, wave);
assert.ok(Math.abs(mean) < 1e-12, `wave shape changes mean sea level: ${mean}`);
assert.ok(crest > Math.abs(trough) * 1.25, `crest/trough remain symmetric: ${crest}/${trough}`);
console.log('PASS: sharper crests and broader troughs preserve mean sea level');

let maxVelocityError = 0;
for (const t of [0, 17, 115, 280, 500, 770, 1300]) {
  for (const storm of [0, 0.38, 1]) {
    for (const [x, z, vx, vz] of [[0, 0, 0, 0], [170, -130, 8, -3], [-800, 420, -6, 11]]) {
      const eps = 0.0001;
      const next = gerstnerHeight(x + vx * eps, z + vz * eps, t + eps, WAVE_PARAMS, storm);
      const prev = gerstnerHeight(x - vx * eps, z - vz * eps, t - eps, WAVE_PARAMS, storm);
      const speed = gerstnerVerticalVelocity(x, z, t, WAVE_PARAMS, storm, vx, vz);
      maxVelocityError = Math.max(maxVelocityError, Math.abs(speed - (next - prev) / (2 * eps)));
    }
  }
}
assert.ok(maxVelocityError < 1e-6, `surface velocity disagrees with moving samples: ${maxVelocityError}`);
console.log(`PASS: moving-water velocity matches finite differences (${maxVelocityError.toExponential(2)})`);

const scene = new THREE.Scene();
const ocean = new OceanRenderer();
ocean.init(scene, 'low');
const grid = scene.getObjectByName('ocean-lod-grid');
const material = grid.children[0].material;
// Execute the arithmetic actually emitted into the vertex and fragment shader.
// This catches a profile/normal change landing on only one side of the wire.
const body = material.vertexShader.match(/vec3 waveField\(vec2 p, float camDist\) \{([\s\S]+?)\n  \}/)?.[1];
assert.ok(body, 'the ocean material must contain its generated wave field');
assert.ok(material.fragmentShader.includes(body), 'fragment normals must sample the same emitted wave field');
const evalField = new Function('p', 'camDist', 'u_time', 'u_roughness', 'stormWaveIntensity',
  'dot', 'vec2', 'vec3', 'smoothstep',
  body.replace(/\bfloat\b/g, 'let').replace(/\b(sin|cos)\(/g, 'Math.$1('));
const smoothstep = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
let maxShaderError = 0;
let maxNormalError = 0;
for (const t of [0, 39, 250]) {
  for (const storm of [0, 0.38, 1]) {
    for (const [x, z] of [[0, 0], [140, -370], [-780, 520]]) {
      const field = evalField([x, z], 0, t, getOceanRoughness(t), () => storm,
        (a, b) => a[0] * b[0] + a[1] * b[1], (a, b) => [a, b], (...v) => v, smoothstep);
      const height = gerstnerHeight(x, z, t, WAVE_PARAMS, storm);
      maxShaderError = Math.max(maxShaderError, Math.abs(height - field[0]));
      const eps = 0.001;
      const dx = (gerstnerHeight(x + eps, z, t, WAVE_PARAMS, storm)
        - gerstnerHeight(x - eps, z, t, WAVE_PARAMS, storm)) / (2 * eps);
      const dz = (gerstnerHeight(x, z + eps, t, WAVE_PARAMS, storm)
        - gerstnerHeight(x, z - eps, t, WAVE_PARAMS, storm)) / (2 * eps);
      maxNormalError = Math.max(maxNormalError, Math.abs(dx - field[1]), Math.abs(dz - field[2]));
    }
  }
}
assert.ok(maxShaderError < 0.012, `CPU/GPU height mismatch: ${maxShaderError}m`);
assert.ok(maxNormalError < 0.002, `shader normals disagree with displacement: ${maxNormalError}`);
assert.ok(!material.vertexShader.includes('v_shoreDamp'), 'shore tint must not separate rendered and physical heights');
console.log(`PASS: emitted shader matches physical height and slope (${maxShaderError.toFixed(5)}m / ${maxNormalError.toFixed(6)})`);
grid.traverse((object) => { object.geometry?.dispose(); });
material.dispose();

const islands = new MapGenerator(20260801).generateIslands();
const depthMap = new OceanBathymetry(islands);
const initialVersion = depthMap.texture.version;
assert.equal(depthMap.step(0), false, 'a zero-budget row must not block on a whole map');
assert.equal(depthMap.texture.version, initialVersion, 'partial island depths must not be uploaded');
depthMap.step(Infinity);
assert.equal(depthMap.complete, true, 'all coastline samples must complete');
assert.equal(depthMap.texture.version, initialVersion + 1, 'complete depth map uploads exactly once');
const readBed = (x, z) => {
  const { data, width, height } = depthMap.texture.image;
  const b = depthMap.bounds;
  const col = Math.max(0, Math.min(width - 1, Math.floor((x - b.x) / b.z * width)));
  const row = Math.max(0, Math.min(height - 1, Math.floor((z - b.y) / b.w * height)));
  return data[(row * width + col) * 4] / 255 * 20 - 12;
};
for (const island of islands.filter(i => i.profile.terrainStyle === 'crescent')) {
  const angle = island.profile.primaryHillAngle + Math.PI;
  const bay = getIslandSurfacePoint(island, 0.5, angle);
  const headland = getIslandSurfacePoint(island, 0.5, angle + 1.4);
  assert.ok(readBed(bay.x, bay.z) < -1, `${island.name} bay must not inherit the island ellipse's foam`);
  assert.ok(readBed(headland.x, headland.z) > 3, `${island.name} headland is missing from shoreline texture`);
}
const booty = islands.find(i => i.id === 'booty-bay');
const cay = getIslandSurfacePoint(booty, 0.8, booty.profile.primaryHillAngle + Math.PI);
assert.ok(readBed(cay.x, cay.z) > 1, 'sand cay must get its own shallow-water boundary');
for (const island of islands) {
  const reach = getIslandMaxRadius(island) + 42;
  // Near each row-job's outer bounds, deep water must already match the
  // unsampled sea. A uniform -6.5m physics floor here made visible rectangles.
  for (const [dx, dz] of [[reach, 0], [-reach, 0], [0, reach], [0, -reach]]) {
    assert.ok(readBed(island.position.x + dx, island.position.z + dz) < -11.8,
      `${island.name}: bathymetry has a rectangular shelf at its sampling boundary`);
  }
}
depthMap.dispose();
console.log('PASS: time-sliced bathymetry follows bays/cays and joins deep water without rectangular shelves');

function makeShip(type) {
  const stats = SHIP_STATS[type];
  return {
    id: `ocean-${type}`, type, ownerId: 'test', crewIds: [],
    position: { x: 310, y: 0, z: -220 }, velocity: { x: 0, y: 0, z: 0 },
    rotation: 0, angularVelocity: 0, sailHeight: 0, sailAngle: 0,
    anchored: true, anchorRaiseProgress: 0, holes: [], nextHoleId: 1,
    maxHull: stats.maxHull, onFire: false, fireTimer: 0, fireDamageAccum: 0,
    sinkProgress: 0, sinking: false, cannonCooldowns: Array(stats.cannonCount).fill(0),
    chainshottedUntil: 0, sailIntegrity: 1, sailRepairWoodTimer: 0,
    gold: 0, treasureChestIds: [], inventory: [], repairCooldown: 0,
    autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}

for (const storm of [null, { centerX: 0, centerZ: 0, safeRadius: 20, phase: 6 }]) {
  for (const type of ['sloop', 'brigantine', 'galleon']) {
    const physics = new PhysicsSystem();
    const ship = makeShip(type);
    let squaredError = 0;
    let maxError = 0;
    let samples = 0;
    for (let i = 0; i < 40 * 60; i++) {
      const t = i / 60;
      physics.update(1 / 60, t, [ship], [], [], [], [], storm);
      if (t < 6) continue;
      const intensity = getStormWaveIntensity(storm, ship.position.x, ship.position.z);
      const height = gerstnerHeight(ship.position.x, ship.position.z, t, WAVE_PARAMS, intensity);
      const error = Math.abs(ship.position.y - height);
      squaredError += error * error;
      maxError = Math.max(maxError, error);
      samples++;
      assert.ok(Number.isFinite(ship.position.y) && Math.abs(ship.pitch ?? 0) <= 0.5
        && Math.abs(ship.roll ?? 0) <= 0.6, `${type} lost stable wave attitude`);
    }
    const rms = Math.sqrt(squaredError / samples);
    const label = `${type} ${storm ? 'storm' : 'calm'}`;
    assert.ok(rms < (storm ? 0.30 : 0.10), `${label} lags the moving water: RMS ${rms}`);
    assert.ok(maxError < (storm ? 0.8 : 0.30), `${label} heave spike: ${maxError}`);
    console.log(`PASS: ${label} buoyancy follows moving water (RMS ${rms.toFixed(3)}m, peak ${maxError.toFixed(3)}m)`);
  }
}
