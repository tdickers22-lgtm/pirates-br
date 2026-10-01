// SHIP PLANK SHADER — the gate for SHIPVIS-01 phase A (ships-21 gap 1).
//
// WHY A LOGIC GATE AND NOT A SCREENSHOT. The plank detail is fragment ALU
// injected into three's chunk pipeline by string replacement. The three ways it
// silently dies are all textual, and none of them is visible to a browser
// suite that only counts draws: (1) a chunk name changes on a three upgrade and
// the replacement becomes a no-op, so the hull quietly goes back to the flat
// canvas; (2) the patch overwrites `onBeforeCompile` instead of chaining and
// takes the breach see-through discard with it — a hole stops being a hole;
// (3) the plank grid is declared in <normal_fragment_begin> but read in
// <map_fragment>, so if three ever emits those chunks the other way round the
// shader stops COMPILING and the whole ship disappears.
//
// So this gate assembles the real fragment/vertex source three would build,
// and grades declaration-before-use, composition with the hole discard, the
// tier split (the low tier must compile a strictly shorter program), and that
// the wet line is a live uniform the renderer actually moves.
//
//   node --import tsx scripts/test-ship-plank-shader.mjs [--mutate]
//
// `--mutate` renames the chunk the colour block hooks so the replacement misses
// — the gate must FAIL. That is its proof it can.
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { applyPlankDetail, makePlankUniforms } = await import('../src/client/rendering/ship/plankDetail.ts');

const MUTATE = process.argv.includes('--mutate');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function stubShader() {
  // Deliberately in three's real emission order (meshphysical.glsl.js r160):
  // common, map, roughness, normal_fragment_begin, emissivemap. (b4.2e: the
  // stub used to put normals first, which is not three's order and kept the
  // declaration check red at HEAD for a shader that links fine.) If the patch declares the plank grid in the wrong
  // chunk the assembled source reads a name before it exists.
  return {
    uniforms: {},
    vertexShader: ['#include <common>', 'void main() {', '#include <begin_vertex>', '}'].join('\n'),
    fragmentShader: [
      '#include <common>',
      'void main() {',
      '#include <map_fragment>',
      '#include <roughnessmap_fragment>',
      '#include <normal_fragment_begin>',
      '#include <emissivemap_fragment>',
      '}',
    ].join('\n'),
  };
}

function patched(surface, highTier, { withHoleDiscard = false } = {}) {
  const mat = new THREE.MeshStandardMaterial();
  const uniforms = makePlankUniforms();
  const holeUniform = { value: [new THREE.Vector4(0, 0, 0, 0)] };
  if (withHoleDiscard) {
    // The same shape of patch ShipRenderer installs first (applyHullHoleDiscard).
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHoles = holeUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uHoles[1];')
        .replace('#include <map_fragment>', 'HOLE_DISCARD_MARKER;\n#include <map_fragment>');
    };
    mat.customProgramCacheKey = () => 'hull-hole-discard-1';
  }
  applyPlankDetail(mat, surface, uniforms, highTier);
  const shader = stubShader();
  if (MUTATE) shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment_v2>');
  mat.onBeforeCompile(shader, null);
  return { mat, shader, uniforms };
}

console.log('SHIP PLANK SHADER (SHIPVIS-01 phase A)');
console.log(MUTATE ? '  [--mutate: the colour hook chunk is renamed; this run must FAIL]' : '');

// ── 1. The patch actually lands on both surfaces ─────────────────────────────
for (const surface of ['hull', 'deck']) {
  const { shader } = patched(surface, true);
  expect(`${surface}: caulking seam darkening reaches the drawn colour`,
    /diffuseColor\.rgb \*= mix\(0\.34, 1\.0, shipPlankSeam\)/.test(shader.fragmentShader),
    'the <map_fragment> replacement missed — the hull is back to the flat canvas');
  expect(`${surface}: the wet line is wired as a uniform`,
    shader.uniforms.uWetY !== undefined && shader.uniforms.uWetBand !== undefined);
  if (surface === 'deck') {
    expect('deck: the board grid is hull-local, not UV',
      /float shipPlankAlongM = vPlankPos\.z;/.test(shader.fragmentShader),
      'a UV grid stretches over the loft taper; the whole point is metric cells');
  } else {
    // b4.2e (ships-05): strake space, not world-Y bands.
    expect('hull: the strake grid reads the strakeUv attribute (strake space), not world Y',
      /attribute vec3 strakeUv;/.test(shader.vertexShader) && /float shipStrakeIdx = vStrake\.y;/.test(shader.fragmentShader)
        && !/vPlankPos\.y \/ /.test(shader.fragmentShader),
      'planks still stack in hull-local Y: they ignore the sheer and the stem taper');
  }
}

