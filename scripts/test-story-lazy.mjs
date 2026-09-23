#!/usr/bin/env node
// LOD-01 / assets-08 — THE COUNTDOWN STOPS WAITING FOR SEVENTEEN MEGABYTES.
//
// The fifteen story tableaux (wrecker tower, kraken wreck, whale skeleton, …)
// are 25-48k triangles each and were every one of them fetched and decoded
// inside `preloadWorld()`, i.e. on the critical path between "queue full" and
// "match starts", for scenery at most two of which exist on the island the
// player spawns on. They now load through `AssetLibrary.ensure()` while a
// seated, named, one-instance placeholder holds their place in the world.
//
// This grades the four things that make that safe rather than merely cheaper:
//   1. the three sets PARTITION the library — nothing loads twice, nothing is
//      dropped, and `preloadWorld()` names no story scene;
//   2. `ensure()` fetches a name ONCE however many callers ask, caps how many
//      GLBs are in flight (LAZY_FETCH_DEPTH), and a priority request PROMOTES a
//      queued one instead of opening a second socket;
//   3. `updateInstanceLod` fires that promotion exactly once, inside
//      LAZY_PRIORITY_M and never outside it — so the per-frame path has no
//      per-frame cost for a scene that already arrived;
//   4. PropScatterer's placeholder is SEATED (its instance matrix lifts the
//      unit box by its own half-height) and carries the `prop-<type>` name, so
//      the floating-prop census counts the same pieces before and after the
//      swap.
//
// No stack, no browser: `node --import tsx scripts/test-story-lazy.mjs`.
// RED ON HEAD: LAZY_ASSET_NAMES does not exist and WORLD_ASSET_NAMES names all
// fifteen scenes. Mutation proof: put one story scene back into the world set
// and check 1 fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as THREE from 'three';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

const Lib = await import('../src/client/assets/AssetLibrary.ts');
const Lod = await import('../src/client/world/island/InstanceLod.ts');

console.log('Story-scene lazy load (LOD-01 / assets-08)');

// ── 1. the sets partition the library ────────────────────────────────────
const all = new Set(Lib.ASSET_NAMES);
const boot = new Set(Lib.BOOT_ASSET_NAMES);
const world = new Set(Lib.WORLD_ASSET_NAMES);
const lazy = new Set(Lib.LAZY_ASSET_NAMES ?? []);
expect('fifteen story scenes are declared lazy', lazy.size === 15, `got ${lazy.size}`);
const leaked = [...lazy].filter((n) => world.has(n) || boot.has(n));
expect('preloadWorld/preloadBoot name no story scene', leaked.length === 0, `leaked: ${leaked.join(', ')}`);
const union = new Set([...boot, ...world, ...lazy]);
expect('boot + world + lazy = the whole library',
  union.size === all.size && [...all].every((n) => union.has(n)),
  `library ${all.size}, covered ${union.size}`);
expect('every lazy name is a real asset', [...lazy].every((n) => all.has(n)));
expect('isLazyAsset agrees with the set',
  Lib.isLazyAsset('kraken_wreck') && !Lib.isLazyAsset('palm_a') && !Lib.isLazyAsset('barrel'));

// ── 2. ensure(): once per name, depth-capped, priority promotes ──────────
const lib = new Lib.AssetLibrary();
const started = [];
const gates = new Map();
lib.loader = {
  loadAsync(url) {
    started.push(url.replace('/assets/models/', '').replace('.glb', ''));
    return new Promise((res) => gates.set(started[started.length - 1], () => res({ scene: new THREE.Group(), animations: [] })));
  },
};
const names = [...lazy];
const pending = names.map((n) => lib.ensure(n));
const again = lib.ensure(names[0]);
await Promise.resolve();
expect('two callers of ensure() share one promise', again === pending[0]);
expect('at most LAZY_FETCH_DEPTH GLBs in flight', started.length === 4, `in flight: ${started.length}`);
// the last name is at the BACK of the queue; promoting it must make it next.
const lastName = names[names.length - 1];
lib.ensure(lastName, true);
gates.get(started[0])();
await pending[0];
await new Promise((r) => setTimeout(r, 0));
expect('a priority request jumps the queue instead of opening a socket',
  started[4] === lastName, `next fetch was ${started[4]}`);
expect('a promoted name is not fetched twice',
  started.filter((n) => n === lastName).length === 1);
