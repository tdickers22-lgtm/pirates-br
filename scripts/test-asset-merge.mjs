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
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'public/assets/models');

// TEXTURED GLBs IN NODE. The island's assets carry no images, so GLTFLoader
// never reached its texture path here; the hero assets (WEAPON-01/HWGLB-01)
// embed one baked atlas each, and the loader then throws `self is not defined`
// and the whole file "fails to parse". The image is not what this suite grades
// — attributes, material collapse, boot/world partition are — so the decode is
// stubbed rather than emulated: a 1x1 bitmap, and every geometry test is
// unaffected.
globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

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

const { ASSET_NAMES, FLAT_SHADED_ASSETS, BOOT_ASSET_NAMES, WORLD_ASSET_NAMES, AssetLibrary, assets } = await import('../src/client/assets/AssetLibrary.ts');

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

const { CollapsedAssetMaterial, TINT_ATTRIBUTE, SURFACE_ATTRIBUTE, EMISSIVE_ATTRIBUTE, collapseBlockers } =
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
const bakeKey = (...vals) => vals.map((v) => Math.round(v * 10000)).join('/');

/** The union of every attribute name the asset's SOURCE meshes carry. The merge
 *  owes the merged buffer a channel for each — see the superset assertion. */
function sourceAttributeNames(name) {
  const root = assets.clone(name);
  const names = new Set();
  root?.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (const attr of Object.keys(o.geometry.attributes)) names.add(attr);
  });
  return names;
}

/** emissive x emissiveIntensity, which is what three folds into the `emissive`
 *  uniform and therefore what the baked attribute has to reproduce. */
const litRGB = (mat) => {
  const k = mat.emissiveIntensity ?? 1;
  return mat.emissive ? [mat.emissive.r * k, mat.emissive.g * k, mat.emissive.b * k] : [0, 0, 0];
};

