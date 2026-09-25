// Server flooding (lane b2.2). Extracted from PhysicsSystem (b2.2a): the hole
// evaluation, the ingress sum, the flood list and the bilge step now live here
// and read the shared Torricelli law (src/shared/flooding/floodModel.ts) and
// fill table (src/shared/flooding/hullVolume.ts). PhysicsSystem re-exports
// every name, so its callers and the suites keep their imports.
import type { Ship, ShipHole, ShipHoleSource } from '../../shared/types/index.js';
import { FLOODING, SHIP, SHIP_STATS, SHIP_UPGRADES } from '../../shared/constants/index.js';
import { countOpenHoles, getShipHoleTier } from '../../shared/interactions.js';
// Circular with PhysicsSystem, read only at call time (never at module eval).
import { HULL_IMPACT } from './PhysicsSystem.js';
import { clamp, gerstnerHeight, WAVE_PARAMS } from '../../shared/utils/index.js';
import { holeIngress, holeInsideHead, holeSizeArea, waterlineHoleIngress } from '../../shared/flooding/floodModel.js';

/** A hull with every slot an OPEN breach is "shot to pieces" (liveplay-v02):
 *  a wetter shot EVICTS the driest open hole (moves it down to the new point,
 *  ties by lowest id) so a waterline hit on a saturated hull still floods, and
 *  after GRACE_SECONDS at the cap the seams work open by themselves at
 *  FORCED_INGRESS water-level/s, so a hull nobody planks founders instead of
 *  being immune. */
export const HULL_SATURATION = {
  GRACE_SECONDS: 20,
  FORCED_INGRESS: 0.02,
  /** A new point must sit at least this much LOWER than the driest open hole
   *  to evict it — a shot at the same height lands in the existing wound. */
  EVICT_MIN_DROP: 0.05,
} as const;
/** Sim time at which each hull reached the open-hole cap (server-private:
 *  keyed by the live Ship object, never on the wire). */
const saturatedSince = new WeakMap<Ship, number>();
/** Seconds a hull has sat at the open-hole cap (0 when below it). */
export function hullSaturatedFor(ship: Ship, t: number): number {
  const since = saturatedSince.get(ship);
  return since === undefined ? 0 : Math.max(0, t - since);
}

export interface HoleFlood {
  hole: ShipHole;
  /** Metres below the LIVE outside surface (negative = above it). */
  depth: number;
  /** Head the hold water pushes back with (0 until the water covers the hole). */
  insideHead: number;
  /** Fill fraction per second through this hole (reinforcement not applied). */
  ingress: number;
  flooding: boolean;
  /** ingress / the waterline reference, capped: the weight in the flood list. */
  rateFactor: number;
}

/**
 * Per-HOLE flood evaluation. Every unpatched breach is tested at its own
 * hull-local point: the hole's world Y carries ship heave (position.y, which
 * includes the settle), pitch and roll, so a breach on the raised windward rail
 * of a heeled ship stays dry while its opposite number gushes. `depth` is metres
 * below the LIVE Gerstner surface, and ingress follows the sqrt law of the net
 * head (outside depth minus the inside head), so a settling hull drags its own
 * holes deeper and floods faster: the doom spiral.
 */
export function evaluateHoleFlood(ship: Ship, t: number, storm = 0): HoleFlood[] {
  const sinR = Math.sin(ship.rotation);
  const cosR = Math.cos(ship.rotation);
  const sinPitch = Math.sin(ship.pitch ?? 0);
  const sinRoll = Math.sin(ship.roll ?? 0);
  const fill = clamp(ship.waterLevel ?? 0, 0, 1);
  const ref = waterlineHoleIngress(ship.type);
  const out: HoleFlood[] = [];
  for (const hole of ship.holes ?? []) {
    if (hole.patched) continue;
    const worldX = ship.position.x + hole.x * cosR + hole.z * sinR;
    const worldZ = ship.position.z + hole.z * cosR - hole.x * sinR;
    // Positive roll lifts the +x (PORT, see sideOfLocalX) rail; positive pitch dips the bow (+z).
    const holeY = ship.position.y + hole.y + hole.x * sinRoll - hole.z * sinPitch;
    // Storm seas break over holes that calm water would leave dry.
    const surfaceY = gerstnerHeight(worldX, worldZ, t, WAVE_PARAMS, storm);
    const depth = surfaceY - holeY;
    const insideHead = holeInsideHead(ship.type, fill, hole.y);
    const size = (hole as ShipHole & { size?: number }).size;
    const ingress = holeIngress(ship.type, holeSizeArea(size), depth, insideHead);
    out.push({
      hole,
      depth,
      insideHead,
      ingress,
      flooding: ingress > 0,
      rateFactor: ref > 0 ? Math.min(FLOODING.LIST_WEIGHT_MAX, ingress / ref) : 0,
    });
  }
  return out;
}

