#!/usr/bin/env node
// SHADOW-01 — THE SHADOW IS ATTACHED TO THE THING CASTING IT, THE ISLAND CASTS
// ONE, THE SEA TAKES ONE, AND THE STORM PUTS THE SUN OUT.
//
// Four defects shipped together in the same lighting rig, and each of them has
// a number that can be graded here, with no stack and no rasteriser:
//
//   graphics-04 / physics-39  `sun.shadow.normalBias` was 1.0 m (high) / 1.8 m
//     (balanced), in WORLD units, against a map whose texels are 15-20 cm. A
//     receiver displaced d along its normal moves the sampled shadow edge by
//     d / tan(sunElevation): 1.8 m under a 30 degree sun is 3.1 m of daylight
//     between a barrel and its own shadow. The bias is a number of TEXELS; this
//     grades that it is derived from the live box and map size, that it tracks
//     the governor's map-size ladder, and that it never again reaches a metre.
//
//   graphics-13  `terrain.castShadow = false` — the largest occluders in the
//     world threw nothing on their own flanks, their beaches or their bays.
//     Graded on the shipped builder source: casting is on AND the DoubleSide
//     heightfield renders the shadow pass BackSide (which is what cured the
//     acne the flag was switched off for; without it, turning casting on
//     reintroduces the self-shadow wash).
//
//   graphics-14  the sea received nothing: `receiveShadow = false` on every
//     ring AND a raw ShaderMaterial with no shadow chunks in it, so the flag
//     alone would have been a no-op. Graded on the shipped GLSL: the vertex
//     stage builds the shadow coordinate, the fragment stage samples it, and
//     the sample multiplies the KEY term (an unused sample is a fill cost that
//     changes no pixel).
//
//   graphics-25 / storm-06  a third always-on DirectionalLight for lightning
//     (a full GGX lobe per lit fragment, non-zero for 0.45 s in a match), and a
//     storm that dimmed the sun to 42% while the sky said 6%. Graded: the bolt
//     is an override of the fill light that already exists, the storm key is
//     down at the finder's 0.12, and the fill terms rise by at least the key
//     the scene lost so the storm goes flat rather than dark.
//
// RED ON HEAD: normalBias is a hand-picked metre, TerrainMeshBuilder says
// castShadow = false, OCEAN_FRAG has no shadowmap chunk, EnvironmentFx owns a
// boltLight and getStormSunIntensity returns 0.42.
//
// Run: node --import tsx scripts/test-shadow-bias.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

let failures = 0;
const expect = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const Renderer = await import('../src/client/rendering/Renderer.ts').catch((e) => {
  console.log(`  (Renderer.ts import failed: ${e.message})`);
  return {};
});
const Ocean = await import('../src/client/rendering/OceanRenderer.ts').catch((e) => {
  console.log(`  (OceanRenderer.ts import failed: ${e.message})`);
  return {};
});

console.log('SHADOW-01 — bias in texels, islands cast, sea receives, storm puts the sun out');

// ── 1. the bias is derived from texels ──────────────────────────────────────
console.log('\n1. normalBias is a texel count, not a hand-picked metre');
const nb = Renderer.shadowNormalBias;
expect('Renderer exports shadowNormalBias(texelWorldSize)', typeof nb === 'function',
  'no exported derivation: the bias is a literal in the constructor');
