/**
 * INSTANCE-COUNT LOD — the triangle diet for scattered props.
 *
 * The draw-call diet merged the scenery and gated the characters, and the wide
 * shots still cost two to three and a half MILLION triangles. The census says
 * where they are: on a settled cave-interior frame, 2.5M triangles belong to
 * island detail roots and 1.33M of those — 53% — are the `props-*`
 * InstancedMeshes. They are gated by exactly one thing, the island's detail
 * radius, so an island 1,022 m away pays for every palm, every barrel and every
 * half-metre flower patch it has, at full geometry, because it has not yet
 * crossed a line drawn at 950 m.
 *
 * A draw call is not what those cost. One `props-flower_patch` batch is ONE
 * call and 43,000 triangles, and a flower patch is 0.48 m tall: at a kilometre
 * it is a third of a pixel. The batcher cannot help — it is already one call —
 * and hiding the batch outright is the only thing the old gate could do, which
 * is why nobody did it.
 *
 * WHAT THIS DOES INSTEAD. Instances of one batch live in ONE contiguous buffer,
 * and three draws the first `count` of them. So sort each batch's transforms by
 * SCALE, largest first, at build time — and then the only thing the runtime has
 * to do is write a smaller number. No re-upload, no re-sort, no allocation: one
 * integer per batch per frame. Lowering it drops the SMALLEST instances first,
 * which is exactly the right order, because the small ones are the ones that
 * stopped being resolvable.
 *
 * TWO RULES DECIDE THE NUMBER, and the count is the lesser of them:
 *
 *  1. THE PIXEL FLOOR. An instance whose projected height is under a couple of
 *     pixels is not scenery, it is noise, and it costs the same 2,407 triangles
 *     as the one at your feet. Because the batch is sorted by scale and every
 *     instance of a type shares one asset height, "how many are still bigger
 *     than n pixels" is a binary search over a Float32Array. This is the rule
 *     that does the work at long range: a 9 m palm survives it to the edge of
 *     the map while the scrub under it does not survive 300 m.
 *  2. THE DENSITY RAMP. Palms pass the pixel floor everywhere, and a grove read
 *     at eight pixels tall does not need every trunk in it. A gentle fraction,
 *     piecewise-linear in distance, thins the survivors — never inside the
 *     full-detail radius, and never on the island you are standing on, because
 *     that island's EDGE distance is negative.
 *
 * BOTH RULES MEASURE APPARENT DISTANCE, not metres. Raising the spyglass
 * narrows the field of view, which is the player deliberately asking for detail
 * at range; a metre rule would answer by showing them a bald island. Distance is
 * divided by the same factor the projection is multiplied by, so a 6° scope
 * makes a kilometre behave like eighty metres and every prop comes back.
 *
 * WHY IT CANNOT POP. Scales inside a type spread over a real range, so the count
 * moves CONTINUOUSLY as the camera approaches — a batch fades in over tens of
 * metres rather than switching on. The `stagger` is a per-type phase so two
 * batch types never cross their thresholds at the same distance, and the
 * deadband below means a camera hovering on a boundary cannot oscillate: a
 * change has to be worth 5% of the batch before it is written at all.
 */
import type * as THREE from 'three';
import type { RenderQuality } from '../../rendering/QualityPreference.js';

/**
 * A batch that can be thinned, and everything the per-frame update needs.
 *
 * `scales` is DESCENDING — the invariant the whole scheme rests on. It is the
 * scatterer's job to have sorted the instance matrices into the same order; see
 * `attachInstanceLod`, which is the only place the two are tied together.
 */
export type InstanceLodBatch = {
  readonly mesh: THREE.InstancedMesh;
  /** Per-instance scale, descending. Empty for density-only batches. */
  readonly scales: Float32Array;
  /** The asset's own height in metres at scale 1. Zero for density-only batches. */
  readonly height: number;
  /** Every instance the batch was built with — the ceiling `count` returns to. */
  readonly full: number;
  /** 0..1 phase so no two batch types thin at the same distance. */
  readonly stagger: number;
  /** Which ramp this batch follows. */
  readonly kind: 'prop' | 'cover' | 'fleck';
  /** The count last written, so a hovering camera writes nothing. */
  applied: number;
  /** True while THIS module is the reason the mesh is invisible. Without it a
   *  restore would fight the radius gates that hide the same nodes. */
  hidden: boolean;
};

