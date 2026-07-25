import type { Ship, ShipHole, ShipHoleSource, Player, Projectile, Island, Vec3, HullSections, SeaRock, StormState } from '../../shared/types/index.js';
import { PHYSICS, SHIP_STATS, SHIP, PLAYER, SHIP_UPGRADES, WORLD, FLOODING, GEYSER } from '../../shared/constants/index.js';
import type { GangwayPlan } from '../../shared/interactions.js';
import { toShipLocalPoint, toShipWorldPoint, getShipGangwayPlan, getGangwayFloorY, countOpenHoles } from '../../shared/interactions.js';
import {
  getBridgeDeckY,
  getIslandDistRatio,
  gerstnerHeight,
  getStormWaveIntensity,
  geyserEruptionLevel,
  WAVE_PARAMS,
  angleWrap,
  clamp,
  getNearestShipBoardingLadder,
  getIslandMaxRadius,
  getIslandSurfaceY,
  getCaveCeilingY,
  getCaveFloorY,
  isPointInsideIslandFootprint,
  sampleWind,
  getCrowNestStandingY,
  getMainMastLocalZ,
  getShipCompanionwayConfig,
  getShipDeckRaiseAt,
  getShipDeckWalkHalfWidth,
  getSeaRockBoundsRadius,
  getSeaRockColliders,
  intersectRaySeaRock,
  seaRockColliderWorldCenter,
  isInsideSwimHullFootprint,
  pushOutOfSwimHullFootprint,
  getSwimHullVerticalBand,
  getSwimHullVerticalT,
  getTavernBoundsRadius,
  getTavernWallBand,
  intersectRayTavern,
  pushOutOfTavernWalls,
  tavernLocalToWorld,
  toDockLocalPoint,
  toTavernLocal,
} from '../../shared/utils/index.js';
import { intersectRayIslandProps, resolvePropCollision } from '../../shared/props.js';
import { raymarchIslandSurface } from '../../shared/raycast.js';

// ── Ship wave-riding dynamics tuning ─────────────────────────────────────────
/** Near-critical damping for the heave spring (k = PHYSICS.BUOYANCY_SPRING). */
const HEAVE_DAMPING = 3.8;
/** Wave-attitude spring: pitch/roll chase the sampled wave slope. */
const ATTITUDE_STIFFNESS = 4;
const ATTITUDE_DAMPING = 3.8;
/** Broad reach (~110° off the wind) is the power point of the sail polar. */
const SAIL_POLAR_PEAK = 1.92;
/** Centerline hull stations (z as a fraction of length, half-width as a
 *  fraction of beam) for the ship-ship / grounding capsule chain.
 *  CONTRACT (pinned by test-ship-dynamics): parallel galleons (beam 10) at 11m
 *  centers are rail-to-rail BOARDING range with no phantom contact — so the
 *  widest station must keep 2·half·beam comfortably under 11 (0.52 → 10.4m). */
const HULL_CONTACT_STATIONS: ReadonlyArray<{ z: number; half: number }> = [
  { z: -0.44, half: 0.32 },
  { z: -0.30, half: 0.47 },
  { z: -0.15, half: 0.515 },
  { z: 0.00, half: 0.52 },
  { z: 0.15, half: 0.49 },
  { z: 0.30, half: 0.39 },
  { z: 0.44, half: 0.17 },
];

/** Walkable crow's-nest basket: ship-local disc radius around the mast the
 *  lookout can pace. Mirrors the client nest geometry (ShipRenderer builds the
 *  floor at r = 1.0 with the rail hoop at r = 1.06), minus a body margin so the
 *  lookout stops at the rail instead of clipping through it. The old 0.55 left
 *  a 1.1 m disc that read as standing on a dinner plate. */
const CROW_NEST_WALK_RADIUS = 0.9;

// ── On-foot locomotion tuning (terrain v2) ───────────────────────────────────
const LOCO = {
  /** Walk→swim once the standing ground sits this far below the LOCAL wave
   *  surface (gerstner, not y=0). Stay swimming until it rises back within
   *  SWIM_EXIT_DEPTH — the ≈0.35 m hysteresis kills state flapping at the
   *  waterline. Beach walk-ins and archipelago saddles share this test. */
  SWIM_ENTER_DEPTH: 1.1,
  SWIM_EXIT_DEPTH: 0.75,
  /** Wading band: still 'alive' but slowed once water is at least this deep. */
  WADE_MIN_DEPTH: 0.2,
  WADE_SPEED_SCALE: 0.55,
  /** Rise/run above which terrain is a cliff face — unwalkable (block/slide);
   *  jumping is still permitted (this gate only fires for grounded walkers).
   *  ~1.15 ≈ 49°: beaches and hill flanks (typically <40°) stay walkable, but
   *  sheer volcanic spires / cliff plinths genuinely wall a pirate out. */
  SLOPE_MAX: 1.15,
  /** The macro slope ahead is sampled over this many metres along the direction
   *  of travel, rather than from the raw ~0.08m per-tick step. A stable baseline
   *  reads the true face steepness instead of aliasing into terrace micro-relief
   *  (which would stutter-block a walkable terraced hillside). Kept modest so the
   *  block engages near the face, not as an invisible wall a metre short of it. */
  SLOPE_PROBE: 1.05,
  /** A single-tick footing step longer than this is treated as a warp/teleport
   *  and never slope-blocked (avoids reverting a respawn/warp to a stale spot). */
  SLOPE_MAX_STEP: 1.0,
  /** Head clearance kept under a cave ceiling. */
  CAVE_HEAD_CLEARANCE: 0.1,
  /** Broad-phase pad added to an island's max radius for prop-collision culling. */
  PROP_BROADPHASE_PAD: 6,
  /** Fall-damage curve on hard ground: harmless below FALL_SAFE_SPEED (m/s of
   *  downward impact), then linear to a per-landing cap. Deep-water entry never
   *  reaches this path (the swim branch owns it), and is guarded again below.
   *  Tuned lenient (SoT-style): with GRAVITY −18 the free-fall ceiling is
   *  15²/(2·18) ≈ 6.2 m, a 25 m cliff costs ~67, only huge falls approach the
   *  cap — the old 12/7 curve made ordinary mountain hops hit like musket balls. */
  FALL_SAFE_SPEED: 15,
  FALL_DAMAGE_PER_SPEED: 4.5,
  FALL_DAMAGE_MAX: 70,
  /** Standing water at least this deep cancels fall damage entirely — any real
   *  splash is safe (SoT rule: water landings never hurt); only ankle-film
   *  puddles still count as hard ground. */
  FALL_SAFE_WATER_DEPTH: 0.3,
} as const;

/**
 * Arcade points-of-sail polar over the angle off the wind
 * (0 = bow dead upwind, PI = dead run):
 * - inside the no-go cone the sails luff to a crawl (~0.10)
 * - power builds through close-hauled toward the beam
 * - peaks at 1.0 on a beam/broad reach
 * - eases to ~0.85 on a dead run (following wind spills from the canvas)
 */
export function computeSailPolar(offWind: number): number {
  const a = clamp(offWind, 0, Math.PI);
  if (a <= SHIP.SAIL_NO_GO_ANGLE) return 0.10;
  if (a < SAIL_POLAR_PEAK) {
    const t = (a - SHIP.SAIL_NO_GO_ANGLE) / (SAIL_POLAR_PEAK - SHIP.SAIL_NO_GO_ANGLE);
    return 0.10 + 0.90 * Math.pow(t, 0.7);
  }
  const t = (a - SAIL_POLAR_PEAK) / (Math.PI - SAIL_POLAR_PEAK);
  return 1 - 0.15 * t * t;
}

/**
 * Rudder steering shared by the player helm (Match) and bot helmsmen.
 * Slews ship.rudderAngle toward the requested deflection, then blends
 * angularVelocity toward a yaw rate that only bites with way on the ship:
 * full-sail handling keeps the classic turnRate cap, a stationary ship
 * barely answers the helm.
 *
 * `steer` is the requested rudder fraction in [-1, 1] (positive = helm right,
 * same sign as the old helm input). `omegaCapScale` carries the sail/chainshot
 * handling modifiers so stats.turnRate stays the hard cap.
 */
export function applyShipRudderSteering(ship: Ship, dt: number, steer: number, omegaCapScale = 1) {
  const stats = SHIP_STATS[ship.type];
  const target = clamp(steer, -1, 1) * SHIP.RUDDER_MAX_ANGLE;
  const current = ship.rudderAngle ?? 0;
  const maxStep = SHIP.RUDDER_SLEW * SHIP.RUDDER_MAX_ANGLE * dt;
  ship.rudderAngle = current + clamp(target - current, -maxStep, maxStep);

  const speed = Math.hypot(ship.velocity.x, ship.velocity.z);
  const way = clamp(speed / (stats.maxSpeed * 0.42), 0, 1);
  // Quadratic-ish rise with a whisper of a floor so a becalmed ship can still
  // creep its bow around instead of feeling bricked.
  const effectiveness = 0.05 + 0.95 * way * (0.35 + 0.65 * way);
  // Weight of water in the bilge dulls the helm — a swamped hull barely answers.
  const waterAuthority = 1 - clamp(ship.waterLevel ?? 0, 0, 1) * FLOODING.RUDDER_PENALTY;
  const targetOmega = -(ship.rudderAngle / SHIP.RUDDER_MAX_ANGLE)
    * stats.turnRate * omegaCapScale * effectiveness * waterAuthority;
  const blend = 1 - Math.exp(-dt * SHIP.RUDDER_SLEW);
  ship.angularVelocity += (targetOmega - ship.angularVelocity) * blend;
}

// ── Storm sea-state ──────────────────────────────────────────────────────────
/**
 * Local storm sea-state in [0, 1] at a world position, adapted from the
 * replicated StormState shape (centerX/centerZ) to the shared
 * getStormWaveIntensity API. Every server-side gerstnerHeight sample threads
 * this through so ships inside the storm genuinely pitch/heave harder, take
 * waves over their holes, and swimmers/projectiles ride the same swell the
 * client renders.
 */
export function stormSeaState(
  storm: Pick<StormState, 'centerX' | 'centerZ' | 'safeRadius' | 'phase'> | null | undefined,
  x: number,
  z: number,
): number {
  if (!storm) return 0;
  return getStormWaveIntensity(
    { center: { x: storm.centerX, y: storm.centerZ }, safeRadius: storm.safeRadius, phase: storm.phase },
    x,
    z,
  );
}

// ── Flooding model ───────────────────────────────────────────────────────────
/**
 * Per-HOLE flood evaluation. Every unpatched breach is tested at its own
 * hull-local point: the hole's world Y carries ship heave (position.y), pitch
 * and roll, so a breach on the raised windward rail of a heeled ship stays dry
 * while its opposite number gushes. `depth` is metres below the LIVE Gerstner
 * surface (negative = still above it), and the leak rate scales with it, so a
 * settling hull drags its own holes deeper and floods faster — the doom spiral.
 */
export function evaluateHoleFlood(
  ship: Ship,
  t: number,
  storm = 0,
): Array<{ hole: ShipHole; depth: number; flooding: boolean; rateFactor: number }> {
  const sinR = Math.sin(ship.rotation);
  const cosR = Math.cos(ship.rotation);
  const sinPitch = Math.sin(ship.pitch ?? 0);
  const sinRoll = Math.sin(ship.roll ?? 0);
  const out: Array<{ hole: ShipHole; depth: number; flooding: boolean; rateFactor: number }> = [];
  for (const hole of ship.holes ?? []) {
    if (hole.patched) continue;
    const worldX = ship.position.x + hole.x * cosR + hole.z * sinR;
    const worldZ = ship.position.z + hole.z * cosR - hole.x * sinR;
    // Positive roll lifts starboard (+x); positive pitch dips the bow (+z).
    const holeY = ship.position.y + hole.y + hole.x * sinRoll - hole.z * sinPitch;
    // Storm seas break over holes that calm water would leave dry.
    const surfaceY = gerstnerHeight(worldX, worldZ, t, WAVE_PARAMS, storm);
    const depth = surfaceY - holeY;
    const flooding = depth > -FLOODING.HOLE_WATERLINE_DEPTH;
    out.push({
      hole,
      depth,
      flooding,
      rateFactor: flooding
        ? clamp(1 + depth, FLOODING.HOLE_DEPTH_MIN_FACTOR, FLOODING.HOLE_DEPTH_MAX_FACTOR)
        : 0,
    });
  }
  return out;
}

/** Total ingress (water-level/sec) from every open, submerged hole. A hole
 *  sitting exactly on the waterline leaks INGRESS_PER_HOLE; deeper gushes up to
 *  1.5×. A reinforced hull seeps slower (HULL_INGRESS_MULT). */
export function shipIngressRate(ship: Ship, t: number, storm = 0): number {
  const classScale = FLOODING.INGRESS_CLASS_SCALE[ship.type] ?? 1;
  const reinforced = ship.upgrades.some((u) => u.type === 'hull_reinforcement')
    ? SHIP_UPGRADES.HULL_INGRESS_MULT
    : 1;
  let total = 0;
  for (const h of evaluateHoleFlood(ship, t, storm)) {
    if (h.flooding) total += FLOODING.INGRESS_PER_HOLE * h.rateFactor;
  }
  return total * classScale * reinforced;
}

/**
 * Advance a ship's bilge one step: ingress from open holes, else the passive
 * bilge pump slowly recovers a patched hull. Publishes ship.floodingRate (the
 * client gauge trend) and douses fire once a holed section goes under. Bailing
 * (player/bot) removes water separately, before this runs in the tick.
 */
export function updateShipFlooding(ship: Ship, t: number, dt: number, storm = 0): void {
  const water = ship.waterLevel ?? 0;
  const ingress = shipIngressRate(ship, t, storm);
  if (ingress > 0) {
    ship.waterLevel = clamp(water + ingress * dt, 0, 1);
    ship.floodingRate = ingress;
    // Water pouring through a submerged hole douses a deck fire.
    if (ship.onFire) {
      ship.onFire = false;
      ship.fireTimer = 0;
      ship.fireDamageAccum = 0;
    }
  } else {
    const pumpMult = ship.upgrades.some((u) => u.type === 'hull_reinforcement')
      ? SHIP_UPGRADES.HULL_PUMP_MULT
      : 1;
    const pump = FLOODING.BAIL_RATE * FLOODING.PASSIVE_PUMP_FACTOR * pumpMult;
    ship.waterLevel = clamp(water - pump * dt, 0, 1);
    ship.floodingRate = (ship.waterLevel ?? 0) > 0 ? -pump : 0;
  }
}

export type PhysicsCombatEvent =
  | {
      type: 'player_hit';
      attackerId: string;
      targetId: string;
      damage: number;
      position: Vec3;
      projectileType: Projectile['type'];
      kill: boolean;
    }
  | {
      type: 'ship_hit';
      attackerId: string;
      targetId: string;
      damage: number;
      position: Vec3;
      projectileType: Projectile['type'];
      section: keyof HullSections;
      remainingSection: number;
      remainingHull: number;
      milestone: 'half' | 'critical' | null;
      /** The breaches this ball opened, hull-local — rides ship_damage so every
       *  client spawns the decal the same frame instead of waiting for the
       *  next 10 Hz full snapshot. */
      holes: Array<{ id: number; x: number; y: number; z: number }>;
    }
  | {
      /** Ram damage credit — banked for ship-sink attribution (no client toast). */
      type: 'ship_ram';
      attackerId: string;
      targetId: string;
      damage: number;
    }
  | {
      /** A physical hull crash (ram / running aground / sea-rock strike). Purely
       *  for FX — broadcast to nearby clients so the smash is audible. No credit. */
      type: 'ship_impact';
      kind: 'ram' | 'ground' | 'rock';
      position: Vec3;
      speed: number;
    };

