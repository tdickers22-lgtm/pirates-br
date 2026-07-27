/**
 * Contact shadows for the dressing layer.
 *
 * At noon nothing under a prop was darker than the ground beside it: the sun
 * shadow map only reaches the near cascade and skips the small stuff entirely,
 * so boulders, logs, camp clutter and palms all read as stickers pasted onto
 * the island. The cheapest honest fix in a forward renderer is the oldest one —
 * a soft radial decal under each piece.
 *
 * The rules that keep it cheap and keep it from looking like a decal:
 *   • ONE shared radial texture and ONE instanced quad mesh per island. A quad
 *     per prop would have added ~300 draw calls per island (the draw budget for
 *     the whole dock vista is 2,900).
 *   • MULTIPLY blending, so the decal darkens whatever ground colour is under
 *     it instead of stamping a grey disc — it survives every biome palette,
 *     wet sand, ash and the night lighting curve without tuning.
 *   • Each quad lies in the terrain's own plane (the drawn triangle normal from
 *     GroundTruth), lifted a few centimetres, depth-write off. A flat quad on a
 *     15° hillside cuts into the slope and reads as a floating card.
 *   • Strength fades out with slope: a blob on a near-vertical caldera wall is
 *     a smear, not a shadow.
 */
import * as THREE from 'three';
import type { IslandBuildCtx } from './context.js';
import { getMeshGround } from './GroundTruth.js';

type ShadowRequest = {
  x: number;
  z: number;
  radius: number;
  strength: number;
};

/** Queued per island id between the first builder that asks for a shadow and
 *  the flush at the end of the island's decor pass. */
const pending = new Map<string, ShadowRequest[]>();

let shadowTexture: THREE.Texture | null = null;
let shadowMaterial: THREE.MeshBasicMaterial | null = null;

/** Soft radial falloff, dark in the middle and pure white at the rim (white is
 *  the identity for multiply blending, so the quad's edge vanishes). */
function getShadowTexture(): THREE.Texture {
  if (shadowTexture) return shadowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Umbra core, a long soft penumbra, dead white by the rim.
  grad.addColorStop(0.0, 'rgba(28, 26, 24, 0.92)');
  grad.addColorStop(0.35, 'rgba(48, 45, 40, 0.62)');
  grad.addColorStop(0.68, 'rgba(90, 86, 78, 0.26)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  shadowTexture = tex;
  return tex;
}

function getShadowMaterial(): THREE.MeshBasicMaterial {
  if (shadowMaterial) return shadowMaterial;
  const mat = new THREE.MeshBasicMaterial({
    map: getShadowTexture(),
    color: 0xffffff,
    transparent: true,              // three only applies `blending` to transparent materials
    blending: THREE.MultiplyBlending,
    depthWrite: false,
    // The decal lies IN the terrain surface; a depth bias keeps the hillside
    // from punching through it at grazing angles.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    // Fog would tint the multiply toward the sky colour — i.e. distant shadows
    // would BRIGHTEN the ground. The layer is culled by distance instead.
    fog: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aShadowFade;\nvarying float vShadowFade;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vShadowFade = 1.0;
         // Guarded like every shared-material injection here: the attribute
         // only exists on the instanced decal geometry.
         #ifdef USE_INSTANCING
         vShadowFade = aShadowFade;
         #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vShadowFade;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n'
        // White is the multiply identity: fading toward white fades the shadow out.
        + 'diffuseColor.rgb = mix(vec3(1.0), diffuseColor.rgb, clamp(vShadowFade, 0.0, 1.0));',
      );
  };
  mat.customProgramCacheKey = () => 'pirates-contact-shadow';
  shadowMaterial = mat;
  return mat;
}

/**
 * Ask for a contact shadow under a piece standing at island-local (x, z).
 * `radius` is the piece's ground footprint radius; anything under ~0.25 m is
 * dropped (a shell does not shade the beach). Ignored at low quality.
 */
export function queueContactShadow(
  ctx: IslandBuildCtx,
  x: number,
  z: number,
  radius: number,
  strength = 1,
): void {
  if (ctx.lowDetail) return;
  if (!(radius > 0.25) || !Number.isFinite(x) || !Number.isFinite(z)) return;
  const list = pending.get(ctx.island.id);
  if (list) list.push({ x, z, radius, strength });
  else pending.set(ctx.island.id, [{ x, z, radius, strength }]);
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Build the island's single contact-shadow mesh from everything queued for it.
 * Called once, at the end of the island's decor pass; safe to call with nothing
 * queued (and it always clears the queue, so a rebuild starts clean).
 */
export function flushContactShadows(ctx: IslandBuildCtx): THREE.InstancedMesh | null {
  const { island, group } = ctx;
  const requests = pending.get(island.id);
  pending.delete(island.id);
  if (!requests || requests.length === 0) return null;
  const ground = getMeshGround(island);

  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI * 0.5);
  const fades = new Float32Array(requests.length);
  const mesh = new THREE.InstancedMesh(geometry, getShadowMaterial(), requests.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let placed = 0;
  for (const req of requests) {
    const hit = ground?.hit(req.x, req.z) ?? null;
    if (!hit) continue;
    normal.set(hit.nx, hit.ny, hit.nz);
    // A shadow needs a floor to fall on: past ~55° there isn't one, and a blob
    // on the caldera's inner wall reads as a stain.
    const slopeFade = THREE.MathUtils.clamp((hit.ny - 0.55) / 0.3, 0, 1);
    if (slopeFade <= 0.02) continue;
    quaternion.setFromUnitVectors(UP, normal);
    // Lift along the normal, more on steeper ground where the quad spans a
    // bigger height range across its own width.
    const lift = 0.04 + req.radius * 0.02 + (1 - hit.ny) * req.radius * 0.5;
    position.set(req.x + normal.x * lift, hit.y + normal.y * lift, req.z + normal.z * lift);
    const d = req.radius * 2.35;
    scale.set(d, 1, d);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(placed, matrix);
    fades[placed] = THREE.MathUtils.clamp(req.strength, 0, 1) * slopeFade;
    placed += 1;
  }
  if (placed === 0) {
    geometry.dispose();
    return null;
  }
  mesh.count = placed;
  geometry.setAttribute('aShadowFade', new THREE.InstancedBufferAttribute(fades, 1));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Ground decals belong under every other transparent thing in the scene
  // (spray, mist, the ocean's shallows band).
  mesh.renderOrder = -2;
  mesh.name = 'island-contact-shadows';
  group.add(mesh);
  return mesh;
}
