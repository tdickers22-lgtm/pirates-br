#!/usr/bin/env node
// Asset merge guard — runs the REAL AssetLibrary (preload + mergedGeometry)
// over every shipped GLB and asserts the merge stays sound.
//
// This is the net under the "black props" class of bug: mergedGeometry
// flattens a GLB's meshes into ONE geometry with per-material groups, and the
// three ways that silently goes wrong on screen are
//   1. a material with vertexColors=true landing on a merged geometry that has
//      NO color attribute  → three multiplies by an undefined attribute and the
//      prop renders BLACK,
//   2. a merged geometry that HAS COLOR_0 under a material with
//      vertexColors=false → the authored Blender vertex paint is thrown away
//      and the prop renders as flat untinted grey,
//   3. the COLLAPSE going wrong. An asset's material array is now folded onto
//      ONE material with the colour and the surface in per-vertex attributes
//      (src/client/assets/AssetMaterialCollapse.ts), because three submits a
//      mesh once per material GROUP and a palm was five draw calls per island.
//      A tint baked at the wrong offset, a chunk that never got written, or an
//      array that quietly failed to collapse at all are all invisible to every
//      other test and all visible on screen.
// None of those throw. They only show up as a wrong-looking prop in game, so
// they need an assertion.
//
// The check this replaced was group bookkeeping — "one group per material,
// covering every vertex" — and it is worth recording why it had to go: it was
// written `if (mats.length > 1)`, so the day the collapse made every asset
// single-material it stopped running and reported a pass. A gate whose subject
// can disappear is a gate that cannot fail.
//
// Runs headless: THREE + GLTFLoader work fine in Node, and a small fetch shim
// serves /assets/models/*.glb off disk so preload() takes its real code path.
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'public/assets/models');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

// ── Browser-URL shim. AssetLibrary asks for the site-absolute path
// `/assets/models/<name>.glb`; Node's Request/fetch reject a relative URL, so
// give them an origin to resolve against and serve the bytes off disk. The
// library itself runs unmodified — this only stands in for the web server.
const ORIGIN = 'http://assets.test';
// three's FileLoader emits download-progress events; Node has no ProgressEvent.
if (!globalThis.ProgressEvent) {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.lengthComputable = !!init.lengthComputable;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  };
}
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input, init) {
    super(typeof input === 'string' && input.startsWith('/') ? ORIGIN + input : input, init);
  }
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const match = /\/assets\/models\/([^/?#]+)$/.exec(url);
  if (match) {
    const file = path.join(MODELS_DIR, match[1]);
    if (!existsSync(file)) return new Response(null, { status: 404, statusText: 'Not Found' });
    const buf = await readFile(file);
    return new Response(buf, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
  }
  return realFetch(input, init);
};

const { ASSET_NAMES, assets } = await import('../src/client/assets/AssetLibrary.ts');

// Loader failures inside preload() are logged and tolerated by design (callers
// keep a procedural fallback), so capture them rather than let them scroll past.
const loadWarnings = [];
const realWarn = console.warn;
console.warn = (...args) => { loadWarnings.push(args.map(String).join(' ')); };
await assets.preload();
console.warn = realWarn;

console.log(`asset merge guard — ${ASSET_NAMES.length} assets\n`);

expect('every GLB loaded (no procedural fallbacks)', loadWarnings.length === 0,
  loadWarnings.join('\n     '));

const { CollapsedAssetMaterial, TINT_ATTRIBUTE, SURFACE_ATTRIBUTE, collapseBlockers } =
  await import('../src/client/assets/AssetMaterialCollapse.ts');

/**
 * The asset's materials BEFORE the collapse, and how many merged-geometry
 * vertices each one owns.
 *
 * This is a deliberate re-derivation of `mergedGeometry`'s own walk, not a
 * reading of what it produced: a gate that asks the collapse to describe itself
 * cannot catch the collapse being wrong. The two rules that matter are that a
 * multi-group mesh contributes `group.count` vertices per group, and that a
 * single-group mesh contributes its INDEX count (mergeGeoms de-indexes), which
 * is not the same number as its position count.
 */
function sourceVertexCounts(name) {
  const root = assets.clone(name);
  const counts = new Map();
  const add = (mat, verts) => { if (mat) counts.set(mat, (counts.get(mat) ?? 0) + verts); };
  root?.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = o.geometry.groups;
    if (groups.length > 1) {
      for (const g of groups) add(mats[g.materialIndex ?? 0], g.count);
    } else {
      const index = o.geometry.getIndex();
      add(mats[0], index ? index.count : o.geometry.getAttribute('position').count);
    }
  });
  return counts;
}