if (typeof nb === 'function') {
  // Every (tier, governor step) the shipping client can be in: one 310 m box,
  // map sizes from the tier opener down the governor's ladder.
  const HALF = 155;
  // ceiling: what a tier OPENS at must be under half a metre; the governor's
  // emergency steps must still beat the 1.0/1.8 m they replace.
  const rows = [
    ['high 2048', 2048, 0.40], ['balanced 1536', 1536, 0.40],
    ['governor step 1024', 1024, 0.55], ['governor step 768', 768, 0.70],
    ['governor step 512', 512, 0.90],
  ];
  for (const [name, size, ceiling] of rows) {
    const texel = (HALF * 2) / size;
    const bias = nb(texel);
    expect(`${name}: bias ${bias.toFixed(3)} m <= ${ceiling} m (was 1.0-1.8 m)`, bias <= ceiling + 1e-4,
      `${bias.toFixed(3)} m is still most of a stride of daylight under the caster`);
    expect(`${name}: bias >= 1.4 texels (${(bias / texel).toFixed(2)}) so PCFSoft cannot self-shadow`,
      bias / texel >= 1.4 - 1e-6, `${(bias / texel).toFixed(2)} texels invites acne`);
  }
  // It must MOVE with the texel or the ladder's bottom step is the old defect.
  expect('halving the map raises the bias (it tracks the ladder)',
    nb((HALF * 2) / 512) > nb((HALF * 2) / 2048),
    'a bias that ignores mapSize is the metre by another name');
  // A future tight cascade must be allowed to be tight.
  expect('a 4.4 cm cascade texel yields <= 0.10 m (contact stays attached)', nb(0.044) <= 0.10,
    `${nb(0.044).toFixed(3)} m`);
  expect('SHADOW_DEPTH_BIAS is -0.0002', Renderer.SHADOW_DEPTH_BIAS === -0.0002,
    String(Renderer.SHADOW_DEPTH_BIAS));
}
const rendererSrc = read('src/client/rendering/Renderer.ts');
expect('the constructor no longer hard-codes a metre of normalBias',
  !/normalBias\s*=\s*this\.quality/.test(rendererSrc), 'quality-keyed literal still present');
expect('applyShadowMapSize re-derives the bias after a governor step',
  /applyShadowMapSize[\s\S]{0,900}?applyShadowBias\(\)/.test(rendererSrc), 'not re-derived on resize');

// ── 2. the island casts ─────────────────────────────────────────────────────
console.log('\n2. the heightfield casts, and casts BackSide');
const terrainSrc = read('src/client/world/island/TerrainMeshBuilder.ts');
expect('terrain.castShadow = true', /terrain\.castShadow\s*=\s*true/.test(terrainSrc),
  'the 90 m peak still throws nothing on its own beach');
expect('the DoubleSide heightfield renders the shadow pass BackSide',
  /terrainMat\.shadowSide\s*=\s*THREE\.BackSide/.test(terrainSrc),
  'without shadowSide the DoubleSide receiver writes its own front-face depth: acne wash');
expect('the proxy/far LOD mesh does NOT cast (it is a silhouette, not a surface)',
  /proxy[\s\S]{0,400}?castShadow\s*=\s*false/i.test(terrainSrc) || !/proxy/i.test(terrainSrc),
  'a low-poly proxy casting beside the real cap double-shadows the same island');

// ── 3. the sea receives ─────────────────────────────────────────────────────
console.log('\n3. the sea receives');
const vert = Ocean.OCEAN_VERT ?? '';
const frag = Ocean.OCEAN_FRAG ?? '';
expect('OCEAN_VERT is exported so the shadow wiring can be graded', vert.length > 0);
expect('OCEAN_VERT includes shadowmap_pars_vertex', vert.includes('shadowmap_pars_vertex'));
expect('OCEAN_VERT writes vDirectionalShadowCoord through directionalShadowMatrix',
  /vDirectionalShadowCoord\[\s*i\s*\]\s*=\s*directionalShadowMatrix\[\s*i\s*\]/.test(vert),
  'the fragment stage samples a varying nothing ever wrote');
expect('the coordinate carries the light\'s own shadowNormalBias offset',
  /shadowWorldPosition[\s\S]{0,220}?shadowNormalBias/.test(vert),
  'without the normal offset the sea acnes against its own displaced surface');
expect('the bias offset is along UP, not along the Gerstner ripple normal',
  /vec3\(0\.0,\s*1\.0,\s*0\.0\)\s*\*\s*directionalLightShadows/.test(vert),
  'biasing along a moving wave normal makes the hull shadow crawl with the swell');
expect('the whole block is behind USE_SHADOWMAP (low tier compiles it away)',
  /#if\s+defined\(\s*USE_SHADOWMAP\s*\)[\s\S]{0,600}?vDirectionalShadowCoord/.test(vert),
  'low has no shadow map: an unguarded chunk is a link error there, not a cost');
expect('OCEAN_FRAG includes packing + shadowmap_pars_fragment',
  frag.includes('packing') && frag.includes('shadowmap_pars_fragment'));