type LodMesh = THREE.InstancedMesh & {
  userData: { instanceLod?: InstanceLodBatch };
};

/**
 * The projected-height floor, in reference pixels, under which an instance is
 * not drawn.
 *
 * Measured against the same 1080-pixel reference the character gate uses, so a
 * probe running at 540p grades the distances a player actually gets rather than
 * a stricter set of its own. The tiers differ because a machine that opened on
 * 'low' has already told us it cannot afford the benefit of the doubt.
 */
const MIN_INSTANCE_PIXELS: Record<RenderQuality, number> = {
  low: 3.0,
  balanced: 2.1,
  high: 1.5,
};

const REFERENCE_HEIGHT_PX = 1080;
/** The field these rules are calibrated against — the on-foot FOV. */
const BASE_HALF_FOV_TAN = Math.tan((74 * Math.PI) / 360);

/**
 * The density ramp, as (apparent metres → fraction kept) knots.
 *
 * The first knot is the FULL-DETAIL RADIUS: inside it nothing is thinned at all,
 * and since island distances here are measured from the island's EDGE, an island
 * you are standing on is at a negative distance and is never touched by any of
 * this. The far knot is the floor; past it the fraction stops falling, because a
 * shoreline that keeps thinning forever eventually reads as a different island.
 */
const PROP_DENSITY_RAMP: Record<RenderQuality, readonly (readonly [number, number])[]> = {
  low: [[150, 1], [300, 0.62], [460, 0.4]],
  balanced: [[300, 1], [560, 0.74], [820, 0.5]],
  high: [[400, 1], [700, 0.78], [1000, 0.55]],
};

/**
 * Ground cover — grass tufts, ferns, shell flecks — thins on its own, steeper
 * ramp.
 *
 * These batches are already hidden past 200-300 m, so this ramp lives entirely
 * inside that: it is the band between "individual blades" and "a green tint on
 * the terrain" and the second one does not need nine thousand cards to say it.
 * They are NOT sorted by scale (their per-instance colour buffer is written in
 * placement order and re-ordering it for a rule that would drop every blade at
 * once is a bad trade), so they are density-only — and because placement order
 * is a seeded walk over the whole island, thinning by count thins uniformly in
 * space rather than eating one side of the island.
 */
const COVER_DENSITY_RAMP: readonly (readonly [number, number])[] = [[90, 1], [180, 0.58], [300, 0.3]];

/**
 * FLECKS — the scatter that exists to be looked at from two metres.
 *
 * `island-pebbles` is a scatter of sub-20cm stones whose own build comment says
 * what it is for: "the island had NOTHING between 8m props and painted colour; a
 * scatter of sub-20cm stones gives the eye real scale reference AT 2M". Up to
 * 1,400 of them per island, thirty-six triangles each, and no gate of any kind —
 * so the triangle attribution finds them at 7.3k to 11.0k triangles on every
 * island in frame, out to the full detail radius. On a settled open-sea frame
 * that is 36k triangles of gravel on five islands whose nearest edge is 470 m.
 *
 * At the 74° field this game is measured against, a 0.2 m stone is 1.6 reference
 * pixels at 100 m, 0.54 at 300 m and 0.18 at 900 m. There is no distance in the
 * band this ramp covers at which removing one of them is a thing anyone could
 * see, and past 190 m there is no distance at which drawing one is a thing
 * anyone could see either — so unlike the cover ramp, this one ends at ZERO.
 *
 * Reaching zero rather than a floor is deliberate and it is not the same change
 * as hiding the batch: the count falls continuously the whole way, so the last
 * stone leaves on its own frame instead of two hundred leaving on one. And a
 * batch whose count reaches zero is dropped from the render list outright rather
 * than submitted empty — see the visibility write in `updateInstanceLod`.
 */
const FLECK_DENSITY_RAMP: readonly (readonly [number, number])[] = [[40, 1], [110, 0.5], [190, 0]];

