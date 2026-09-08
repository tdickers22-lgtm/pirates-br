/**
 * AO-01 — the prop's own ground contact.
 *
 * `ContactShadows` darkens the ground under a piece; `bakeGroundContactAo`
 * darkens the piece where it meets the ground. This suite grades the four
 * things that make that safe to do to a SHARED, CACHED geometry on a per-island
 * build path, because every one of them is a bug that would not print:
 *
 *   1. IDEMPOTENCE. Ten islands call this on the same cached barrel. Without
 *      the latch the barrel ends at 0.62^10 = 0.008 — black — and only on maps
 *      with ten islands, which is every map.
 *   2. NO GLOBAL DIMMER. Everything above the band must come out BIT-IDENTICAL.
 *      A ramp that reaches the canopy is not occlusion, it is turning the sun
 *      down, and it would sail through an "is it darker?" assertion.
 *   3. NO NEW MEMORY. The claim in the commit is zero bytes and zero shader
 *      ops, so the attribute set must be unchanged and the colour attribute
 *      must be the SAME object, mutated — not a replacement copy.
 *   4. THE BAND IS CLAMPED. A 12 m palm scaled by fraction alone gets a 1.9 m
 *      dark boot and reads as scorched; a 6 cm shell gets 1 cm and reads as
 *      nothing. Both ends are graded against real prop heights.
 *
 * No GLB loading and no browser: the function is pure geometry arithmetic, so
 * the fixtures are built here and the verdicts are exact.
 */
import * as THREE from 'three';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); return; }
  failures++;
  console.log(`  ✗ FAIL: ${label}`);
  if (detail) console.log(`     ${detail}`);
}

const { bakeGroundContactAo } = await import('../src/client/world/island/PropScatterer.ts');

console.log('prop ground-contact AO (AO-01)\n');

/** A column of `rows` vertices from y=0 to y=height, all pure white. */
function column(height, rows = 64, itemSize = 3) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(rows * 3);
  const col = new Float32Array(rows * itemSize);
  for (let i = 0; i < rows; i++) {
    pos[i * 3 + 1] = (i / (rows - 1)) * height;
    for (let c = 0; c < itemSize; c++) col[i * itemSize + c] = c === 3 ? 1 : 1;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, itemSize));
  return g;
}

const yOf = (g, i) => g.getAttribute('position').getY(i);
const lumOf = (g, i) => g.getAttribute('color').getX(i);

// ── 1. it darkens the bottom and only the bottom ───────────────────────────
{
  const bush = column(1.2);
  expect('the bake reports it ran', bakeGroundContactAo(bush) === true);
  expect('the vertex ON the ground is darkened to the floor',
    Math.abs(lumOf(bush, 0) - 0.62) < 1e-6, `got ${lumOf(bush, 0)}`);
  const band = Math.max(0.08, 1.2 * 0.16);
  let monotonic = true;
  for (let i = 1; i < bush.getAttribute('color').count; i++) {
    if (lumOf(bush, i) < lumOf(bush, i - 1) - 1e-6) monotonic = false;
  }
  expect('brightness rises monotonically with height (no banding, no inversion)', monotonic);
  let dimmedAbove = 0;
  let untouched = 0;
  for (let i = 0; i < bush.getAttribute('color').count; i++) {
    if (yOf(bush, i) < band) continue;
    if (lumOf(bush, i) === 1) untouched++; else dimmedAbove++;
  }
  expect('every vertex above the band is bit-identical (this is occlusion, not a dimmer)',
    dimmedAbove === 0 && untouched > 0, `${dimmedAbove} dimmed, ${untouched} untouched above ${band.toFixed(3)} m`);
}

// ── 2. idempotence: the shared-cache latch ─────────────────────────────────
{
  const barrel = column(0.9);
  bakeGroundContactAo(barrel);
  const afterOne = lumOf(barrel, 0);
  let ran = 0;
  for (let island = 0; island < 10; island++) if (bakeGroundContactAo(barrel)) ran++;
  expect('a second call refuses (ten islands share one cached geometry)', ran === 0);
  expect('ten more calls leave the contact vertex exactly where one call left it',
    lumOf(barrel, 0) === afterOne, `${lumOf(barrel, 0)} vs ${afterOne}`);
  expect('and it never approaches 0.62^10 (the un-latched result)',
    lumOf(barrel, 0) > 0.5, `${lumOf(barrel, 0)}`);
}

// ── 3. no new memory, no new attribute ─────────────────────────────────────
{
  const rock = column(2.0);
  const before = Object.keys(rock.attributes).sort().join(',');
  const colorObject = rock.getAttribute('color');
  const arrayObject = colorObject.array;
  const versionBefore = colorObject.version;
  bakeGroundContactAo(rock);
  expect('no attribute is added or removed',
    Object.keys(rock.attributes).sort().join(',') === before, before);
  expect('the colour attribute is mutated in place, not replaced by a copy',
    rock.getAttribute('color') === colorObject && rock.getAttribute('color').array === arrayObject);
  // `needsUpdate` is write-only in three r160 (the setter bumps `version` and
  // there is no getter), so reading it back would assert on `undefined`. The
  // version is the thing WebGLAttributes actually compares.
  expect('the mutated attribute is flagged for re-upload (version bumped)',
    rock.getAttribute('color').version > versionBefore,
    `version ${versionBefore} -> ${rock.getAttribute('color').version}`);
}

// ── 4. the band is clamped at both ends, against real prop heights ─────────
{
  // The band is the height at which the ramp reaches 1.0, recovered by scanning.
  const bandOf = (height) => {
    const g = column(height, 512);
    bakeGroundContactAo(g);
    let last = 0;
    for (let i = 0; i < g.getAttribute('color').count; i++) {
      if (lumOf(g, i) < 1 - 1e-7) last = yOf(g, i);
    }
    return last;
  };
  const palm = bandOf(12);
  const shell = bandOf(0.06);
  const bush = bandOf(1.2);
  expect('a 12 m palm gets a boot no taller than 0.85 m, not 1.9 m',
    palm <= 0.86, `${palm.toFixed(3)} m`);
  expect('a 6 cm shell still gets a visible band (floor 0.08 m, i.e. its whole self)',
    shell > 0.05, `${shell.toFixed(4)} m`);
  expect('a 1.2 m bush lands between the clamps, on the fraction',
    bush > 0.15 && bush < 0.20, `${bush.toFixed(3)} m`);
}

// ── 5. refusals ────────────────────────────────────────────────────────────
{
  const noColor = new THREE.BufferGeometry();
  noColor.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  expect('a geometry with no COLOR_0 is left alone and not latched',
    bakeGroundContactAo(noColor) === false && !noColor.userData.groundContactAo);

  const flat = column(0);
  expect('a zero-height geometry is refused rather than divided by zero',
    bakeGroundContactAo(flat) === false
      && Number.isFinite(lumOf(flat, 0)) && lumOf(flat, 0) === 1);

  const rgba = column(1.0, 32, 4);
  bakeGroundContactAo(rgba);
  const alpha = rgba.getAttribute('color').getW(0);
  expect('a vec4 COLOR_0 keeps its alpha (setXYZ must not touch the fourth channel)',
    alpha === 1, `alpha ${alpha}`);
}

console.log(failures === 0 ? '\nAll prop ground-AO assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