// ── 2. Declaration before use, in three's real chunk order ───────────────────
{
  const { shader } = patched('hull', true);
  const src = shader.fragmentShader;
  for (const name of ['shipPlankSeam', 'shipPlankRnd', 'shipPlankWet', 'shipTrenail', 'shipGold']) {
    // Word-boundary, or `shipPlankSeam` matches inside `shipPlankSeamA` and the
    // gate grades the wrong token.
    const decl = src.indexOf(`float ${name} =`);
    const uses = [...src.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].map((m) => m.index);
    expect(`hull: ${name} is declared before it is read`,
      decl >= 0 && uses.length > 1 && uses[0] === decl + 'float '.length,
      decl < 0 ? 'never declared' : `declared at ${decl}, first read at ${uses[0]}`);
  }
  for (const v of ['vPlankPos', 'vPlankAcross']) {
    expect(`hull: ${v} is declared in both stages`,
      new RegExp(`varying vec3 ${v};`).test(src) && new RegExp(`varying vec3 ${v};`).test(shader.vertexShader));
  }
  expect('hull: vPlankAcross is a view-space object axis (normalMatrix), not screen space',
    /vPlankAcross = normalize\(normalMatrix \*/.test(shader.vertexShader));
}

// ── 3. Composition: the breach discard survives the plank patch ──────────────
{
  const { mat, shader } = patched('hull', true, { withHoleDiscard: true });
  expect('hull: the see-through breach discard still runs after chaining',
    shader.fragmentShader.includes('HOLE_DISCARD_MARKER'),
    'applyPlankDetail overwrote onBeforeCompile — holes stopped being holes');
  expect('hull: the plank block ALSO runs',
    /shipPlankSeam/.test(shader.fragmentShader));
  expect('hull: the program cache key folds in the previous patch',
    mat.customProgramCacheKey().startsWith('hull-hole-discard-1|ship-plank2-hull-'),
    `got ${mat.customProgramCacheKey()}`);
}

// ── 4. Tier split: the low tier compiles a strictly cheaper program ──────────
{
  const hi = patched('hull', true);
  const lo = patched('hull', false);
  expect('low tier: no SHIP_PLANK_HIGH define',
    !(lo.mat.defines && 'SHIP_PLANK_HIGH' in lo.mat.defines));
  expect('balanced/high tier: SHIP_PLANK_HIGH define present',
    Boolean(hi.mat.defines && 'SHIP_PLANK_HIGH' in hi.mat.defines));
  expect('the two tiers do not share a program',
    hi.mat.customProgramCacheKey() !== lo.mat.customProgramCacheKey(),
    `${hi.mat.customProgramCacheKey()} vs ${lo.mat.customProgramCacheKey()}`);
  // The bevel + grain block is guarded, so the low tier's preprocessed source
  // drops it entirely rather than branching around it at runtime.
  const guarded = hi.shader.fragmentShader.match(/#ifdef SHIP_PLANK_HIGH([\s\S]*?)#endif/);
  expect('the bevel normal and grain are behind the tier guard',
    Boolean(guarded) && /vPlankAcross \* \(shipPlankBevel/.test(guarded[1]),
    'the expensive half is not guarded: the low tier pays for it');
}

// ── 5. The wet line is LIVE: the renderer moves it every frame ───────────────
{
  const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
  const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
  const scene = new THREE.Scene();
  const sr = new ShipRenderer();
  sr.init(scene, 'balanced');
  const ship = {
    id: 's1', type: 'sloop', position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, health: SHIP_STATS.sloop.maxHealth,
    maxHealth: SHIP_STATS.sloop.maxHealth, sailAngle: 0, sailOpen: 1, speed: 0,
    crew: [], holes: [], waterLevel: 0, sinking: false, anchored: false,
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
  sr.buildShip(ship);
  sr.update([ship], [], 0, 1 / 60, 0);
  const dry = sr.getPlankWetLevel('s1');
  expect('a built hull carries a live plank wet-line uniform', typeof dry === 'number', `got ${dry}`);
  expect('a hull at her marks is wet at about the design waterline',
    typeof dry === 'number' && Math.abs(dry) < 1.2, `uWetY = ${dry}`);
  // Half-flooded: the server's buoyancy target already drops the hull by
  // 0.8 x waterLevel, so the wet line must ride UP her topside by the same
  // amount without anyone telling the shader about flooding.
  ship.waterLevel = 1;
  for (let i = 0; i < 120; i++) sr.update([ship], [], i / 60, 1 / 60, 0);
  const flooded = sr.getPlankWetLevel('s1');
  expect('a hull down by the head is wet above her marks',
    typeof flooded === 'number' && flooded > dry + 0.5,
    `uWetY went ${dry} -> ${flooded} (expected at least +0.5 m)`);
  // Sinking: the hull leaves the wave surface entirely and settles to the y the
  // server sends. She must be wet to the rail, not showroom-dry.
  ship.sinking = true;
  ship.position.y = -1.6;
  for (let i = 0; i < 200; i++) sr.update([ship], [], i / 60, 1 / 60, 0);
  const wet = sr.getPlankWetLevel('s1');
  expect('the wet line climbs the topside as she goes under',
    typeof wet === 'number' && wet > flooded && wet > dry + 0.9,
    `uWetY went ${dry} -> flooded ${flooded} -> sinking ${wet} (expected wetter still, and +0.9 m on dry)`);
  sr.clear();
}

// ── 6. Plank shader v2: strake space on the real spline shell (b4.2e) ────────
{
  console.log('\nplank shader v2 (b4.2e, ships-05)');
  const pd = await import('../src/client/rendering/ship/plankDetail.ts');
  const { makeSplineHullGeometry } = await import('../src/client/rendering/ship/geometry.ts');
  const { getHullProfile } = await import('../src/shared/hull.ts');
  const have = typeof pd.computeStrakeSpace === 'function';
  expect('plankDetail exports computeStrakeSpace (strake-space UVs)', have);
  if (have) {
    expect('plank length 5-8 m on the hull and the deck',
      pd.PLANK_LENGTH.hull >= 5 && pd.PLANK_LENGTH.hull <= 8 && pd.PLANK_LENGTH.deck >= 5 && pd.PLANK_LENGTH.deck <= 8);
    expect('3-strake butt stagger, trenails every 0.6 m, 1-1.5 cm caulking, 0.4 m grime',
      pd.BUTT_STAGGER_STRAKES === 3 && pd.TRENAIL_PITCH === 0.6 && pd.CAULK_WIDTH >= 0.01 && pd.CAULK_WIDTH <= 0.015 && pd.GRIME_HEIGHT === 0.4);
    for (const type of ['sloop', 'brigantine', 'galleon']) {
      for (const tier of [0, 1]) {
        const geo = makeSplineHullGeometry(getHullProfile(type), tier);
        const { cols, rows } = geo.userData;
        const { data, strakes } = pd.computeStrakeSpace(geo);
        let nonMono = 0, alongBad = 0, countBad = 0, minW = Infinity, maxW = 0;
        for (const side of [0, 1]) {
          for (let c = 0; c < cols; c++) {
            const at = (r) => (side * cols * rows + c * rows + r) * 3;
            for (let r = 1; r < rows; r++) if (data[at(r) + 1] < data[at(r - 1) + 1] - 1e-6) nonMono++;
            if (Math.abs(data[at(0) + 1]) > 1e-4 || Math.abs(data[at(rows - 1) + 1] - strakes) > 1e-3) countBad++;
            if (c > 0) for (let r = 0; r < rows; r++) if (data[at(r)] < data[(side * cols * rows + (c - 1) * rows + r) * 3] - 1e-6) alongBad++;
            minW = Math.min(minW, data[at(0) + 2]); maxW = Math.max(maxW, data[at(0) + 2]);
          }
        }
        expect(`${type} tier ${tier}: strake v monotonic along the girth on every column`, nonMono === 0, `${nonMono} reversals`);
        expect(`${type} tier ${tier}: ${strakes} strakes at the stem == amidships (sheer 0 -> keel ${strakes} on every column)`, countBad === 0, `${countBad} columns lose or gain a strake`);
        expect(`${type} tier ${tier}: plank run monotonic from transom to stem`, alongBad === 0, `${alongBad} reversals`);
        expect(`${type} tier ${tier}: strakes taper toward the ends (narrowest < 0.8 x widest, widest ~${pd.STRAKE_TARGET_WIDTH} m)`,
          minW < 0.8 * maxW && Math.abs(maxW - pd.STRAKE_TARGET_WIDTH) < 0.06, `min ${minW.toFixed(3)} max ${maxW.toFixed(3)}`);
      }
    }
    const { shader } = patched('hull', true);
    const src = shader.fragmentShader;
    expect('hull: trenail pairs on the frame line, boot-top, own-ship gold edge, env lift all compiled in',
      /vPlankPos\.z \/ 0\.6000/.test(src) && /shipBoot/.test(src) && /uOwnEdge/.test(src) && /totalEmissiveRadiance \+= diffuseColor\.rgb \* uEnvLift/.test(src),
      'one of trenails / boot-top / gold edge / env lift is missing');
    expect('hull: live wet band and grime keyed to uWetY', /vPlankPos\.y - uWetY/.test(src) && shader.uniforms.uOwnEdge && shader.uniforms.uEnvLift);
    // The renderer attaches strake space to the detail hull and drives the gold edge.
    const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
    const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
    const scene = new THREE.Scene();
    const sr = new ShipRenderer();
    sr.init(scene, 'balanced');
    const ship = {
      id: 's2', type: 'galleon', position: { x: 0, y: 0, z: 0 }, rotation: 0,
      velocity: { x: 0, y: 0, z: 0 }, health: SHIP_STATS.galleon.maxHealth,
      maxHealth: SHIP_STATS.galleon.maxHealth, sailAngle: 0, sailOpen: 1, speed: 0,
      crew: [], crewIds: [], holes: [], waterLevel: 0, sinking: false, anchored: false,
      repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
    };
    sr.buildShip(ship);
    let shell = null;
    scene.traverse((o) => { if (o.isMesh && o.material && o.material.name === 'ship-hull-shell') shell = o; });
    expect('the detail hull shell carries the strakeUv attribute', Boolean(shell && shell.geometry.attributes.strakeUv),
      'the shader would read (0,0,0): one plank over the whole hull');
    // b4.2e (stern): outboard timber that is NOT on the plank shader (wales, boot-top, the stern castle)
    // carries the same env lift through its emissive map, or the stern reads as a black slab at noon
    // (gallery galleon stern hullLuma 37.2). Hold timber (ship-dark-timber) stays unlifted: the hold is lit by lanterns.
    const byName = new Map();
    scene.traverse((o) => { if (o.isMesh && o.material && !Array.isArray(o.material) && !byName.has(o.material.name)) byName.set(o.material.name, o.material); });
    const lifted = (m) => Boolean(m && m.emissiveMap && m.emissiveMap === m.map && m.emissive.r === 1 && m.emissive.g === 1 && m.emissive.b === 1
      && Math.abs(m.emissiveIntensity - pd.PLANK_ENV_LIFT) < 1e-6);
    const strake = byName.get('ship-hull-strake');
    expect('ship-hull-strake: present and lifted by PLANK_ENV_LIFT through its own map', lifted(strake),
      strake ? `emissiveMap ${Boolean(strake.emissiveMap)} emissive ${strake.emissive?.getHexString?.()} intensity ${strake.emissiveIntensity}` : 'no mesh with this material');
    // The stern castle (above the deck, aft of -0.37 L) is drawn by a lifted material, not by darkMat.
    const prof = getHullProfile('galleon');
    let castleLifted = 0, castleDark = 0;
    const v = new THREE.Vector3();
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position || Array.isArray(o.material)) return;
      const kind = lifted(o.material) ? 'lift' : o.material.name === 'ship-dark-timber' ? 'dark' : null;
      if (!kind) return;
      o.updateWorldMatrix(true, false);
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        // The transom panel and the castle's after face: aft of -0.47 L, from 0.35 H (above the rudder head) to the castle top.
        if (v.z < -prof.L * 0.47 && v.y > prof.H * 0.35 && v.y < prof.H * 1.3) kind === 'lift' ? castleLifted++ : castleDark++;
      }
    });
    expect('the transom panel and stern castle are drawn lifted, not on ship-dark-timber', castleLifted > 0 && castleLifted > castleDark,
      `lifted ${castleLifted} vs dark ${castleDark} vertices`);
    const dark = byName.get('ship-dark-timber');
    expect('ship-dark-timber (hold, deck furniture) is not lifted', Boolean(dark) && !dark.emissiveMap);
    sr.clear();
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