// Drain: opening the four in flight lets the queue pump the next four, whose
// gates only exist after a turn of the loop — so keep going until the last
// promise settles rather than iterating the map once.
for (let spin = 0; spin < 200 && names.some((n) => !lib.has(n)); spin++) {
  for (const [, open] of gates) open();
  await new Promise((r) => setTimeout(r, 0));
}
await Promise.all(pending);
expect('every ensured scene lands', names.every((n) => lib.has(n)));
expect('an already-loaded name ensures without a fetch',
  lib.ensure(names[0]) instanceof Promise && started.filter((n) => n === names[0]).length === 1);

// ── 3. LAZY MEANS NEAR (b1.1g, performance-09) ───────────────────────────
// The slot's LOD0 state machine, driven with a stub library: nothing fetched
// beyond the fetch line, one priority ensure inside it, the proxy hidden in the
// same step LOD0 appears, a phone evicting past 1.5 km and re-fetching on the
// next approach, and eviction held while another slot still shows the scene.
// RED ON f5fee97e..5e1edb53: makeStoryResidency does not exist and
// lazyStoryStandIn queues an unconditional `assets.ensure(name)` at build time.
const Scat = await import('../src/client/world/island/PropScatterer.ts');
const tick = () => new Promise((r) => setTimeout(r, 0));
function stubLib(deferred = false) {
  const calls = { ensure: [], evict: [] };
  const loaded = new Set();
  const opens = [];
  return {
    calls, opens,
    ensure(n, priority) {
      calls.ensure.push({ n, priority });
      if (!deferred) { loaded.add(n); return Promise.resolve(); }
      return new Promise((res) => opens.push(() => { loaded.add(n); res(); }));
    },
    evict(n) { calls.evict.push(n); return loaded.delete(n); },
  };
}
function slotFor(name, phone, lib) {
  const island = new THREE.Group();
  const ph = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  ph.name = `prop-${name}`;
  island.add(ph);
  const built = [];
  const res = Scat.makeStoryResidency({ name, proxy: ph, phone, lib, build: () => { const g = new THREE.Group(); built.push(g); return g; } });
  return { island, ph, built, res };
}
expect('fetch lines: 600 m desktop, 400 m phone, evict beyond 1500 m (phone)',
  Lib.LAZY_PRIORITY_M === 600 && Lib.STORY_LOD0_PHONE_M === 400 && Lib.STORY_EVICT_PHONE_M === 1500);
{
  const lib = stubLib();
  const s = slotFor('kraken_wreck', false, lib);
  for (const d of [3000, 1500, 900, Lib.LAZY_PRIORITY_M + 1]) s.res(d);
  await tick();
  expect('desktop: no LOD0 fetch while the island edge is beyond 600 m', lib.calls.ensure.length === 0,
    `fetched ${lib.calls.ensure.length}x`);
  s.res(Lib.LAZY_PRIORITY_M - 1);
  await tick();
  expect('desktop: one PRIORITY ensure on crossing 600 m', lib.calls.ensure.length === 1 && lib.calls.ensure[0].priority === true);
  const real = s.built[0];
  expect('the resolve swaps LOD0 in and hides the proxy in the same step (no gap, no double draw)',
    real?.parent === s.island && s.ph.parent === s.island && s.ph.visible === false && real.name === 'prop-kraken_wreck',
    `real parent ${real?.parent === s.island}, proxy visible ${s.ph.visible}, name ${real?.name}`);
  expect('while LOD0 stands the prop-<type> name is on the scene only',
    s.island.children.filter((c) => c.name === 'prop-kraken_wreck').length === 1);
  s.res(10); s.res(300);
  await tick();
  expect('no second fetch or build while LOD0 stands', lib.calls.ensure.length === 1 && s.built.length === 1);
  s.res(5000);
  await tick();
  expect('desktop never evicts', lib.calls.evict.length === 0 && s.ph.visible === false && real.parent === s.island);
}
{
  const lib = stubLib();
  const s = slotFor('gallows', true, lib);
  s.res(500);
  await tick();
  expect('phone: no LOD0 fetch at 500 m (phone line is 400 m)', lib.calls.ensure.length === 0);
  s.res(399);
  await tick();
  const first = s.built[0];
  expect('phone: LOD0 fetched and shown inside 400 m', lib.calls.ensure.length === 1 && first?.parent === s.island && !s.ph.visible);
  s.res(1400);
  await tick();
  expect('phone: LOD0 held between 400 m and 1500 m (hysteresis)', lib.calls.evict.length === 0 && first.parent === s.island);
  s.res(1501);
  await tick();
  expect('phone: past 1500 m LOD0 leaves, the proxy returns, the library evicts once',
    first.parent === null && s.ph.visible === true && s.ph.name === 'prop-gallows' && lib.calls.evict.length === 1 && lib.calls.evict[0] === 'gallows',
    `scene parent ${first.parent}, proxy visible ${s.ph.visible}, evictions ${lib.calls.evict.length}`);
  s.res(2500);
  expect('phone: an evicted slot evicts nothing more', lib.calls.evict.length === 1);
  s.res(350);
  await tick();
  expect('phone: re-approach re-ensures and re-shows LOD0',
    lib.calls.ensure.length === 2 && s.built.length === 2 && s.built[1].parent === s.island && !s.ph.visible);
}
{
  const lib = stubLib(true);
  const s = slotFor('dig_site', true, lib);
  s.res(100);
  s.res(1600);
  lib.opens.shift()();
  await tick(); await tick();
  expect('phone: a fetch that lands after its slot went far is not shown and is evicted',
    s.built.length === 0 && s.ph.visible === true && lib.calls.evict.filter((n) => n === 'dig_site').length === 2);
}
{
  const lib = stubLib();
  const a = slotFor('mine_head', true, lib);
  const b = slotFor('mine_head', true, lib);
  a.res(100); b.res(100);
  await tick();
  a.res(2000);
  expect('phone: a scene another slot still shows is not evicted', lib.calls.evict.length === 0);
  b.res(2000);
  expect('phone: the last holder letting go evicts it', lib.calls.evict.length === 1);
}
{
  const seen = [];
  const stand = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 1);
  Lod.attachLazyStoryLod(stand, (d) => seen.push(d));
  const batches = Lod.collectInstanceLodBatches(stand);
  expect('the proxy is collected as a batch', batches.length === 1);
  Lod.updateInstanceLod(batches, 500, 'low', 12);
  Lod.updateLazyStoryResidency(batches, 1800);
  expect('residency gets REAL edge metres (a 12x scope does not fetch the map), on and off the detail band',
    seen.length === 2 && seen[0] === 500 && seen[1] === 1800, `saw ${seen.join(', ')}`);
  expect('the proxy is never thinned away', stand.count === 1 && stand.visible);
  const game = read('src/client/core/Game.ts');
  expect('Game drives residency for islands off the detail band', /else if \(instanceBatches\)[\s\S]{0,200}updateLazyStoryResidency\(instanceBatches, edgeDist\)/.test(game));
}
{
  // AssetLibrary: proxies ride the world set, LOD0 does not; evict releases.
  const lib2 = new Lib.AssetLibrary();
  const urls = [];
  lib2.loader = { loadAsync(url) { urls.push(url.replace('/assets/models/', '').replace('.glb', '')); return Promise.resolve({ scene: new THREE.Group(), animations: [] }); } };
  await lib2.preloadWorld();
  const proxies = Lib.STORY_PROXY_NAMES;
  expect(`preloadWorld fetches every shipped story proxy (${proxies.length}/15) and no story LOD0`,
    proxies.every((n) => urls.includes(`${n}_far`)) && ![...lazy].some((n) => urls.includes(n))
    && urls.filter((u) => u.endsWith('_far') && lazy.has(u.slice(0, -4))).length === proxies.length);
  expect('every shipped proxy is a story scene', proxies.every((n) => lazy.has(n)));
  await lib2.ensure('whale_skeleton');
  expect('evict() releases a loaded story scene', lib2.evict('whale_skeleton') === true && !lib2.has('whale_skeleton') && lib2.storyEvictions === 1);
  expect('evict() refuses a non-story asset', lib2.evict('palm_a') === false);
  const before = urls.filter((u) => u === 'whale_skeleton').length;
  await lib2.ensure('whale_skeleton');
  expect('an evicted scene is fetched again by the next ensure()', urls.filter((u) => u === 'whale_skeleton').length === before + 1);
}

