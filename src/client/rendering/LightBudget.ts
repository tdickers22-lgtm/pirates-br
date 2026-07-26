import * as THREE from 'three';

/**
 * A FIXED-SIZE pool of point lights, and the reason the world is allowed to
 * hang as many lanterns, torches, crystals, braziers and chest glows as the art
 * wants.
 *
 * Two things go wrong when every one of those is a real THREE.PointLight in the
 * scene:
 *
 *  1. COST. three.js is a single-pass forward renderer: every lit fragment in
 *     the frame loops over EVERY visible point light. Inside a torch-lit cave
 *     that was 36 lights per pixel. Measured on an M1 at 1600x900: 7.3 fps with
 *     36 lights, 11.3 fps with 8, 12.1 fps with none — i.e. lights past the
 *     eighth were costing more than the entire rest of the cave put together.
 *
 *  2. STALLS. The light COUNT is baked into every shader program. One torch
 *     popping in or out re-links every material in the scene. Walking toward a
 *     cave, surfacing from a dive or joining a match churned the count and cost
 *     multi-second freezes — the join and first-swim hitches were mostly this.
 *
 * So the pool is allocated once, is always `visible`, and never changes size:
 * the program cache is stable for the whole session. Each frame the brightest
 * few emitters within reach of the camera are copied into the pool and the
 * spare slots go to zero intensity. World code keeps creating ordinary
 * PointLights and toggling `.visible` for LOD exactly as before — registering
 * one hides it from three's light gathering and hands it to the pool instead.
 */

export type LightBudgetTier = 'low' | 'balanced' | 'high';

/** Simultaneous point lights per tier. Past ~8 the eye stops noticing and the
 *  fragment loop does not, so the ladder buys real frames for very little. */
const POOL_SIZE: Record<LightBudgetTier, number> = {
  low: 4,
  balanced: 6,
  high: 8,
};

/** Emitters past this from the camera cannot matter; skipped before any math. */
const MAX_CONSIDER_DISTANCE = 220;

/** A newcomer must beat the dimmest holder by this much to take its slot, so a
 *  light does not strobe on and off as you drift between two equal torches. */
const SWAP_MARGIN = 1.18;

interface Emitter {
  light: THREE.PointLight;
  /** Intended visibility, written through the shadowed `visible` accessor. */
  wanted: boolean;
}

const emitters: Emitter[] = [];
const byLight = new WeakMap<THREE.PointLight, Emitter>();
let pool: THREE.PointLight[] = [];
let scene: THREE.Scene | null = null;
let assigned: Emitter[] = [];

const scratchWorld = new THREE.Vector3();

/** Allocate the pool. Safe to call once per renderer; later calls re-tier it. */
export function initLightBudget(target: THREE.Scene, tier: LightBudgetTier): void {
  if (scene && scene !== target) clearLightBudget();
  scene = target;
  const size = POOL_SIZE[tier];
  for (const light of pool) {
    light.parent?.remove(light);
    light.dispose();
  }
  pool = [];
  for (let i = 0; i < size; i++) {
    // decay 2 = physically correct falloff, which is what every registered
    // emitter is authored against; per-frame assignment overwrites the rest.
    const light = new THREE.PointLight(0xffffff, 0, 1, 2);
    light.name = `budget-light-${i}`;
    // NEVER toggled. The whole point is that NUM_POINT_LIGHTS is a constant.
    light.visible = true;
    light.castShadow = false;
    target.add(light);
    pool.push(light);
  }
  assigned = [];
}

/**
 * Hand a world light to the budget. It stays exactly where it is in the scene
 * graph (so it still rides its island/ship/prop transform) but stops being one
 * of three's lights; the pool re-emits it when it earns a slot.
 *
 * LOD code keeps WRITING `light.visible` exactly as before and the budget obeys
 * it. Reading it back always returns `false`, because that is the answer three
 * has to hear when it gathers lights — ask `budgetLightWanted(light)` for the
 * intent instead.
 */
export function registerBudgetLight(light: THREE.PointLight): void {
  if (byLight.has(light)) return;
  const emitter: Emitter = { light, wanted: light.visible };
  Object.defineProperty(light, 'visible', {
    configurable: true,
    enumerable: true,
    get: () => false,
    set: (value: boolean) => { emitter.wanted = !!value; },
  });
  emitters.push(emitter);
  byLight.set(light, emitter);
}

/** Drop every registration and zero the pool (match teardown / world rebuild). */
export function clearLightBudget(): void {
  emitters.length = 0;
  assigned = [];
  for (const light of pool) light.intensity = 0;
}

/** What LOD last asked of this emitter (its `visible` always reads `false`). */
export function budgetLightWanted(light: THREE.PointLight): boolean {
  return byLight.get(light)?.wanted ?? light.visible;
}

/** Registered emitter count — diagnostics and tests. */
export function budgetEmitterCount(): number {
  return emitters.length;
}

/** Pool size actually allocated. */
export function budgetPoolSize(): number {
  return pool.length;
}

/**
 * Pick this frame's winners and copy them into the pool. Emitters whose branch
 * of the graph is hidden, whose `visible` was turned off, or that are no longer
 * attached to the scene are skipped (and detached ones are forgotten).
 */
export function updateLightBudget(cameraPos: THREE.Vector3): void {
  if (pool.length === 0) return;

  const previous = assigned;
  const winners: Emitter[] = [];
  const scores: number[] = [];

  for (let i = emitters.length - 1; i >= 0; i--) {
    const emitter = emitters[i];
    const light = emitter.light;

    // Prune lights that have been disposed out of the scene, so a long session
    // of island rebuilds does not walk an ever-growing list.
    let root: THREE.Object3D = light;
    let branchVisible = emitter.wanted;
    while (root.parent) {
      root = root.parent;
      if (!root.visible) branchVisible = false;
    }
    if (root !== scene) {
      emitters.splice(i, 1);
      continue;
    }
    if (!branchVisible || light.intensity <= 0.001) continue;

    light.getWorldPosition(scratchWorld);
    const distance = scratchWorld.distanceTo(cameraPos);
    if (distance > MAX_CONSIDER_DISTANCE) continue;
    const range = light.distance > 0 ? light.distance : 60;
    const reach = 1 - distance / range;
    if (reach <= 0) continue;

    // Brightness as it would land on the camera, with a nudge for whoever held
    // the slot last frame so the active set is stable while you walk.
    let score = light.intensity * reach * reach;
    if (previous.includes(emitter)) score *= SWAP_MARGIN;

    let at = winners.length;
    while (at > 0 && scores[at - 1] < score) at--;
    if (at >= pool.length) continue;
    winners.splice(at, 0, emitter);
    scores.splice(at, 0, score);
    if (winners.length > pool.length) {
      winners.length = pool.length;
      scores.length = pool.length;
    }
  }

  for (let i = 0; i < pool.length; i++) {
    const slot = pool[i];
    const emitter = winners[i];
    if (!emitter) {
      // Kept in the scene, kept `visible`, simply contributing nothing: the
      // program cache must not learn that a light went away.
      slot.intensity = 0;
      continue;
    }
    const light = emitter.light;
    light.getWorldPosition(scratchWorld);
    slot.position.copy(scratchWorld);
    slot.color.copy(light.color);
    slot.intensity = light.intensity;
    slot.distance = light.distance;
    slot.decay = light.decay;
  }

  assigned = winners;
}
