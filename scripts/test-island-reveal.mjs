#!/usr/bin/env node
// THE ISLAND MUST NEVER LEAVE THE WORLD.
//
// The chunked reveal hides an island's whole detail subtree the instant the
// camera crosses the detail radius and lets it back out over the following
// frames. That is the right medicine for the upload burst, but it means the
// detail tier draws NOTHING on the crossing frame — and the LOD pass drops the
// proxy on that same frame. Between the two, the island is not in the scene at
// all, and it stays that way until the reveal reaches it.
//
// That is not a frame. The reveal pump has a per-frame allowance and used to
// hand all of it to whichever job came first in the map, so islands crossing
// together queued behind each other. Measured in the browser on a cold
// approach, three islands over their radii at once:
//
//     castaway-reach   detail=1 proxy=0   0/658 meshes released
//     gallows-sands    detail=1 proxy=0   0/544 meshes released
//     skull-cove       detail=1 proxy=0   7/896 meshes released
//
// …and twenty seconds later the first two were still at zero. Two islands
// simply absent from the sea while you sailed at them.
//
// So this suite holds two contracts, both deterministic and neither needing a
// GL context: the proxy stays up until the detail tier has the silhouette on
// screen, and no island can be starved of the allowance by another.
//
//   node --import tsx scripts/test-island-reveal.mjs
import * as THREE from 'three';
import { IslandDetailWarmer } from '../src/client/rendering/IslandDetailWarmup.js';
import { beginFirstDrawFrame, clearFirstDrawBudget } from '../src/client/rendering/FirstDrawBudget.js';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

/** A mesh with real attribute data, so the reveal sees a geometry bill to pay. */
function makeMesh(name) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 64), 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = name;
  return mesh;
}

/** An island group shaped like the real one: a detail root whose silhouette
 *  tier is named the way `revealPriority` expects, and a proxy terrain. */
function makeIsland(scene, id, props) {
  const group = new THREE.Group();
  group.name = `island-${id}`;
  const detailRoot = new THREE.Group();
  detailRoot.name = 'island-detail-root';
  detailRoot.add(makeMesh('island-terrain'));
  detailRoot.add(makeMesh('island-shore-skirt'));
  for (let i = 0; i < props; i++) detailRoot.add(makeMesh(`decor-${i}`));
  const proxyRoot = new THREE.Group();
  proxyRoot.name = 'island-proxy-root';
  proxyRoot.add(makeMesh('island-proxy-terrain'));
  proxyRoot.visible = false;
  group.add(detailRoot);
  group.add(proxyRoot);
  scene.add(group);
  return { id, group, detailRoot, proxyRoot };
}

/** Meshes the driver would actually be asked to draw for this island. */
function drawable(island) {
  let n = 0;
  for (const root of [island.detailRoot, island.proxyRoot]) {
    if (!root.visible) continue;
    root.traverse((node) => {
      if (!node.isMesh || !node.visible) return;
      for (let cursor = node.parent; cursor && cursor !== root; cursor = cursor.parent) {
        if (!cursor.visible) return;
      }
      n += 1;
    });
  }
  return n;
}

function newWarmer(scene) {
  const camera = new THREE.PerspectiveCamera();
  const renderer = { compile() {}, initTexture() {} };
  return new IslandDetailWarmer(() => ({ renderer, scene, camera }));
}

/** One frame of the real sequence, in the real order: the warmer's release pass
 *  runs at the top of `updateEnvironmentLod`, the LOD decisions after it. */
function frame(warmer, islands, shown, showDetailFor) {
  beginFirstDrawFrame();
  warmer.update();
  for (const island of islands) {
    const wasShown = shown.get(island.id) ?? false;
    const showDetail = showDetailFor(island);
    if (showDetail !== wasShown) {
      shown.set(island.id, showDetail);
      if (showDetail) warmer.beginReveal(island.id, island.detailRoot);
      else warmer.cancelReveal(island.id);
    }
    island.detailRoot.visible = showDetail;
    island.proxyRoot.visible = !showDetail || warmer.revealSilhouettePending(island.id);
  }
}

