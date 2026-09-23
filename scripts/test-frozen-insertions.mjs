#!/usr/bin/env node
// islands-16 / verify "missing 3" — NOTHING INSERTED UNDER A FROZEN ISLAND
// KEEPS AN IDENTITY WORLD MATRIX.
//
// IslandBuilder freezes every island group with freezeStaticSubtree(): the root
// loses matrixWorldAutoUpdate, and because the scene and environment roots are
// freezeStaticParent()ed, three r160's per-frame walk reaches the island with
// force=false and never descends. That is the point (it took ~6,800 nodes off
// the walk), and it has one sharp edge: a node ADDED under the island after the
// freeze is never walked either. It keeps the matrixWorld it was born with — the
// identity — and draws at the world origin. The fifteen story scenes did exactly
// that for as long as they have been lazy (they drew inside Old Maw Caldera).
//
// This gate holds the whole class, not the one instance:
//   1. LOGIC: the real insertion helpers (PropScatterer.swapInStoryScene) leave
//      the new subtree at parent.matrixWorld * local after the renderer's walk,
//      on a graph frozen exactly like the game's; and a bare add() on the same
//      graph is DETECTED as stale (the check can fail).
//   2. SCAN, deferred callbacks: in the island build code (IslandBuilder.ts and
//      world/island/*.ts) every `.add(x)` inside a `.then(` / setTimeout /
//      requestAnimationFrame / queueMicrotask / requestIdleCallback callback
//      must refresh `x` (refreshFrozenChild(x) or x.updateMatrixWorld(...)) in
//      the same callback, or go through a helper this file proves in (1).
//   3. SCAN, post-build handles: any function in src/client that reaches an
//      island group after it was built (islandMeshes.get(, `.inst.parent`)
//      and adds a node there refreshes that node in the same function, or is
//      listed below with the per-frame refresh that covers it (asserted).
//   4. SELF-TEST: both scanners flag a synthetic bad snippet.
//
// No stack, no browser: `node --import tsx scripts/test-frozen-insertions.mjs`.
// Red on the tree before b1.1f: scan (2) flags PropScatterer's story swap
// (`parent.add(real)` inside `assets.ensure(name).then(`) and the logic check
// finds the swapped scene at (0, 0, 0). Reproduce the red on any revision with
//   --src src/client/world/island/PropScatterer.ts=/tmp/old-PropScatterer.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import * as THREE from 'three';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const overrides = new Map();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--src') {
    const [rel, file] = process.argv[++i].split('=');
    overrides.set(rel, file);
  }
}
const read = (rel) => readFileSync(overrides.get(rel) ?? resolve(root, rel), 'utf8');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