const sourceMaterials = (name) => [...sourceVertexCounts(name).keys()];

/**
 * EVERY ASSET THE GAME DRAWS AS AN InstancedMesh — re-derived from `src/`, not
 * listed here.
 *
 * These are the assets for which a surviving material ARRAY is a draw call per
 * material on every island that has one, and they are the only ones whose
 * collapse this gate treats as mandatory. Reading them out of the source is
 * what keeps the gate honest when someone adds a twentieth instanced prop type:
 * the list grows on its own, and if the new asset is emissive the gate fails
 * instead of the prop quietly costing six calls.
 */
const MUST_COLLAPSE = (() => {
  const names = new Set();
  const files = [
    'src/client/world/island/PropScatterer.ts',
    'src/client/world/island/DecorScatter.ts',
    'src/client/world/island/CaveBuilder.ts',
  ];
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    // `const instancedTypes: ReadonlySet<string> = new Set([ … ])` and
    // `const PORTAL_ROCK_ASSETS = [ … ]` — the two array literals that decide
    // which types get an InstancedMesh at all.
    for (const block of text.matchAll(/(?:instancedTypes[^=]*=\s*new Set\(\[|PORTAL_ROCK_ASSETS\s*=\s*\[)([\s\S]*?)\]/g)) {
      for (const q of block[1].matchAll(/'([a-z0-9_]+)'/g)) names.add(q[1]);
    }
    // …plus every asset asked for a merged geometry by name.
    for (const q of text.matchAll(/mergedGeometry\(\s*'([a-z0-9_]+)'\s*\)/g)) names.add(q[1]);
  }
  return names;
})();

/** Quantised so a float round-trip through a Float32Array cannot fail the
 *  comparison on its own; 1e-4 is far finer than any of these values differ. */
const bakeKey = (r, g, b, s, m) => [r, g, b, s, m].map((v) => Math.round(v * 10000)).join('/');

let merged = 0;
const problems = [];
/** Assets that legitimately cannot collapse (a lit material), reported rather
 *  than failed — none of them is instanced. */
const refused = [];
for (const name of ASSET_NAMES) {
  const issues = [];

  if (!assets.has(name)) {
    problems.push(`${name}: GLB missing or failed to parse`);
    continue;
  }

  const m = assets.mergedGeometry(name);
  if (!m) {
    problems.push(`${name}: mergedGeometry returned null (no meshes in the GLB)`);
    continue;
  }
  merged += 1;

  const mats = Array.isArray(m.material) ? m.material : [m.material];
  const geom = m.geometry;
  const pos = geom.getAttribute('position');
  const color = geom.getAttribute('color');
  const groups = geom.groups;

  if (!pos || pos.count === 0) issues.push('merged geometry has no vertices');

  // 1. vertexColors materials MUST have a COLOR_0 attribute to multiply against.
  const vcMats = mats.filter((x) => x.vertexColors);
  if (!color && vcMats.length > 0) {
    issues.push(`BLACK-RISK: ${vcMats.length}/${mats.length} materials have vertexColors=true but the merged geometry has no COLOR_0`);
  }
  // 2. …and the converse: COLOR_0 present but a material ignoring it throws the
  //    authored Blender paint away.
  if (color) {
    const unlit = mats.filter((x) => !x.vertexColors);
    if (unlit.length > 0) {
      issues.push(`UNLIT-VC: merged geometry has COLOR_0 but ${unlit.length}/${mats.length} materials have vertexColors=false`);
    }
    if (color.count !== pos.count) {
      issues.push(`COLOR_0 count ${color.count} != position count ${pos.count}`);
    }
    // A merged geometry whose paint is essentially all-black renders as a
    // silhouette regardless of the material colour.
    let dark = 0;
    let minLum = Infinity;
    for (let i = 0; i < color.count; i++) {
      const lum = 0.299 * color.getX(i) + 0.587 * color.getY(i) + 0.114 * color.getZ(i);
      if (lum < minLum) minLum = lum;
      if (lum < 0.02) dark += 1;
    }
    if (dark > color.count * 0.5) {
      issues.push(`DARK-VC: ${dark}/${color.count} vertices have luminance < 0.02 (min ${minLum.toFixed(3)})`);
    }
  }

  // 3. THE COLLAPSE CONTRACT. It used to be group bookkeeping — one group per
  //    material, covering every vertex — and that check silently stopped
  //    existing the day the collapse made every asset single-material, because
  //    it was written `if (mats.length > 1)`. What replaces it is the claim the
  //    collapse actually makes: ONE material, no groups, and the per-vertex
  //    tint/surface reproducing the material array term for term.
  const collapseIssues = collapseBlockers(sourceMaterials(name));
  if (collapseIssues.length > 0) {
    // A refusal is only a DEFECT for an asset the game actually instances. Nine
    // of the sixty-one carry a lit material — `Ember`, `Lantern_Glass`,
    // `Candle_Wax` — which no vertex attribute can express, and every one of
    // them is placed as a GLB clone rather than as an InstancedMesh, so its
    // material array never costs a draw call per group.
    const line = `${name}: ${collapseIssues.join('; ')}`;
    if (MUST_COLLAPSE.has(name)) issues.push(`NOT-COLLAPSIBLE (and instanced): ${collapseIssues.join('; ')}`);
    else refused.push(line);
  } else {
    if (Array.isArray(m.material)) {
      issues.push(`UNCOLLAPSED: still a material ARRAY of ${mats.length} — ${mats.length} draw calls per InstancedMesh`);
    }
    if (groups.length !== 0) {
      issues.push(`STALE-GROUPS: ${groups.length} groups survive under a single material`);
    }
    if (!(m.material instanceof CollapsedAssetMaterial) || m.material.bakedTint !== true) {
      issues.push('NO-BAKED-TINT: merged material does not read the baked attributes');
    }
    const tint = geom.getAttribute(TINT_ATTRIBUTE);
    const surf = geom.getAttribute(SURFACE_ATTRIBUTE);
    if (!tint || !surf) {
      issues.push(`MISSING-BAKE: ${TINT_ATTRIBUTE}=${!!tint} ${SURFACE_ATTRIBUTE}=${!!surf}`);
    } else if (tint.count !== pos.count || surf.count !== pos.count) {
      issues.push(`BAKE-COUNT: tint ${tint.count} / surface ${surf.count} vs ${pos.count} vertices`);
    } else {
      // 3a. THE SHADING IDENTITY, re-derived rather than trusted. Walk the GLB
      //     the way mergedGeometry walks it and count how many vertices each
      //     source material owns; then tally the baked attributes by value. The
      //     two tallies must agree exactly. A single wrong tint, a chunk
      //     boundary off by one, or a material whose roughness never made it
      //     into the buffer all fail here — none of them throw on their own, and
      //     all of them are visible on screen.
      const want = new Map();
      for (const [mat, verts] of sourceVertexCounts(name)) {
        const key = bakeKey(1 - mat.color.r, 1 - mat.color.g, 1 - mat.color.b,
          1 - mat.roughness, mat.metalness);
        want.set(key, (want.get(key) ?? 0) + verts);
      }
      const got = new Map();
      for (let i = 0; i < pos.count; i++) {
        const key = bakeKey(tint.getX(i), tint.getY(i), tint.getZ(i), surf.getX(i), surf.getY(i));
        got.set(key, (got.get(key) ?? 0) + 1);
      }
      const keys = new Set([...want.keys(), ...got.keys()]);
      const wrong = [...keys].filter((k) => (want.get(k) ?? 0) !== (got.get(k) ?? 0));
      if (wrong.length > 0) {
        issues.push(`BAKE-MISMATCH: ${wrong.length} of ${keys.size} (tint,surface) values disagree — `
          + wrong.slice(0, 3).map((k) => `${k}: want ${want.get(k) ?? 0}v got ${got.get(k) ?? 0}v`).join(', '));
      }
      // 3b. ALL-ZERO MUST BE THE IDENTITY, not a mirror and not a black prop.
      //     The attributes are stored as complements for exactly this reason, so
      //     a fully-zero row means "white, fully rough" — the benign answer.
      //     Values outside 0..1 mean the complement arithmetic slipped.
      for (const [attr, label] of [[tint, TINT_ATTRIBUTE], [surf, SURFACE_ATTRIBUTE]]) {
        const arr2 = attr.array;
        for (let i = 0; i < arr2.length; i++) {
          if (!(arr2[i] >= 0 && arr2[i] <= 1)) {
            issues.push(`BAKE-RANGE: ${label}[${i}] = ${arr2[i]} outside 0..1`);
            break;
          }
        }
      }
    }
  }

  // 4. Non-finite vertices poison bounding spheres (and every frustum cull).
  const arr = pos?.array;
  if (arr) {
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) { issues.push(`non-finite vertex at component ${i}`); break; }
    }
  }

  if (issues.length) problems.push(`${name}: ${issues.join(' | ')}`);
}