let merged = 0;
let collapsedCount = 0;
const droppedAttributes = [];
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

  // 0. EVERY SOURCE CHANNEL SURVIVES THE MERGE (assets-05). mergeGeoms used to
  //    copy a hand-listed position/normal/color, so `crow_roost` — the only GLB
  //    the Blender pipeline exports with TEXCOORD_0 — reached the InstancedMesh
  //    with its UVs silently gone, and any texture pass with it. Nothing throws;
  //    the prop just cannot ever be textured. So assert the merged attribute set
  //    is a SUPERSET of the union of the source meshes' attribute sets.
  const wantAttrs = sourceAttributeNames(name);
  const gotAttrs = new Set(Object.keys(geom.attributes));
  const lost = [...wantAttrs].filter((a) => !gotAttrs.has(a));
  if (lost.length > 0) {
    droppedAttributes.push(`${name}: merge dropped ${lost.join(', ')} (source has ${[...wantAttrs].sort().join(', ')})`);
  }

  if (['palm_a', 'palm_b', 'palm_c', 'bush', 'bush_berry', 'flower_bush', 'fern_plant', 'flower_patch', 'wildflowers'].includes(name)) {
    if (mats.length !== 1) issues.push('organic asset no longer collapses to one draw');
  }
  // The GLB's normals decide the shading (assets-06). Anything that comes back
  // flat-shaded and is not in the allowlist means the loader threw away
  // authored smooth normals — ropes, tentacles, the idol, the shark.
  const flat = mats.filter((mat) => mat.flatShading);
  if (flat.length > 0 && !FLAT_SHADED_ASSETS.has(name)) {
    issues.push(`${flat.length}/${mats.length} materials forced flatShading; authored normals discarded`);
  }
  // …and the converse: removing the override must NOT have smoothed a rock.
  // A flat-authored mesh ships split normals, so it has 3 verts per triangle.
  if (['boulder_a', 'boulder_b', 'boulder_c', 'rock_arch'].includes(name)) {
    const idx = geom.getIndex();
    const tris = (idx ? idx.count : pos.count) / 3;
    if (pos.count < tris * 2.9) issues.push(`stone lost its split normals (${(pos.count / tris).toFixed(2)} verts/tri, want 3)`);
  }

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
    } else {
      collapsedCount += 1;
    }
    if (groups.length !== 0) {
      issues.push(`STALE-GROUPS: ${groups.length} groups survive under a single material`);
    }
    if (!(m.material instanceof CollapsedAssetMaterial) || m.material.bakedTint !== true) {
      issues.push('NO-BAKED-TINT: merged material does not read the baked attributes');
    }
    const tint = geom.getAttribute(TINT_ATTRIBUTE);
    const surf = geom.getAttribute(SURFACE_ATTRIBUTE);
    const emis = geom.getAttribute(EMISSIVE_ATTRIBUTE);
    // The glow buffer is OPTIONAL by design: 12 bytes a vertex on the nine lit
    // GLBs, nothing on the other fifty-four (a missing attribute reads
    // (0,0,0,1), i.e. no glow). Allocating it everywhere would be ~12 MB of
    // zeros in the instanced buffers, which the low tier cannot spare.
    const anyLit = [...sourceVertexCounts(name).keys()].some((mat) => litRGB(mat).some((v) => v !== 0));
    if (anyLit !== !!emis) {
      issues.push(anyLit
        ? `MISSING-GLOW: a source material is emissive but the merged geometry has no ${EMISSIVE_ATTRIBUTE}`
        : `WASTED-GLOW: nothing in this asset glows but it still allocates ${EMISSIVE_ATTRIBUTE} (${emis.count} vertices)`);
    }
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
          1 - mat.roughness, mat.metalness, ...litRGB(mat));
        want.set(key, (want.get(key) ?? 0) + verts);
      }
      const got = new Map();
      for (let i = 0; i < pos.count; i++) {
        const key = bakeKey(tint.getX(i), tint.getY(i), tint.getZ(i), surf.getX(i), surf.getY(i),
          emis ? emis.getX(i) : 0, emis ? emis.getY(i) : 0, emis ? emis.getZ(i) : 0);
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
expect('the merge keeps every attribute the source meshes carry (UVs included)',
  droppedAttributes.length === 0, droppedAttributes.join('\n     '));
// A glow is a baked vec3 now, not a refusal (assets-09): `lantern_post` stands
// on every dock and cost three draws a copy for one `Lantern_Glass`. 52 assets
// collapsed before that landed; the nine lit ones bring it to 61 at least.
expect(`at least 61 of ${ASSET_NAMES.length} assets collapse to ONE material (emissive is baked, not refused)`,
  collapsedCount >= 61, `${collapsedCount} collapsed, ${refused.length} refused`);
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

// ── the boot/world split (BOOT-01) ─────────────────────────────────────────
//
// `Game.init` awaited all 63 GLBs before the name field worked. The split is
// only safe if `preloadBoot` genuinely does NOT start the island content: a
// caller that skipped `preloadWorld` and built a world anyway would get
// procedural fallbacks for 53 assets — a wrong-looking island, silently. So the
// absence is asserted, not the presence, and it is deterministic because
// preloadBoot resolves before anything world-shaped is even requested.
{
  const boot = [...BOOT_ASSET_NAMES];
  const world = [...WORLD_ASSET_NAMES];
  expect('the boot set and the world set partition the library exactly',
    boot.length + world.length === ASSET_NAMES.length
      && boot.every((n) => ASSET_NAMES.includes(n))
      && world.every((n) => ASSET_NAMES.includes(n))
      && boot.every((n) => !world.includes(n)),
    `${boot.length} boot + ${world.length} world vs ${ASSET_NAMES.length}`);
  expect('the boot set is small enough to be worth splitting for (<= 12 files)',
    boot.length <= 12, `${boot.length} boot assets: ${boot.join(', ')}`);

  const lib = new AssetLibrary();
  const progress = [];
  console.warn = () => {};
  await lib.preloadBoot((done, total) => progress.push([done, total]));
  console.warn = realWarn;

  const missingBoot = boot.filter((n) => !lib.has(n));
  expect('preloadBoot loads every boot asset', missingBoot.length === 0, missingBoot.join(', '));
  const leaked = world.filter((n) => lib.has(n));
  expect('preloadBoot loads NO island content (the world set must stay behind the countdown)',
    leaked.length === 0, `${leaked.length} world asset(s) fetched at boot: ${leaked.slice(0, 6).join(', ')}`);
  expect('a boot-only library does not claim to be fully loaded',
    lib.isFullyLoaded === false && assets.isFullyLoaded === true);
  expect('the progress bar still counts against the WHOLE library, not the boot set',
    progress.length === boot.length && progress.every(([, total]) => total === ASSET_NAMES.length)
      && progress[progress.length - 1][0] === boot.length,
    `${progress.length} ticks, last ${JSON.stringify(progress[progress.length - 1])}`);
}

// ── TEX-01 phase 2: the DETAIL FAMILY table (PLAN 2.4a) ────────────────────
//
// A triplanar detail set needs to know what a surface is made of, and the only
// thing a shipped GLB still says about that is the Blender material NAME. So
// the classification is a TABLE, and a table's whole failure mode is being
// incomplete: the day an asset ships `Wood_Charred`, the shader would grain it
// like a plank (family 0 -> no fetch, or worse, a wrong one) and nothing would
// print. This section is what makes that loud.
//
// It grades three separate things, because they fail in different ways:
//   1. COVERAGE — every material name on every shipped GLB has a row. Derived
//      from the loaded assets, never from the table, so the table cannot grade
//      itself.
//   2. PARITY — the Blender-side table and the runtime table are the same rows.
//      Two copies of a 108-row map WILL drift; this is the only thing that
//      stops it, and it is a text parse of the .py so it cannot be fooled by an
//      import shim.
//   3. THE BAKE — with `bakeFamily`, every vertex of a chunk carries its own
//      material's index; without it, no buffer is allocated at all (the low
//      tier does not pay for an attribute nothing samples yet).
{
  const {
    DETAIL_FAMILIES, MATERIAL_FAMILIES, FAMILY_ATTRIBUTE, SURFACE_FAMILIES,
    TERRAIN_MAT_FAMILIES, familyForMaterialName, familyIndexForMaterialName, collapseChunks,
  } = await import('../src/client/assets/AssetMaterialCollapse.ts');

  // 1. COVERAGE, read out of the SHIPPED FILES rather than out of the library.
  //    `assets` only preloads the island set; the ship hardware and hero GLBs
  //    are loaded elsewhere and carry material names too (`Atlas_wheel`,
  //    `Glass_Flame.001`), so grading the library would leave five rows
  //    ungraded and would call a genuinely-shipped material an orphan. The GLB
  //    JSON chunk is enough and needs no loader.
  const glbMaterialNames = () => {
    const byName = new Map(); // material name -> the files that carry it
    const dir = path.join(ROOT, 'public/assets/models');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.glb'))) {
      const buf = readFileSync(path.join(dir, file));
      const jsonLength = buf.readUInt32LE(12);
      const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
      for (const mat of gltf.materials ?? []) {
        const list = byName.get(mat.name) ?? [];
        if (!list.includes(file)) list.push(file);
        byName.set(mat.name, list);
      }
    }
    return byName;
  };
  const shipped = glbMaterialNames();
  const glbFiles = readdirSync(path.join(ROOT, 'public/assets/models')).filter((f) => f.endsWith('.glb'));
  const unclassified = [...shipped].filter(([name]) => !familyForMaterialName(name));
  expect(`every material name on all ${glbFiles.length} shipped GLBs has a detail family`,
    unclassified.length === 0,
    `${unclassified.length} unclassified: `
    + unclassified.slice(0, 8).map(([m, f]) => `${m} (${f[0]})`).join(', '));
  expect('every family in the table is one of the nine declared families',
    Object.values(MATERIAL_FAMILIES).every((f) => DETAIL_FAMILIES.includes(f)),
    [...new Set(Object.values(MATERIAL_FAMILIES))].filter((f) => !DETAIL_FAMILIES.includes(f)).join(', '));
  // A row for a material nobody ships is dead weight the next reader will
  // trust, and it is how a table drifts away from the assets it describes.
  const orphans = Object.keys(MATERIAL_FAMILIES).filter((n) => !shipped.has(n));
  expect('the table carries no rows for materials no GLB ships',
    orphans.length === 0, orphans.join(', '));
  // The library's own assets are the ones the collapse actually runs on, so
  // they are graded a second time through the loaded materials — this is what
  // would catch a name the loader mangles on the way in.
  const loadedUnclassified = new Set();
  for (const name of ASSET_NAMES) {
    if (!assets.has(name)) continue;
    for (const mat of sourceMaterials(name)) {
      if (!familyForMaterialName(mat.name)) loadedUnclassified.add(`${mat.name} (${name})`);
    }
  }
  expect(`every material the library loads for its ${ASSET_NAMES.length} assets has a family after parsing`,
    loadedUnclassified.size === 0, [...loadedUnclassified].slice(0, 8).join(', '));
  console.log(`   families: ${shipped.size} material names over ${glbFiles.length} GLBs`);

  // 2. PARITY with the Blender-side table.
  const py = readFileSync(path.join(ROOT, 'scripts/blender/_families.py'), 'utf8');
  const pyBody = py.split('MATERIAL_FAMILIES = {')[1]?.split('\n}')[0] ?? '';
  const pyTable = new Map();
  for (const row of pyBody.matchAll(/'([^']+)':\s*'([^']+)',/g)) pyTable.set(row[1], row[2]);
  const pyFamilies = (py.match(/^FAMILIES = \[([^\]]*)\]/m)?.[1] ?? '')
    .split(',').map((t) => t.trim().replace(/'/g, '')).filter(Boolean);
  expect('the Blender family list and the runtime family list are identical',
    pyFamilies.join('|') === DETAIL_FAMILIES.join('|'),
    `py [${pyFamilies.join(', ')}] vs ts [${DETAIL_FAMILIES.join(', ')}]`);
  const drift = [];
  for (const [name, family] of pyTable) {
    if (MATERIAL_FAMILIES[name] !== family) drift.push(`${name}: py=${family} ts=${MATERIAL_FAMILIES[name] ?? '(absent)'}`);
  }
  for (const name of Object.keys(MATERIAL_FAMILIES)) {
    if (!pyTable.has(name)) drift.push(`${name}: py=(absent) ts=${MATERIAL_FAMILIES[name]}`);
  }
  expect(`scripts/blender/_families.py and AssetMaterialCollapse.ts agree on all ${pyTable.size} rows`,
    drift.length === 0, drift.slice(0, 6).join('; '));

  // 2b. THE TERRAIN'S CLASSES ARE THE FIRST FOUR LAYERS, in order.
  //
  //     `TerrainMeshBuilder` ships `aMat` in 0..3 and its shader fans that into
  //     four weights with hard-coded class numbers. If `aMat` class c equals
  //     detail layer c (family c+1), the triplanar fetch needs no lookup and no
  //     branch for the biggest surface in the game — and that alignment is free
  //     until somebody reorders either list, at which point the terrain would
  //     sample ash where it means grass and NOTHING would print. So both ends
  //     are read from their own source: the family ladder from the module, the
  //     class numbers out of the terrain shader's own GLSL.
  expect('each terrain aMat class maps to the detail layer of the same index',
    TERRAIN_MAT_FAMILIES.every((family, c) => DETAIL_FAMILIES.indexOf(family) === c + 1),
    TERRAIN_MAT_FAMILIES.map((f, c) => `${c}:${f}=${DETAIL_FAMILIES.indexOf(f) - 1}`).join(' '));
  const terrainSource = readFileSync(path.join(ROOT, 'src/client/world/island/TerrainMeshBuilder.ts'), 'utf8');
  const shaderClasses = [...terrainSource.matchAll(/float w(\w+) = max\(0\.0, 1\.0 - abs\(mC - (\d)\.0\)\)/g)]
    .map(([, name, index]) => [name.toLowerCase(), Number(index)]);
  expect('the terrain shader still numbers its classes sand=0 grass=1 rock=2 ash=3',
    shaderClasses.length === TERRAIN_MAT_FAMILIES.length
      && shaderClasses.every(([name, index]) => TERRAIN_MAT_FAMILIES[index] === name),
    shaderClasses.map(([n, i]) => `${n}=${i}`).join(' ') || 'no class weights found in the shader');

  // 2c. The BUILT surfaces (caves, sea rocks, the ship) — the same table on
  //     both sides, and every value a real family.
  const pySurfaceBody = py.split('SURFACE_FAMILIES = {')[1]?.split('\n}')[0] ?? '';
  const pySurface = new Map();
  for (const row of pySurfaceBody.matchAll(/'([^']+)':\s*'([^']+)',/g)) pySurface.set(row[1], row[2]);
  const surfaceDrift = [];
  for (const [key, family] of pySurface) {
    if (SURFACE_FAMILIES[key] !== family) surfaceDrift.push(`${key}: py=${family} ts=${SURFACE_FAMILIES[key] ?? '(absent)'}`);
  }
  for (const key of Object.keys(SURFACE_FAMILIES)) {
    if (!pySurface.has(key)) surfaceDrift.push(`${key}: py=(absent)`);
  }
  expect(`the built-surface families agree on both sides (${pySurface.size} rows)`,
    surfaceDrift.length === 0, surfaceDrift.join('; '));
  expect('every built surface names a real family',
    Object.values(SURFACE_FAMILIES).every((f) => DETAIL_FAMILIES.includes(f))
      && TERRAIN_MAT_FAMILIES.every((f) => DETAIL_FAMILIES.includes(f)));
  // The ship's three families are the point of PLAN 7.3 slice c: wood, weave,
  // iron. A ship surface that fell back to `flat` would lose its grain silently.
  const shipFamilies = new Set(Object.entries(SURFACE_FAMILIES)
    .filter(([key]) => key.startsWith('ship_')).map(([, f]) => f));
  expect('the ship spans exactly the plank / canvas / iron families',
    [...shipFamilies].sort().join(',') === 'canvas,iron,plank', [...shipFamilies].join(','));

  // 3. THE BAKE, on a real asset's real materials and its real vertex ranges.
  //    `barrel` is the useful one: five materials that span three families
  //    (plank, plank, plank, iron, iron), so a bake that wrote one value for the
  //    whole geometry — the obvious bug — cannot pass.
  const counts = sourceVertexCounts('barrel');
  const chunks = [];
  let cursor = 0;
  for (const [material, verts] of counts) {
    chunks.push({ start: cursor, count: verts, material });
    cursor += verts;
  }
  const distinct = new Set(chunks.map((c) => familyIndexForMaterialName(c.material.name)));
  expect('the bake fixture spans more than one family (or it grades nothing)',
    distinct.size >= 2, `families ${[...distinct].join(',')} over ${chunks.length} chunks`);

  const makeGeometry = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cursor * 3), 3));
    return g;
  };
  const plain = makeGeometry();
  expect('collapseChunks allocates NO family buffer by default (nothing samples it yet)',
    !!collapseChunks(plain, chunks) && !plain.getAttribute(FAMILY_ATTRIBUTE));

  const baked = makeGeometry();
  const bakedMat = collapseChunks(baked, chunks, { bakeFamily: true });
  const attr = baked.getAttribute(FAMILY_ATTRIBUTE);
  expect('collapseChunks bakes one family float per vertex when asked',
    !!bakedMat && !!attr && attr.itemSize === 1 && attr.count === cursor,
    attr ? `itemSize ${attr.itemSize}, count ${attr.count} vs ${cursor}` : 'no attribute');
  let wrong = 0;
  if (attr) {
    for (const chunk of chunks) {
      const want = familyIndexForMaterialName(chunk.material.name);
      for (let i = chunk.start; i < chunk.start + chunk.count; i++) {
        if (attr.array[i] !== want) { wrong++; break; }
      }
    }
  }
  expect('every baked vertex carries its own chunk material\'s family index',
    wrong === 0, `${wrong}/${chunks.length} chunks baked the wrong family`);
  expect('a name the table has never heard of resolves to null, not to a guess',
    familyForMaterialName('Wood_Charred') === null
      && familyIndexForMaterialName('Wood_Charred') === 0);
  expect("Blender's .001 duplicate suffix falls back to the base row, and an explicit row still wins",
    familyForMaterialName('Trunk_Palm.001') === 'bark'
      && familyForMaterialName('Glass_Flame.001') === 'flat');
}

console.log(failures === 0 ? '\nAll asset merge assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
