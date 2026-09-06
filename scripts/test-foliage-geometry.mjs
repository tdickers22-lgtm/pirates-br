#!/usr/bin/env node
// Geometry/lighting contracts for instanced understory; no canvas or WebGL.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeGrassTuftGeometry, makeFernRosetteGeometry, understoryDensity } from '../src/client/world/island/FoliageGeometry.ts';
import { applyFoliageSway } from '../src/client/world/island/PropScatterer.ts';

for (const [name, build, budget, minHeight, maxHeight] of [
  ['grass', makeGrassTuftGeometry, 32, 0.35, 0.7],
  ['fern', makeFernRosetteGeometry, 350, 0.65, 1.0],
]) {
  const geo = build();
  const pos = geo.attributes.position;
  const normal = geo.attributes.normal;
  const color = geo.attributes.color;
  assert.ok(geo.index.count / 3 <= budget, `${name} exceeds per-instance triangle budget`);
  assert.equal(color.count, pos.count, `${name} loses root/tip color on part of its mesh`);
  assert.ok([...pos.array, ...normal.array, ...color.array].every(Number.isFinite), `${name} contains non-finite attributes`);
  const size = geo.boundingBox.getSize(new THREE.Vector3());
  assert.ok(size.y >= minHeight && size.y <= maxHeight, `${name} is outside human-scale cover bounds: ${size.y}`);
  assert.ok(geo.boundingBox.min.y <= 0 && geo.boundingBox.min.y >= -0.08, `${name} roots do not seat into soil`);
  assert.ok(size.x > 0.2 && size.z > 0.2, `${name} collapses to a card from the side`);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let surfaceArea = 0;
  for (let i = 0; i < geo.index.count; i += 3) {
    a.fromBufferAttribute(pos, geo.index.getX(i));
    b.fromBufferAttribute(pos, geo.index.getX(i + 1));
    c.fromBufferAttribute(pos, geo.index.getX(i + 2));
    const area = b.sub(a).cross(c.sub(a)).length() * 0.5;
    assert.ok(area > 1e-8, `${name} has a collapsed triangle`);
    surfaceArea += area;
  }
  assert.ok(surfaceArea > (name === 'grass' ? 0.04 : 0.09), `${name} has no readable leaf area`);
  assert.deepEqual(build().attributes.position.array, pos.array, `${name} changes geometry between builds`);
  console.log(`PASS: ${name} has finite, rooted, dimensional leaf geometry within budget (${geo.index.count / 3} triangles)`);
  geo.dispose();
}

let low = 1, high = 0, discontinuity = 0;
for (let x = -80; x <= 80; x += 4) {
  for (let z = -80; z <= 80; z += 4) {
    const lush = understoryDensity('lush', x, z, 1234);
    low = Math.min(low, lush); high = Math.max(high, lush);
    assert.ok(lush > 0 && lush <= 1, 'density must be a probability');
    assert.ok(understoryDensity('volcanic', x, z, 1234) < lush * 0.4, 'volcanic ground cannot grow a lush lawn');
    assert.equal(understoryDensity('lush', x, z, 1234), lush, 'density must be deterministic');
    discontinuity = Math.max(discontinuity, Math.abs(lush - understoryDensity('lush', x + 0.05, z, 1234)));
  }
}
assert.ok(high - low > 0.4 && discontinuity < 0.02, 'cover must form coherent thickets and clearings');
console.log('PASS: seeded understory has continuous patches and biome-dependent density');

const material = new THREE.MeshStandardMaterial({ vertexColors: true });
material.onBeforeCompile = shader => { shader.vertexShader = '#define INHERITED_TINT\n' + shader.vertexShader; };
material.customProgramCacheKey = () => 'inherited-tint';
const host = { foliageTime: { value: 12 }, foliageWind: { value: new THREE.Vector2(1, 0) } };
applyFoliageSway(material, host, true);
const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
material.onBeforeCompile(shader, null);
assert.ok(shader.vertexShader.includes('#define INHERITED_TINT'), 'wind dropped the existing material patch');
assert.equal(shader.uniforms.uFoliageTime, host.foliageTime);
assert.equal(shader.uniforms.uFoliageWind, host.foliageWind);
assert.equal(shader.uniforms.uFoliageFlex.value.x, 0, 'short ground cover must bend above its roots');
const key = material.customProgramCacheKey();
applyFoliageSway(material, host, true);
assert.equal(material.customProgramCacheKey(), key, 'repeat registration stacks wind patches');
assert.ok(key.includes('inherited-tint'), 'wind dropped the inherited cache key');
console.log('PASS: wind shares the live uniforms and preserves existing material patches');