expect(`all ${ASSET_NAMES.length} assets produced a merged geometry`, merged === ASSET_NAMES.length,
  `${merged}/${ASSET_NAMES.length} merged`);
expect('no asset has a merge defect (collapse contract / COLOR_0 / vertices)', problems.length === 0,
  problems.join('\n     '));
expect(`every instanced asset collapsed to one material (${MUST_COLLAPSE.size} derived from src/)`,
  MUST_COLLAPSE.size >= 19 && [...MUST_COLLAPSE].every((n) => ASSET_NAMES.includes(n)),
  `derived: ${[...MUST_COLLAPSE].sort().join(', ')}`);
if (refused.length) {
  console.log(`\n  · ${refused.length} non-instanced asset(s) keep their material array (lit materials):`);
  for (const line of refused) console.log(`      ${line}`);
}

// mergedGeometry caches: the second call must hand back the SAME geometry, or
// every InstancedMesh rebuild leaks a full copy of the asset.
const first = assets.mergedGeometry(ASSET_NAMES[0]);
const second = assets.mergedGeometry(ASSET_NAMES[0]);
expect('mergedGeometry is cached (same object on re-request)',
  !!first && first.geometry === second?.geometry);
expect('merged geometry is registered as a shared resource (never disposed by callers)',
  !!first && assets.isShared(first.geometry));

