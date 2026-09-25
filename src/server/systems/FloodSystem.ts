// Server flooding (lane b2.2). Extracted from PhysicsSystem (b2.2a): the hole
// evaluation, the ingress sum, the flood list and the bilge step now live here
// and read the shared Torricelli law (src/shared/flooding/floodModel.ts) and
// fill table (src/shared/flooding/hullVolume.ts). PhysicsSystem re-exports
// every name, so its callers and the suites keep their imports.
import type { Ship, ShipHole, ShipHoleSize, ShipHoleSource } from '../../shared/types/index.js';
import { FLOODING, SHIP, SHIP_STATS, SHIP_UPGRADES } from '../../shared/constants/index.js';
import { countOpenHoles, getShipHoleTier } from '../../shared/interactions.js';
// Circular with PhysicsSystem, read only at call time (never at module eval).
import { HULL_IMPACT, SEAKEEPING } from './PhysicsSystem.js';
import { clamp, gerstnerHeight, WAVE_PARAMS } from '../../shared/utils/index.js';
import { floodSettle, holeIngress, holeInsideHead, holeSize, holeSizeArea, waterlineHoleIngress } from '../../shared/flooding/floodModel.js';
import { newSloshState, sloshGeometry, sloshTargetX, sloshTargetZ, stepSlosh, type SloshState } from '../../shared/flooding/slosh.js';

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
    const ingress = holeIngress(ship.type, holeSizeArea(hole.size), depth, insideHead);
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

const SEA_RHO = 1025;
const SEA_G = 9.81;
/** Server-private slosh state per live hull (b2.2c). Never on the wire: the
 *  client reads the roll / pitch it produces. */
const sloshByShip = new WeakMap<Ship, SloshState>();

/** The water aboard as a MASS (kg): the displacement of the class settle,
 *  rho x A_wp x floodSettle(fill), the same number the heave sink reads. */
export function floodWaterMass(ship: Ship): number {
  const sk = SEAKEEPING[ship.type];
  if (!sk) return 0;
  return SEA_RHO * sk.waterplaneArea * floodSettle(ship.type, ship.waterLevel ?? 0);
}

/** The water as a point load for PhysicsSystem.applyPointLoad: its mass at the
 *  slosh centroid (hull-local, x port +, z bow +). Also the added mass the
 *  surge / yaw integration should carry (handoff to b2.1). */
export function floodWaterLoad(ship: Ship): { local: { x: number; y: number; z: number }; mass: number } {
  const st = sloshByShip.get(ship);
  return { local: { x: st?.x ?? 0, y: 0, z: st?.z ?? 0 }, mass: floodWaterMass(ship) };
}

/** The hull's slosh state, created the first time she is seen with water in
 *  her. Water already aboard with no history came in through her breaches
 *  (planked or not), so the memory is seeded at their mean position and the
 *  centroid starts where that memory allows: a fixture, a respawned snapshot
 *  or a founder capture lists toward her holed side from the first tick. */
function sloshStateFor(ship: Ship): SloshState | undefined {
  const existing = sloshByShip.get(ship);
  if (existing) return existing;
  const fill = clamp(ship.waterLevel ?? 0, 0, 1);
  if (!(fill > 1e-4)) return undefined;
  const st = newSloshState();
  const holes = ship.holes ?? [];
  if (holes.length > 0) {
    for (const h of holes) { st.memX += h.x; st.memZ += h.z; }
    st.memX /= holes.length; st.memZ /= holes.length;
    const sk = SEAKEEPING[ship.type];
    const hull = { type: ship.type, fill, mass: floodWaterMass(ship), kRoll: sk?.kRoll ?? 0, roll: 0, pitch: 0 };
    const geom = sloshGeometry(ship.type, fill);
    st.x = sloshTargetX(geom, hull, st.memX);
    st.z = sloshTargetZ(geom, hull, st.memZ);
  }
  sloshByShip.set(ship, st);
  return st;
}

/** Read-only view of a hull's slosh state (suites, the founder capture). */
export function floodSloshState(ship: Ship): Readonly<SloshState> | undefined {
  return sloshByShip.get(ship);
}