/** Total ingress (fill fraction/sec) from every open hole under the surface.
 *  A reinforced hull seeps slower (HULL_INGRESS_MULT). */
export function shipIngressRate(ship: Ship, t: number, storm = 0): number {
  const reinforced = ship.upgrades.some((u) => u.type === 'hull_reinforcement')
    ? SHIP_UPGRADES.HULL_INGRESS_MULT
    : 1;
  let total = 0;
  for (const h of evaluateHoleFlood(ship, t, storm)) total += h.ingress;
  return total * reinforced;
}

/**
 * SERVER-owned list. The heel and trim a hull takes from the water standing in
 * her, derived ONLY from her open breaches (which rail they are on, which end,
 * and how hard each one runs) so a seeded match replays the same lean. b2.2c
 * replaces this with the slosh water centroid.
 *
 * Conventions match the renderer and updateShipWaveAttitude: positive roll
 * LIFTS the +x (port) rail, so breaches keyed 'starboard' (= +x, the legacy
 * HullSections key) produce a NEGATIVE roll (that rail goes down); positive
 * pitch DIPS the bow, so a flooded bow trims positive.
 */
export function floodListTargets(ship: Ship, t: number, storm = 0): { roll: number; trim: number } {
  const stats = SHIP_STATS[ship.type];
  const halfW = Math.max(0.001, stats.width * 0.5);
  const halfL = Math.max(0.001, stats.length * 0.5);
  let lateral = 0;
  let longitudinal = 0;
  for (const h of evaluateHoleFlood(ship, t, storm)) {
    if (!h.flooding) continue;
    lateral += h.rateFactor * clamp(h.hole.x / halfW, -1, 1);
    longitudinal += h.rateFactor * clamp(h.hole.z / halfL, -1, 1);
  }
  return {
    roll: clamp(-lateral * FLOODING.LIST_ROLL_GAIN, -FLOODING.LIST_ROLL_MAX, FLOODING.LIST_ROLL_MAX),
    trim: clamp(longitudinal * FLOODING.LIST_TRIM_GAIN, -FLOODING.LIST_TRIM_MAX, FLOODING.LIST_TRIM_MAX),
  };
}

/**
 * Advance a ship's bilge one step: ingress from open holes. A stock hull has
 * NO passive pump (D15: water stays until bailed); hull_reinforcement keeps a
 * slow one. Publishes ship.floodingRate (the client gauge trend) and douses
 * fire once a hole is taking water. Bailing (player/bot) removes water
 * separately, before this runs in the tick.
 */
export function updateShipFlooding(ship: Ship, t: number, dt: number, storm = 0): void {
  const water = ship.waterLevel ?? 0;
  let ingress = shipIngressRate(ship, t, storm);
  // Shot to pieces: at the cap for longer than the grace the seams open.
  if (countOpenHoles(ship) >= FLOODING.MAX_HOLES_PER_SHIP) {
    if (!saturatedSince.has(ship)) saturatedSince.set(ship, t);
    if (hullSaturatedFor(ship, t) > HULL_SATURATION.GRACE_SECONDS) ingress += HULL_SATURATION.FORCED_INGRESS;
  } else if (saturatedSince.has(ship)) {
    saturatedSince.delete(ship);
  }
  if (ingress > 0) {
    ship.waterLevel = clamp(water + ingress * dt, 0, 1);
    ship.floodingRate = ingress;
    // Water pouring through a submerged hole douses a deck fire.
    if (ship.onFire) {
      ship.onFire = false;
      ship.fireTimer = 0;
      ship.fireDamageAccum = 0;
    }
    return;
  }
  const pumpFactor = ship.upgrades.some((u) => u.type === 'hull_reinforcement')
    ? SHIP_UPGRADES.REINFORCED_PUMP_FACTOR
    : FLOODING.PASSIVE_PUMP_FACTOR;
  const pump = FLOODING.BAIL_RATE * pumpFactor;
  ship.waterLevel = clamp(water - pump * dt, 0, 1);
  ship.floodingRate = pump > 0 && (ship.waterLevel ?? 0) > 0 ? -pump : 0;
}

/**
 * Punch `count` breaches into the planking at an EXACT hull-local point —
 * the single entry point for every damage source (cannon, ram, rock,
 * grounding, keg, storm, fire). Extra holes from the same hit are jittered
 * ±0.35 m along the hull so a broadside reads as a cluster of separate
 * wounds rather than one stacked disc.
 *
 * A hull already carrying MAX_HOLES_PER_SHIP entities does NOT go immune:
 * the hit RE-OPENS the patched hole nearest the impact (the plank is blown
 * off), so sustained fire keeps degrading a heavily-repaired hull. Only if
 * every slot is an open hole does the shot land on an existing wound.
 *
 * Re-arms the field-repair cooldown so anchored auto-carpentry can't
 * instantly undo a fresh hit. Returns the entities that changed, for the
 * ship_damage wire event that spawns client decals the same frame.
 */
