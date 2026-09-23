#!/usr/bin/env node
// islands-10 — THE DIG-SITE SPARKLE IS ROUND MOTES, NOT SQUARE BOXES, AND IT
// COSTS NO NEW SHADER PROGRAM.
//
// A PointsMaterial without a `map` rasterises each point as a screen-aligned
// square: over every buried chest the eight gold motes read as pale 0.3 m UI
// boxes. The fix samples the session's one soft round particle sprite.
//
//   1. makeDigSparkle(tex) builds eight motes whose material samples `tex`,
//      stays additive, depth-write off, unlit and NOT tone-mapped (exposure
//      swings with the day cycle), and adds no alphaTest (a program define);
//   2. EntityMeshes hands it the shared sprite (host.getSoftParticleTexture()),
//      never a texture of its own;
//   3. the shared sprite's radial falloff reaches alpha 0 at the inscribed
//      circle, so a mote's corner (distance size/sqrt(2) > size/2) is 0 alpha:
//      max corner alpha < 0.1;
//   4. PROGRAM CENSUS: three keys a PointsMaterial program on (map, tone
//      mapping, alphaTest, vertexColors, sizeAttenuation, a custom
//      onBeforeCompile). The distinct Points program variants in src/client stay
//      at or under the pre-fix count: the sparkle is still the only
//      tone-mapping-off points material, so its variant is REPLACED, not added.
//
// No stack, no browser: `node --import tsx scripts/test-dig-sparkle.mjs`.
// Red before b1.1f: makeDigSparkle does not exist and the sparkle literal in
// EntityMeshes has no `map` (reproduce with
//   --src src/client/world/island/EntityMeshes.ts=/tmp/old-EntityMeshes.ts).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import * as THREE from 'three';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const overrides = new Map();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--src') { const [rel, file] = process.argv[++i].split('='); overrides.set(rel, file); }
}
const read = (rel) => readFileSync(overrides.get(rel) ?? resolve(root, rel), 'utf8');

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

/** Points program variants before b1.1f (f5fee97e..69189598): sparkle {no map, no tone map},
 *  ship fire {no map}, the volcanic/steam sprites {map}, waterfall mist {map + onBeforeCompile}. */
const PINNED_POINTS_VARIANTS = 4;

console.log('Dig-site sparkle (islands-10)');
const entityRel = 'src/client/world/island/EntityMeshes.ts';
const entitySrc = read(entityRel);

// ── 1. the real builder ──────────────────────────────────────────────────
let sparkle = null;
if (!overrides.has(entityRel)) {
  const Ent = await import('../src/client/world/island/EntityMeshes.ts');
  const tex = new THREE.Texture();
  sparkle = typeof Ent.makeDigSparkle === 'function' ? Ent.makeDigSparkle(tex) : null;
  const m = sparkle?.material;
  expect('makeDigSparkle exists and builds a THREE.Points', sparkle instanceof THREE.Points);
  expect('eight motes', sparkle?.geometry.getAttribute('position').count === 8);
  expect('the motes sample the soft sprite it was handed (no square points)', m?.map === tex);
  expect('additive, depth-write off, transparent', m?.blending === THREE.AdditiveBlending && m?.depthWrite === false && m?.transparent === true);
  expect('unlit gold, not tone-mapped (holds its colour through the exposure cycle)', m?.toneMapped === false && m?.color.getHex() === 0xffd77a);
  expect('no alphaTest (a program define) and no custom shader hook',
    (m?.alphaTest ?? 1) === 0 && m?.onBeforeCompile === THREE.Material.prototype.onBeforeCompile);
  expect('named dig-sparkle', sparkle?.name === 'dig-sparkle');
}

// ── 2. EntityMeshes passes the shared sprite ─────────────────────────────
expect('EntityMeshes builds the sparkle from host.getSoftParticleTexture()',
  /makeDigSparkle\(\s*host\.getSoftParticleTexture\(\)\s*\)/.test(entitySrc));

// ── 3. the shared sprite is 0 alpha at the corners ───────────────────────
{
  const game = read('src/client/core/Game.ts');
  const body = game.split('private getSoftParticleTexture(')[1]?.split('\n  }\n')[0] ?? '';
  const grad = /createRadialGradient\(\s*size \/ 2,\s*size \/ 2,\s*0,\s*size \/ 2,\s*size \/ 2,\s*size \/ 2\s*\)/.test(body);
  const stops = [...body.matchAll(/addColorStop\(\s*([\d.]+)\s*,\s*'rgba\([^)]*,\s*([\d.]+)\)'\s*\)/g)]
    .map((s) => ({ at: Number(s[1]), a: Number(s[2]) })).sort((x, y) => x.at - y.at);
  const last = stops[stops.length - 1];
  // Beyond the outer circle a canvas radial gradient holds the last stop's colour.
  const cornerAlpha = grad && last && last.at === 1 ? last.a : 1;
  expect('soft sprite: radial gradient centred, outer radius size/2', grad);
  expect(`soft sprite corner alpha ${cornerAlpha} < 0.1 (corners lie outside the inscribed circle)`, cornerAlpha < 0.1);
  expect('soft sprite: opaque core (alpha 1 at the centre)', stops[0]?.at === 0 && stops[0]?.a === 1);
}

// ── 4. program census over every PointsMaterial in src/client ────────────
{
  const files = [];
  const walk = (abs) => { for (const e of readdirSync(abs)) { const p = join(abs, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(relative(root, p)); } };
  walk(resolve(root, 'src/client'));
  const variants = new Map();
  let sparkleKey = null;
  for (const rel of files) {
    const src = read(rel);
    for (const m of src.matchAll(/new THREE\.PointsMaterial\(\{([\s\S]*?)\}\)/g)) {
      const lit = m[1];
      const after = src.slice(m.index, m.index + 600);
      const key = [
        /\bmap\s*:/.test(lit) ? 'map' : 'nomap',
        /toneMapped\s*:\s*false/.test(lit) ? 'notone' : 'tone',
        /alphaTest\s*:/.test(lit) ? 'alphatest' : '',
        /vertexColors\s*:\s*true/.test(lit) ? 'vcol' : '',
        /sizeAttenuation\s*:\s*false/.test(lit) ? 'flat' : '',
        /\.onBeforeCompile\s*=/.test(after) ? `custom@${rel}` : '',
      ].filter(Boolean).join('+');
      if (!variants.has(key)) variants.set(key, []);
      variants.get(key).push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      if (rel === entityRel && /0xffd77a/.test(lit)) sparkleKey = key;
    }
  }
  const lines = [...variants].map(([k, at]) => `${k}: ${at.join(', ')}`);
  console.log(`     points variants: ${variants.size}\n     ${lines.join('\n     ')}`);
  expect(`Points program variants ${variants.size} <= ${PINNED_POINTS_VARIANTS} (the sparkle adds none)`,
    variants.size <= PINNED_POINTS_VARIANTS);
  expect('the sparkle literal samples a map', sparkleKey?.startsWith('map+') ?? false, `sparkle key: ${sparkleKey}`);
  expect('the sparkle keeps a variant of its own only by replacing its old one (one literal, sole tone-off points)',
    sparkleKey !== null && variants.get(sparkleKey)?.length === 1);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