// ── 4. the placeholder is seated and named like the scene it replaces ────
const scat = read('src/client/world/island/PropScatterer.ts');
expect('a story type always starts as its proxy (residency decides, not build order)',
  /isLazyAsset\(prop\.type\)\s*\?\s*lazyStoryStandIn\(/.test(scat));
const standIn = (scat.split('function lazyStoryStandIn')[1] ?? '').split('\n}\n')[0];
expect('EAGER-ENSURE MUTATION GUARD: the stand-in queues no fetch at build time',
  !/assets\.ensure\(/.test(standIn), 'lazyStoryStandIn calls assets.ensure() — every story LOD0 would load whatever the distance');
expect('the stand-in is the merged far proxy (box only as a fallback)',
  /assets\.mergedStoryProxy\(/.test(scat.split('function makeStoryProxy')[1] ?? ''));
expect('the stand-in lifts the unit box by its own half-height (seated, not sunk)',
  /new THREE\.Vector3\(0, half\[1\] \* scale, 0\)/.test(scat));
expect('the stand-in carries the prop-<type> name through the swap',
  /real\.name = ph\.name/.test(scat));
expect('the swap goes through swapInStoryScene',
  /swapInStoryScene\(proxy, node\)/.test(scat.split('function makeStoryResidency')[1] ?? ''));
expect('the swap adds into the stand-in\'s slot and hides the proxy',
  /parent\.add\(real\);[\s\S]{0,120}ph\.visible = false/.test(scat.split('function swapInStoryScene')[1] ?? ''));
expect('the real scene gets the shadow flags and the story-pad blend',
  /blendStoryPad\(obj, island\)/.test(scat.split('function lazyStoryStandIn')[1] ?? ''));

// ── 5. the swapped-in scene stands at its island, not at the world origin ─
// islands-16: the island group is frozen (freezeStaticSubtree clears
// matrixWorldAutoUpdate on the ROOT), and three's per-frame walk never descends
// into a frozen root. A node added under it after the freeze keeps whatever
// matrixWorld it was born with (identity), so every story scene that landed
// after its island was built drew at (0,0,0), inside Old Maw Caldera.
{
  const Scat = await import('../src/client/world/island/PropScatterer.ts');
  const { freezeStaticParent, freezeStaticSubtree } = await import('../src/client/rendering/three-util.ts');
  // The game's graph: a still scene and a still environment root (Renderer /
  // Game freezeStaticParent them), so the walk reaches the island group with
  // force=false and skips it — exactly the condition the freeze exists for.
  const scene = new THREE.Scene();
  const env = new THREE.Group();
  scene.add(env);
  freezeStaticParent(scene);
  freezeStaticParent(env);
  const islandGroup = new THREE.Group();
  islandGroup.position.set(-528, 0, -600);
  islandGroup.rotation.y = 0.7;
  env.add(islandGroup);
  const ph = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  ph.position.set(12, 9.5, -4);
  ph.rotation.y = 1.1;
  islandGroup.add(ph);
  freezeStaticSubtree(islandGroup);
  scene.updateMatrixWorld();
  const phWorld = ph.getWorldPosition(new THREE.Vector3());

  const real = new THREE.Group();
  real.position.copy(ph.position);
  real.rotation.copy(ph.rotation);
  const part = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  part.position.set(0.5, 1.2, -0.3);
  real.add(part);
  const swapped = Scat.swapInStoryScene(ph, real);
  for (let frame = 0; frame < 3; frame++) scene.updateMatrixWorld(); // the renderer's walk
  const want = new THREE.Matrix4().multiplyMatrices(islandGroup.matrixWorld, real.matrix);
  const wantPart = new THREE.Matrix4().multiplyMatrices(want, part.matrix);
  const close = (a, b) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) < 1e-4);
  const at = new THREE.Vector3().setFromMatrixPosition(real.matrixWorld);
  expect('the swap reports success, adds the scene and hides the stand-in',
    swapped === true && real.parent === islandGroup && ph.parent === islandGroup && ph.visible === false);
  expect('after the swap real.matrixWorld == island.matrixWorld * real.matrix (frozen parent)',
    close(real.matrixWorld, want),
    `scene draws at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}), stand-in stood at (${phWorld.x.toFixed(1)}, ${phWorld.y.toFixed(1)}, ${phWorld.z.toFixed(1)})`);
  expect('the scene\'s own children are refreshed too', close(part.matrixWorld, wantPart));
  expect('the scene stands where its stand-in stood', at.distanceTo(phWorld) < 1e-3,
    `off by ${at.distanceTo(phWorld).toFixed(1)} m`);
  expect('a stand-in that already left the graph swaps nothing',
    (islandGroup.remove(ph), Scat.swapInStoryScene(ph, new THREE.Group()) === false));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