export class PhysicsSystem {
  private combatEvents: PhysicsCombatEvent[] = [];
  /** Rotation applied to each ship this update — deck passengers must be carried by the actual delta. */
  private shipRotationDeltas = new Map<string, number>();
  /** Per-ship spring-damper velocities for heave/pitch/roll wave riding. */
  private shipDynamics = new Map<string, { pitchVel: number; rollVel: number; heaveVel: number }>();
  /** Each player's footing at the end of the previous tick — the "walk from"
   *  point for steep-slope blocking. Keyed by id so it governs bot body-walk
   *  (BotSystem moves position directly, not velocity) exactly like human input. */
  private playerPrevXZ = new Map<string, { x: number; z: number }>();
  /** Seconds of remaining geyser-launch immunity per player, so one eruption
   *  launches a pirate once instead of trampolining them to death. */
  private playerGeyserCooldown = new Map<string, number>();

  update(
    dt: number,
    t: number,
    ships: Ship[],
    players: Player[],
    projectiles: Projectile[],
    islands: Island[],
    seaRocks: SeaRock[] = [],
    storm: StormState | null = null,
  ) {
    this.updateProjectiles(dt, t, projectiles, ships, players, islands, seaRocks, storm);
    this.updateShips(dt, t, ships, players, islands, seaRocks, storm);
    this.updatePlayers(dt, t, players, ships, islands, seaRocks, storm);
  }

  flushCombatEvents(): PhysicsCombatEvent[] {
    return this.combatEvents.splice(0);
  }

