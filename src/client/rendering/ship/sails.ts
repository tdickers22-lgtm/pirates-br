import * as THREE from 'three';

// Sail cloth step, moved out of ShipRenderer (b4.2a). The GPU cloth of b4.2g
// replaces this module's CPU loop; until then it is the same code, moved.

/** CPU cloth: traveling wind ripple plus hard luff flutter when the sail is
 *  depowered (trim far from the wind). Displaces the low-vert sail plane
 *  along its billow normal; the yard-attached top edge stays pinned. */
export function updateSailCloth(
  sail: THREE.Mesh,
  t: number,
  windStrength: number,
  trimCatch: number,
  sailHeight: number,
  sailIntegrity: number,
  luffing = false,
frameIndex = 0,
): void {
  const base = sail.userData.clothBase as Float32Array | undefined;
  if (!base) return;
  const w = sail.userData.clothW as number;
  const h = sail.userData.clothH as number;
  const minDim = Math.min(w, h);
  const phaseSeed = typeof sail.userData.phaseSeed === 'number' ? sail.userData.phaseSeed : sail.position.z;
  const phase = phaseSeed * 0.7 + sail.position.y * 0.31;
  const rippleAmp = (0.012 + 0.02 * windStrength) * minDim * sailHeight;
  const depower = 1 - trimCatch;
  // Luffing hits the whole sail (not just the leech) with a fast, deep flap.
  const luffGain = luffing ? 0.14 : 0.055;
  const luffFreq = luffing ? 16.5 : 11.5;
  const luffAmp = Math.min(0.55, depower * depower * luffGain * minDim) * sailHeight * (0.4 + 0.6 * sailIntegrity);
  if (rippleAmp < 0.001 && luffAmp < 0.001) return;

  const posAttr = sail.geometry.attributes.position as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;
  const invH = 1 / Math.max(h, 0.001);
  for (let i = 0; i < posAttr.count; i++) {
    const i3 = i * 3;
    const x = base[i3];
    const y = base[i3 + 1];
    const nyTop = (y + h * 0.5) * invH; // 1 at the yard, 0 at the foot
    const pin = 1 - nyTop * nyTop;
    const ripple = Math.sin(t * 2.7 + x * 0.85 + y * 0.55 + phase) * rippleAmp;
    const luff = Math.sin(t * luffFreq + x * 2.7 + phase * 1.7) * luffAmp;
    arr[i3 + 2] = base[i3 + 2] + (ripple + luff) * pin;
  }
  posAttr.needsUpdate = true;
  // Normal recompute is the expensive half of the cloth sim and the low-amp
  // ripple barely moves them — refresh every 3rd frame, staggered per sail.
  if ((frameIndex + sail.id) % 3 === 0) {
    clothNormals(sail.geometry);
  }
}

/**
 * computeVertexNormals for the cloth grid, straight on the typed arrays.
 * three's version reads every corner through BufferAttribute.getX/Y/Z, which
 * boxed a HeapNumber per read: ~22 KB per CPU frame on the low tier (b3 gate
 * test-frame-allocation, scripts/probes/alloc-profile.mjs), the largest
 * single allocator after ShipRenderer.update itself. Same winding and result
 * (face normal = (C - B) x (A - B), summed per vertex, normalised).
 */
export function clothNormals(geo: THREE.BufferGeometry): void {
  const nAttr = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const index = geo.index;
  if (!nAttr || !index) { geo.computeVertexNormals(); return; }
  const p = geo.attributes.position.array as Float32Array;
  const n = nAttr.array as Float32Array;
  const ix = index.array;
  n.fill(0);
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    const cbx = p[c] - p[b], cby = p[c + 1] - p[b + 1], cbz = p[c + 2] - p[b + 2];
    const abx = p[a] - p[b], aby = p[a + 1] - p[b + 1], abz = p[a + 2] - p[b + 2];
    const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2]);
    if (len > 0) { const inv = 1 / len; n[i] *= inv; n[i + 1] *= inv; n[i + 2] *= inv; }
  }
  nAttr.needsUpdate = true;
}
