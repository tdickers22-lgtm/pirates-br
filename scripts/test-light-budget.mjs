#!/usr/bin/env node
// The point-light budget contract.
//
// three.js is a single-pass forward renderer: the number of visible point
// lights is compiled INTO every shader program, and every lit fragment loops
// over all of them. So two invariants have to hold, forever:
//
//   1. the pool size never changes at runtime  → no material ever re-links
//      because a torch came into view (that churn was multi-second freezes on
//      join and on the first swim);
//   2. only the pool is ever counted           → a cave can hang thirty torches
//      and still cost eight lights per pixel.
//
// Registered emitters keep behaving like normal lights from the caller's side:
// LOD still writes `.visible` and the budget obeys it (read the intent back via
// budgetLightWanted), and positions still ride their parent transforms.
import * as THREE from 'three';
import {
  budgetEmitterCount,
  budgetLightWanted,
  budgetPoolSize,
  clearLightBudget,
  initLightBudget,
  registerBudgetLight,
  updateLightBudget,
} from '../src/client/rendering/LightBudget.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

/** Count the lights three.js would actually gather for this frame. */
function effectiveLights(scene) {
  let count = 0;
  const walk = (object) => {
    if (!object.visible) return;
    if (object.isPointLight) count += 1;
    for (const child of object.children) walk(child);
  };
  walk(scene);
  return count;
}

const CAMERA = new THREE.Vector3(0, 2, 0);

function makeWorld(tier, emitterCount) {
  clearLightBudget();
  const scene = new THREE.Scene();
  initLightBudget(scene, tier);
  const lights = [];
  for (let i = 0; i < emitterCount; i++) {
    // Fan the emitters out along +x so "nearest" is unambiguous.
    const light = new THREE.PointLight(0xffaa55, 3, 40, 2);
    light.position.set((i + 1) * 2, 2, 0);
    registerBudgetLight(light);
    scene.add(light);
    lights.push(light);
  }
  scene.updateMatrixWorld(true);
  return { scene, lights };
}

console.log('\nPool size is fixed per quality tier');
for (const [tier, expected] of [['low', 4], ['balanced', 6], ['high', 8]]) {
  const { scene } = makeWorld(tier, 30);
  expect(`${tier}: pool is ${expected} lights`, budgetPoolSize() === expected, `got ${budgetPoolSize()}`);
  expect(`${tier}: 30 emitters still cost ${expected} lights`, effectiveLights(scene) === expected,
    `got ${effectiveLights(scene)}`);
  updateLightBudget(CAMERA);
  expect(`${tier}: still ${expected} after an update`, effectiveLights(scene) === expected,
    `got ${effectiveLights(scene)}`);
}

console.log('\nThe count never moves, whatever the world does');
{
  const { scene, lights } = makeWorld('high', 24);
  const counts = new Set();
  scene.updateMatrixWorld(true);
  for (let frame = 0; frame < 12; frame++) {
    // Torches switching off, emitters walking past, whole branches hidden —
    // exactly the churn that used to re-link every program in the scene.
    for (let i = 0; i < lights.length; i++) lights[i].visible = (i + frame) % 3 !== 0;
    for (const light of lights) light.position.x += 3;
    scene.updateMatrixWorld(true);
    updateLightBudget(CAMERA);
    counts.add(effectiveLights(scene));
  }
  expect('light count is constant across 12 churning frames', counts.size === 1 && counts.has(8),
    `saw ${[...counts].join(', ')}`);
}

console.log('\nThe nearest emitters win the slots');
{
  const { scene, lights } = makeWorld('high', 20);
  scene.updateMatrixWorld(true);
  updateLightBudget(CAMERA);
  const pool = scene.children.filter((o) => o.isPointLight && o.name.startsWith('budget-light-'));
  expect('pool lights are named and present', pool.length === 8, `got ${pool.length}`);
  const lit = pool.filter((p) => p.intensity > 0);
  expect('every slot is filled when there are more emitters than slots', lit.length === 8,
    `got ${lit.length}`);
  const furthest = Math.max(...lit.map((p) => p.position.x));
  expect('no slot went to an emitter beyond the eighth nearest', furthest <= lights[7].position.x + 1e-6,
    `furthest lit slot at x=${furthest}`);
  const colour = lit[0].color.getHex();
  expect('slot carries the emitter colour', colour === 0xffaa55, `got ${colour.toString(16)}`);
}

console.log('\nHidden emitters and hidden branches contribute nothing');
{
  clearLightBudget();
  const scene = new THREE.Scene();
  initLightBudget(scene, 'high');
  const branch = new THREE.Group();
  scene.add(branch);
  const inBranch = new THREE.PointLight(0xffffff, 5, 40, 2);
  inBranch.position.set(3, 2, 0);
  registerBudgetLight(inBranch);
  branch.add(inBranch);
  const loose = new THREE.PointLight(0xffffff, 5, 40, 2);
  loose.position.set(9, 2, 0);
  registerBudgetLight(loose);
  scene.add(loose);
  scene.updateMatrixWorld(true);

  updateLightBudget(CAMERA);
  const pool = scene.children.filter((o) => o.isPointLight && o.name.startsWith('budget-light-'));
  expect('both emitters light up to start', pool.filter((p) => p.intensity > 0).length === 2);

  branch.visible = false;
  updateLightBudget(CAMERA);
  expect('an emitter under a hidden group goes dark', pool.filter((p) => p.intensity > 0).length === 1);

  branch.visible = true;
  loose.visible = false;
  updateLightBudget(CAMERA);
  expect('an emitter switched off by LOD goes dark', pool.filter((p) => p.intensity > 0).length === 1);
  expect('the intent LOD wrote is readable via budgetLightWanted',
    budgetLightWanted(loose) === false && budgetLightWanted(inBranch) === true);
  expect('but three is always told the emitter is invisible',
    loose.visible === false && inBranch.visible === false);
}

console.log('\nDetached emitters are forgotten, not leaked');
{
  const { scene, lights } = makeWorld('high', 6);
  expect('six emitters registered', budgetEmitterCount() === 6, `got ${budgetEmitterCount()}`);
  for (const light of lights) scene.remove(light);
  updateLightBudget(CAMERA);
  expect('an island torn down drops its emitters', budgetEmitterCount() === 0, `got ${budgetEmitterCount()}`);
  expect('the pool survives the teardown', budgetPoolSize() === 8, `got ${budgetPoolSize()}`);
}

console.log('\nA distant emitter cannot steal a slot from a near one');
{
  clearLightBudget();
  const scene = new THREE.Scene();
  initLightBudget(scene, 'low'); // 4 slots
  const near = new THREE.PointLight(0xffffff, 2, 30, 2);
  near.position.set(4, 2, 0);
  registerBudgetLight(near);
  scene.add(near);
  const far = new THREE.PointLight(0xffffff, 2, 30, 2);
  far.position.set(400, 2, 0); // past MAX_CONSIDER_DISTANCE and past its own range
  registerBudgetLight(far);
  scene.add(far);
  scene.updateMatrixWorld(true);
  updateLightBudget(CAMERA);
  const pool = scene.children.filter((o) => o.isPointLight && o.name.startsWith('budget-light-'));
  const lit = pool.filter((p) => p.intensity > 0);
  expect('only the emitter within reach is lit', lit.length === 1, `got ${lit.length}`);
  expect('and it is the near one', Math.abs(lit[0].position.x - 4) < 1e-6, `at x=${lit[0]?.position.x}`);
}

if (failures > 0) {
  console.error(`\n${failures} light-budget assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll light-budget assertions passed');