  private updateShips(dt: number, t: number, ships: Ship[], players: Player[], islands: Island[], seaRocks: SeaRock[], storm: StormState | null) {
    const wind = sampleWind(t);
    const helmedShipIds = new Set<string>();
    const helmsmanByShip = new Map<string, string>();
    for (const player of players) {
      if (player.atHelm && player.onShipId) {
        helmedShipIds.add(player.onShipId);
        helmsmanByShip.set(player.onShipId, player.id);
      }
    }
    this.shipRotationDeltas.clear();

    for (const ship of ships) {
      if (!ship.alive) continue;
      if (ship.sinking) {
        ship.sinkProgress += dt / SHIP.SINK_TIME;
        ship.position.y -= dt * 1.5;
        // Frame-rate-independent decay preserving the previous per-16ms feel.
        const sinkDrag = Math.pow(0.94, dt / 0.016);
        ship.velocity.x *= sinkDrag;
        ship.velocity.z *= sinkDrag;
        ship.angularVelocity *= Math.pow(0.9, dt / 0.016);
        // The client's sink tilt owns the attitude while going down — ease the
        // wave attitude out so it never fights sinkProgress.
        const attitudeDecay = Math.exp(-dt * 1.6);
        ship.pitch = (ship.pitch ?? 0) * attitudeDecay;
        ship.roll = (ship.roll ?? 0) * attitudeDecay;
        ship.heave = 0;
        ship.luffing = false;
        if (ship.sinkProgress >= 1) {
          ship.alive = false;
          this.shipDynamics.delete(ship.id);
        }
        continue;
      }

      const stats = SHIP_STATS[ship.type];

      // Integrate heading for ALL ships so rock impacts / tsunami impulses turn
      // unhelmed hulls too (helm input only writes angularVelocity in Match).
      if (!helmedShipIds.has(ship.id)) {
        ship.angularVelocity *= Math.exp(-dt * SHIP.RUDDER_DECAY);
        // Untended rudders relax toward center. Bot helmsmen re-slew every tick
        // before physics runs, so this only truly centers abandoned wheels.
        ship.rudderAngle = (ship.rudderAngle ?? 0) * Math.exp(-dt * SHIP.RUDDER_DECAY * 0.5);
      }
      const rotationDelta = ship.angularVelocity * dt;
      ship.rotation += rotationDelta;
      this.shipRotationDeltas.set(ship.id, rotationDelta);

      const chainshotted = t < ship.chainshottedUntil;
      const cosR = Math.cos(ship.rotation);
      const sinR = Math.sin(ship.rotation);
      const currentFwd = sinR * ship.velocity.x + cosR * ship.velocity.z;
      const currentLat = cosR * ship.velocity.x - sinR * ship.velocity.z;
      // Drag of a torn hull: every two open breaches cost what one wrecked
      // section used to (same 4-step ceiling at 8 holes as the old model).
      const breachDrag = Math.min(4, countOpenHoles(ship) / 2);
      const floodPenalty = Math.max(0.48, 1 - breachDrag * SHIP.FLOOD_SPEED_PENALTY);
      const signedRelative = angleWrap(wind.direction - ship.rotation);
      const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
      const trimError = Math.abs(angleWrap(ship.sailAngle - desiredTrim)) / SHIP.MAX_SAIL_ANGLE;
      const trimEfficiency = 1 - Math.pow(Math.min(1, trimError), 1.15);
      // Points of sail — angle off the wind drives an arcade polar (in-irons
      // crawl, close-hauled builds, beam/broad reach peak, dead run eases off).
      const offWind = Math.PI - Math.abs(signedRelative);
      const sailPolar = computeSailPolar(offWind);
      const sailDeployment =
        (chainshotted ? 0.42 : 1) * ship.sailHeight * clamp(ship.sailIntegrity, 0, 1);
      // Inside the no-go cone with canvas set the sails visibly luff (client flutter).
      ship.luffing = offWind <= SHIP.SAIL_NO_GO_ANGLE && sailDeployment > 0.08 && !ship.anchored;
      const speedMult = ship.upgrades.some(u => u.type === 'swift_sails') ? SHIP_UPGRADES.SWIFT_SPEED_MULT : 1;
      // Weight of water: a swamped hull is dragged down to ~0.62× top speed.
      const waterSpeedFactor = 1 - clamp(ship.waterLevel ?? 0, 0, 1) * FLOODING.SPEED_PENALTY;
      const targetSpeed = ship.anchored
        ? 0
        : stats.maxSpeed * speedMult * sailDeployment * (0.16 + trimEfficiency * 0.84) * sailPolar * wind.strength * floodPenalty * waterSpeedFactor;
      const sailLoad = clamp(ship.sailHeight * clamp(ship.sailIntegrity, 0, 1), 0, 1);
      const accelRate = ship.anchored ? SHIP.ANCHOR_BRAKE * 1.28 : 1.55 + sailLoad * 1.05;
      const speedBlend = 1 - Math.exp(-accelRate * dt);
      const forwardSpeed = currentFwd + (targetSpeed - currentFwd) * speedBlend;
      const lateralDamping = ship.anchored
        ? 8.5
        : 3.15 + Math.min(1.9, Math.abs(currentFwd) / Math.max(1, stats.maxSpeed) * 1.15);
      const lateralSpeed = currentLat * Math.exp(-dt * lateralDamping);

      ship.velocity.x = sinR * forwardSpeed + cosR * lateralSpeed;
      ship.velocity.z = cosR * forwardSpeed - sinR * lateralSpeed;

      // Leeway — the wind shoves a hull with canvas set gently downwind. The
      // lateral damping above keeps this a small (~4% of speed) sideways drift.
      if (!ship.anchored && sailDeployment > 0.1) {
        const leewayAccel = Math.sin(signedRelative) * wind.strength
          * Math.min(Math.abs(forwardSpeed), stats.maxSpeed) * 0.12;
        ship.velocity.x += cosR * leewayAccel * dt;
        ship.velocity.z += -sinR * leewayAccel * dt;
      }

      if (ship.anchored) {
        const drag = Math.max(0, 1 - SHIP.ANCHOR_BRAKE * dt);
        ship.velocity.x *= drag;
        ship.velocity.z *= drag;
      }

      const speed = Math.sqrt(ship.velocity.x ** 2 + ship.velocity.z ** 2);
      const maxSpeed = stats.maxSpeed * speedMult * 1.08;
      if (speed > maxSpeed) {
        const scale = maxSpeed / Math.max(speed, 0.001);
        ship.velocity.x *= scale;
        ship.velocity.z *= scale;
      }

      ship.position.x += ship.velocity.x * dt;
      ship.position.z += ship.velocity.z * dt;

      // World boundary bounce
      const boundary = WORLD.HALF - WORLD.SHIP_MARGIN;
      if (Math.abs(ship.position.x) > boundary) {
        ship.velocity.x *= -0.5;
        ship.position.x = Math.sign(ship.position.x) * boundary;
      }
      if (Math.abs(ship.position.z) > boundary) {
        ship.velocity.z *= -0.5;
        ship.position.z = Math.sign(ship.position.z) * boundary;
      }

      // Buoyancy — a spring-damper heave (not a bare lerp) so the hull carries
      // real vertical momentum riding swells. ship.heave publishes the residual
      // surface detail the smoothing filtered out; the renderer adds it back so
      // hulls sit exactly on the visible Gerstner surface.
      const dyn = this.getShipDynamics(ship.id);
      // Local storm sea-state (0 calm → 1 raging) boosts every wave sample for
      // this hull: buoyancy target, attitude sampling and hole waterlines all
      // ride the same boosted sea, so ships inside the storm genuinely heave.
      const seaState = stormSeaState(storm, ship.position.x, ship.position.z);
      const waveY = gerstnerHeight(ship.position.x, ship.position.z, t, WAVE_PARAMS, seaState);
      // A flooding hull rides lower — the bilge water pushes the buoyancy target
      // down by up to FREEBOARD_DROP, dipping more sections under (the SoT spiral).
      const buoyTarget = waveY - clamp(ship.waterLevel ?? 0, 0, 1) * FLOODING.FREEBOARD_DROP;
      dyn.heaveVel += ((buoyTarget - ship.position.y) * PHYSICS.BUOYANCY_SPRING - dyn.heaveVel * HEAVE_DAMPING) * dt;
      ship.position.y += dyn.heaveVel * dt;
      ship.heave = clamp(buoyTarget - ship.position.y, -2, 2);

      // Ship-island collision
      for (const island of islands) {
        this.pushShipOutOfIsland(ship, island);
        if (island.dock) this.pushShipOutOfDock(ship, island.dock);
      }
      for (const rock of seaRocks) {
        this.pushShipOutOfSeaRock(ship, rock);
      }

      // Ship-ship collision — oriented capsule-chain hulls, resolved pairwise once.
      for (const other of ships) {
        if (other.id === ship.id || !other.alive) continue;
        if (ship.id > other.id) continue;
        this.resolveShipShipCollision(ship, other, helmsmanByShip);
      }

      // Wave attitude — pitch/roll chase the sampled Gerstner slope through a
      // spring-damper so the deck genuinely rides the ocean. Storm winds heel
      // the hull noticeably harder.
      const windHeelCap = 0.05 * (1 + seaState * 0.8);
      const windHeel = clamp(
        -Math.sin(signedRelative) * sailDeployment * wind.strength * windHeelCap,
        -windHeelCap, windHeelCap,
      );
      this.updateShipWaveAttitude(ship, stats, t, dt, windHeel, seaState);

      if (ship.onFire) {
        ship.fireTimer = Math.max(0, ship.fireTimer - dt);
        // A deck fire chars through the planking HIGH on the topside
        // (FIRE_HOLE_START_Y, well above the calm waterline) and then keeps
        // burning each of its own chars DOWNWARD toward the sea. So a firebomb
        // is not a one-hole-then-douse dud any more: an untended blaze stacks
        // several dry breaches, and the moment the first one reaches the water
        // it both floods AND drowns the fire. Storm seas or a settling bilge
        // can reach them early.
        ship.fireDamageAccum += dt;
        if (ship.fireDamageAccum >= SHIP.FIRE_HOLE_INTERVAL) {
          ship.fireDamageAccum -= SHIP.FIRE_HOLE_INTERVAL;
          // Char the face carrying the fewest breaches so the fire spreads round
          // the ship instead of gnawing one plank.
          const faces: Array<{ x: number; z: number }> = [
            { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
          ];
          let bestFace = faces[0];
          let bestCount = Infinity;
          for (const face of faces) {
            let n = 0;
            for (const hole of ship.holes) {
              if (hole.patched) continue;
              if (face.x !== 0 ? Math.sign(hole.x) === face.x : Math.sign(hole.z) === face.z) n += 1;
            }
            if (n < bestCount) { bestCount = n; bestFace = face; }
          }
          const point = this.hullFacePoint(
            ship,
            { x: bestFace.x * stats.width, z: bestFace.z * stats.length },
            Math.min(FLOODING.FIRE_HOLE_START_Y, stats.height * 0.62),
            stats.length * 0.5,
          );
          this.openHoleAt(ship, point, 1, 'fire');
        }
        // Burn-down: the flames eat each char lower through the hull.
        for (const hole of ship.holes) {
          if (hole.patched || hole.source !== 'fire') continue;
          hole.y = Math.max(FLOODING.HOLE_BAND_Y.min, hole.y - FLOODING.FIRE_BURN_DOWN_RATE * dt);
        }
        if (ship.fireTimer <= 0) {
          ship.onFire = false;
          ship.fireTimer = 0;
          ship.fireDamageAccum = 0;
        }
      }

      // Bilge: ingress from open holes below the waterline (or passive pumping
      // when patched). Runs after bailing (applied earlier in the tick).
      // Storm seas wash over holes calm water would spare.
      updateShipFlooding(ship, t, dt, seaState);
    }
  }

  private updatePlayers(dt: number, t: number, players: Player[], ships: Ship[], islands: Island[], seaRocks: SeaRock[], storm: StormState | null) {
    // Frame-rate-independent decay preserving the previous 0.9-per-16ms feel.
    const knockbackDamp = Math.pow(0.9, dt / 0.016);
    // Boarding planks are ship×dock geometry, not per-player — resolve them once
    // per tick (typically zero or one) instead of 14 docks × 10 hulls per walker.
    const gangwayPlans: GangwayPlan[] = [];
    for (const island of islands) {
      if (!island.dock) continue;
      for (const ship of ships) {
        const plan = getShipGangwayPlan(ship, island.dock);
        if (plan) gangwayPlans.push(plan);
      }
    }
    const playerBoundary = WORLD.HALF - WORLD.PLAYER_MARGIN;
    for (const player of players) {
      if (player.respawnProtectionTimer > 0) {
        player.respawnProtectionTimer = Math.max(0, player.respawnProtectionTimer - dt);
      }
      if (player.shipBoundaryGraceTimer > 0) {
        player.shipBoundaryGraceTimer = Math.max(0, player.shipBoundaryGraceTimer - dt);
      }
      const geyserCooldown = this.playerGeyserCooldown.get(player.id) ?? 0;
      if (geyserCooldown > 0) this.playerGeyserCooldown.set(player.id, Math.max(0, geyserCooldown - dt));
      if (player.state === 'eliminated' || player.state === 'respawning') continue;

      // Downed pirates keep full physics (gravity, deck carry, water) but the
      // locomotion state machine below must never overwrite 'downed' — Match
      // owns entering/leaving that state (bleed-out, revive, finish).
      const downed = player.state === 'downed';

      // Ladder climbers are welded to the mast — knockback can't peel them off.
      if (player.mastClimb !== null) {
        player.knockbackVelocity.x = 0;
        player.knockbackVelocity.y = 0;
        player.knockbackVelocity.z = 0;
      }

      // Apply knockback velocity decay
      player.knockbackVelocity.x *= knockbackDamp;
      player.knockbackVelocity.y *= knockbackDamp;
      player.knockbackVelocity.z *= knockbackDamp;

      // Add knockback to position
      player.position.x += player.knockbackVelocity.x * dt;
      player.position.y += player.knockbackVelocity.y * dt;
      player.position.z += player.knockbackVelocity.z * dt;

      if (player.cannonBallistic) {
        player.cannonFlightTimer = Math.max(0, player.cannonFlightTimer - dt);
        if (player.cannonFlightTimer <= 0) {
          // Flight timed out (very long arc) — drop into swimming with current momentum
          player.cannonBallistic = false;
          player.velocity.x *= 0.65;
          player.velocity.z *= 0.65;
          player.velocity.y *= 0.7;
          player.state = 'swimming';
          player.swimTimer = 0;
          continue;
        }
        player.state = 'alive';
        // Pure projectile motion during cannon flight — gravity only.
        // The previous code applied 0.98^(dt*24) ≈ 0.992/frame horizontal drag, which bled ~38% of X/Z
        // velocity per second and made every launch feel near-vertical (cannonballs in this game don't
        // suffer this drag, so the player's arc looked broken next to the round they were riding).
        player.velocity.y += PHYSICS.GRAVITY * dt;
        player.position.x += player.velocity.x * dt;
        player.position.y += player.velocity.y * dt;
        player.position.z += player.velocity.z * dt;
        if (this.resolvePlayerSeaRockCollision(player, seaRocks, true)) {
          player.cannonFlightTimer = 0;
          player.cannonBallistic = false;
          player.velocity.x *= 0.28;
          player.velocity.z *= 0.28;
          player.velocity.y = Math.max(player.velocity.y, 0.8);
          player.state = 'alive';
          continue;
        }

        let landedShip: Ship | null = null;
        if (player.shipBoundaryGraceTimer <= 0.2) {
          for (const ship of ships) {
            if (!ship.alive) continue;
            const stats = SHIP_STATS[ship.type];
            const local = this.toShipLocal(player.position, ship);
            const deckY = ship.position.y + stats.height + 0.1;
            if (
              this.isInsideShipDeckFootprint(local, stats, 0.32)
              && player.position.y <= deckY + 0.42
              && player.position.y >= deckY - 1
            ) {
              landedShip = ship;
              break;
            }
          }
        }
        if (landedShip) {
          const stats = SHIP_STATS[landedShip.type];
          player.onShipId = landedShip.id;
          player.position.y = landedShip.position.y + stats.height + 0.1;
          player.velocity.y = 0;
          player.cannonFlightTimer = 0;
          player.cannonBallistic = false;
          player.swimTimer = 0;
          continue;
        }

        const onIsland = this.findPlayerIsland(player, islands);
        const onDock = this.findPlayerDock(player, islands);
        const groundY = Math.max(
          onIsland ? getIslandSurfaceY(onIsland, player.position.x, player.position.z) : -Infinity,
          onDock ? onDock.position.y + 0.14 : -Infinity,
        );
        if (groundY > -Infinity && player.position.y <= groundY) {
          // A geyser arc (flagged by the live launch cooldown) lands as a real
          // fall — hard ground hurts. Cannon self-launches never set the cooldown,
          // so they keep their damage-free landing.
          const geyserFall = (this.playerGeyserCooldown.get(player.id) ?? 0) > 0;
          const impactSpeed = -player.velocity.y;
          // Splash rule: an arc that ends in standing water is always a free
          // landing, same as ordinary falls — only hard (dry) ground hurts.
          const landingSea = stormSeaState(storm, player.position.x, player.position.z);
          const landingWaveY = gerstnerHeight(player.position.x, player.position.z, t, WAVE_PARAMS, landingSea);
          const landedInWater = !onDock && landingWaveY - groundY > LOCO.FALL_SAFE_WATER_DEPTH;
          if (
            geyserFall
            && !landedInWater
            && impactSpeed > LOCO.FALL_SAFE_SPEED
            && player.respawnProtectionTimer <= 0
          ) {
            const dmg = Math.min(
              LOCO.FALL_DAMAGE_MAX,
              (impactSpeed - LOCO.FALL_SAFE_SPEED) * LOCO.FALL_DAMAGE_PER_SPEED,
            );
            player.lastDamagedById = null;
            player.lastDamagedAt = null;
            player.lastDamageWasHeadshot = false;
            player.health -= dmg;
          }
          player.position.y = groundY;
          player.velocity.y = 0;
          player.cannonFlightTimer = 0;
          player.cannonBallistic = false;
          player.swimTimer = 0;
          continue;
        }

        const waveY = gerstnerHeight(player.position.x, player.position.z, t, WAVE_PARAMS,
          stormSeaState(storm, player.position.x, player.position.z));
        const waterSurface = waveY + 0.32;
        if (player.position.y <= waterSurface) {
          // Don't snap to the surface — let the player keep their downward
          // momentum so they actually plunge underwater and have to swim back up.
          // Water absorbs ~35% of impact velocity in each axis on entry.
          player.velocity.x *= 0.65;
          player.velocity.z *= 0.65;
          player.velocity.y *= 0.7;
          player.cannonFlightTimer = 0;
          player.cannonBallistic = false;
          player.state = 'swimming';
          player.swimTimer = 0;
          continue;
        }
        continue;
      }

      const onShip = this.findPlayerShip(player, ships);
      if (onShip) {
        player.onShipId = onShip.id;

        const stats = SHIP_STATS[onShip.type];

        // ── Mast ladder: the body is pinned to the ladder line in ship space,
        // Y lerped base→nest by mastClimb (Match drives the fraction from W/S).
        // No gravity, no swim, no deck passes — the ship transform owns motion.
        if (player.mastClimb !== null) {
          const mastZ = getMainMastLocalZ(stats);
          const world = this.toShipWorld(0.42, mastZ - 0.12, onShip);
          const baseY = onShip.position.y + stats.height + 0.2;
          const nestY = onShip.position.y + getCrowNestStandingY(stats);
          player.position.x = world.x;
          player.position.z = world.z;
          player.position.y = baseY + (nestY - baseY) * player.mastClimb;
          player.velocity.x = 0;
          player.velocity.y = 0;
          player.velocity.z = 0;
          player.swimTimer = 0;
          if (!downed) player.state = 'alive';
          continue;
        }
        const deckY = onShip.position.y + stats.height + 0.1;
        const localBeforeCarry = this.toShipLocal(player.position, onShip);

        // Passengers need to inherit both ship translation and turn so the hold feels welded to the hull.
        player.position.x += onShip.velocity.x * dt;
        player.position.z += onShip.velocity.z * dt;
        if (!player.atHelm && !player.atCannon) {
          const turnDelta = this.shipRotationDeltas.get(onShip.id) ?? onShip.angularVelocity * dt;
          if (Math.abs(turnDelta) > 0.0001) {
            const midRotation = onShip.rotation - turnDelta * 0.5;
            const midCos = Math.cos(midRotation);
            const midSin = Math.sin(midRotation);
            player.position.x += (-localBeforeCarry.x * midSin + localBeforeCarry.z * midCos) * turnDelta;
            player.position.z += (-localBeforeCarry.z * midSin - localBeforeCarry.x * midCos) * turnDelta;

            const velCos = Math.cos(turnDelta);
            const velSin = Math.sin(turnDelta);
            const vx = player.velocity.x;
            const vz = player.velocity.z;
            player.velocity.x = vx * velCos + vz * velSin;
            player.velocity.z = vz * velCos - vx * velSin;
          }
        }

        let local = this.toShipLocal(player.position, onShip);

        // Clamp inside hold walls before floor resolution so players don't pop upward at the hull boundary.
        if (player.position.y < deckY - 0.18) {
          const holdClamp = this.clampHoldPosition(local, stats);
          if (holdClamp.x !== local.x || holdClamp.z !== local.z) {
            const world = this.toShipWorld(holdClamp.x, holdClamp.z, onShip);
            player.position.x = world.x;
            player.position.z = world.z;
            player.velocity.x = 0;
            player.velocity.z = 0;
            local = holdClamp;
          }
        }

        const floorY = this.getShipFloorY(player.position, onShip, local);

        // Gravity (crow's nest: walkable basket — the nest deck is a FLOOR, not
        // a Y pin, so a jump reads as a jump: gravity + velocity.y run normally
        // and land back on the basket. WASD stays clamped to the nest disc
        // (airborne too) so a hop can't drift the lookout into thin air.
        if (player.atCrowNest) {
          const mastZ = getMainMastLocalZ(stats);
          const offX = local.x;
          const offZ = local.z - mastZ;
          const offR = Math.hypot(offX, offZ);
          if (offR > CROW_NEST_WALK_RADIUS) {
            const pull = CROW_NEST_WALK_RADIUS / offR;
            const world = this.toShipWorld(offX * pull, mastZ + offZ * pull, onShip);
            player.position.x = world.x;
            player.position.z = world.z;
            local = this.toShipLocal(player.position, onShip);
          }
          const nestFloorY = onShip.position.y + getCrowNestStandingY(stats);
          player.velocity.y += PHYSICS.GRAVITY * dt;
          player.position.y += player.velocity.y * dt;
          if (player.position.y <= nestFloorY) {
            player.position.y = nestFloorY;
            player.velocity.y = 0;
          }
        } else {
          player.velocity.y += PHYSICS.GRAVITY * dt;
          player.position.y += player.velocity.y * dt;
          if (player.position.y < floorY) {
            player.position.y = floorY;
            player.velocity.y = 0;
          }
        }

        // Invisible deck rails: stay aboard unless the player explicitly jumps out.
        if (
          player.position.y >= deckY - 0.3
          && player.shipBoundaryGraceTimer <= 0
          && !player.atHelm
          && !player.atCannon
          && !player.atSails
          && !player.atCrowNest
        ) {
          const deckClamp = this.clampDeckPosition(local, stats);
          if (deckClamp.x !== local.x || deckClamp.z !== local.z) {
            const world = this.toShipWorld(deckClamp.x, deckClamp.z, onShip);
            player.position.x = world.x;
            player.position.z = world.z;
            player.velocity.x = 0;
            player.velocity.z = 0;
          }
        }

        local = this.toShipLocal(player.position, onShip);
        if (
          player.position.y >= deckY - 0.25
          && !player.atHelm
          && !player.atCannon
          && !player.atSails
          && !player.atCrowNest
        ) {
          const obstacleClamp = this.resolveShipDeckObstacleCollision(local, stats);
          if (obstacleClamp.pushed) {
            const world = this.toShipWorld(obstacleClamp.x, obstacleClamp.z, onShip);
            player.position.x = world.x;
            player.position.z = world.z;
            player.velocity.x = 0;
            player.velocity.z = 0;
          }
        }

        player.swimTimer = 0;
        if (!downed) player.state = 'alive';
        if (onShip.onFire && player.respawnProtectionTimer <= 0) {
          player.lastDamagedById = null;
          player.lastDamagedAt = null;
          player.lastDamageWasHeadshot = false;
          player.health -= SHIP.FIRE_PLAYER_DAMAGE_PER_SEC * dt;
        }
      } else {
        player.onShipId = null;

        const onIsland = this.findPlayerIsland(player, islands);

        // ── Horizontal terrain resolution (runs before the vertical/water pass) ──
        // Props (palms/towers/lantern posts/boulders) block walkers and near-shore
        // swimmers via capsule/sphere pushout; steep faces block a walking ascent.
        this.resolvePlayerPropCollision(player, islands);
        this.resolvePlayerTavernCollision(player, islands);
        this.resolveSlopeBlock(player, onIsland);

        const onDock = this.findPlayerDock(player, islands);
        // Cave-aware floor: on the hillside ABOVE a cave the player rests on the
        // natural surface (getIslandSurfaceY, cave carve opt-out); once they drop
        // under the ceiling they stand on the carved cave floor instead.
        const stand = onIsland
          ? this.islandStandY(onIsland, player.position.x, player.position.z, player.position.y)
          : { floorY: -Infinity, ceilingY: null as number | null, inCave: false };
        const islandFloor = stand.floorY;
        const ceilingY = stand.ceilingY;
        const dockFloor = onDock ? onDock.position.y + 0.14 : -Infinity;
        // Rope-bridge deck: a real standing surface, but only when the player
        // is at deck level (within a step) — walking through the saddle UNDER
        // the bridge must not teleport them up onto it.
        let bridgeFloor = -Infinity;
        if (onIsland?.bridges) {
          for (const bridge of onIsland.bridges) {
            const deckY = getBridgeDeckY(bridge, player.position.x, player.position.z);
            if (deckY !== null && player.position.y > deckY - 1.2) {
              bridgeFloor = Math.max(bridgeFloor, deckY);
            }
          }
        }
        // Boarding gangway: a berthed ship's plank is a real standing surface
        // between the dock edge and its bulwark, so walking aboard a galleon is
        // a stroll up the plank instead of a 2 m freeboard climb. Same shared
        // geometry the client draws (getShipGangwayPlan), gated on being at
        // plank level so nobody gets teleported up from the water beneath it.
        let gangwayFloor = -Infinity;
        for (const plan of gangwayPlans) {
          const plankY = getGangwayFloorY(plan, player.position.x, player.position.z);
          if (plankY !== null && player.position.y > plankY - 1.1) {
            gangwayFloor = Math.max(gangwayFloor, plankY);
          }
        }
        const groundY = Math.max(islandFloor, dockFloor, bridgeFloor, gangwayFloor);
        const standingOnDock = (onDock !== null && dockFloor >= islandFloor) || gangwayFloor > islandFloor;

        // ── Water entry: submerged island ground makes the player swim ──
        // depth = local wave surface − standing ground. Beaches dipping under the
        // wave line and archipelago saddles both surface here; hysteresis on the
        // enter/exit threshold prevents alive⇄swimming flapping at the shoreline.
        let submergeDepth = -Infinity;
        let swimHere = false;
        const playerSea = stormSeaState(storm, player.position.x, player.position.z);
        if (onIsland && !standingOnDock && !stand.inCave) {
          // Caves are DRY by fiat (stand.inCave exempt): the generator keeps every
          // cave floor above the waterline, and comparing a carved interior floor
          // against the open-sea wave height would flip deep-cave walkers into the
          // swim branch — whose seabed resolve (natural surface, 20-45m overhead)
          // then ejects them through the roof onto the hillside.
          const waveY = gerstnerHeight(player.position.x, player.position.z, t, WAVE_PARAMS, playerSea);
          submergeDepth = waveY - islandFloor;
          swimHere = player.state === 'swimming' || downed
            ? submergeDepth > LOCO.SWIM_EXIT_DEPTH
            : submergeDepth > LOCO.SWIM_ENTER_DEPTH;
        }

        if (groundY > -Infinity && !swimHere) {
          // Wading band: shin-deep water keeps you 'alive' but caps walk speed.
          // Pull back the walk step Match already applied and slow the velocity.
          if (!standingOnDock && submergeDepth > LOCO.WADE_MIN_DEPTH) {
            const keep = LOCO.WADE_SPEED_SCALE;
            player.position.x -= player.velocity.x * dt * (1 - keep);
            player.position.z -= player.velocity.z * dt * (1 - keep);
            player.velocity.x *= keep;
            player.velocity.z *= keep;
          }
          player.velocity.y += PHYSICS.GRAVITY * dt;
          player.position.y += player.velocity.y * dt;
          const landing = player.position.y < groundY && player.velocity.y <= 0;
          if (player.position.y < groundY - 0.6 || landing) {
            // Fall damage — only a genuine landing (falling onto ground), only past
            // the safe impact speed, and never when the footing is deep water
            // (a cliff-jump into a cove is a splash, not a splat).
            const impactSpeed = -player.velocity.y;
            if (
              landing
              && impactSpeed > LOCO.FALL_SAFE_SPEED
              && submergeDepth < LOCO.FALL_SAFE_WATER_DEPTH
              && player.respawnProtectionTimer <= 0
            ) {
              const dmg = Math.min(
                LOCO.FALL_DAMAGE_MAX,
                (impactSpeed - LOCO.FALL_SAFE_SPEED) * LOCO.FALL_DAMAGE_PER_SPEED,
              );
              player.lastDamagedById = null;
              player.lastDamagedAt = null;
              player.lastDamageWasHeadshot = false;
              player.health -= dmg;
            }
            player.position.y = groundY;
            player.velocity.y = 0;
          }
          player.swimTimer = 0;
          if (!downed) player.state = 'alive';
          // Cave roof: a jump inside a cave can't punch the player's head through it.
          if (
            ceilingY !== null
            && player.position.y < ceilingY
            && player.position.y + PLAYER.HEIGHT > ceilingY
          ) {
            player.position.y = ceilingY - PLAYER.HEIGHT;
            if (player.velocity.y > 0) player.velocity.y = 0;
          }
          // ── Geysers: an erupting vent launches a grounded pirate skyward ──
          // Launched as a true ballistic arc (the cannon-flight path: it
          // integrates x/z AND is exempt from Match's idle velocity-zeroing), so
          // the outward kick genuinely carries the pirate up AND OFF the vent —
          // otherwise a stationary/AFK pirate would rise straight up, drop back
          // on the same vent, and get relaunched to death across eruptions. The
          // one-launch cooldown then gates re-fire; landing on rock deals fall
          // damage below (geyser arcs are flagged via the live cooldown). Downed
          // crawlers are spared.
          if (
            !downed
            && onIsland?.geysers
            && onIsland.geysers.length > 0
            && (this.playerGeyserCooldown.get(player.id) ?? 0) <= 0
          ) {
            for (const g of onIsland.geysers) {
              if (player.position.y > g.y + GEYSER.TRIGGER_MAX_HEIGHT) continue;
              const dxg = player.position.x - g.x;
              const dzg = player.position.z - g.z;
              if (dxg * dxg + dzg * dzg > g.radius * g.radius) continue;
              const level = geyserEruptionLevel(g, t);
              if (level < GEYSER.LAUNCH_THRESHOLD) continue;
              // Full-power launch for the whole eruption: the one-launch cooldown
              // fires on the rising edge, so scaling by `level` here would only
              // ever land the weak threshold-crossing throw. The plume visual
              // carries the ramp; the impulse is the vent's rated power.
              const launch = g.power;
              // Escape direction: outward from the vent if off-centre, else down
              // the fall line (away from the island centre) so a dead-centre
              // pirate is still thrown clear rather than straight back up.
              let dirX = dxg;
              let dirZ = dzg;
              let dLen = Math.hypot(dirX, dirZ);
              if (dLen < 0.4) {
                dirX = g.x - onIsland.position.x;
                dirZ = g.z - onIsland.position.z;
                dLen = Math.hypot(dirX, dirZ) || 1;
              }
              dirX /= dLen;
              dirZ /= dLen;
              player.velocity.x = dirX * launch * GEYSER.OUTWARD_BOOST;
              player.velocity.z = dirZ * launch * GEYSER.OUTWARD_BOOST;
              player.velocity.y = launch;
              player.position.y = g.y + GEYSER.TRIGGER_MAX_HEIGHT + 0.05;
              player.cannonBallistic = true;
              player.cannonFlightTimer = SHIP.CANNON_PLAYER_FLIGHT_MAX;
              player.swimTimer = 0;
              // One launch per eruption — the cooldown outlasts the whole arc and
              // also flags the ballistic landing below as a geyser fall.
              this.playerGeyserCooldown.set(player.id, GEYSER.LAUNCH_COOLDOWN);
              break;
            }
          }
        } else {
          // If we ever end up spatially inside dock geometry, snap back to solid ground.
          // Do not rescue against the wider island footprint here: just past a cliff
          // edge that reads as an invisible platform over open water.
          let rescueY = -Infinity;
          for (const island of islands) {
            if (!island.dock) continue;
            const local = this.toDockLocal(player.position, island.dock);
            if (Math.abs(local.x) <= island.dock.width * 0.5 + 0.75 && Math.abs(local.z) <= island.dock.length * 0.5 + 0.75) {
              rescueY = Math.max(rescueY, island.dock.position.y + 0.14);
            }
          }
          if (rescueY > -Infinity && player.position.y < rescueY - 0.75) {
            player.position.y = rescueY;
            player.velocity.y = 0;
            player.swimTimer = 0;
            if (!downed) player.state = 'alive';
            continue;
          }

          // Not on any surface — airborne above sea or in water
          const waveY = gerstnerHeight(player.position.x, player.position.z, t, WAVE_PARAMS, playerSea);
          const surfaceY = waveY + 0.32;

          // A downed pirate in the water floats with the swim physics (their
          // state stays 'downed'; Match's crawl input is the only propulsion).
          const alreadySwimming = player.state === 'swimming'
            || (downed && player.position.y <= surfaceY + 0.001);
          if (!alreadySwimming && player.position.y > surfaceY) {
            // Airborne until the player's feet actually cross the waterline. Applying
            // swimming drag a metre above the surface made dock jumps and cannon arcs
            // feel like they hit an invisible platform instead of plunging through.
            player.velocity.y += PHYSICS.GRAVITY * dt;
            player.position.y += player.velocity.y * dt;
            // state intentionally not changed — stays 'alive' while falling through air
          } else {
            // Near or in water — full swimming physics
            if (!alreadySwimming) {
              player.velocity.x *= 0.78;
              player.velocity.z *= 0.78;
              // Water absorbs ~10% of vertical impact velocity on entry. Was 18% which
              // killed too much plunge — a 4 m fall barely dipped your head under.
              if (player.velocity.y < 0) player.velocity.y *= 0.90;
              player.swimTimer = 0;
            }
            const maxDiveDepth = waveY - PLAYER.SWIM_MAX_DEPTH;
            const maxBreachHeight = waveY + 0.86;
            const depthBelowSurface = Math.max(0, surfaceY - player.position.y);
            // Buoyancy: pulls toward the surface. Tuned so a fall actually feels like a
            // plunge — the player hangs under for a beat before bobbing back up.
            const buoyancyScale = depthBelowSurface > 12
              ? 0.22
              : depthBelowSurface > 4
                ? 0.42
                : 0.6;
            const maxLift = depthBelowSurface > 12 ? 2.4 : 2.8;
            const buoyancy = clamp((surfaceY - player.position.y) * buoyancyScale, -2.0, maxLift);
            player.velocity.y += buoyancy * dt;
            // Water drag — gentler vertical drag so plunge momentum carries through
            // 1–2 metres of submersion before buoyancy turns the player around.
            const yDamp = Math.pow(0.55, dt); // ~45 %/sec retention
            const xzDamp = Math.pow(0.5, dt);
            player.velocity.x *= xzDamp;
            player.velocity.z *= xzDamp;
            player.velocity.y *= yDamp;
            player.position.y += player.velocity.y * dt;
            if (player.position.y < maxDiveDepth) {
              player.position.y = maxDiveDepth;
              if (player.velocity.y < 0) player.velocity.y *= -0.08;
            }
            // Only clamp the breach height when player is actively rising — a falling
            // player should slip beneath the surface, not be teleported down to it.
            if (player.position.y > maxBreachHeight && player.velocity.y >= 0) {
              player.position.y = maxBreachHeight;
              player.velocity.y *= 0.12;
            }
            // Underwater terrain: a swimmer below the local ground is inside
            // rock. Resolve by penetration depth — shallow means a gentle
            // walk-in slope (ride up onto the sand); deep means they swam into
            // a submerged face or under the shell (push the step back out,
            // then settle onto whatever seabed is legal there). The seabed
            // covers the full underwater apron (distRatio ≤ ~1.22), not just
            // the walk footprint, so diving under the island is impossible.
            const seabedY = this.swimSeabedY(islands, player.position.x, player.position.z);
            // A swim resolution may lift you onto the sand but never OUT of
            // the sea — cap at the wave surface; if the ground is genuinely
            // above water the walk branch takes over next tick.
            const seabedClampCap = waveY + 0.05;
            if (seabedY > -Infinity && player.position.y < seabedY) {
              const penetration = seabedY - player.position.y;
              if (seabedY > seabedClampCap + 0.3) {
                // SHORE FACE: the terrain at this column pokes ABOVE the waves
                // (rocky/cliff aprons at distRatio ~1.0–1.05). The old cap
                // pinned the swimmer at the water surface INSIDE the rock —
                // never converting to walk (outside the footprint), never
                // rescued by the anti-embed net. Push them seaward along the
                // descending terrain gradient instead; a couple of ticks walks
                // them back into open water regardless of how they got in
                // (swimming, knockback, geyser ballistic, wave surge).
                const probe = 0.9;
                let bestX = player.position.x;
                let bestZ = player.position.z;
                let bestY = seabedY;
                for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]] as const) {
                  const nx = player.position.x + ox * probe;
                  const nz = player.position.z + oz * probe;
                  const ny = this.swimSeabedY(islands, nx, nz);
                  if (ny < bestY) {
                    bestY = ny;
                    bestX = nx;
                    bestZ = nz;
                  }
                }
                player.position.x = bestX;
                player.position.z = bestZ;
                player.position.y = Math.max(player.position.y, Math.min(bestY, seabedClampCap));
                // Kill the inward drive so holding forward can't bore back in.
                player.velocity.x *= 0.15;
                player.velocity.z *= 0.15;
                player.knockbackVelocity.x *= 0.15;
                player.knockbackVelocity.z *= 0.15;
              } else if (penetration > 1.2) {
                player.position.x -= (player.velocity.x + player.knockbackVelocity.x) * dt;
                player.position.z -= (player.velocity.z + player.knockbackVelocity.z) * dt;
                player.velocity.x *= -0.05;
                player.velocity.z *= -0.05;
                const restoredSeabedY = this.swimSeabedY(islands, player.position.x, player.position.z);
                if (restoredSeabedY > -Infinity && player.position.y < Math.min(restoredSeabedY, seabedClampCap)) {
                  player.position.y = Math.min(restoredSeabedY, seabedClampCap);
                  if (player.velocity.y < 0) player.velocity.y = 0;
                }
              } else if (player.position.y < Math.min(seabedY, seabedClampCap)) {
                player.position.y = Math.min(seabedY, seabedClampCap);
                if (player.velocity.y < 0) player.velocity.y = 0;
              }
            }
            // Flooded-cave roof clamp mirrors the on-foot case.
            if (
              ceilingY !== null
              && player.position.y < ceilingY
              && player.position.y + PLAYER.HEIGHT > ceilingY
            ) {
              player.position.y = ceilingY - PLAYER.HEIGHT;
              if (player.velocity.y > 0) player.velocity.y = 0;
            }
            if (!downed) player.state = 'swimming';

            // Drowning
            player.swimTimer += dt;
            if (player.swimTimer > PLAYER.DROWN_TIME && player.respawnProtectionTimer <= 0) {
              player.lastDamagedById = null;
              player.lastDamagedAt = null;
              player.lastDamageWasHeadshot = false;
              player.health -= PLAYER.DROWN_DAMAGE * dt;
            }
          }
        }

        // ── Anti-embed safety net ──────────────────────────────────────────
        // A pirate can never stay stuck INSIDE above-water island terrain (e.g.
        // wedged in a cliff/rock after a jump at the shore): if they end up well
        // below the solid surface, pop them back onto it. Caves (they legit
        // stand below the natural surface) and open-water swimming are exempt.
        if (onIsland && !downed) {
          const solidY = getIslandSurfaceY(onIsland, player.position.x, player.position.z);
          const inCave = getCaveCeilingY(onIsland, player.position.x, player.position.z) !== null;
          if (!inCave && solidY > 0.5 && player.position.y < solidY - 1.0) {
            player.position.y = solidY;
            if (player.velocity.y < 0) player.velocity.y = 0;
            player.swimTimer = 0;
            player.state = 'alive';
          }
        }
      }

