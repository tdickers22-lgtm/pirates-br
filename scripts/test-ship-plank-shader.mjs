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
  // Deliberately in three's real emission order: common, then normals, then
  // map, then roughness. If the patch declares the plank grid in the wrong
  // chunk the assembled source reads a name before it exists.
  return {
    uniforms: {},
    vertexShader: ['#include <common>', 'void main() {', '#include <begin_vertex>', '}'].join('\n'),
    fragmentShader: [
      '#include <common>',
      'void main() {',
      '#include <normal_fragment_begin>',
      '#include <map_fragment>',
      '#include <roughnessmap_fragment>',
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
  expect(`${surface}: the plank grid is hull-local, not UV`,
    /vPlankPos\.z \/ /.test(shader.fragmentShader),
    'a UV grid stretches over the loft taper; the whole point is metric cells');
}

// ── 2. Declaration before use, in three's real chunk order ───────────────────
{
  const { shader } = patched('hull', true);
  const src = shader.fragmentShader;
  for (const name of ['shipPlankSeam', 'shipPlankRnd', 'shipPlankWet']) {
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
    mat.customProgramCacheKey().startsWith('hull-hole-discard-1|ship-plank-hull-'),
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

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