// ── one island, crossed once: never a frame with nothing on screen ────────
{
  clearFirstDrawBudget();
  const scene = new THREE.Scene();
  const warmer = newWarmer(scene);
  const island = makeIsland(scene, 'lone', 400);
  const shown = new Map();
  let inside = false;
  let emptyFrames = 0;
  let proxyAndTerrain = 0;
  for (let f = 0; f < 200; f++) {
    if (f === 3) inside = true;
    frame(warmer, [island], shown, () => inside);
    if (drawable(island) === 0) emptyFrames += 1;
    // The handoff must not double-draw either: once the real terrain is up the
    // proxy is down, or the island wears two skins for a frame.
    const terrainUp = island.detailRoot.visible
      && island.detailRoot.getObjectByName('island-terrain').visible;
    if (terrainUp && island.proxyRoot.visible) proxyAndTerrain += 1;
  }
  expect('a crossing never leaves the island with nothing on screen', emptyFrames === 0, `${emptyFrames} empty frames`);
  expect('and never draws the proxy over the real terrain', proxyAndTerrain === 0, `${proxyAndTerrain} doubled frames`);
  expect('the reveal finishes', !warmer.isRevealing('lone'));
}

// ── three islands crossing together: none of them is starved ──────────────
{
  clearFirstDrawBudget();
  const scene = new THREE.Scene();
  const warmer = newWarmer(scene);
  const islands = [
    makeIsland(scene, 'skull-cove', 894),
    makeIsland(scene, 'castaway-reach', 656),
    makeIsland(scene, 'gallows-sands', 542),
  ];
  const shown = new Map();
  let inside = false;
  let emptyFrames = 0;
  /** Frame each island first had its own silhouette up (proxy handed over). */
  const handover = new Map();
  const FRAMES = 400;
  for (let f = 0; f < FRAMES; f++) {
    if (f === 3) inside = true;
    frame(warmer, islands, shown, () => inside);
    for (const island of islands) {
      if (drawable(island) === 0) emptyFrames += 1;
      if (!handover.has(island.id) && !warmer.revealSilhouettePending(island.id) && shown.get(island.id)) {
        handover.set(island.id, f);
      }
    }
  }
  expect('three islands crossing together are all still in the world', emptyFrames === 0, `${emptyFrames} empty island-frames`);
  expect('all three hand over from proxy to detail', handover.size === 3, `${handover.size} of 3: ${JSON.stringify([...handover])}`);
  // The starvation signature: the last island to get any allowance waited on
  // the whole of the ones in front of it. Round-robin puts them within a few
  // frames of each other instead.
  const waits = [...handover.values()];
  const spread = Math.max(...waits) - Math.min(...waits);
  expect('and none of them waits for the others to finish', spread <= 6, `handover spread ${spread} frames: ${JSON.stringify([...handover])}`);
  expect('every reveal drains', islands.every((i) => !warmer.isRevealing(i.id)));
  // …and everything held back is eventually on screen, which is the whole point
  // of holding it back rather than dropping it.
  for (const island of islands) {
    let hidden = 0;
    island.detailRoot.traverse((node) => { if (node.isMesh && !node.visible) hidden += 1; });
    expect(`${island.id} shows every mesh once the reveal drains`, hidden === 0, `${hidden} still hidden`);
  }
}

// ── backing out mid-reveal puts the flags back ────────────────────────────
{
  clearFirstDrawBudget();
  const scene = new THREE.Scene();
  const warmer = newWarmer(scene);
  const island = makeIsland(scene, 'passing', 400);
  const shown = new Map();
  let inside = false;
  for (let f = 0; f < 6; f++) {
    if (f === 2) inside = true;
    if (f === 4) inside = false;
    frame(warmer, [island], shown, () => inside);
  }
  let hidden = 0;
  island.detailRoot.traverse((node) => { if (node.isMesh && !node.visible) hidden += 1; });
  expect('an island left mid-reveal keeps none of its meshes hidden', hidden === 0, `${hidden} stranded`);
  expect('…and is back on its proxy', island.proxyRoot.visible && !island.detailRoot.visible);
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nIsland reveal continuity checks passed.');