      this.resolveSwimmerShipCollision(player, ships);
      this.resolvePlayerSeaRockCollision(player, seaRocks, false);

      // World boundary
      player.position.x = clamp(player.position.x, -playerBoundary, playerBoundary);
      player.position.z = clamp(player.position.z, -playerBoundary, playerBoundary);

      player.health = clamp(player.health, 0, PLAYER.MAX_HEALTH);

      // Check chest proximity
      player.nearChestId = null;
      if (!player.carryingChestId) {
        let bestChestDistance: number = PLAYER.INTERACT_RANGE;
        for (const island of islands) {
          for (const chest of island.chests) {
            if (chest.opened || chest.carriedByPlayerId === player.id) continue;
            const dx = player.position.x - chest.position.x;
            const dy = player.position.y - chest.position.y;
            const dz = player.position.z - chest.position.z;
            const distance = Math.sqrt(dx * dx + Math.min(Math.abs(dy), 2.2) ** 2 + dz * dz);
            if (distance < bestChestDistance) {
              bestChestDistance = distance;
              player.nearChestId = chest.id;
            }
          }
        }
      }

      player.nearBarrelId = null;
      for (const island of islands) {
        for (const barrel of island.barrels) {
          if (barrel.opened && barrel.loot.length === 0) continue;
          const dx = player.position.x - barrel.position.x;
          const dz = player.position.z - barrel.position.z;
          if (Math.sqrt(dx * dx + dz * dz) < PLAYER.INTERACT_RANGE) {
            player.nearBarrelId = barrel.id;
          }
        }
      }

      // Check nearby ship ladder for boarding
      player.nearShipId = null;
      const onIslandNow = player.onShipId === null
        && (this.findPlayerIsland(player, islands) !== null || this.findPlayerDock(player, islands) !== null);
      for (const ship of ships) {
        if (!ship.alive) continue;
        const ladder = getNearestShipBoardingLadder(ship, player.position);
        if (!ladder) continue;
        if (player.state === 'swimming' && ladder.distance < 3.5) {
          player.nearShipId = ship.id;
        } else if (onIslandNow && ladder.distance < 3.0) {
          player.nearShipId = ship.id;
        }
      }

