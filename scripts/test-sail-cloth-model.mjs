// b4.2g (ships-03): the GPU sail cloth model, graded through its JS mirror.
//   node --import tsx scripts/test-sail-cloth-model.mjs
// Pure: no browser, no canvas. Checks the fill law (monotonic in wind and trim,
// sign reverses aback, taken aback flips within 0.4 s), the cloth shape (full
// fill 10-14% of the chord at 40% down from the head, luffing mean <= 2%,
// flutter 3-6 Hz at 2-4% chord), analytic normals = finite differences, no NaN
// at wind 0, hoist gathers at the yard, tears only from sailIntegrity, and that
// the per-frame sail path no longer recomputes normals on the CPU.
import { readFileSync } from 'node:fs';

const THREE = await import('three');
const cloth = await import('../src/client/rendering/ship/sailCloth.ts');
const { apparentWindLocal } = await import('../src/client/rendering/signConventions.ts');
const { braceCatch } = await import('../src/shared/sailing.ts');

let checks = 0; let failures = 0;
function expect(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

const pt = { y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
const sailDims = (over = {}) => ({ fill: 1, luff: 0, hoist: 1, time: 0, phase: 0.4, wind01: 0.95, headW: 12, footW: 12, height: 9, chord: 12, ...over });

// ── 1. fill law ────────────────────────────────────────────────────────────
{
  // Wind from dead astern blows toward +Z (localYaw 0); a square yard (yaw 0) draws.
  let prev = -1; let mono = true; const seq = [];
  for (const v of [0, 1, 2, 4, 6, 9, 12, 16, 22, 30]) {
    const f = cloth.sailFillTarget(0, v, 0, 1, false); seq.push(f.toFixed(3));
    if (f < prev - 1e-12) mono = false; prev = f;
  }
  expect('fill monotonic non-decreasing in apparent wind (trim 1, square run)', mono && Number(seq[0]) === 0 && Number(seq.at(-1)) > 0.9, seq.join(' '));
  prev = -1; mono = true; const tseq = [];
  for (let c = 0; c <= 1.0001; c += 0.1) {
    const f = cloth.sailFillTarget(0, 12, 0, c, false); tseq.push(f.toFixed(3));
    if (f < prev - 1e-12) mono = false; prev = f;
  }
  expect('fill monotonic non-decreasing in trimCatch (12 m/s run)', mono && Number(tseq[0]) === 0 && Number(tseq.at(-1)) > 0.85, tseq.join(' '));
  const draw = cloth.sailFillTarget(0, 12, 0, 1, false);
  const aback = cloth.sailFillTarget(Math.PI, 12, 0, 1, false); // wind blowing aft onto the forward face
  expect('sign reverses when taken aback (wind on the forward face)', draw > 0.5 && aback < -0.5, `drawing ${draw.toFixed(3)}, aback ${aback.toFixed(3)}`);
  const wrongBrace = cloth.sailFillTarget(2.4, 12, -1.15, braceCatch(-1.15, 0.7), false);
  expect('yards braced the wrong way on a close reach are aback', wrongBrace < -0.3, `${wrongBrace.toFixed(3)}`);
  const luff = cloth.sailFillTarget(Math.PI, 12, 0, 1, true);
  expect('luffing caps |fill| at the luff cap', Math.abs(luff) <= cloth.SAIL_LUFF_FILL_CAP + 1e-12, `${luff.toFixed(3)}`);
  const z = [cloth.sailFillTarget(0, 0, 0, 1, false), cloth.sailFillTarget(1, 0, 0.3, 0.5, true), cloth.sailFillTarget(NaN, NaN, 0, NaN, false)];
  expect('no NaN and zero fill at wind 0 (and NaN inputs)', z.every((v) => Number.isFinite(v) && v === 0), z.join(' '));
}

// ── 2. taken aback flips within 0.4 s ────────────────────────────────────────
{
  let f = cloth.sailFillTarget(0, 15, 0, 1, false);
  const target = cloth.sailFillTarget(Math.PI, 15, 0, 1, false);
  let tFlip = -1; let t = 0;
  for (; t < 0.4 - 1e-9; t += 1 / 60) {
    f = cloth.stepSailFill(f, target, 1 / 60);
    if (tFlip < 0 && f < 0) tFlip = t + 1 / 60;
  }
  expect('taken aback: sign flips and reaches >= 85% of the aback fill within 0.4 s (60 fps)', tFlip > 0 && tFlip <= 0.4 && f <= target * 0.85,
    `flip at ${tFlip.toFixed(3)} s, fill at 0.4 s ${f.toFixed(3)} of ${target.toFixed(3)}`);
  let g = cloth.sailFillTarget(0, 15, 0, 1, false); for (let i = 0; i < 12; i++) g = cloth.stepSailFill(g, target, 1 / 30);
  expect('same flip at 30 fps (frame-rate independent)', Math.abs(g - f) < 0.03, `${g.toFixed(3)} vs ${f.toFixed(3)}`);
}

// ── 3. shape: belly depth, peak height, luffing mean, flutter ────────────────
{
  const fullFill = cloth.sailFillTarget(0, 15, 0, 1, false);
  const p = sailDims({ fill: fullFill, wind01: cloth.sailWind01(15), luff: cloth.sailLuff01(fullFill, false) });
  let best = -1; let bestS = 0;
  for (let i = 0; i <= 100; i++) {
    const s = i / 100;
    cloth.clothSurface(0, p.height * 0.5 - s * p.height, { ...p, luff: 0 }, pt);
    if (pt.z > best) { best = pt.z; bestS = s; }
  }
  expect('full fill (15 m/s, trim 1): belly 10-14% of the chord', best / p.chord >= 0.10 && best / p.chord <= 0.14, `${(100 * best / p.chord).toFixed(2)}%`);
  expect('max depth 40% down from the head (+-3%)', Math.abs(bestS - 0.4) <= 0.03, `s = ${bestS.toFixed(2)}`);
  cloth.clothSurface(0, p.height * 0.5, p, pt);
  const head = pt.z;
  expect('yard edge pinned (head z = 0)', Math.abs(head) < 1e-9, head.toExponential(2));
  // Taken aback: mirror of the drawing belly.
  cloth.clothSurface(0, p.height * 0.5 - 0.4 * p.height, { ...p, fill: -fullFill, luff: 0 }, pt);
  expect('aback belly goes to -Z by the same depth', pt.z < 0 && Math.abs(pt.z + best) < 1e-9, pt.z.toFixed(3));

  // Luffing over 2 s: mean depth <= 2% chord, flutter 2-4% chord at 3-6 Hz.
  for (const wind of [3, 8, 15, 24]) {
    const w01 = cloth.sailWind01(wind);
    const fill = cloth.sailFillTarget(Math.PI * 0.5, wind, 0, 0.05, true);
    const q = sailDims({ fill, wind01: w01, luff: cloth.sailLuff01(fill, true) });
    let sum = 0; let n = 0; let maxDev = 0; let crossings = 0; let prevZ = null;
    for (let k = 0; k < 600; k++) {
      q.time = 10 + k * (2 / 600);
      for (let gy = 0; gy <= 8; gy++) for (let gx = -6; gx <= 6; gx++) {
        cloth.clothSurface(gx, q.height * 0.5 - (gy / 8) * q.height, q, pt);
        sum += pt.z; n += 1;
      }
      cloth.clothSurface(q.headW * 0.5, -q.height * 0.5, q, pt); // clew (leech foot)
      const zf = pt.z; maxDev = Math.max(maxDev, Math.abs(zf));
      if (prevZ !== null && Math.sign(zf) !== Math.sign(prevZ) && zf !== 0) crossings += 1;
      prevZ = zf;
    }
    const mean = sum / n / q.chord;
    const hz = crossings / 2 / 2;
    expect(`luffing at ${wind} m/s: mean depth <= 2% chord`, Math.abs(mean) <= 0.02, `${(100 * mean).toFixed(2)}%`);
    expect(`luffing at ${wind} m/s: leech flutter 2-4% chord at 3-6 Hz`, maxDev / q.chord >= 0.0195 && maxDev / q.chord <= 0.0405 && hz >= 2.9 && hz <= 6.1,
      `${(100 * maxDev / q.chord).toFixed(2)}% at ${hz.toFixed(2)} Hz`);
  }
  const full = sailDims({ fill: fullFill, wind01: 0.95, luff: cloth.sailLuff01(fullFill, false) });
  let maxFl = 0;
  for (let k = 0; k < 120; k++) {
    const a = cloth.clothSurface(full.headW * 0.5, -full.height * 0.5, { ...full, time: k / 60 }, pt).z;
    maxFl = Math.max(maxFl, Math.abs(a));
  }
  expect('a well-filled sail barely flutters (< 0.5% chord at the clew)', maxFl / full.chord < 0.005, `${(100 * maxFl / full.chord).toFixed(3)}%`);
}

// ── 4. analytic normals = finite differences; no NaN at wind 0 ───────────────
{
  let worst = 0; let nan = 0;
  const cases = [
    sailDims({ fill: 0.9, luff: 0.2, time: 3.3 }),
    sailDims({ fill: -0.7, luff: 1, wind01: 0.6, time: 7.1 }),
    sailDims({ fill: 0.5, luff: 0.4, hoist: 0.45, time: 1.2, headW: 8, footW: 12 }),
    sailDims({ fill: 0, luff: 1, wind01: 0, hoist: 0.06, time: 2 }),
  ];
  const e = 1e-4; const a = { ...pt }; const b = { ...pt }; const c = { ...pt }; const d = { ...pt };
  for (const p of cases) {
    for (let gy = 1; gy < 16; gy++) for (let gx = 1; gx < 24; gx++) {
      const y = p.height * 0.5 - (gy / 16) * p.height;
      const s = gy / 16;
      const hw = 0.5 * (p.headW + (p.footW - p.headW) * s);
      const x = -hw + (gx / 24) * 2 * hw;
      cloth.clothSurface(x, y, p, pt);
      if (![pt.y, pt.z, pt.nx, pt.ny, pt.nz].every(Number.isFinite)) { nan += 1; continue; }
      // Surface point P(x, y) = (x, y'(y), z(x, y)); tangents by central differences.
      cloth.clothSurface(x + e, y, p, a); cloth.clothSurface(x - e, y, p, b);
      cloth.clothSurface(x, y + e, p, c); cloth.clothSurface(x, y - e, p, d);
      const tx = new THREE.Vector3(2 * e, a.y - b.y, a.z - b.z);
      const ty = new THREE.Vector3(0, c.y - d.y, c.z - d.z);
      const fd = tx.cross(ty).normalize();
      const an = new THREE.Vector3(pt.nx, pt.ny, pt.nz);
      worst = Math.max(worst, THREE.MathUtils.radToDeg(an.angleTo(fd)));
    }
  }
  expect('no NaN anywhere on the grid (incl. wind 0, hoist 0.06)', nan === 0, `${nan} NaN points`);
  expect('analytic normals match finite differences (< 0.5 deg) on 4 states x 345 points', worst < 0.5, `worst ${worst.toFixed(3)} deg`);
}

// ── 5. hoist gathers at the yard, no squash of the head ──────────────────────
{
  const p = sailDims({ fill: 0.6, luff: 0, hoist: 0.3 });
  cloth.clothSurface(0, p.height * 0.5, p, pt); const head = pt.y;
  cloth.clothSurface(0, -p.height * 0.5, p, pt); const foot = pt.y;
  expect('hoist 0.3: head stays at the yard, foot rises to 30% of the drop', Math.abs(head - p.height * 0.5) < 1e-9 && Math.abs((head - foot) - 0.3 * p.height) < 1e-9,
    `head ${head.toFixed(2)}, drop ${(head - foot).toFixed(2)} of ${p.height}`);
  let folds = 0; let prev = null;
  for (let i = 1; i < 200; i++) {
    const z = cloth.clothSurface(5.5, p.height * 0.5 - (i / 200) * p.height, { ...p, fill: 0 }, pt).z;
    if (prev !== null && Math.sign(z) !== Math.sign(prev)) folds += 1;
    prev = z;
  }
  expect('a part-hoisted sail hangs in folds (>= 5 reversals down the cloth)', folds >= 5, `${folds}`);
  const full = cloth.clothSurface(5.5, 0, { ...p, hoist: 1, fill: 0 }, pt).z;
  expect('a fully hoisted sail has no folds', Math.abs(full) < 1e-9, `${full}`);
}

// ── 6. tears from sailIntegrity only ─────────────────────────────────────────
{
  const area = (integrity) => {
    const tear = cloth.sailTearAmount(integrity); let n = 0; let holes = 0;
    for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) { n += 1; if (cloth.clothTornAt(i / 99, j / 99, tear, 1.3)) holes += 1; }
    return holes / n;
  };
  const a1 = area(1); const a6 = area(0.6); const a2 = area(0.2); const a0 = area(0);
  expect('intact sail has no holes; holes grow as integrity falls; never more than 25% of the cloth', a1 === 0 && a6 <= a2 && a2 <= a0 && a0 > 0.02 && a0 < 0.25,
    `${a1.toFixed(3)} / ${a6.toFixed(3)} / ${a2.toFixed(3)} / ${a0.toFixed(3)}`);
  expect('the bolt-rope border never tears', !cloth.clothTornAt(0.02, 0.5, 1, 0) && !cloth.clothTornAt(0.5, 0.97, 1, 0));
}

// ── 7. drawing sails belly to leeward of the apparent wind (anim contract) ───
{
  let worst = 1; let cases = 0;
  for (let h = 0; h < 8; h++) {
    const shipRot = -Math.PI + (h * Math.PI) / 4 + 0.2;
    for (const offWind of [0.9, 1.4, 2.0, 2.6, 3.0, -1.2, -1.9, -2.7]) {
      const windDir = shipRot + offWind + Math.PI;
      const rel = Math.atan2(Math.sin(windDir - shipRot), Math.cos(windDir - shipRot));
      let best = -1; let brace = 0;
      for (let a = -1.5; a <= 1.5; a += 0.01) { const c = braceCatch(a, rel); if (c > best) { best = c; brace = a; } }
      if (best < 0.3) continue;
      const aw = apparentWindLocal(windDir, 0.9, shipRot, Math.sin(shipRot) * 6, Math.cos(shipRot) * 6);
      const yaw = Math.max(-1.15, Math.min(1.15, brace));
      const fill = cloth.sailFillTarget(aw.localYaw, aw.speed, yaw, best, false);
      // belly world direction = sign(fill) * sail normal; leeward = along the flow.
      const bellyDotFlow = Math.sign(fill) * Math.cos(aw.localYaw - yaw);
      worst = Math.min(worst, fill > 0 ? bellyDotFlow : -1); cases += 1;
    }
  }
  expect(`trimmed sails draw (fill > 0) and belly to leeward at 8 headings (${cases} cases)`, cases >= 30 && worst > 0, `worst ${worst.toFixed(3)}`);
}

// ── 8. no per-frame CPU cloth in the sail path ───────────────────────────────
{
  const sr = readFileSync(new URL('../src/client/rendering/ShipRenderer.ts', import.meta.url), 'utf8');
  const sails = readFileSync(new URL('../src/client/rendering/ship/sails.ts', import.meta.url), 'utf8');
  const cpuCloth = /updateSailCloth|clothNormals|clothBase/;
  expect('ShipRenderer and ship/sails.ts carry no CPU cloth step (updateSailCloth / clothNormals / clothBase)', !cpuCloth.test(sr) && !cpuCloth.test(sails),
    `${cpuCloth.test(sr) ? 'ShipRenderer ' : ''}${cpuCloth.test(sails) ? 'sails.ts' : ''}`);
  expect('ShipRenderer drives the GPU cloth (setSailClothUniforms) and no longer pulses scale.z (sin(t*1.2)); square sails take the cloth branch',
    /setSailClothUniforms\(/.test(sr) && !/Math\.sin\(t \* 1\.2/.test(sr) && /if \(cloth\) \{/.test(sr));
  // The per-frame uniform write itself never touches geometry.
  const orig = THREE.BufferGeometry.prototype.computeVertexNormals; let calls = 0;
  THREE.BufferGeometry.prototype.computeVertexNormals = function () { calls += 1; return orig.call(this); };
  const mat = new THREE.MeshStandardMaterial();
  const u = cloth.attachSailCloth(mat, 10, 12, 8, 0.3);
  for (let f = 0; f < 120; f++) cloth.setSailClothUniforms(u, Math.sin(f), 0.5, 0.8, f / 60, 0.7, 0.4);
  THREE.BufferGeometry.prototype.computeVertexNormals = orig;
  expect('120 frames of cloth updates: 0 computeVertexNormals calls', calls === 0, `${calls}`);
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <clipping_planes_fragment>' };
  mat.onBeforeCompile(shader, null);
  expect('shader patch lands (cloth position, analytic normal, tear discard) with per-sail uniforms',
    /vec3 transformed = clothPos/.test(shader.vertexShader) && /objectNormal = clothNormal/.test(shader.vertexShader) && /discard/.test(shader.fragmentShader) && shader.uniforms.uCloth0 === u.uCloth0,
    '');
  const g = cloth.makeSailClothGeometry(10, 12, 8, 24, 16);
  expect('LOD0 grid 24x16 = 425 vertices, bounds cover aback', g.attributes.position.count === 425 && g.boundingBox.min.z < -1.2, `${g.attributes.position.count} verts, min z ${g.boundingBox.min.z.toFixed(2)}`);
}

console.log(`\n${checks - failures}/${checks} checks`);
if (failures) { console.log(`FAIL: ${failures} sail-cloth check(s)`); process.exit(1); }
console.log('PASS: sail cloth model');