/**
 * SERVER-owned list. The heel and trim a hull takes from the water in her:
 *
 *  - the WATER MASS at its slosh centroid (b2.2c), converted exactly as
 *    applyPointLoad converts a load (moment over the righting stiffness), so
 *    the list follows the water and PERSISTS after the last hole is planked;
 *  - plus the INFLOW still arriving: water gushing through a breach piles
 *    against that rail before it spreads (weighted by how hard each hole runs),
 *    which is also what tips a fresh hull toward her holed side.
 *
 * Conventions match the renderer and updateShipWaveAttitude: positive roll
 * LIFTS the +x (port) rail, so water or breaches at +x produce a NEGATIVE roll
 * (that rail goes down); positive pitch DIPS the bow, so a flooded bow trims
 * positive.
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
  let roll = -lateral * FLOODING.LIST_ROLL_GAIN;
  let trim = longitudinal * FLOODING.LIST_TRIM_GAIN;
  const st = sloshStateFor(ship);
  const sk = SEAKEEPING[ship.type];
  if (st && sk) {
    const m = floodWaterMass(ship);
    roll += -(m * st.x * SEA_G) / sk.kRoll;
    trim += (m * st.z * SEA_G) / sk.kPitch;
  }
  return {
    roll: clamp(roll, -FLOODING.LIST_ROLL_MAX, FLOODING.LIST_ROLL_MAX),
    trim: clamp(trim, -FLOODING.LIST_TRIM_MAX, FLOODING.LIST_TRIM_MAX),
  };
}

/** Step the hold water's slosh (b2.2c): called once per tick by
 *  updateShipFlooding with the inflow of this tick. */
function updateShipSlosh(ship: Ship, dt: number, prevFill: number, floods: HoleFlood[], ingressScale: number): void {
  const fill = clamp(ship.waterLevel ?? 0, 0, 1);
  // A hull first seen with water (fixture, founder) seeds from her breaches;
  // one that floods from dry starts empty and learns from the inflow below.
  const st = prevFill > 1e-4 ? sloshStateFor(ship) : (sloshByShip.get(ship) ?? newSloshState());
  if (!st) return;
  sloshByShip.set(ship, st);
  const sk = SEAKEEPING[ship.type];
  const inflow = floods
    .filter((h) => h.ingress > 0)
    .map((h) => ({ amount: h.ingress * ingressScale * dt, x: h.hole.x, z: h.hole.z }));
  stepSlosh(st, {
    type: ship.type, fill, mass: floodWaterMass(ship), kRoll: sk?.kRoll ?? 0,
    roll: ship.roll ?? 0, pitch: ship.pitch ?? 0,
  }, dt, prevFill, inflow);
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
  const reinforced = ship.upgrades.some((u) => u.type === 'hull_reinforcement')
    ? SHIP_UPGRADES.HULL_INGRESS_MULT
    : 1;
  const floods = evaluateHoleFlood(ship, t, storm);
  let ingress = 0;
  for (const h of floods) ingress += h.ingress;
  ingress *= reinforced;
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
    updateShipSlosh(ship, dt, water, floods, reinforced);
    return;
  }
  const pumpFactor = ship.upgrades.some((u) => u.type === 'hull_reinforcement')
    ? SHIP_UPGRADES.REINFORCED_PUMP_FACTOR
    : FLOODING.PASSIVE_PUMP_FACTOR;
  const pump = FLOODING.BAIL_RATE * pumpFactor;
  ship.waterLevel = clamp(water - pump * dt, 0, 1);
  ship.floodingRate = pump > 0 && (ship.waterLevel ?? 0) > 0 ? -pump : 0;
  updateShipSlosh(ship, dt, water, floods, reinforced);
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
  size: number = 1,
): ShipHole[] {
  if (count <= 0) return [];
  const tornSize = holeSize(size);
  // Siblings of ONE event never widen each other (a keg face or a fast
  // grounding stays a cluster); only a LATER hit enlarges a wound.
  const touched = new Set<ShipHole>();
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
    const hole = placeShipHole(ship, point, source, tornSize, touched);
    touched.add(hole);
    opened.push(hole);
  }
  ship.repairCooldown = Math.max(ship.repairCooldown, SHIP.FIELD_REPAIR_DELAY);
  ship.autoRepairProgress = 0;
  return opened;
}