// ── helpers: balanced-bracket extraction over TS source ──────────────────
/** Index of the bracket that closes the one at `open` (skips strings/comments roughly). */
function matchClose(src, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const want = [pairs[src[open]]];
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) want.push(pairs[c]);
    else if (c === want[want.length - 1]) { want.pop(); if (want.length === 0) return i; }
  }
  return -1;
}
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** `.add(x)` calls in a body whose argument `x` is not refreshed in the same body. */
function unrefreshedAdds(body) {
  const code = stripComments(body);
  const out = [];
  for (const m of code.matchAll(/\b([\w.]+)\.add\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const [, recv, arg] = m;
    // Set/Map bookkeeping (`seen.add(key)`) is not scene-graph insertion.
    if (/(^|\.)(seen|set|ids|keys|warmed|uploaded|pending)$/i.test(recv)) continue;
    const refreshed = new RegExp(`refreshFrozenChild\\(\\s*${arg}\\s*\\)|\\b${arg}\\.updateMatrixWorld\\(|\\b${arg}\\.updateWorldMatrix\\(`).test(code);
    if (!refreshed) out.push(`${recv}.add(${arg})`);
  }
  return out;
}

/** Bodies of deferred callbacks: the argument list of `.then(`, setTimeout(, … */
function deferredBodies(src) {
  const out = [];
  for (const m of src.matchAll(/(\.then|\bsetTimeout|\brequestAnimationFrame|\bqueueMicrotask|\brequestIdleCallback)\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(src, open);
    if (close > open) out.push({ kind: m[1], line: lineOf(src, m.index), body: src.slice(open, close + 1) });
  }
  return out;
}

/** The body of the function/method that encloses `idx` (nearest header whose braces contain it). */
function enclosingFunction(src, idx) {
  const header = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:private\s+|public\s+|protected\s+|static\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?)\s*\([^;{]*?\)\s*(?::\s*[^={;]+?)?\s*\{/g;
  let best = null;
  for (const m of src.matchAll(header)) {
    const brace = m.index + m[0].length - 1;
    if (brace > idx) break;
    const close = matchClose(src, brace);
    if (close > idx) {
      const name = m[1] ?? m[2];
      if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
      best = { name, start: brace, body: src.slice(brace, close + 1) };
    }
  }
  return best;
}

function listTs(dirRel) {
  const out = [];
  const walk = (abs) => {
    for (const e of readdirSync(abs)) {
      const p = join(abs, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(relative(root, p));
    }
  };
  walk(resolve(root, dirRel));
  return out.sort();
}

console.log('Frozen-subtree insertions (islands-16)');

// ── 1. logic: the real helpers, on a graph frozen like the game's ────────
const { freezeStaticParent, freezeStaticSubtree } = await import('../src/client/rendering/three-util.ts');
const Scat = await import('../src/client/world/island/PropScatterer.ts');

function frozenIsland() {
  const scene = new THREE.Scene();
  const env = new THREE.Group();
  scene.add(env);
  freezeStaticParent(scene); // Renderer
  freezeStaticParent(env);   // Game.environment
  const island = new THREE.Group();
  island.position.set(310, 0, -455);
  island.rotation.y = -2.2;
  env.add(island);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  slot.position.set(-18, 6.2, 27);
  slot.rotation.y = 0.4;
  island.add(slot);
  freezeStaticSubtree(island); // IslandBuilder
  scene.updateMatrixWorld();
  return { scene, island, slot };
}
function lateScene(slot) {
  const real = new THREE.Group();
  real.position.copy(slot.position);
  real.rotation.copy(slot.rotation);
  real.scale.setScalar(1.3);
  const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  a.position.set(1, 2, 3);
  const b = new THREE.Group();
  b.rotation.x = 0.3;
  const c = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  c.position.set(-0.5, 0.25, 0);
  b.add(c);
  real.add(a, b);
  return real;
}
/** Worst element error between every node's matrixWorld and parent.matrixWorld * matrix. */
function staleness(node) {
  let worst = 0;
  node.traverse((o) => {
    const want = new THREE.Matrix4().multiplyMatrices(o.parent.matrixWorld, o.matrix);
    o.matrixWorld.elements.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - want.elements[i])); });
  });
  return worst;
}
{
  const { scene, island, slot } = frozenIsland();
  const real = lateScene(slot);
  Scat.swapInStoryScene(slot, real);
  for (let f = 0; f < 3; f++) scene.updateMatrixWorld();
  const err = staleness(real);
  expect('swapInStoryScene: every node of the late scene at parent.matrixWorld * local', err < 1e-4,
    `worst element error ${err.toFixed(3)}; scene origin at ${new THREE.Vector3().setFromMatrixPosition(real.matrixWorld).toArray().map((v) => v.toFixed(1)).join(', ')}`);
  expect('the frozen island itself stays frozen (the fix does not thaw the walk)',
    island.matrixWorldAutoUpdate === false);
}
{
  // Control: the same insertion without a refresh must read as stale, or the
  // check above could never have failed.
  const { scene, slot } = frozenIsland();
  const real = lateScene(slot);
  slot.parent.add(real);
  for (let f = 0; f < 3; f++) scene.updateMatrixWorld();
  expect('control: a bare add() under the frozen island is detected as stale', staleness(real) > 1);
}

// ── 2. scan: deferred callbacks in the island build code ─────────────────
const islandFiles = ['src/client/world/IslandBuilder.ts', ...listTs('src/client/world/island')];
const deferredViolations = [];
let deferredSeen = 0;
for (const rel of islandFiles) {
  const src = read(rel);
  for (const d of deferredBodies(src)) {
    deferredSeen += 1;
    for (const v of unrefreshedAdds(d.body)) deferredViolations.push(`${rel}:${d.line} ${d.kind}( … ${v} …)`);
  }
}
expect(`island build code: ${deferredSeen} deferred callbacks, none adds an unrefreshed node`,
  deferredViolations.length === 0, deferredViolations.join('\n     '));
{
  const scat = read('src/client/world/island/PropScatterer.ts');
  const swapBody = enclosingFunction(scat, scat.indexOf('parent.add(real)'))?.body ?? '';
  expect('the story swap refreshes the scene it inserts (refreshFrozenChild(real) in swapInStoryScene)',
    /refreshFrozenChild\(real\)/.test(swapBody));
}

// ── 3. scan: functions that reach a built island group and add to it ─────
// name → the per-frame proof that covers the node they add.
const COVERED = {
  'src/client/rendering/EnvironmentFx.ts:buildHarvestClone': {
    why: 'the promoted clone is refreshed every frame by the harvest update (refreshFrozenChild(node))',
    proof: (src) => /promoted\.node[\s\S]{0,4000}refreshFrozenChild\(node\)/.test(src),
  },
};
const handleRe = /islandMeshes\.get\(|\.inst\.parent\b/g;
const postBuild = [];
const covered = new Set();
for (const rel of listTs('src/client')) {
  const src = read(rel);
  if (!handleRe.test(src)) continue;
  handleRe.lastIndex = 0;
  const seenFns = new Set();
  for (const m of src.matchAll(handleRe)) {
    const fn = enclosingFunction(src, m.index);
    if (!fn || seenFns.has(fn.start)) continue;
    seenFns.add(fn.start);
    const bad = unrefreshedAdds(fn.body);
    if (bad.length === 0) continue;
    const key = `${rel}:${fn.name}`;
    const cover = COVERED[key];
    if (cover) {
      covered.add(key);
      expect(`${key}: ${cover.why}`, cover.proof(src));
    } else {
      postBuild.push(`${key} (line ${lineOf(src, fn.start)}): ${bad.join(', ')}`);
    }
  }
}
expect('no function adds an unrefreshed node to a built island group', postBuild.length === 0, postBuild.join('\n     '));
expect('every COVERED entry still exists (a stale allow-list is a hole)',
  Object.keys(COVERED).every((k) => covered.has(k)),
  `unused: ${Object.keys(COVERED).filter((k) => !covered.has(k)).join(', ')}`);

// ── 4. self-test: the scanners can fail ──────────────────────────────────
{
  const bad = `function lazy() {\n  void assets.ensure(name).then(() => {\n    const parent = ph.parent;\n    parent.add(real);\n    parent.remove(ph);\n  });\n}\n`;
  const hits = deferredBodies(bad).flatMap((d) => unrefreshedAdds(d.body));
  expect('self-test: a bare add in a .then( callback is flagged', hits.length === 1, `hits: ${hits.join(', ')}`);
  const good = bad.replace('parent.add(real);', 'parent.add(real);\n    refreshFrozenChild(real);');
  expect('self-test: the refreshed form passes', deferredBodies(good).flatMap((d) => unrefreshedAdds(d.body)).length === 0);
  const method = `class A {\n  private chop(island: Island): void {\n    const g = this.islandMeshes.get(island.id);\n    g.add(node);\n  }\n}\n`;
  const fn = enclosingFunction(method, method.indexOf('islandMeshes.get('));
  expect('self-test: a method adding to islandMeshes.get(...) is found and flagged',
    fn?.name === 'chop' && unrefreshedAdds(fn.body).length === 1, `fn ${fn?.name}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