expect('OCEAN_FRAG samples the shadow map (getShadow)', /getShadow\s*\(/.test(frag),
  'chunks included but never sampled is fill spent on nothing');
expect('the sample multiplies the KEY term, not the ambient',
  /u_keyLight\s*\*\s*diff\s*\*\s*[A-Za-z_]/.test(frag) || /u_ambient\s*\+\s*u_keyLight\s*\*\s*diff\s*\*\s*[A-Za-z_]/.test(frag),
  'a shadow that dims the ambient makes shadowed water read as a hole');
expect('the specular lobe is shadowed too (a sun glint inside a hull shadow)',
  /specCol\s*=\s*min\(specCol[^;]*\)\s*\*\s*keyShadow/.test(frag),
  'shade with a full glitter path on it reads as a decal, not a shadow');
expect('the shadow sample is guarded by receiveShadow (outer rings pay nothing)',
  /if\s*\(\s*receiveShadow\s*\)/.test(frag), 'every ring pays 9 PCF taps a fragment');
const oceanSrc = read('src/client/rendering/OceanRenderer.ts');
expect('the surface material declares lights:true (three merges the shadow uniforms)',
  /lights:\s*true/.test(oceanSrc), 'without lights:true directionalLightShadows is unbound');
expect('receiveShadow is on the NEAR rings only, not the whole grid',
  /mesh\.receiveShadow\s*=\s*i\s*<\s*OCEAN_SHADOW_RINGS/.test(oceanSrc),
  'the outer rings are beyond the shadow box: 9 taps a fragment for a lookup that is always lit');
expect('OCEAN_SHADOW_RINGS is 2 (the box is 310 m; ring 3 starts outside it)',
  /const OCEAN_SHADOW_RINGS = 2;/.test(oceanSrc));

// ── 4. one fewer directional light, and a storm that is flat ────────────────
console.log('\n4. the bolt borrows the fill light, and the storm puts the sun out');
const envSrc = read('src/client/rendering/EnvironmentFx.ts');
expect('EnvironmentFx no longer allocates a third DirectionalLight',
  !/boltLight/.test(envSrc), 'a full GGX lobe per lit fragment, every frame, for 0.45 s of use');
expect('EnvironmentFx drives the bolt through renderer.setBoltFill',
  /setBoltFill\s*\(/.test(envSrc), 'nothing carries the strike');
expect('Renderer exposes setBoltFill', /setBoltFill\s*\(/.test(rendererSrc));
expect('the bolt override is applied in render(), after every clamp that would overwrite it',
  /render\(\)\s*\{[\s\S]{0,900}?applyBoltFill\(\)/.test(rendererSrc),
  'horizonFill position/colour are rewritten every frame; an override before them is lost');
const key = Renderer.stormKeyIntensity;
const amb = Renderer.stormAmbientIntensity;
const hemi = Renderer.stormHemisphereIntensity;
expect('Renderer exports the storm light curves', [key, amb, hemi].every((f) => typeof f === 'function'),
  'storm intensities are private literals');
if (typeof key === 'function' && typeof amb === 'function' && typeof hemi === 'function') {
  expect(`storm key at day is <= 0.12 (${key(0).toFixed(3)}, was 0.42)`, key(0) <= 0.1201,
    'hard-edged sun shadows under a sky with no visible sun');
  expect(`storm key at night is <= 0.20 (${key(1).toFixed(3)})`, key(1) <= 0.2001);
  const lostDay = 0.42 - key(0);
  const gainDay = (amb(0) - 0.36) + (hemi(0) - 0.28);
  expect(`the fill takes back the key the storm lost (lost ${lostDay.toFixed(2)}, gained ${gainDay.toFixed(2)})`,
    gainDay >= lostDay * 0.9,
    'dimming the key without raising the fill makes a storm dark instead of flat');
  const lostNight = (0.42 + 0.16) - key(1);
  const gainNight = (amb(1) - 0.76) + (hemi(1) - 0.78);
  expect(`the same holds at night (lost ${lostNight.toFixed(2)}, gained ${gainNight.toFixed(2)})`,
    gainNight >= lostNight * 0.9);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
