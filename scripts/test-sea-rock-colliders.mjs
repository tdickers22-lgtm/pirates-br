#!/usr/bin/env node
import {
  buildSeaRockColliders,
  getSeaRockBoundsRadius,
  intersectRaySeaRock,
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

console.log('Sea rock mesh collider contract');

const colliderSet = buildSeaRockColliders(22, 34, 0.6, 2);
const rock = {
  id: 'rock-test',
  position: { x: 0, y: 0, z: 0 },
  radius: 22,
  height: 34,
  rotation: 0.6,
  variant: 2,
  colliderBoundsRadius: colliderSet.boundsRadius,
  colliders: colliderSet.colliders,
};

expect('Generates one main collider plus variant shards', rock.colliders.length === 7, `count=${rock.colliders.length}`);
expect('Broad collision radius covers the authoring radius', getSeaRockBoundsRadius(rock) >= rock.radius, `bounds=${getSeaRockBoundsRadius(rock)}`);

const horizontalHit = intersectRaySeaRock(
  { x: -60, y: 8, z: 0 },
  { x: 1, y: 0, z: 0 },
  120,
  rock,
);
expect('Horizontal weapon ray hits the rock body', horizontalHit !== null && horizontalHit > 25 && horizontalHit < 60, `hit=${horizontalHit}`);

const highMiss = intersectRaySeaRock(
  { x: -60, y: 90, z: 0 },
  { x: 1, y: 0, z: 0 },
  120,
  rock,
);
expect('Weapon ray above the mesh does not hit', highMiss === null, `hit=${highMiss}`);

const sideMiss = intersectRaySeaRock(
  { x: -60, y: 8, z: 85 },
  { x: 1, y: 0, z: 0 },
  120,
  rock,
);
expect('Weapon ray beside the broad mesh does not hit', sideMiss === null, `hit=${sideMiss}`);

const verticalHit = intersectRaySeaRock(
  { x: 0, y: 80, z: 0 },
  { x: 0, y: -1, z: 0 },
  120,
  rock,
);
expect('Falling projectile ray can hit the top of the rock', verticalHit !== null && verticalHit > 45 && verticalHit < 90, `hit=${verticalHit}`);

if (failures > 0) {
  console.error(`\n${failures} sea-rock collider assertion(s) failed.`);
  process.exit(1);
}

console.log('\nAll sea-rock collider assertions passed.');