      // Remember this tick's resolved footing — next tick's steep-slope test
      // measures the rise/run from here (governs bot body-walk too).
      this.playerPrevXZ.set(player.id, { x: player.position.x, z: player.position.z });
    }

    // Forget footing for players who left the match so the map can't grow unbounded.
    if (this.playerPrevXZ.size > players.length || this.playerGeyserCooldown.size > players.length) {
      const live = new Set(players.map((p) => p.id));
      for (const id of this.playerPrevXZ.keys()) {
        if (!live.has(id)) this.playerPrevXZ.delete(id);
      }
      for (const id of this.playerGeyserCooldown.keys()) {
        if (!live.has(id)) this.playerGeyserCooldown.delete(id);
      }
    }
  }

  private updateProjectiles(dt: number, t: number, projectiles: Projectile[], ships: Ship[], players: Player[], islands: Island[], seaRocks: SeaRock[], storm: StormState | null) {
    for (const proj of projectiles) {
      if (!proj.alive) continue;

      proj.age += dt;
      if (proj.age > proj.maxAge) { proj.alive = false; continue; }

      if (proj.visualOnly) {
        proj.position.x += proj.velocity.x * dt;
        proj.position.y += proj.velocity.y * dt;
        proj.position.z += proj.velocity.z * dt;
        continue;
      }

      const previousPosition = { ...proj.position };

      // Gravity
      proj.velocity.y += PHYSICS.GRAVITY * dt * (proj.type === 'bullet' ? 0.3 : SHIP.CANNON_GRAVITY_MULT);

      proj.position.x += proj.velocity.x * dt;
      proj.position.y += proj.velocity.y * dt;
      proj.position.z += proj.velocity.z * dt;

      if (this.didProjectileHitSeaRock(previousPosition, proj, seaRocks)) {
        proj.alive = false;
        proj.showImpact = true;
        continue;
      }

      // Island terrain hit — heightfield march along this tick's travel segment
      const travelX = proj.position.x - previousPosition.x;
      const travelY = proj.position.y - previousPosition.y;
      const travelZ = proj.position.z - previousPosition.z;
      const travelDist = Math.sqrt(travelX * travelX + travelY * travelY + travelZ * travelZ);
      if (travelDist > 0.0001) {
        const dir = { x: travelX / travelDist, y: travelY / travelDist, z: travelZ / travelDist };
        const terrainHit = raymarchIslandSurface(previousPosition, dir, travelDist, islands);
        if (terrainHit.hit) {
          if (terrainHit.point) proj.position = { ...terrainHit.point };
          proj.alive = false;
          proj.showImpact = true;
          continue;
        }
        // Solid world structures (boulders, towers, the fort, the tavern) eat a
        // round — cover that reads as cover must BE cover.
        const structureT = this.firstStructureHit(previousPosition, dir, travelDist, islands);
        if (structureT !== null) {
          proj.position = {
            x: previousPosition.x + dir.x * structureT,
            y: previousPosition.y + dir.y * structureT,
            z: previousPosition.z + dir.z * structureT,
          };
          proj.alive = false;
          proj.showImpact = true;
          continue;
        }
      }

      // Ship hit — tested BEFORE the water kill so waterline shots punch holes
      // (a wave cresting over the impact point no longer eats the ball).
      // Chainshot additionally checks a taller rigging band so it can actually
      // shred the canvas it exists for.
      for (const ship of ships) {
        if (!ship.alive || ship.id === proj.ownerShipId) continue;
        if (this.isProjectileInsideShipHull(proj, ship) || this.isChainshotInRiggingBand(proj, ship)) {
          this.onProjectileHitShip(proj, ship, t);
          proj.alive = false;
          break;
        }
      }
      if (!proj.alive) continue;

      // Water hit — real wave surface incl. local storm swell, not the y=0 plane
      const projSea = stormSeaState(storm, proj.position.x, proj.position.z);
      if (proj.position.y < gerstnerHeight(proj.position.x, proj.position.z, t, WAVE_PARAMS, projSea)) {
        proj.alive = false;
        continue;
      }

      // Player hit
      for (const player of players) {
        if (
          player.id === proj.ownerId
          || player.state === 'eliminated'
          || player.state === 'respawning'
          || player.respawnProtectionTimer > 0
        ) continue;
        if (this.projectileHitsPlayer(proj, player)) {
          this.onProjectileHitPlayer(proj, player, t);
          proj.alive = false;
          break;
        }
      }
    }
  }

  /**
   * Nearest solid island STRUCTURE along a unit ray (blocking props + tavern
   * shells), or null. Shared geometry with the on-foot colliders and with
   * Match's hitscan occlusion, so a boulder that stops your boots also stops
   * your shot. Broad-phased per island by its max radius.
   */
  firstStructureHit(origin: Vec3, direction: Vec3, range: number, islands: Island[]): number | null {
    let best: number | null = null;
    for (const island of islands) {
      const reach = getIslandMaxRadius(island) + LOCO.PROP_BROADPHASE_PAD;
      const rx = island.position.x - origin.x;
      const rz = island.position.z - origin.z;
      const along = clamp(rx * direction.x + rz * direction.z, 0, range);
      const px = rx - direction.x * along;
      const pz = rz - direction.z * along;
      if (px * px + pz * pz > reach * reach) continue;
      const propT = intersectRayIslandProps(origin, direction, best ?? range, island);
      if (propT !== null && (best === null || propT < best)) best = propT;
      if (island.tavern) {
        const tavernT = intersectRayTavern(origin, direction, best ?? range, island.tavern);
        if (tavernT !== null && (best === null || tavernT < best)) best = tavernT;
      }
    }
    return best;
  }

  /** Torso-centred capsule matching the render pose — swimming lays the body
   *  horizontal along facing yaw (mirrors the hitscan hitboxes in Match). */
  private projectileHitsPlayer(proj: Projectile, player: Player): boolean {
    const hitRadius = 0.5 + 0.3; // torso radius + projectile radius
    let a: Vec3;
    let b: Vec3;
    if (player.state === 'swimming') {
      const yaw = player.rotation.x;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const surfaceLift = 0.42; // body floats roughly half a metre above feet position
      a = {
        x: player.position.x - fx * 0.45,
        y: player.position.y + surfaceLift - 0.08,
        z: player.position.z - fz * 0.45,
      };
      b = {
        x: player.position.x + fx * 0.62,
        y: player.position.y + surfaceLift + 0.18,
        z: player.position.z + fz * 0.62,
      };
    } else {
      a = { x: player.position.x, y: player.position.y + 0.45, z: player.position.z };
      b = { x: player.position.x, y: player.position.y + PLAYER.HEIGHT * 0.86, z: player.position.z };
    }
    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const abZ = b.z - a.z;
    const apX = proj.position.x - a.x;
    const apY = proj.position.y - a.y;
    const apZ = proj.position.z - a.z;
    const abLenSq = abX * abX + abY * abY + abZ * abZ;
    const s = abLenSq > 0.000001
      ? clamp((apX * abX + apY * abY + apZ * abZ) / abLenSq, 0, 1)
      : 0;
    const dx = apX - abX * s;
    const dy = apY - abY * s;
    const dz = apZ - abZ * s;
    return dx * dx + dy * dy + dz * dz <= hitRadius * hitRadius;
  }

  private onProjectileHitShip(proj: Projectile, ship: Ship, t: number) {
    if (proj.type === 'bullet') return;

    // Canonical ship-local frame (+z bow, +x starboard) — correct at every
    // heading. This is the EXACT point the ball struck, in the same frame the
    // hull loft and its discard shader use, so the breach opens where you shot.
    const local = this.toShipLocal(proj.position, ship);
    const localY = proj.position.y - ship.position.y;
    const section: keyof HullSections = this.impactHullSection(local);

    const beforeHull = this.getHullIntegrity(ship);
    // Chainshot is a rigging weapon — it shreds canvas and fouls the helm but
    // never opens a hull hole, so it punches nothing (see below).
    let holes: ShipHole[] = [];
    if (proj.type !== 'chainshot') {
      // Discrete holes: one per ball, +CHARGED_EXTRA_HOLES for a Heavy Shot ship,
      // and a super cannonball caves in three. No HP pool — the ball punches the
      // hull; water through the hole is what actually sinks the ship.
      const superShot = proj.special === 'super_cannonball';
      const charged = proj.damage > SHIP.CANNON_DAMAGE_HULL * 1.15;
      const holeCount = superShot ? 3 : (charged ? 1 + SHIP_UPGRADES.CHARGED_EXTRA_HOLES : 1);
      holes = this.openHoleAt(ship, { x: local.x, y: localY, z: local.z }, holeCount, 'cannon');
    }
    const remainingHull = this.getHullIntegrity(ship);
    const milestone = beforeHull > 0.5 && remainingHull <= 0.5
      ? 'half'
      : beforeHull > 0.25 && remainingHull <= 0.25
        ? 'critical'
        : null;
    this.combatEvents.push({
      type: 'ship_hit',
      attackerId: proj.ownerId,
      targetId: ship.id,
      // Chainshot deals no hull damage — report 0 so the HUD shows a rigging hit.
      damage: proj.type === 'chainshot' ? 0 : proj.damage,
      position: { ...proj.position },
      projectileType: proj.type,
      section,
      remainingSection: remainingHull,
      remainingHull,
      milestone,
      holes: holes.map((h) => ({ id: h.id, x: h.x, y: h.y, z: h.z })),
    });

    if (proj.type === 'firebomb') {
      ship.onFire = true;
      ship.fireTimer = Math.max(ship.fireTimer, SHIP.FIRE_DURATION);
    }
    if (proj.type === 'chainshot') {
      ship.chainshottedUntil = t + 30;
      const torn = SHIP.CHAINSHOT_SAIL_DAMAGE;
      ship.sailIntegrity = Math.max(0, ship.sailIntegrity - torn);
      // Sea-of-Thieves style: the canvas physically collapses on hit. Sails drop
      // proportional to how much they were carrying, and only the repair station
      // can hoist them back up.
      const drop = torn * SHIP.CHAINSHOT_SAIL_DROP_FACTOR;
      ship.sailHeight = Math.max(0, ship.sailHeight - drop);
    }
  }

  private onProjectileHitPlayer(proj: Projectile, player: Player, t: number) {
    if (player.respawnProtectionTimer > 0 || player.state === 'respawning') return;
    // Cannon rounds carry hull damage in proj.damage; against flesh they deal
    // CANNON_DAMAGE_PLAYER scaled by the same upgrade/super multipliers.
    const damage = proj.type === 'bullet'
      ? proj.damage
      : SHIP.CANNON_DAMAGE_PLAYER * (proj.damage / SHIP.CANNON_DAMAGE_HULL);
    player.lastDamagedById = proj.ownerId;
    player.lastDamagedAt = t;
    player.lastDamageWasHeadshot = false;
    // Iron Cuirass absorbs combat rounds before flesh (Match owns the same
    // rule for guns/melee; environmental damage in this file bypasses armor).
    let healthDamage = damage;
    if (player.armor && player.armor > 0) {
      const absorbed = Math.min(player.armor, healthDamage);
      player.armor -= absorbed;
      healthDamage -= absorbed;
    }
    player.health -= healthDamage;
    this.combatEvents.push({
      type: 'player_hit',
      attackerId: proj.ownerId,
      targetId: player.id,
      damage,
      position: {
        x: player.position.x,
        y: player.position.y + PLAYER.HEIGHT * 0.72,
        z: player.position.z,
      },
      projectileType: proj.type,
      kill: player.health <= 0,
    });

    if (proj.knockback > 0) {
      const dir = { x: proj.velocity.x, y: 0, z: proj.velocity.z };
      const len = Math.sqrt(dir.x ** 2 + dir.z ** 2) || 1;
      const heavyKnockback = proj.knockback >= 20;
      const impulse = heavyKnockback ? proj.knockback * 1.18 : proj.knockback;
      player.knockbackVelocity.x += (dir.x / len) * impulse;
      player.knockbackVelocity.y += impulse * (heavyKnockback ? 0.62 : 0.4);
      player.knockbackVelocity.z += (dir.z / len) * impulse;
    }
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
  openHoleAt(
    ship: Ship,
    local: { x: number; y: number; z: number },
    count = 1,
    source?: ShipHoleSource,
  ): ShipHole[] {
    if (count <= 0) return [];
    if (!Array.isArray(ship.holes)) ship.holes = [];
    const stats = SHIP_STATS[ship.type];
    const maxY = Math.max(FLOODING.HOLE_BAND_Y.max, stats.height * 0.6);
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
      opened.push(this.placeHole(ship, point, source));
    }
    ship.repairCooldown = Math.max(ship.repairCooldown, SHIP.FIELD_REPAIR_DELAY);
    ship.autoRepairProgress = 0;
    return opened;
  }

  /** Insert one breach entity, recycling the nearest patched slot when the hull
   *  is at its wire/shader cap. */
  private placeHole(ship: Ship, point: { x: number; y: number; z: number }, source?: ShipHoleSource): ShipHole {
    if (ship.holes.length < FLOODING.MAX_HOLES_PER_SHIP) {
      const hole: ShipHole = {
        id: ship.nextHoleId ?? (ship.nextHoleId = 1),
        x: point.x,
        y: point.y,
        z: point.z,
        patched: false,
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
    // Every slot already an OPEN hole — the shot lands in an existing wound.
    if (!victim) {
      let nearest = ship.holes[0];
      let nearestSq = Infinity;
      for (const hole of ship.holes) {
        const d2 = (hole.x - point.x) ** 2 + (hole.y - point.y) ** 2 + (hole.z - point.z) ** 2;
        if (d2 < nearestSq) { nearestSq = d2; nearest = hole; }
      }
      return nearest;
    }
    victim.patched = false;
    victim.x = point.x;
    victim.y = point.y;
    victim.z = point.z;
    if (source) victim.source = source;
    return victim;
  }

  /** Plank ONE breach shut (one plank per hole). The entity stays in the list so
   *  the crossed-plank repair keeps rendering at the spot. */
  patchHole(ship: Ship, holeId: number): boolean {
    const hole = (ship.holes ?? []).find((h) => h.id === holeId && !h.patched);
    if (!hole) return false;
    hole.patched = true;
    return true;
  }

  /** Rotate a world-space direction into a ship's local frame. +z = forward, +x = starboard.
   *  Same rotation convention as the canonical toShipLocalPoint in shared/interactions. */
  private rotateWorldToShipLocal(wx: number, wz: number, rotation: number) {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return { x: wx * cos - wz * sin, z: wx * sin + wz * cos };
  }

  /**
   * Damage multiplier based on impact angle relative to the ship's hull.
   * - 1.0 when the hit is along the bow/stern axis (the rammer)
   * - up to 1.9 when the hit is fully broadside (the T-boned victim)
   */
  private tboneDamageFactor(localImpact: { x: number; z: number }) {
    const len = Math.hypot(localImpact.x, localImpact.z) || 1;
    const lateral = Math.abs(localImpact.x) / len;
    return 1 + lateral * lateral * 0.9;
  }

  /** Pick the hull section (bow/stern/port/starboard) that absorbed the hit. */
  private impactHullSection(localImpact: { x: number; z: number }): keyof HullSections {
    return Math.abs(localImpact.z) >= Math.abs(localImpact.x)
      ? (localImpact.z >= 0 ? 'bow' : 'stern')
      : (localImpact.x >= 0 ? 'starboard' : 'port');
  }

  /** Feed/HUD-only "how wrecked is she" scalar, 1 → whole, 0 → riddled. Eight
   *  open breaches reads as a total loss; nothing keys damage off this. */
  private getHullIntegrity(ship: Ship) {
    return clamp(1 - countOpenHoles(ship) / 8, 0, 1);
  }

  /** Hull-local point on the face nearest `local`, at the waterline band —
   *  used by damage sources that only know a direction/section, not a surface
   *  point (storm seas, keg faces, fire burn-through). */
  hullFacePoint(ship: Ship, local: { x: number; z: number }, y: number, spread = 0.6): { x: number; y: number; z: number } {
    const stats = SHIP_STATS[ship.type];
    const jitter = (this.holeJitter = (this.holeJitter * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
    if (Math.abs(local.x) >= Math.abs(local.z) * (stats.width / stats.length)) {
      return {
        x: Math.sign(local.x || 1) * stats.width * 0.5,
        y,
        z: clamp(local.z + jitter * spread, -stats.length * 0.44, stats.length * 0.44),
      };
    }
    return {
      x: clamp(local.x + jitter * spread, -stats.width * 0.44, stats.width * 0.44),
      y,
      z: Math.sign(local.z || 1) * stats.length * 0.42,
    };
  }

  /** LCG state for hull-face jitter — deterministic per server process so a
   *  replayed sim lands the same breach points. */
  private holeJitter = 0x2f6e2b1;

  /** Block passing through the full hull — swimmers AND walkers whose feet are
   *  below the deck rail (docked-ship walk-through). Boarding still happens via
   *  the ladder prompt; the vertical band below keeps above-rail jumps clear. */
  private resolveSwimmerShipCollision(player: Player, ships: Ship[]) {
    if (player.cannonBallistic || player.onShipId) return;
    if (player.state !== 'swimming' && player.state !== 'alive') return;

    for (const ship of ships) {
      if (!ship.alive || ship.sinking) continue;
      const stats = SHIP_STATS[ship.type];
      const { keelY, deckY } = getSwimHullVerticalBand(ship.position.y, stats, ship.type);

      const local = this.toShipLocal(player.position, ship);
      const margin = PLAYER.RADIUS + 0.18;
      // The hull tucks in hard below the waterline — a swimmer at depth may hug
      // the visible bilge curve instead of a straight prism.
      const verticalT = getSwimHullVerticalT(player.position.y, ship.position.y, stats, ship.type);
      const insideFootprint = isInsideSwimHullFootprint(stats, local.x, local.z, margin, verticalT);

      // Underside barrier: a swimmer beneath the hull footprint cannot rise up
      // through the keel — they must swim out from under it (or board via the
      // ladder). This closes the "swim into the ship through the bottom of the
      // hull" exploit while still letting a deep swimmer transit under the keel.
      if (player.position.y < keelY) {
        const risingIntoHull = insideFootprint
          && player.position.y > keelY - (PLAYER.HEIGHT + 0.4)
          && (player.velocity.y > 0 || player.knockbackVelocity.y > 0);
        if (risingIntoHull) {
          if (player.velocity.y > 0) player.velocity.y = 0;
          if (player.knockbackVelocity.y > 0) player.knockbackVelocity.y = 0;
          player.position.y = Math.min(player.position.y, keelY - 0.02);
        }
        continue;
      }
      if (player.position.y > deckY + 0.35) continue;
      if (!insideFootprint) continue;

      const out = pushOutOfSwimHullFootprint(stats, local.x, local.z, margin, verticalT);
      if (!out.pushed) continue;

      const w = this.toShipWorld(out.x, out.z, ship);
      const prevX = player.position.x;
      const prevZ = player.position.z;
      player.position.x = w.x;
      player.position.z = w.z;
      const pushX = w.x - prevX;
      const pushZ = w.z - prevZ;
      const pl = Math.hypot(pushX, pushZ);
      if (pl > 0.002) {
        const nx = pushX / pl;
        const nz = pushZ / pl;
        const into = player.velocity.x * nx + player.velocity.z * nz;
        if (into < 0) {
          player.velocity.x -= into * nx;
          player.velocity.z -= into * nz;
        }
        player.knockbackVelocity.x = 0;
        player.knockbackVelocity.z = 0;
      }
    }
  }

  private findPlayerShip(player: Player, ships: Ship[]): Ship | null {
    if (player.cannonBallistic) return null;
    if (player.state === 'swimming') return null;

    // Fast path: player knows which ship they're on
    if (player.onShipId) {
      const ship = ships.find((s) => s.id === player.onShipId && s.alive);
      if (!ship) return null;
      const stats = SHIP_STATS[ship.type];
      const local = this.toShipLocal(player.position, ship);
      const deckY = ship.position.y + stats.height + 0.1;
      const holdFloor = ship.position.y + 0.35;
      const aboveDeckLine = player.position.y > ship.position.y + stats.height * 0.35;
      const withinDeckXZ = this.isInsideShipDeckFootprint(local, stats, 0.2);
      if (aboveDeckLine && withinDeckXZ) return ship;
      const withinHullXZ = this.isInsideShipHoldFootprint(local, stats, 0.18);
      const inHoldY = player.position.y >= holdFloor - 0.6 && player.position.y < deckY - 0.2;
      if (withinHullXZ && inHoldY) return ship;
      return null;
    }

    // Auto-detect: player has no onShipId (e.g. spawned at dock, jumped from island).
    // Be generous on the upper Y bound so a mid-air jumper doesn't oscillate between
    // "on island" and "on ship" while descending — once they're over the ship's
    // deck XZ and within ~1.8m of the deck, claim the ship and let on-ship gravity
    // bring them down to it.
    for (const ship of ships) {
      if (!ship.alive) continue;
      const stats = SHIP_STATS[ship.type];
      const local = this.toShipLocal(player.position, ship);
      const deckY = ship.position.y + stats.height + 0.1;
      const aboveDeckLine = player.position.y > ship.position.y + stats.height * 0.25;
      const withinDeckXZ = this.isInsideShipDeckFootprint(local, stats, 0.3);
      if (aboveDeckLine && withinDeckXZ && player.position.y <= deckY + 1.8) return ship;
    }

    return null;
  }

  /** Seabed under a swimmer: the shared heightfield keeps descending past the
   *  footprint (wet-sand walk-in to distRatio ~1.16), so the collision floor
   *  must cover that apron too — inside-footprint-only checks let swimmers
   *  dive straight under the island shell. Returns -Infinity in open water. */
  private swimSeabedY(islands: Island[], x: number, z: number): number {
    let floor = -Infinity;
    for (const island of islands) {
      const { distRatio } = getIslandDistRatio(island, x, z);
      if (distRatio > 1.22) continue;
      floor = Math.max(floor, getIslandSurfaceY(island, x, z));
    }
    return floor;
  }

  private findPlayerIsland(player: Player, islands: Island[]): Island | null {
    for (const island of islands) {
      if (isPointInsideIslandFootprint(island, player.position.x, player.position.z, 0)) return island;
    }
    return null;
  }

  /**
   * Standing floor + interior ceiling at (x, z), cave-aware. On the hillside
   * ABOVE a cave the player rests on the natural surface (cave carve stays
   * opt-out in getIslandSurfaceY, so they never fall into the trench); once
   * their feet drop under the ceiling they stand on the carved cave floor via
   * the documented getCaveFloorY API. `ceilingY` is null outside any cave box.
   */
  private islandStandY(
    island: Island,
    x: number,
    z: number,
    playerY: number,
  ): { floorY: number; ceilingY: number | null; inCave: boolean } {
    const natural = getIslandSurfaceY(island, x, z);
    const ceilingY = getCaveCeilingY(island, x, z);
    let floorY = natural;
    let inCave = false;
    if (ceilingY !== null && playerY < ceilingY - LOCO.CAVE_HEAD_CLEARANCE) {
      const caveFloor = getCaveFloorY(island, x, z);
      if (caveFloor !== null && caveFloor < natural) { floorY = caveFloor; inCave = true; }
    }
    return { floorY, ceilingY, inCave };
  }

  /**
   * Push an on-foot / near-shore player out of every blocking island prop
   * (palms & towers & lantern posts as capsules, boulders as spheres) via the
   * shared resolvePropCollision. Broad-phased by squared distance to each
   * island centre so it stays cheap at 62.5 Hz. Projectiles never call this —
   * visual-scale props only block players, not cannon fire.
   */
  private resolvePlayerPropCollision(player: Player, islands: Island[]) {
    for (const island of islands) {
      const props = island.props;
      if (!props || props.length === 0) continue;
      const dxi = player.position.x - island.position.x;
      const dzi = player.position.z - island.position.z;
      const br = getIslandMaxRadius(island) + LOCO.PROP_BROADPHASE_PAD;
      if (dxi * dxi + dzi * dzi > br * br) continue;
      const res = resolvePropCollision(player.position, PLAYER.RADIUS, island);
      if (!res.pushed) continue;
      const pushX = res.x - player.position.x;
      const pushZ = res.z - player.position.z;
      player.position.x = res.x;
      player.position.z = res.z;
      // Cancel the velocity component driving into the prop so the player slides
      // along the collider instead of buzzing against it.
      const pl = Math.hypot(pushX, pushZ);
      if (pl > 1e-4) {
        const nx = pushX / pl;
        const nz = pushZ / pl;
        const into = player.velocity.x * nx + player.velocity.z * nz;
        if (into < 0) {
          player.velocity.x -= into * nx;
          player.velocity.z -= into * nz;
        }
      }
    }
  }

  /**
   * The tavern is a BUILDING, not a hologram: its four plaster walls block on
   * foot, with the doorway in the dock-facing (+local-z) wall genuinely open.
   * Wall geometry comes from the shared getTavernWallSegments so the collision
   * shell, the shot-occlusion shell and the GLB are one and the same.
   */
  private resolvePlayerTavernCollision(player: Player, islands: Island[]) {
    for (const island of islands) {
      const tavern = island.tavern;
      if (!tavern) continue;
      const band = getTavernWallBand(tavern);
      if (player.position.y < band.minY || player.position.y > band.maxY) continue;
      const dx = player.position.x - tavern.position.x;
      const dz = player.position.z - tavern.position.z;
      const reach = getTavernBoundsRadius(tavern) + PLAYER.RADIUS;
      if (dx * dx + dz * dz > reach * reach) continue;
      const local = toTavernLocal(tavern, player.position.x, player.position.z);
      const out = pushOutOfTavernWalls(tavern, local.x, local.z, PLAYER.RADIUS);
      if (!out.pushed) continue;
      const world = tavernLocalToWorld(tavern, out.x, out.z);
      const pushX = world.x - player.position.x;
      const pushZ = world.z - player.position.z;
      player.position.x = world.x;
      player.position.z = world.z;
      const pl = Math.hypot(pushX, pushZ);
      if (pl > 1e-4) {
        const nx = pushX / pl;
        const nz = pushZ / pl;
        const into = player.velocity.x * nx + player.velocity.z * nz;
        if (into < 0) {
          player.velocity.x -= into * nx;
          player.velocity.z -= into * nz;
        }
      }
    }
  }

  /**
   * Steep terrain is unwalkable: if a grounded walker is climbing INTO a face
   * steeper than LOCO.SLOPE_MAX, revert this tick's footing (block) but keep any
   * sideways momentum so the pirate slides along the cliff base instead of
   * sticking. The steepness is the MACRO terrain slope sampled LOCO.SLOPE_PROBE
   * metres ahead along the direction of travel — a stable baseline that reads
   * the true face angle rather than aliasing into 2.4-6m terrace micro-relief
   * (a raw per-tick 0.08m sample would stutter-block walkable terraced hills).
   * Because it keys off the actual footing displacement, bot body-walk (which
   * moves position directly, not velocity) obeys the same limit humans do.
   * Jumping is untouched: the gate only fires while grounded, not rising, and
   * not being knocked back, and never reverts a warp-sized step.
   */
  private resolveSlopeBlock(player: Player, island: Island | null) {
    if (!island || player.state !== 'alive') return;
    const prev = this.playerPrevXZ.get(player.id);
    if (!prev) return;
    const stepX = player.position.x - prev.x;
    const stepZ = player.position.z - prev.z;
    const run = Math.hypot(stepX, stepZ);
    if (run <= 1e-4 || run > LOCO.SLOPE_MAX_STEP) return;
    // Effective footing surface: INSIDE a cave the walkable floor is the gently
    // ramping cave floor, not the steep natural mountain roof above it. Measuring
    // the cliff-block against the natural surface bricked the player a few metres
    // into every cave mouth (the flank rises fastest exactly where caves bore in),
    // making the whole interior unreachable — so sample the cave floor when under
    // a roof and let the mouth-approach read the descending floor ahead.
    const standY = (sx: number, sz: number): number => {
      const natural = getIslandSurfaceY(island, sx, sz);
      const ceil = getCaveCeilingY(island, sx, sz);
      // Mirror islandStandY's playerY gate: only substitute the cave floor when
      // the walker is actually UNDER the roof. Without it, a player on the
      // hillside ABOVE a cave probed the cave floor 10-20m below their feet,
      // read the "slope" as a plunge, and the steep-slope block never fired —
      // letting them walk straight up cliff faces over any cave footprint.
      if (ceil !== null && player.position.y < ceil - LOCO.CAVE_HEAD_CLEARANCE) {
        const cf = getCaveFloorY(island, sx, sz);
        if (cf !== null && cf < natural) return cf;
      }
      return natural;
    };
    // Only cliff-block a grounded walker (airborne jumpers clear steep ground),
    // and never fight an explosion/cannon knockback impulse.
    const gTo = standY(player.position.x, player.position.z);
    const grounded = player.position.y <= gTo + 0.4;
    const knocked = Math.hypot(player.knockbackVelocity.x, player.knockbackVelocity.z) > 1;
    if (!grounded || knocked || player.velocity.y > 0.2) return;
    // Macro slope of the (effective) footing immediately ahead in the travel dir.
    const dirX = stepX / run;
    const dirZ = stepZ / run;
    const probe = LOCO.SLOPE_PROBE;
    const gAhead = standY(player.position.x + dirX * probe, player.position.z + dirZ * probe);
    const slopeAhead = (gAhead - gTo) / probe;
    if (slopeAhead > LOCO.SLOPE_MAX) {
      player.position.x = prev.x;
      player.position.z = prev.z;
      // Cancel only the into-slope component of velocity so lateral travel along
      // the cliff base still works (find the walkable saddle, don't get bricked).
      const into = player.velocity.x * dirX + player.velocity.z * dirZ;
      if (into > 0) {
        player.velocity.x -= into * dirX;
        player.velocity.z -= into * dirZ;
      }
    }
  }

  private findPlayerDock(player: Player, islands: Island[]) {
    for (const island of islands) {
      if (!island.dock) continue;
      const local = this.toDockLocal(player.position, island.dock);
      if (Math.abs(local.x) <= island.dock.width * 0.5 + 0.45 && Math.abs(local.z) <= island.dock.length * 0.5 + 0.45) {
        return island.dock;
      }
    }
    return null;
  }

  private toShipLocal(position: Vec3, ship: Ship) {
    return toShipLocalPoint(position, ship);
  }

  private toShipWorld(x: number, z: number, ship: Ship) {
    return toShipWorldPoint({ x, z }, ship);
  }

  private toDockLocal(position: Vec3, dock: NonNullable<Island['dock']>) {
    return toDockLocalPoint(dock, position.x, position.z);
  }

  private getShipDynamics(shipId: string) {
    let dyn = this.shipDynamics.get(shipId);
    if (!dyn) {
      dyn = { pitchVel: 0, rollVel: 0, heaveVel: 0 };
      this.shipDynamics.set(shipId, dyn);
    }
    return dyn;
  }

  /**
   * Sample the shared Gerstner field at bow/stern/port/starboard hull points
   * (canonical ship transform) and chase the resulting slope with a
   * near-critically-damped spring. Conventions match the client renderer:
   * positive pitch dips the bow, positive roll lifts the starboard rail.
   * Magnitudes stay inside the client's defensive clamps (±0.5 / ±0.6).
   */
  private updateShipWaveAttitude(
    ship: Ship,
    stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS],
    t: number,
    dt: number,
    windHeel: number,
    seaState = 0,
  ) {
    const dyn = this.getShipDynamics(ship.id);
    const halfL = stats.length * 0.4;
    const halfW = stats.width * 0.4;
    const bow = this.toShipWorld(0, halfL, ship);
    const stern = this.toShipWorld(0, -halfL, ship);
    const starboard = this.toShipWorld(halfW, 0, ship);
    const port = this.toShipWorld(-halfW, 0, ship);
    const bowY = gerstnerHeight(bow.x, bow.z, t, WAVE_PARAMS, seaState);
    const sternY = gerstnerHeight(stern.x, stern.z, t, WAVE_PARAMS, seaState);
    const starboardY = gerstnerHeight(starboard.x, starboard.z, t, WAVE_PARAMS, seaState);
    const portY = gerstnerHeight(port.x, port.z, t, WAVE_PARAMS, seaState);

    const cosR = Math.cos(ship.rotation);
    const sinR = Math.sin(ship.rotation);
    const forwardSpeed = sinR * ship.velocity.x + cosR * ship.velocity.z;
    const speedFrac = clamp(Math.abs(forwardSpeed) / Math.max(1, stats.maxSpeed), 0, 1.15);

    // Slight bow-up trim at speed; turn heel leans the hull out of a hard turn.
    // Storm seas produce steeper sampled slopes — let the targets breathe a
    // little wider so heavy weather genuinely pitches the deck (still inside
    // the client renderer's defensive clamps of ±0.5 / ±0.6).
    const pitchCap = 0.35 + seaState * 0.1;
    const rollCap = 0.45 + seaState * 0.08;
    // An anchored hull holds nearly flat — berthed ships used to heel with
    // every passing wave, so identical docks showed randomly tilted parks.
    const anchorCalm = ship.anchored ? 0.3 : 1;
    const targetPitch = clamp(
      (Math.atan2(sternY - bowY, stats.length * 0.8) - speedFrac * 0.035) * anchorCalm,
      -pitchCap, pitchCap,
    );
    const turnHeel = clamp(-ship.angularVelocity * speedFrac * 0.5, -0.06, 0.06);
    const targetRoll = clamp(
      (Math.atan2(starboardY - portY, stats.width * 0.8) + turnHeel + windHeel) * anchorCalm,
      -rollCap, rollCap,
    );

    const pitch = ship.pitch ?? 0;
    const roll = ship.roll ?? 0;
    dyn.pitchVel += ((targetPitch - pitch) * ATTITUDE_STIFFNESS - dyn.pitchVel * ATTITUDE_DAMPING) * dt;
    dyn.rollVel += ((targetRoll - roll) * ATTITUDE_STIFFNESS - dyn.rollVel * ATTITUDE_DAMPING) * dt;
    ship.pitch = clamp(pitch + dyn.pitchVel * dt, -0.45, 0.45);
    ship.roll = clamp(roll + dyn.rollVel * dt, -0.55, 0.55);
  }

  /**
   * Oriented capsule-chain hull vs hull. Both hulls use beam-accurate sample
   * radii so parallel ships can come rail-to-rail (~sum of half beams) without
   * phantom contact, while rams resolve at the true contact point with a
   * linear impulse plus r×J torque on both hulls.
   */
  private resolveShipShipCollision(ship: Ship, other: Ship, helmsmanByShip?: Map<string, string>) {
    const stats = SHIP_STATS[ship.type];
    const otherStats = SHIP_STATS[other.type];
    const dxC = ship.position.x - other.position.x;
    const dzC = ship.position.z - other.position.z;
    const dCenter = Math.hypot(dxC, dzC);
    if (dCenter > (stats.length + otherStats.length) * 0.62) return;

    const samplesA = this.getShipHullContactSamples(ship);
    const samplesB = this.getShipHullContactSamples(other);
    let deepest: {
      ax: number; az: number; bx: number; bz: number;
      ra: number; rb: number; d: number; penetration: number;
    } | null = null;
    for (const sa of samplesA) {
      for (const sb of samplesB) {
        const dx = sa.x - sb.x;
        const dz = sa.z - sb.z;
        const d = Math.hypot(dx, dz);
        const penetration = sa.radius + sb.radius - d;
        if (penetration > 0 && (!deepest || penetration > deepest.penetration)) {
          deepest = { ax: sa.x, az: sa.z, bx: sb.x, bz: sb.z, ra: sa.radius, rb: sb.radius, d, penetration };
        }
      }
    }
    if (!deepest) return;

    // Contact normal points from `other` toward `ship`. Degenerate overlaps
    // (samples coincident) separate along the center line, then abeam.
    let nx: number;
    let nz: number;
    if (deepest.d > 0.05) {
      nx = (deepest.ax - deepest.bx) / deepest.d;
      nz = (deepest.az - deepest.bz) / deepest.d;
    } else if (dCenter > 0.05) {
      nx = dxC / dCenter;
      nz = dzC / dCenter;
    } else {
      nx = Math.cos(ship.rotation);
      nz = -Math.sin(ship.rotation);
    }

    const half = deepest.penetration * 0.5;
    ship.position.x += nx * half;
    ship.position.z += nz * half;
    other.position.x -= nx * half;
    other.position.z -= nz * half;

    // Approximate contact point on the interface between the two sample circles.
    const frac = deepest.rb / Math.max(0.001, deepest.ra + deepest.rb);
    const cx = deepest.bx + (deepest.ax - deepest.bx) * frac;
    const cz = deepest.bz + (deepest.az - deepest.bz) * frac;

    const rv = (ship.velocity.x - other.velocity.x) * nx + (ship.velocity.z - other.velocity.z) * nz;
    if (rv >= 0) return; // already separating
    const relSpd = -rv;
    const jMag = relSpd * 0.4;
    ship.velocity.x += nx * jMag;
    ship.velocity.z += nz * jMag;
    other.velocity.x -= nx * jMag;
    other.velocity.z -= nz * jMag;

    // Torque about +Y: τ = rz·Jx − rx·Jz. Off-center rams pivot both hulls.
    const raX = cx - ship.position.x;
    const raZ = cz - ship.position.z;
    const rbX = cx - other.position.x;
    const rbZ = cz - other.position.z;
    const invInertiaA = 4.2 / (stats.length * stats.length);
    const invInertiaB = 4.2 / (otherStats.length * otherStats.length);
    ship.angularVelocity += clamp((raZ * nx - raX * nz) * jMag * invInertiaA, -0.35, 0.35);
    other.angularVelocity += clamp((rbZ * -nx - rbX * -nz) * jMag * invInertiaB, -0.35, 0.35);

    // Damage on hard collision — T-bone (broadside) victims take heavier damage
    // than rammers hitting with their bow/stern. Both ships still take some.
    if (relSpd > 2.5) {
      const baseDmg = relSpd * 12;
      // The face of each ship that touched the other = impact normal in its local frame.
      const shipImpact = this.rotateWorldToShipLocal(-nx, -nz, ship.rotation);
      const otherImpact = this.rotateWorldToShipLocal(nx, nz, other.rotation);
      const shipFactor = this.tboneDamageFactor(shipImpact);
      const otherFactor = this.tboneDamageFactor(otherImpact);
      // The REAL contact point, resolved into each hull's own frame — the
      // rammer is stove in at the bow, the victim amidships on the struck beam.
      const shipLocal = this.toShipLocal({ x: cx, y: 0, z: cz }, ship);
      const otherLocal = this.toShipLocal({ x: cx, y: 0, z: cz }, other);
      const bandY = (FLOODING.HOLE_BAND_Y.min + FLOODING.HOLE_BAND_Y.max) * 0.5;
      // Discrete holes: a bow-on ram stoves in one plank; a broadside T-bone
      // (high factor) caves in two; a very hard slam adds a third. The T-boned
      // victim therefore always loses more planks than the rammer.
      const ramHoles = (factor: number) =>
        1 + (factor > 1.4 ? 1 : 0) + (baseDmg * factor > 90 ? 1 : 0);
      this.openHoleAt(ship, { x: shipLocal.x, y: bandY, z: shipLocal.z }, ramHoles(shipFactor), 'ram');
      this.openHoleAt(other, { x: otherLocal.x, y: bandY, z: otherLocal.z }, ramHoles(otherFactor), 'ram');

      // Ram kill credit: each hull's damage is banked to the OTHER hull's
      // helmsman (or its owner), so ramming a ship to death now credits the
      // rammer — eliminating the crew and awarding kills like every other
      // sink route (Match resolves it via markShipDamagedByPlayer).
      this.combatEvents.push({
        type: 'ship_ram',
        attackerId: helmsmanByShip?.get(other.id) ?? other.ownerId,
        targetId: ship.id,
        damage: baseDmg * shipFactor,
      });
      this.combatEvents.push({
        type: 'ship_ram',
        attackerId: helmsmanByShip?.get(ship.id) ?? ship.ownerId,
        targetId: other.id,
        damage: baseDmg * otherFactor,
      });
      // One spatial crash FX at the contact point (the two hulls slamming).
      this.combatEvents.push({
        type: 'ship_impact', kind: 'ram', position: { x: cx, y: 0, z: cz }, speed: relSpd,
      });
    }
  }

  /**
   * Depth-based grounding: the keel (the RENDERED draft, height · HULL_DRAFT_F,
   * plus a small safety bite) tests the island heightfield under each hull
   * sample — so a scrape lands where the visible keel would touch, not 0.6–0.7 m
   * of clear water earlier. Where the
   * seabed rises above keel depth the ship scrapes — speed-scaled section
   * damage, a small yaw kick, and a downhill push back toward deep water.
   * Beaches slope gently underwater so shallow approaches ground out, while
   * deep inlets and coves stay honestly sailable because the heightfield
   * itself sits below the keel there.
   */
  private pushShipOutOfIsland(ship: Ship, island: Island) {
    const stats = SHIP_STATS[ship.type];
    const broadphase = getIslandMaxRadius(island) + stats.length * 0.6;
    const dxI = ship.position.x - island.position.x;
    const dzI = ship.position.z - island.position.z;
    if (dxI * dxI + dzI * dzI > broadphase * broadphase) return;

    const keelY = ship.position.y - stats.height * SHIP.HULL_DRAFT_F[ship.type] - SHIP.GROUND_KEEL_SAFETY;
    let deepest: { x: number; z: number; depth: number } | null = null;
    for (const sample of this.getShipHullContactSamples(ship)) {
      const depth = getIslandSurfaceY(island, sample.x, sample.z) - keelY;
      if (depth > 0 && (!deepest || depth > deepest.depth)) {
        deepest = { x: sample.x, z: sample.z, depth };
      }
    }
    if (!deepest) return;

    // A hull at rest sits on the bottom — no jitter for moored/beached ships.
    const planarSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
    if (planarSpeed < 0.6) return;

    // Push downhill along the heightfield gradient (fallback: away from centre).
    const eps = 2;
    const gx = getIslandSurfaceY(island, deepest.x + eps, deepest.z)
      - getIslandSurfaceY(island, deepest.x - eps, deepest.z);
    const gz = getIslandSurfaceY(island, deepest.x, deepest.z + eps)
      - getIslandSurfaceY(island, deepest.x, deepest.z - eps);
    let nx = -gx;
    let nz = -gz;
    const gradLen = Math.hypot(nx, nz);
    if (gradLen > 0.02) {
      nx /= gradLen;
      nz /= gradLen;
    } else {
      const d = Math.hypot(dxI, dzI);
      nx = d > 0.001 ? dxI / d : 1;
      nz = d > 0.001 ? dzI / d : 0;
    }

    const slope = Math.max(gradLen / (2 * eps), 0.08);
    const push = Math.min(deepest.depth / slope, 0.9);
    ship.position.x += nx * push;
    ship.position.z += nz * push;

    const relVel = ship.velocity.x * nx + ship.velocity.z * nz;
    if (relVel < 0) {
      const impactSpeed = -relVel;
      ship.velocity.x -= relVel * nx * 1.35;
      ship.velocity.z -= relVel * nz * 1.35;
      // Yaw kick pivots the hull off the bar (τ = rz·Fx − rx·Fz about +Y).
      const rx = deepest.x - ship.position.x;
      const rz = deepest.z - ship.position.z;
      ship.angularVelocity += clamp((rz * nx - rx * nz) * impactSpeed * 0.004, -0.12, 0.12);
      if (impactSpeed > 2.0) {
        // Running aground stoves the KEEL in, at the hull sample that actually
        // touched the seabed. y = 0.12 is near the keel, so a grounding breach
        // is always underwater — grounding is the harshest damage in the game.
        const local = this.toShipLocal({ x: deepest.x, y: 0, z: deepest.z }, ship);
        this.openHoleAt(ship, { x: local.x, y: 0.12, z: local.z }, impactSpeed > 5 ? 2 : 1, 'ground');
        this.combatEvents.push({
          type: 'ship_impact', kind: 'ground', position: { x: deepest.x, y: 0, z: deepest.z }, speed: impactSpeed,
        });
      }
    }
  }

  /**
   * A dock is a pile-driven structure standing on the seabed, not a decal: its
   * deck and piles stop a hull. Treated as an oriented box in the canonical dock
   * frame (the same one toDockLocal uses) against the keel-line capsule chain,
   * resolved along the least-penetration axis with the sea-rock pushback feel.
   * Berths sit a full beam clear of the box, so moored ships never fight it.
   */
  private pushShipOutOfDock(ship: Ship, dock: NonNullable<Island['dock']>) {
    const stats = SHIP_STATS[ship.type];
    const dxD = ship.position.x - dock.position.x;
    const dzD = ship.position.z - dock.position.z;
    const reach = Math.hypot(dock.width, dock.length) * 0.5 + stats.length * 0.6;
    if (dxD * dxD + dzD * dzD > reach * reach) return;

    const halfX = dock.width * 0.5;
    const halfZ = dock.length * 0.5;
    let deepest: {
      penetration: number;
      alongX: boolean;
      sign: number;
      sampleX: number;
      sampleZ: number;
    } | null = null;
    for (const sample of this.getShipHullContactSamples(ship)) {
      const local = this.toDockLocal({ x: sample.x, y: 0, z: sample.z }, dock);
      const penX = halfX + sample.radius - Math.abs(local.x);
      const penZ = halfZ + sample.radius - Math.abs(local.z);
      if (penX <= 0 || penZ <= 0) continue;
      const alongX = penX <= penZ;
      const penetration = alongX ? penX : penZ;
      if (!deepest || penetration > deepest.penetration) {
        deepest = {
          penetration,
          alongX,
          sign: (alongX ? local.x : local.z) >= 0 ? 1 : -1,
          sampleX: sample.x,
          sampleZ: sample.z,
        };
      }
    }
    if (!deepest) return;

    // Dock-local +x maps to world (cos, −sin) and +z to (sin, cos).
    const cos = Math.cos(dock.rotation);
    const sin = Math.sin(dock.rotation);
    const nx = (deepest.alongX ? cos : sin) * deepest.sign;
    const nz = (deepest.alongX ? -sin : cos) * deepest.sign;
    ship.position.x += nx * deepest.penetration;
    ship.position.z += nz * deepest.penetration;

    const relVel = ship.velocity.x * nx + ship.velocity.z * nz;
    if (relVel < 0) {
      const impactSpeed = -relVel;
      ship.velocity.x -= relVel * nx * 1.35;
      ship.velocity.z -= relVel * nz * 1.35;
      // τ about +Y is rz·Fx − rx·Fz — a glancing scrape swings the bow off the pier.
      ship.angularVelocity += clamp(
        ((deepest.sampleZ - ship.position.z) * nx - (deepest.sampleX - ship.position.x) * nz) * impactSpeed * 0.004,
        -0.12, 0.12,
      );
      if (impactSpeed > 2.0) {
        const local = this.toShipLocal({ x: deepest.sampleX, y: 0, z: deepest.sampleZ }, ship);
        this.openHoleAt(ship, { x: local.x, y: 0.12, z: local.z }, impactSpeed > 5 ? 2 : 1, 'ground');
        this.combatEvents.push({
          type: 'ship_impact', kind: 'ground', position: { x: deepest.sampleX, y: 0, z: deepest.sampleZ }, speed: impactSpeed,
        });
      }
    }
  }

  private pushShipOutOfSeaRock(ship: Ship, rock: SeaRock) {
    const samples = this.getShipCollisionSamples(ship);
    let deepest: {
      nx: number;
      nz: number;
      penetration: number;
      sampleX: number;
      sampleZ: number;
      section: keyof HullSections;
    } | null = null;
    const stats = SHIP_STATS[ship.type];
    const shipMinY = ship.position.y - stats.height * 0.45;
    const shipMaxY = ship.position.y + stats.height + 1.2;

    for (const sample of samples) {
      if (Math.hypot(sample.x - rock.position.x, sample.z - rock.position.z) > getSeaRockBoundsRadius(rock) + sample.radius) continue;
      for (const collider of getSeaRockColliders(rock)) {
        const minY = rock.position.y + collider.minY;
        const maxY = rock.position.y + collider.maxY;
        if (maxY < shipMinY || minY > shipMaxY) continue;
        const center = seaRockColliderWorldCenter(rock, collider);
        const dx = sample.x - center.x;
        const dz = sample.z - center.z;
        const d = Math.hypot(dx, dz);
        const penetration = collider.radius + sample.radius - d;
        if (penetration > 0 && (!deepest || penetration > deepest.penetration)) {
          const inv = d > 0.001 ? 1 / d : 0;
          deepest = {
            nx: d > 0.001 ? dx * inv : 1,
            nz: d > 0.001 ? dz * inv : 0,
            penetration,
            sampleX: sample.x,
            sampleZ: sample.z,
            section: sample.section,
          };
        }
      }
    }

    if (!deepest) return;
    ship.position.x += deepest.nx * deepest.penetration;
    ship.position.z += deepest.nz * deepest.penetration;

    const relVel = ship.velocity.x * deepest.nx + ship.velocity.z * deepest.nz;
    if (relVel < 0) {
      const impactSpeed = -relVel;
      ship.velocity.x -= relVel * deepest.nx * 1.45;
      ship.velocity.z -= relVel * deepest.nz * 1.45;
      // τ about +Y is rz·Fx − rx·Fz — glancing hits pivot the bow away from the rock.
      ship.angularVelocity += (deepest.sampleZ - ship.position.z) * deepest.nx * 0.012
        - (deepest.sampleX - ship.position.x) * deepest.nz * 0.012;

      if (impactSpeed > 2.2) {
        // Striking a sea rock tears the hull open AT THE SAMPLE that struck it —
        // a fast strike punches two. Rock bites sit at the waterline band.
        const local = this.toShipLocal({ x: deepest.sampleX, y: 0, z: deepest.sampleZ }, ship);
        this.openHoleAt(
          ship,
          { x: local.x, y: (FLOODING.HOLE_BAND_Y.min + FLOODING.HOLE_BAND_Y.max) * 0.5, z: local.z },
          impactSpeed > 5 ? 2 : 1,
          'rock',
        );
        this.combatEvents.push({
          type: 'ship_impact', kind: 'rock', position: { x: deepest.sampleX, y: 0, z: deepest.sampleZ }, speed: impactSpeed,
        });
      }
    }
  }

  private resolvePlayerSeaRockCollision(player: Player, seaRocks: SeaRock[], ballistic: boolean) {
    if (player.onShipId || player.state === 'eliminated' || player.state === 'respawning') return false;
    let best: {
      nx: number;
      nz: number;
      penetration: number;
      topY: number;
      topLanding: boolean;
    } | null = null;

    const playerMinY = player.position.y - (player.state === 'swimming' ? 0.45 : 0.04);
    const playerMaxY = player.position.y + (player.state === 'swimming' ? PLAYER.HEIGHT * 0.55 : PLAYER.HEIGHT * 0.92);
    for (const rock of seaRocks) {
      if (Math.hypot(player.position.x - rock.position.x, player.position.z - rock.position.z) > getSeaRockBoundsRadius(rock) + PLAYER.RADIUS + 0.65) continue;
      for (const collider of getSeaRockColliders(rock)) {
        const center = seaRockColliderWorldCenter(rock, collider);
        const minY = rock.position.y + collider.minY;
        const maxY = rock.position.y + collider.maxY;
        const radius = collider.radius + PLAYER.RADIUS;
        const dx = player.position.x - center.x;
        const dz = player.position.z - center.z;
        const d = Math.hypot(dx, dz);
        if (d >= radius) continue;

        const topLanding =
          player.velocity.y <= 0
          && player.position.y >= maxY - (ballistic ? 0.75 : 0.34)
          && player.position.y <= maxY + (ballistic ? 0.55 : 0.2);
        const overlapsVertical = playerMaxY >= minY && playerMinY <= maxY;
        if (!topLanding && !overlapsVertical) continue;

        const penetration = radius - d;
        if (!best || penetration > best.penetration || (topLanding && !best.topLanding)) {
          const inv = d > 0.001 ? 1 / d : 0;
          best = {
            nx: d > 0.001 ? dx * inv : 1,
            nz: d > 0.001 ? dz * inv : 0,
            penetration,
            topY: maxY,
            topLanding,
          };
        }
      }
    }

    if (!best) return false;
    if (best.topLanding) {
      player.position.y = best.topY;
      if (player.velocity.y < 0) player.velocity.y = 0;
      player.swimTimer = 0;
      if (player.state !== 'downed') player.state = 'alive';
      return true;
    }

    player.position.x += best.nx * (best.penetration + 0.015);
    player.position.z += best.nz * (best.penetration + 0.015);
    const relVel = player.velocity.x * best.nx + player.velocity.z * best.nz;
    if (relVel < 0) {
      player.velocity.x -= relVel * best.nx * 1.08;
      player.velocity.z -= relVel * best.nz * 1.08;
    }
    const knockVel = player.knockbackVelocity.x * best.nx + player.knockbackVelocity.z * best.nz;
    if (knockVel < 0) {
      player.knockbackVelocity.x -= knockVel * best.nx;
      player.knockbackVelocity.z -= knockVel * best.nz;
    }
    return true;
  }

  private isProjectileInsideSeaRock(projectile: Projectile, seaRocks: SeaRock[]) {
    const padding = projectile.type === 'cannonball' || projectile.type === 'firebomb' || projectile.type === 'chainshot' ? 0.28 : 0.05;
    for (const rock of seaRocks) {
      if (Math.hypot(projectile.position.x - rock.position.x, projectile.position.z - rock.position.z) > getSeaRockBoundsRadius(rock) + padding) continue;
      for (const collider of getSeaRockColliders(rock)) {
        const minY = rock.position.y + collider.minY - padding;
        const maxY = rock.position.y + collider.maxY + padding;
        if (projectile.position.y < minY || projectile.position.y > maxY) continue;
        const center = seaRockColliderWorldCenter(rock, collider);
        if (Math.hypot(projectile.position.x - center.x, projectile.position.z - center.z) <= collider.radius + padding) {
          return true;
        }
      }
    }
    return false;
  }

  private didProjectileHitSeaRock(previousPosition: Vec3, projectile: Projectile, seaRocks: SeaRock[]) {
    const dx = projectile.position.x - previousPosition.x;
    const dy = projectile.position.y - previousPosition.y;
    const dz = projectile.position.z - previousPosition.z;
    const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (range < 0.0001) return this.isProjectileInsideSeaRock(projectile, seaRocks);

    const direction = { x: dx / range, y: dy / range, z: dz / range };
    const padding = projectile.type === 'cannonball' || projectile.type === 'firebomb' || projectile.type === 'chainshot' ? 0.28 : 0.05;
    for (const rock of seaRocks) {
      const distance = intersectRaySeaRock(previousPosition, direction, range, rock, padding);
      if (distance !== null) return true;
    }
    return false;
  }

  /**
   * Beam-accurate capsule chain along the keel line: centerline samples whose
   * radii follow the hull half-width, so ship-ship contact and keel-depth
   * grounding both track the real hull silhouette (max radius ≈ half beam —
   * parallel galleons truly touch at ~sum of half beams, not before).
   */
  private getShipHullContactSamples(ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const sin = Math.sin(ship.rotation);
    const cos = Math.cos(ship.rotation);
    return HULL_CONTACT_STATIONS.map((station) => {
      const localZ = station.z * stats.length;
      return {
        x: ship.position.x + localZ * sin,
        z: ship.position.z + localZ * cos,
        radius: stats.width * station.half,
        localZ,
      };
    });
  }

  private getShipCollisionSamples(ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const locals = [
      { x: 0, z: stats.length * 0.52, radius: stats.width * 0.3, section: 'bow' as const },
      { x: stats.width * 0.43, z: stats.length * 0.24, radius: stats.width * 0.18, section: 'starboard' as const },
      { x: -stats.width * 0.43, z: stats.length * 0.24, radius: stats.width * 0.18, section: 'port' as const },
      { x: 0, z: stats.length * 0.14, radius: stats.width * 0.36, section: 'bow' as const },
      { x: stats.width * 0.48, z: 0, radius: stats.width * 0.2, section: 'starboard' as const },
      { x: -stats.width * 0.48, z: 0, radius: stats.width * 0.2, section: 'port' as const },
      { x: stats.width * 0.4, z: -stats.length * 0.24, radius: stats.width * 0.18, section: 'starboard' as const },
      { x: -stats.width * 0.4, z: -stats.length * 0.24, radius: stats.width * 0.18, section: 'port' as const },
      { x: 0, z: -stats.length * 0.45, radius: stats.width * 0.3, section: 'stern' as const },
    ];
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return locals.map((sample) => ({
      x: ship.position.x + sample.x * cos + sample.z * sin,
      z: ship.position.z + sample.z * cos - sample.x * sin,
      radius: sample.radius,
      section: sample.section,
    }));
  }

  private isProjectileInsideShipHull(projectile: Projectile, ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const local = this.toShipLocal(projectile.position, ship);
    return Math.abs(projectile.position.y - ship.position.y) < stats.height + 1.1
      && this.isInsideShipDeckFootprint(local, stats, 0.38);
  }

  /** Chainshot is a rigging weapon: it also connects through the mast/sail
   *  band ABOVE the hull — a narrower footprint reaching to the mast tops —
   *  so a shot aimed through the canvas actually tears it instead of passing
   *  clean over the hull band. Matches the client mast layout (mast height =
   *  H × 3.6 single-mast / 3.1 multi-mast, see getCrowNestStandingY). */
  private isChainshotInRiggingBand(projectile: Projectile, ship: Ship): boolean {
    if (projectile.type !== 'chainshot') return false;
    const stats = SHIP_STATS[ship.type];
    const mastHeight = stats.height * (stats.mastCount === 1 ? 3.6 : 3.1);
    const dy = projectile.position.y - ship.position.y;
    if (dy < 0 || dy > stats.height + mastHeight + 0.8) return false;
    const local = this.toShipLocal(projectile.position, ship);
    return Math.abs(local.x) <= stats.width * 0.75 && Math.abs(local.z) <= stats.length * 0.42;
  }

  private getShipFloorY(position: Vec3, ship: Ship, providedLocal?: { x: number; z: number }) {
    const stats = SHIP_STATS[ship.type];
    const deckY = ship.position.y + stats.height + 0.1;
    const holdFloor = ship.position.y + 0.35;
    const local = providedLocal ?? this.toShipLocal(position, ship);
    const stair = this.getShipStairConfig(stats);
    if (
      Math.abs(local.x - stair.x) <= stair.halfWidth
      && local.z <= stair.frontZ
      && local.z >= stair.backZ
    ) {
      // The whole stairwell footprint is open air — the floor there is always the
      // stair ramp, never a deck-level lid. Walking onto the hole from ANY side
      // drops you onto the steps; the coaming colliders around the sides/back are
      // what stop accidental entry, not a phantom floor.
      const descent = clamp((stair.frontZ - local.z) / Math.max(0.001, stair.frontZ - stair.backZ), 0, 1);
      return deckY + (holdFloor - deckY) * descent;
    }
    if (this.isInsideShipHoldFootprint(local, stats, 0.08) && position.y < deckY - 0.25) {
      return holdFloor;
    }
    // Stern quarterdeck dais — a genuinely raised helm platform (ramps up over its
    // front step). 0 everywhere off the dais, so the rest of the deck is unchanged.
    return deckY + getShipDeckRaiseAt(local, stats);
  }

  private getShipStairConfig(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    const companionway = getShipCompanionwayConfig(stats);
    return {
      x: companionway.cx,
      halfWidth: companionway.stairHalfWidth,
      frontZ: companionway.stairFrontZ,
      backZ: companionway.stairBackZ,
    };
  }

  private isInsideShipDeckFootprint(local: { x: number; z: number }, stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS], margin = 0) {
    if (Math.abs(local.z) > stats.length * 0.48 + margin) return false;
    const halfWidth = this.getDeckHalfWidth(stats, local.z, margin);
    return Math.abs(local.x) <= halfWidth;
  }

  private isInsideShipHoldFootprint(local: { x: number; z: number }, stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS], margin = 0) {
    if (Math.abs(local.z) > stats.length * 0.34 + margin) return false;
    const halfWidth = this.getHoldHalfWidth(stats, local.z, margin);
    return Math.abs(local.x) <= halfWidth;
  }

  private clampDeckPosition(local: { x: number; z: number }, stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    const z = clamp(local.z, -stats.length * 0.46, stats.length * 0.46);
    const halfWidth = this.getDeckHalfWidth(stats, z);
    return {
      x: clamp(local.x, -halfWidth, halfWidth),
      z,
    };
  }

  private resolveShipDeckObstacleCollision(
    local: { x: number; z: number },
    stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS],
  ): { x: number; z: number; pushed: boolean } {
    let x = local.x;
    let z = local.z;
    let pushed = false;

    const pushCircle = (cx: number, cz: number, radius: number) => {
      const dx = x - cx;
      const dz = z - cz;
      const d = Math.hypot(dx, dz);
      if (d >= radius) return;
      const inv = d > 0.001 ? 1 / d : 0;
      const nx = d > 0.001 ? dx * inv : 1;
      const nz = d > 0.001 ? dz * inv : 0;
      x = cx + nx * radius;
      z = cz + nz * radius;
      pushed = true;
    };

    const mastCount = stats.mastCount;
    const mastSpacing = stats.length * 0.55 / Math.max(mastCount - 1, 1);
    const mastStartZ = getMainMastLocalZ(stats);
    const mastRadius = 0.075 + (stats.width >= 9 ? 0.045 : stats.width >= 6 ? 0.025 : 0);
    for (let m = 0; m < mastCount; m++) {
      pushCircle(0, mastStartZ - m * mastSpacing, PLAYER.RADIUS + mastRadius * 1.85);
    }

    // Helm furniture — the wheel post and the compass binnacle are solid, so you
    // can't stand inside the wheel or clip through the binnacle.
    pushCircle(0, -stats.length * 0.315, PLAYER.RADIUS + 0.16);          // wheel post
    pushCircle(stats.width * 0.19, -stats.length * 0.205, PLAYER.RADIUS + 0.24); // binnacle

    // Companionway coamings — a thin wall on port, starboard and the AFT edge of
    // the stairwell so the only way down is the forward stair lip. Without these a
    // sideways step drops through the deck beside the hatch.
    const cw = getShipCompanionwayConfig(stats);
    const pushAABB = (minX: number, maxX: number, minZ: number, maxZ: number) => {
      const ex0 = minX - PLAYER.RADIUS, ex1 = maxX + PLAYER.RADIUS;
      const ez0 = minZ - PLAYER.RADIUS, ez1 = maxZ + PLAYER.RADIUS;
      if (x <= ex0 || x >= ex1 || z <= ez0 || z >= ez1) return;
      // Push out along the least-penetration axis.
      const dl = x - ex0, dr = ex1 - x, db = z - ez0, dt = ez1 - z;
      const m = Math.min(dl, dr, db, dt);
      if (m === dl) x = ex0; else if (m === dr) x = ex1;
      else if (m === db) z = ez0; else z = ez1;
      pushed = true;
    };
    const hMinX = cw.cx - cw.stairHalfWidth, hMaxX = cw.cx + cw.stairHalfWidth;
    const coamT = 0.05;
    pushAABB(hMinX - coamT, hMinX + coamT, cw.stairBackZ, cw.stairFrontZ); // port coaming
    pushAABB(hMaxX - coamT, hMaxX + coamT, cw.stairBackZ, cw.stairFrontZ); // starboard coaming
    pushAABB(hMinX, hMaxX, cw.stairBackZ - coamT, cw.stairBackZ + coamT);  // aft coaming (front open)

    return { x, z, pushed };
  }

  private clampHoldPosition(local: { x: number; z: number }, stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    const z = clamp(local.z, -stats.length * 0.32, stats.length * 0.32);
    const halfWidth = this.getHoldHalfWidth(stats, z);
    return {
      x: clamp(local.x, -halfWidth, halfWidth),
      z,
    };
  }

  private getHoldHalfWidth(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS], localZ: number, margin = 0) {
    const normalized = clamp(Math.abs(localZ) / Math.max(0.001, stats.length * 0.34), 0, 1);
    const endTaper = normalized > 0.58 ? (normalized - 0.58) / 0.42 : 0;
    return stats.width * (0.38 - endTaper * 0.11) + margin;
  }

  private getDeckHalfWidth(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS], localZ: number, margin = 0) {
    // Walkable half-width tracks the BULWARK INNER FACE (~0.42·W), not the loft
    // deck-edge/sheer (~0.56·W) — clamping to the sheer let pirates stand out on
    // the covering board and clip through the rail. The taper itself lives in
    // shared getShipDeckWalkHalfWidth so station placement uses the same line.
    return Math.max(PLAYER.RADIUS + 0.08, getShipDeckWalkHalfWidth(stats, localZ, margin));
  }

}