/** The hole a hit at `point` lands in (b2.2b, holes-04): the nearest OPEN
 *  hole within HOLE_ENLARGE_RADIUS, else the nearest PATCHED one there, else
 *  null (a fresh wound). `skip` = entities this same event already touched. */
export function holeHitAt(
  ship: Ship,
  point: { x: number; y: number; z: number },
  skip?: ReadonlySet<ShipHole>,
): ShipHole | null {
  const r2 = FLOODING.HOLE_ENLARGE_RADIUS * FLOODING.HOLE_ENLARGE_RADIUS;
  let open: ShipHole | null = null;
  let openSq = r2;
  let patched: ShipHole | null = null;
  let patchedSq = r2;
  for (const hole of ship.holes ?? []) {
    if (skip?.has(hole)) continue;
    const d2 = (hole.x - point.x) ** 2 + (hole.y - point.y) ** 2 + (hole.z - point.z) ** 2;
    if (hole.patched) {
      if (d2 <= patchedSq) { patchedSq = d2; patched = hole; }
    } else if (d2 <= openSq) { openSq = d2; open = hole; }
  }
  return open ?? patched;
}

/** Insert one breach entity, recycling the nearest patched slot when the hull
 *  is at its wire/shader cap. A hit within HOLE_ENLARGE_RADIUS of an existing
 *  hole never makes a new entity: an open hole widens (size + 1, or the torn
 *  size if bigger, cap HOLE_SIZE_MAX), a patched one loses its plank and
 *  reopens at its old size (or the torn size if bigger). */
function placeShipHole(
  ship: Ship,
  point: { x: number; y: number; z: number },
  source: ShipHoleSource | undefined,
  tornSize: ShipHoleSize,
  skip: ReadonlySet<ShipHole>,
): ShipHole {
  const struck = holeHitAt(ship, point, skip);
  if (struck) {
    const old = holeSize(struck.size);
    const next = struck.patched ? Math.max(old, tornSize) : Math.min(FLOODING.HOLE_SIZE_MAX, Math.max(old + 1, tornSize));
    setHoleSize(struck, next);
    struck.patched = false;
    if (source) struck.source = source;
    return struck;
  }
  if (ship.holes.length < FLOODING.MAX_HOLES_PER_SHIP) {
    const hole: ShipHole = {
      id: ship.nextHoleId ?? (ship.nextHoleId = 1),
      x: point.x,
      y: point.y,
      z: point.z,
      patched: false,
      tier: getShipHoleTier(point.y, SHIP_STATS[ship.type]),
      ...(tornSize > 1 ? { size: tornSize } : {}),
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
  // A recycled slot is a NEW wound at the new point: it takes the torn size.
  setHoleSize(victim, tornSize);
  if (source) victim.source = source;
  return victim;
}

/** Write a size, keeping size 1 implicit (absent) so the entity and the wire
 *  stay as small as before for the common hole. */
function setHoleSize(hole: ShipHole, size: number): void {
  const s = holeSize(size);
  if (s > 1) hole.size = s;
  else delete hole.size;
}

/**
 * The breach a carpenter (bot) should plank first (b2.2b): the one letting in
 * the most water NOW (Torricelli ingress = area x sqrt(head), so biggest and
 * deepest first), then the biggest, then the lowest, then the lowest id so a
 * bot never dithers between equals. Deterministic, no RNG.
 */
export function pickRepairTargetHole(ship: Ship, t: number, storm = 0): ShipHole | null {
  const ingress = new Map<ShipHole, number>();
  for (const h of evaluateHoleFlood(ship, t, storm)) ingress.set(h.hole, h.ingress);
  let best: ShipHole | null = null;
  let bestQ = -1;
  for (const hole of ship.holes ?? []) {
    if (hole.patched) continue;
    const q = ingress.get(hole) ?? 0;
    if (!best) { best = hole; bestQ = q; continue; }
    const bs = holeSize(best.size);
    const hs = holeSize(hole.size);
    const better = q > bestQ + 1e-9
      || (Math.abs(q - bestQ) <= 1e-9 && (hs > bs
        || (hs === bs && (hole.y < best.y - 1e-6
          || (Math.abs(hole.y - best.y) <= 1e-6 && hole.id < best.id)))));
    if (better) { best = hole; bestQ = q; }
  }
  return best;
}
