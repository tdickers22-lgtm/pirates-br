#!/usr/bin/env node
// THE PER-FRAME UPLOAD ALLOWANCE, graded deterministically.
//
// WHY THIS EXISTS AND test-lod-reveal DOES NOT COVER IT. The mechanism being
// tested is per-FRAME: it spreads a group of first appearances over consecutive
// frames. Grading that in the browser needs frames, and the only GL backend this
// machine is allowed to run is SwiftShader, which draws this scene at one to five
// frames a second — a waypoint the rig parks at for 1.6s gets two or three
// frames, so "how much landed on one frame" measured there is mostly a question
// of where the frame boundaries happened to fall. Run to run on identical code it
// read 143, then 439. That is not a threshold that needs widening, it is a
// measurement that cannot be taken on this machine, and tuning against it was
// chasing noise.
//
// So the browser suite keeps the end-to-end numbers and this one holds the
// contract: no frame may exceed the allowance, everything held back must arrive,
// and it must arrive looking the way it would have.
//
//   node --import tsx scripts/test-first-draw-budget.mjs
import * as THREE from 'three';
import {
  beginFirstDrawFrame,
  clearFirstDrawBudget,
  firstDrawRemaining,
  showWhenAffordable,
  hasBeenDrawn,
} from '../src/client/rendering/FirstDrawBudget.js';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

/** A prop root of `n` meshes, parented into a visible world like the real ones. */
function makeProp(world, n, name) {
  const root = new THREE.Group();
  root.name = name;
  for (let i = 0; i < n; i++) root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  root.visible = false;
  world.add(root);
  return root;
}

/** Meshes under the roots that are visible AND reachable — what the driver sees. */
function drawnMeshes(roots) {
  let n = 0;
  for (const root of roots) {
    if (!root.visible) continue;
    let hidden = false;
    for (let c = root.parent; c; c = c.parent) if (!c.visible) hidden = true;
    if (hidden) continue;
    root.traverse((o) => { if (o.isMesh) n += 1; });
  }
  return n;
}

const ALLOWANCE = 48;

// ── the cap binds, and it binds across tiers ──────────────────────────────
{
  clearFirstDrawBudget();
  const world = new THREE.Group();
  // Deliberately mixed, the way a real frame is: forty-four chests at eight
  // meshes each is the measured case that started this.
  const props = [];
  for (let i = 0; i < 44; i++) props.push(makeProp(world, 8, `chest-${i}`));
  for (let i = 0; i < 12; i++) props.push(makeProp(world, 1, `rock-${i}`));

  let worstFrame = 0;
  let frames = 0;
  let previouslyDrawn = 0;
  while (props.some((p) => !p.visible) && frames < 500) {
    beginFirstDrawFrame();
    for (const p of props) showWhenAffordable(p, true);
    const now = drawnMeshes(props);
    worstFrame = Math.max(worstFrame, now - previouslyDrawn);
    previouslyDrawn = now;
    frames += 1;
  }
  expect(
    `no frame shows more than the ${ALLOWANCE}-mesh allowance`,
    worstFrame <= ALLOWANCE,
    `worst frame showed ${worstFrame} meshes`,
  );
  expect('everything asked for is eventually shown', props.every((p) => p.visible), `${props.filter((p) => !p.visible).length} still hidden`);
  // 44*8 + 12 = 364 meshes at 48 a frame is eight frames — an eighth of a second
  // at 60fps, spent on props at the far edge of their radius.
  expect('and it takes a handful of frames, not hundreds', frames <= 12, `took ${frames} frames`);
}

// ── an object the driver has already drawn is never gated again ───────────
{
  clearFirstDrawBudget();
  const world = new THREE.Group();
  const prop = makeProp(world, 8, 'chest');
  beginFirstDrawFrame();
  showWhenAffordable(prop, true);
  expect('a first appearance is paid for once', prop.visible && hasBeenDrawn(prop));

  // Now exhaust a frame completely and ask again: it must still come back.
  beginFirstDrawFrame();
  const hogs = [];
  for (let i = 0; i < 20; i++) hogs.push(makeProp(world, 8, `hog-${i}`));
  for (const h of hogs) showWhenAffordable(h, true);
  showWhenAffordable(prop, false);
  showWhenAffordable(prop, true);
  expect(
    'an object that has been on screen is never held back, even on a full frame',
    prop.visible,
    `remaining allowance was ${firstDrawRemaining()}`,
  );
}

// ── hiding is immediate ───────────────────────────────────────────────────
{
  clearFirstDrawBudget();
  const world = new THREE.Group();
  const prop = makeProp(world, 8, 'chest');
  beginFirstDrawFrame();
  showWhenAffordable(prop, true);
  beginFirstDrawFrame();
  for (let i = 0; i < 20; i++) showWhenAffordable(makeProp(world, 8, `hog-${i}`), true);
  showWhenAffordable(prop, false);
  expect('hiding is never deferred — it costs nothing and delaying it would show', !prop.visible);
}

// ── a root bigger than the whole allowance still gets through ─────────────
{
  clearFirstDrawBudget();
  const world = new THREE.Group();
  const hull = makeProp(world, 78, 'ship-detail-root');
  let frames = 0;
  while (!hull.visible && frames < 50) {
    beginFirstDrawFrame();
    showWhenAffordable(hull, true);
    frames += 1;
  }
  expect('a hull heavier than the whole allowance is not starved forever', hull.visible, `${frames} frames and still hidden`);

  // …but only on a frame it has to itself, so it cannot stack on top of others.
  clearFirstDrawBudget();
  const world2 = new THREE.Group();
  const hull2 = makeProp(world2, 78, 'ship-detail-root');
  const chest = makeProp(world2, 8, 'chest');
  beginFirstDrawFrame();
  showWhenAffordable(chest, true);
  showWhenAffordable(hull2, true);
  expect('an oversized root waits rather than piling onto a spent frame', chest.visible && !hull2.visible);
}

// ── a prop under a hidden group neither spends nor claims the allowance ───
{
  clearFirstDrawBudget();
  const world = new THREE.Group();
  world.visible = false; // an island group held back for a frame after its build
  const props = [];
  for (let i = 0; i < 20; i++) props.push(makeProp(world, 8, `chest-${i}`));
  beginFirstDrawFrame();
  for (const p of props) showWhenAffordable(p, true);
  expect(
    'props under a hidden island do not burn the frame they cannot draw on',
    firstDrawRemaining() === ALLOWANCE,
    `allowance went to ${firstDrawRemaining()}`,
  );
  expect('…and none of them is recorded as drawn', props.every((p) => !hasBeenDrawn(p)));

  // The island shows: now they cost, and are spread.
  world.visible = true;
  beginFirstDrawFrame();
  for (const p of props) showWhenAffordable(p, true);
  expect('…so the frame the island appears is itself budgeted', drawnMeshes(props) <= ALLOWANCE, `${drawnMeshes(props)} meshes`);
}

// ── teardown does not let the next match inherit "already drawn" ──────────
{
  clearFirstDrawBudget();
  const world = new THREE.Group();
  const prop = makeProp(world, 8, 'chest');
  beginFirstDrawFrame();
  showWhenAffordable(prop, true);
  clearFirstDrawBudget();
  expect('a match teardown forgets what the driver had drawn', !hasBeenDrawn(prop));
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nFirst-draw allowance checks passed.');