// ── the static batcher's chunk arithmetic ──────────────────────────────────
//
// `collapseStaticMeshes` merges a PIECE's meshes and then bakes each part's
// colour at the vertex range that part landed in. That range is a running sum of
// position counts, and if it is off by one mesh every plank on the pier draws in
// the wrong colour — which no counting test can see and which the live gate
// (test-decor-batch) cannot see either, because a mis-baked batch is still ONE
// draw call. So build a piece whose right answer is known and read the buffer.
{
  const THREE = await import('three');
  const { collapseStaticMeshes } = await import('../src/client/world/island/StaticBatcher.ts');

  // Three deliberately DIFFERENT vertex counts, so an offset that used a
  // constant stride, the wrong mesh's count, or a reversed order all land on the
  // wrong vertices. Same family (flat, double-sided, vertex colours) so the
  // batcher is obliged to merge them into one.
  const mk = (hex, rough, w) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, 1, 1, w, 1, 1),
      new THREE.MeshStandardMaterial({
        color: hex, roughness: rough, metalness: 0,
        flatShading: true, side: THREE.DoubleSide, vertexColors: false,
      }),
    );
    mesh.position.x = w;
    return mesh;
  };
  const piece = new THREE.Group();
  piece.name = 'test-piece';
  const parts = [mk(0x804020, 0.9, 1), mk(0x2080ff, 0.4, 2), mk(0x10ff30, 0.6, 3)];
  for (const p of parts) piece.add(p);

  const saved = collapseStaticMeshes(piece);
  const batches = piece.children.filter((c) => c.isMesh);
  expect('the batcher merges three same-family materials into one mesh',
    saved === 2 && batches.length === 1, `saved=${saved} meshes=${batches.length}`);

  if (batches.length === 1) {
    const geom = batches[0].geometry;
    const tint = geom.getAttribute(TINT_ATTRIBUTE);
    const surf = geom.getAttribute(SURFACE_ATTRIBUTE);
    let offset = 0;
    const wrong = [];
    for (const part of parts) {
      const n = part.geometry.getAttribute('position').count;
      const m = part.material;
      // Sample the FIRST and LAST vertex of each range: an offset that drifts
      // shows at one end, an order that reverses shows at both.
      for (const i of [offset, offset + n - 1]) {
        const gotTint = bakeKey(tint.getX(i), tint.getY(i), tint.getZ(i), surf.getX(i), surf.getY(i));
        const wantTint = bakeKey(1 - m.color.r, 1 - m.color.g, 1 - m.color.b, 1 - m.roughness, m.metalness);
        if (gotTint !== wantTint) wrong.push(`vertex ${i} (part range ${offset}..${offset + n - 1}): want ${wantTint} got ${gotTint}`);
      }
      offset += n;
    }
    expect('every batched vertex carries its OWN part\'s colour and roughness',
      wrong.length === 0 && offset === tint.count,
      wrong.length ? wrong.join('\n     ') : `baked ${tint.count} vertices for ${offset} part vertices`);
    expect('the batch draws with ONE material, not the three it merged',
      !Array.isArray(batches[0].material) && batches[0].material instanceof CollapsedAssetMaterial);
  }
}

console.log(failures === 0 ? '\nAll asset merge assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
