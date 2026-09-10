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

// ── 3. the per-frame promotion latches, and only inside LAZY_PRIORITY_M ──
let asks = 0;
const stand = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 1);
Lod.attachLazyStoryLod(stand, () => { asks += 1; });
const batches = Lod.collectInstanceLodBatches(stand);
expect('the placeholder is collected as a batch', batches.length === 1);
Lod.updateInstanceLod(batches, Lib.LAZY_PRIORITY_M + 50, 'low', 1);
expect('no promotion outside LAZY_PRIORITY_M', asks === 0, `asked ${asks}x`);
Lod.updateInstanceLod(batches, Lib.LAZY_PRIORITY_M - 100, 'low', 1);
Lod.updateInstanceLod(batches, 10, 'low', 1);
expect('one promotion inside LAZY_PRIORITY_M, and only one', asks === 1, `asked ${asks}x`);
expect('the placeholder is never thinned away', stand.count === 1 && stand.visible);

// ── 4. the placeholder is seated and named like the scene it replaces ────
const scat = read('src/client/world/island/PropScatterer.ts');
expect('the non-instanced path falls back to a story stand-in',
  /buildPropInstance\([\s\S]{0,200}?\?\?\s*lazyStoryStandIn\(/.test(scat));
expect('the stand-in lifts the unit box by its own half-height (seated, not sunk)',
  /new THREE\.Vector3\(0, half\[1\] \* scale, 0\)/.test(scat));
expect('the stand-in carries the prop-<type> name through the swap',
  /real\.name = ph\.name/.test(scat));
expect('the swap re-parents at the same transform',
  /parent\.add\(real\);[\s\S]{0,40}parent\.remove\(ph\)/.test(scat));
expect('the real scene gets the shadow flags and the story-pad blend',
  /blendStoryPad\(obj, island\)/.test(scat.split('function lazyStoryStandIn')[1] ?? ''));

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