export function openShipHoles(
  ship: Ship,
  local: { x: number; y: number; z: number },
  count = 1,
  source?: ShipHoleSource,
): ShipHole[] {
  if (count <= 0) return [];
  if (!Array.isArray(ship.holes)) ship.holes = [];
  const stats = SHIP_STATS[ship.type];
  // Ceiling = the topside limit: a ball that struck the sheer strake leaves
  // a DRY hole up there (it floods only once she lists) instead of being
  // dragged down to the wale (ships-17); anything higher is a deck hit and
  // never reaches this function.
  const maxY = Math.max(FLOODING.HOLE_BAND_Y.max, stats.height * HULL_IMPACT.TOPSIDE_TOP_F);
  const opened: ShipHole[] = [];
  for (let i = 0; i < count; i += 1) {
    // Deterministic-ish spread: first hole lands exactly on the contact
    // point, siblings scatter around it along the hull.
    const spread = i === 0 ? 0 : 0.35;
    const angle = i * 2.399963; // golden-angle fan — no two siblings overlap
    // Clamp onto the hull itself: contact points from collision SAMPLES carry
    // the sample radius and can sit a little proud of the skin, and a breach
    // outside the planking would flood-test (and render) off the hull.
    const point = {
      x: clamp(local.x + Math.cos(angle) * spread, -stats.width * 0.52, stats.width * 0.52),
      // Siblings scatter DOWNWARD only: torn planking splits toward the sea,
      // and it keeps a keel scrape a keel scrape instead of walking a
      // grounding breach up above the waterline.
      y: clamp(local.y - (i === 0 ? 0 : Math.abs(Math.sin(angle)) * 0.12), -stats.height * 0.35, maxY),
      z: clamp(local.z + Math.sin(angle) * spread, -stats.length * 0.5, stats.length * 0.5),
    };
    opened.push(placeShipHole(ship, point, source));
  }
  ship.repairCooldown = Math.max(ship.repairCooldown, SHIP.FIELD_REPAIR_DELAY);
  ship.autoRepairProgress = 0;
  return opened;
}

/** Insert one breach entity, recycling the nearest patched slot when the hull
 *  is at its wire/shader cap. */
function placeShipHole(ship: Ship, point: { x: number; y: number; z: number }, source?: ShipHoleSource): ShipHole {
  if (ship.holes.length < FLOODING.MAX_HOLES_PER_SHIP) {
    const hole: ShipHole = {
      id: ship.nextHoleId ?? (ship.nextHoleId = 1),
      x: point.x,
      y: point.y,
      z: point.z,
      patched: false,
      tier: getShipHoleTier(point.y, SHIP_STATS[ship.type]),
      ...(source ? { source } : {}),
    };
    ship.nextHoleId = hole.id + 1;
    ship.holes.push(hole);
    return hole;
  }
  // Saturated hull: blow the plank off the nearest patched breach.
  let victim: ShipHole | null = null;
  let bestSq = Infinity;
  for (const hole of ship.holes) {
    if (!hole.patched) continue;
    const d2 = (hole.x - point.x) ** 2 + (hole.y - point.y) ** 2 + (hole.z - point.z) ** 2;
    if (d2 < bestSq) { bestSq = d2; victim = hole; }
  }
  // Every slot already an OPEN hole. A WETTER shot evicts the driest open
  // breach (highest y, ties by lowest id) and moves it down to the new point
  // so a waterline hit on a shot-up hull still floods (liveplay-v02); a shot
  // no lower than the driest lands in an existing wound.
  if (!victim) {
    let driest = ship.holes[0];
    for (const hole of ship.holes) {
      if (hole.y > driest.y || (hole.y === driest.y && hole.id < driest.id)) driest = hole;
    }
    if (point.y < driest.y - HULL_SATURATION.EVICT_MIN_DROP) {
      victim = driest;
    } else {
      let nearest = ship.holes[0];
      let nearestSq = Infinity;
      for (const hole of ship.holes) {
        const d2 = (hole.x - point.x) ** 2 + (hole.y - point.y) ** 2 + (hole.z - point.z) ** 2;
        if (d2 < nearestSq) { nearestSq = d2; nearest = hole; }
      }
      return nearest;
    }
  }
  victim.patched = false;
  victim.x = point.x;
  victim.y = point.y;
  victim.z = point.z;
  // A recycled slot MOVED: re-stamp its tier or the breach lies about its
  // height for the rest of the match (the wire byte the client reads).
  victim.tier = getShipHoleTier(point.y, SHIP_STATS[ship.type]);
  if (source) victim.source = source;
  return victim;
}