/** Piecewise-linear lookup, flat outside the knots. */
function rampAt(knots: readonly (readonly [number, number])[], dist: number): number {
  if (dist <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [d1, f1] = knots[i];
    if (dist <= d1) {
      const [d0, f0] = knots[i - 1];
      const t = (dist - d0) / Math.max(1e-3, d1 - d0);
      return f0 + (f1 - f0) * t;
    }
  }
  return knots[knots.length - 1][1];
}

/**
 * A stable 0..1 phase from a batch name.
 *
 * The point is only that two batch TYPES do not cross a threshold at the same
 * moment; it must be the same number every session, so it is a hash of the name
 * and not a random draw.
 */
export function staggerFor(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Register a prop batch for instance-count LOD.
 *
 * `scales` MUST be in the same order as the instance matrices already written,
 * and that order must be descending — the caller sorts its prop list before it
 * composes a single matrix, which is what keeps the two in step. Passing an
 * unsorted array would not crash; it would silently drop the wrong instances,
 * so this asserts the invariant in dev by refusing to attach when it is broken.
 */
export function attachInstanceLod(
  mesh: THREE.InstancedMesh,
  scales: readonly number[],
  assetHeight: number,
): void {
  if (scales.length === 0 || !(assetHeight > 0)) return;
  for (let i = 1; i < scales.length; i++) {
    if (scales[i] > scales[i - 1] + 1e-6) return; // not sorted: attach nothing rather than cull the wrong ones
  }
  (mesh as LodMesh).userData.instanceLod = {
    mesh,
    scales: Float32Array.from(scales),
    height: assetHeight,
    full: mesh.count,
    stagger: staggerFor(mesh.name || 'props'),
    kind: 'prop',
    applied: mesh.count,
    hidden: false,
  };
}

/** Register a ground-cover batch: density-only, no pixel rule, steeper ramp. */
export function attachCoverLod(mesh: THREE.InstancedMesh): void {
  attachDensityLod(mesh, 'cover');
}

/** Register a fleck batch — pebbles and the like: density-only, and the only
 *  ramp here that ends at zero. See FLECK_DENSITY_RAMP. */
export function attachFleckLod(mesh: THREE.InstancedMesh): void {
  attachDensityLod(mesh, 'fleck');
}

function attachDensityLod(mesh: THREE.InstancedMesh, kind: 'cover' | 'fleck'): void {
  if (mesh.count === 0) return;
  (mesh as LodMesh).userData.instanceLod = {
    mesh,
    scales: new Float32Array(0),
    height: 0,
    full: mesh.count,
    stagger: staggerFor(mesh.name || kind),
    kind,
    applied: mesh.count,
    hidden: false,
  };
}

/** Every registered batch under a subtree, resolved ONCE at build time — the
 *  per-frame update must never walk a scene graph. */
export function collectInstanceLodBatches(root: THREE.Object3D): InstanceLodBatch[] {
  const out: InstanceLodBatch[] = [];
  root.traverse((node) => {
    const batch = (node as LodMesh).userData?.instanceLod;
    if (batch) out.push(batch);
  });
  return out;
}

/**
 * How much bigger the projection makes the world than the reference field does.
 *
 * One over this is the factor a distance is divided by to get APPARENT distance,
 * which is the only distance any rule here uses. At the on-foot 74° it is 1; down
 * a 6° spyglass it is ~14, so a prop a kilometre away is judged as if it were
 * seventy metres off and every one of them comes back.
 */
export function apparentDistanceScale(fovDegrees: number): number {
  const tan = Math.tan((Math.max(1, fovDegrees) * Math.PI) / 360);
  return tan / BASE_HALF_FOV_TAN;
}

/**
 * Number of instances still at least `minPixels` tall, given the batch is sorted
 * by scale descending. Binary search — the whole reason the sort exists.
 */
function countAbovePixelFloor(batch: InstanceLodBatch, minWorldHeight: number): number {
  const minScale = minWorldHeight / batch.height;
  const scales = batch.scales;
  if (scales[0] < minScale) return 0;
  let lo = 0;
  let hi = scales.length;            // first index BELOW the floor
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (scales[mid] >= minScale) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Write this frame's instance count for every batch on one island.
 *
 * `edgeDist` is metres from the camera to the island's FOOTPRINT edge and is
 * negative when the camera is on the island — which is what makes "never thin
 * the ground you are standing on" fall out of the arithmetic rather than needing
 * a special case.
 */
export function updateInstanceLod(
  batches: readonly InstanceLodBatch[],
  edgeDist: number,
  quality: RenderQuality,
  distanceScale: number,
): void {
  if (batches.length === 0) return;
  const apparent = Math.max(0, edgeDist) / Math.max(1e-3, distanceScale);
  const propRamp = PROP_DENSITY_RAMP[quality];
  const minPixels = MIN_INSTANCE_PIXELS[quality];
  // World metres per reference pixel at this apparent distance.
  const worldPerPixel = (2 * BASE_HALF_FOV_TAN * Math.max(1, apparent)) / REFERENCE_HEIGHT_PX;

  for (const batch of batches) {
    // Stagger spreads a type's thresholds ±17% around the shared ramp, so a
    // shoreline thickens in several small instalments instead of one.
    const phase = 0.83 + batch.stagger * 0.34;
    let target: number;
    if (batch.kind === 'cover' || batch.kind === 'fleck') {
      const ramp = batch.kind === 'fleck' ? FLECK_DENSITY_RAMP : COVER_DENSITY_RAMP;
      target = Math.ceil(batch.full * rampAt(ramp, apparent * phase));
    } else {
      const byPixels = countAbovePixelFloor(batch, minPixels * worldPerPixel * phase);
      const byDensity = Math.ceil(batch.full * rampAt(propRamp, apparent * phase));
      target = byPixels < byDensity ? byPixels : byDensity;
    }
    if (target > batch.full) target = batch.full;
    if (target < 0) target = 0;
    if (target === batch.applied) {
      // THE ONE FLAG THAT HAS TO BE RE-ASSERTED. The detail reveal captures each
      // held mesh's `visible` when it begins and gives it back when the mesh is
      // let out (IslandDetailWarmup), so a batch thinned to nothing during a
      // reveal comes back visible with a zero count — and this early-out would
      // never write it again. It costs a boolean read on batches drawing
      // nothing, which is the cheapest thing in this loop.
      if (batch.hidden && batch.mesh.visible) batch.mesh.visible = false;
      continue;
    }
    // HYSTERESIS. The endpoints snap (a near island must be exactly whole, an
    // invisible one exactly empty); in between, a change has to be worth 5% of
    // the batch — or two instances, whichever is more — before it is written, so
    // a camera hovering on a threshold cannot oscillate the count.
    const deadband = Math.max(2, batch.full * 0.05);
    if (target !== 0 && target !== batch.full && Math.abs(target - batch.applied) < deadband) continue;
    batch.applied = target;
    batch.mesh.count = target;
    // AN EMPTY BATCH IS NOT A FREE BATCH. three's buffer renderer returns before
    // it draws when the instance count is zero, so the call and its triangles
    // never reach `renderer.info` — but everything upstream of the draw still
    // happens: the frustum test, the render-list insert, the sort, and then
    // setProgram with the material's whole uniform block, which is where
    // uniformMatrix4fv became the single most expensive symbol in the game.
    // Taking the batch out of the list is what actually stops paying for it.
    //
    // ONLY EVER UNDOING ITS OWN WRITE. `visible` on these nodes is not this
    // module's property: Game's lodLayers pass hides island-grass, -ferns and
    // -shells by radius on the same frame, and it runs FIRST. A bare
    // `visible = target > 0` would put the grass back on a 310 m island every
    // frame, because the cover ramp floors at 0.3 and never reaches zero. So the
    // flag is written only to hide a batch this module emptied, and restored
    // only if this module was the one that hid it.
    if (target === 0) {
      if (!batch.hidden) { batch.hidden = true; batch.mesh.visible = false; }
    } else if (batch.hidden) {
      batch.hidden = false;
      batch.mesh.visible = true;
    }
  }
}
