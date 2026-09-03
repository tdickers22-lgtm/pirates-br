import type { StormState, Ship, Player, Island } from '../../shared/types/index.js';
import { STORM_PHASES, STORM_DOCK_COVER_MARGIN, WORLD, FLOODING } from '../../shared/constants/index.js';
import { dist2D, lerp, getIslandSurfaceY } from '../../shared/utils/index.js';
import { SHIP_STATS } from '../../shared/constants/index.js';

interface StormDamageHooks {
  /** Route storm damage through PhysicsSystem.openHoleAt so the tempest stoves
   *  REAL breaches into the seaward planking — at a point on that face, not an
   *  abstract section counter — which then flood. Required: the storm has no
   *  business inventing its own damage model. */
  openHoleAt: (ship: Ship, local: { x: number; y: number; z: number }, count: number) => void;
  /** True while the WORLD may not stove this hull in — she's tied up in her own
   *  berth during the opening storm phases. PhysicsSystem owns the answer so
   *  every environmental source (seabed, reef, tempest) agrees on shelter. */
  isSheltered?: (shipId: string) => boolean;
  /** True while a pirate is inside his post-respawn storm reprieve. Match owns
   *  the clock (see grantStormRespawnGrace) — the tempest just asks. Without it
   *  a respawn the ring had already crossed died again in six seconds, forever. */
  hasStormGrace?: (playerId: string) => boolean;
}

/** Accumulated storm damage (per outside-ring second, phase-scaled) that stoves
 *  a fresh hole into the seaward hull section. */
const STORM_HOLE_DAMAGE = 30;

/** Fraction of the final circle that may sit on dry land before a candidate
 *  centre is rejected (rings this small are the endgame arena). */
const RING_LAND_REJECT_FRACTION = 0.4;
/** Rings at or below this radius get the land check — earlier rings are large
 *  enough that an island inside them is a feature, not a dead arena. */
const RING_LAND_CHECK_RADIUS = 200;
/** Rejection-sampling budget per pick (deterministic bound; last candidate wins). */
const RING_CENTER_TRIES = 12;

export class StormSystem {
  /** Match-seeded stream (RNG-01): ring centres draw from it, so a seeded
   *  match replays. Unseeded it is Math.random (no behaviour change). */
  constructor(private readonly rng: () => number = Math.random) {}
  /** Per-ship storm-damage accumulation toward the next punched hole. */
  private shipStormAccum = new Map<string, number>();
  /** Deterministic LCG for where along the seaward face a sea breaks through. */
  private stormHolePhase = 0x51f3c7;
  /** Islands, for keeping the late rings off dry land (Old Maw Caldera sits at
   *  the world origin, which is exactly where the ring converges). */
  private islands: Island[] = [];
  /** Radius the first ring settles at — STORM_PHASES[0].endRadius, widened if
   *  this world put a spawn dock further out than the table assumed. */
  private firstRingRadius = STORM_PHASES[0].endRadius;

  /** Match hands the world in once at setup — purely read-only sampling. */
  setIslands(islands: Island[]): void {
    this.islands = islands;
    this.firstRingRadius = this.computeFirstRingRadius();
  }

  /**
   * THE FIRST RING IS SIZED OFF THE DOCKS, NOT OFF A GUESS.
   *
   * Every crew starts at a berth: hull alongside the pier, pirate standing on
   * the planking. If the opening circle closes inside that berth line, a player
   * who is still learning the stations is taking storm damage where the game
   * put him — the exact death the phase-1 comment ("explore, loot, get your
   * bearings") promises he will not have. So the ring takes the furthest dock
   * in the world — measured to BOTH the berth and the pier respawn point — adds
   * STORM_DOCK_COVER_MARGIN, and never settles inside that.
   *
   * The table value wins whenever it is already generous enough, and the answer
   * can never exceed the opening radius (a ring that "shrinks" outward would be
   * a bug the HUD would happily draw).
   */
  private computeFirstRingRadius(): number {
    const phase = STORM_PHASES[0];
    let furthest = 0;
    for (const island of this.islands) {
      const dock = island.dock;
      if (!dock) continue;
      furthest = Math.max(
        furthest,
        Math.hypot(dock.berthPosition.x, dock.berthPosition.z),
        Math.hypot(dock.respawnPoint.x, dock.respawnPoint.z),
      );
    }
    if (furthest <= 0) return phase.endRadius;
    return Math.min(
      phase.startRadius,
      Math.max(phase.endRadius, furthest + STORM_DOCK_COVER_MARGIN),
    );
  }

  /** The radius the opening circle settles at in THIS world (test + Match read
   *  it to assert the docks are covered). */
  getFirstRingRadius(): number {
    return this.firstRingRadius;
  }

  buildInitialState(): StormState {
    const phase = STORM_PHASES[0];
    // The first circle closes ON THE WORLD, not on a corner of it: drifting the
    // opening ring off-origin is what put outer berths outside a circle that is
    // otherwise wide enough for all of them. Every LATER ring still drifts —
    // that is the whole tension of the arc — but the one that closes while
    // crews are still at their moorings stays honest and centred.
    return {
      phase: 0,
      centerX: 0,
      centerZ: 0,
      nextCenterX: 0,
      nextCenterZ: 0,
      shrinkStartCenterX: 0,
      shrinkStartCenterZ: 0,
      shrinkStartRadius: phase.startRadius,
      safeRadius: phase.startRadius,
      nextRadius: this.firstRingRadius,
      shrinking: false,
      shrinkTimer: phase.waitSec,
      shrinkDuration: phase.shrinkSec,
      shrinkProgress: 0,
      damagePerSec: phase.dmgPerSec,
    };
  }

  update(dt: number, storm: StormState, ships: Ship[], players: Player[], hooks: StormDamageHooks, t = 0): void {
    if (storm.shrinking) {
      storm.shrinkProgress += dt / storm.shrinkDuration;
      if (storm.shrinkProgress >= 1) {
        storm.shrinkProgress = 1;
        storm.centerX = storm.nextCenterX;
        storm.centerZ = storm.nextCenterZ;
        storm.safeRadius = storm.nextRadius;
        storm.shrinking = false;

        // Advance phase
        storm.phase++;
        if (storm.phase < STORM_PHASES.length) {
          const next = STORM_PHASES[storm.phase];
          const nextCenter = this.pickNextSafeCenter(storm.centerX, storm.centerZ, storm.safeRadius, next.endRadius);
          storm.nextCenterX = nextCenter.x;
          storm.nextCenterZ = nextCenter.z;
          storm.nextRadius = next.endRadius;
          storm.shrinkTimer = next.waitSec;
          storm.shrinkDuration = next.shrinkSec;
          storm.shrinkProgress = 0;
          storm.shrinkStartCenterX = storm.centerX;
          storm.shrinkStartCenterZ = storm.centerZ;
          storm.shrinkStartRadius = storm.safeRadius;
          storm.damagePerSec = next.dmgPerSec;
        } else {
          storm.nextCenterX = storm.centerX;
          storm.nextCenterZ = storm.centerZ;
          storm.shrinkStartCenterX = storm.centerX;
          storm.shrinkStartCenterZ = storm.centerZ;
          storm.shrinkStartRadius = storm.safeRadius;
          storm.shrinkTimer = 0;
        }
      } else {
        storm.centerX = lerp(storm.shrinkStartCenterX, storm.nextCenterX, storm.shrinkProgress);
        storm.centerZ = lerp(storm.shrinkStartCenterZ, storm.nextCenterZ, storm.shrinkProgress);
        storm.safeRadius = lerp(storm.shrinkStartRadius, storm.nextRadius, storm.shrinkProgress);
      }
    } else if (storm.phase >= STORM_PHASES.length) {
      // Terminal phase — the storm holds at its final circle. Pin the timer at
      // 0 instead of decrementing forever (the HUD reads it directly).
      storm.shrinkTimer = 0;
    } else {
      storm.shrinkTimer -= dt;
      if (storm.shrinkTimer <= 0) {
        storm.shrinking = true;
        storm.shrinkProgress = 0;
        storm.shrinkStartCenterX = storm.centerX;
        storm.shrinkStartCenterZ = storm.centerZ;
        storm.shrinkStartRadius = storm.safeRadius;
      }
    }

    // Apply damage to entities outside safe zone (scaled excess ramps gently)
    const dmg = storm.damagePerSec * dt;

    for (const ship of ships) {
      if (!ship.alive || ship.sinking) {
        this.shipStormAccum.delete(ship.id);
        continue;
      }
      const d = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
      if (d <= storm.safeRadius) {
        this.shipStormAccum.delete(ship.id);
        continue;
      }
      // A hull moored in her berth during the opening phases is under shelter:
      // the ring starts at 950 m in a 1000 m world, so half the outer docks sat
      // OUTSIDE the very first circle and quietly took a breach a minute while
      // nobody was even aboard. The storm collects on her once phase 2 lands.
      if (hooks.isSheltered?.(ship.id)) {
        this.shipStormAccum.delete(ship.id);
        continue;
      }
      const excess = (d - storm.safeRadius) / Math.max(1, storm.safeRadius);
      const scaled = dmg * (1 + excess * 0.75);
      // The storm batters the seaward face: the section facing away from the
      // safe zone accumulates damage until it stoves in a hole (which then
      // floods — the storm kills ships the SoT way, a real repair/bail fight).
      // The cadence scales with the storm phase's damagePerSec, so the late
      // storm punches holes fast while the early one only nags a lingering ship.
      const inv = 1 / Math.max(0.001, d);
      const dxN = (ship.position.x - storm.centerX) * inv;
      const dzN = (ship.position.z - storm.centerZ) * inv;
      const cosR = Math.cos(ship.rotation);
      const sinR = Math.sin(ship.rotation);
      const lx = dxN * cosR - dzN * sinR;
      const lz = dxN * sinR + dzN * cosR;
      const accum = (this.shipStormAccum.get(ship.id) ?? 0) + scaled;
      if (accum >= STORM_HOLE_DAMAGE) {
        const holes = Math.floor(accum / STORM_HOLE_DAMAGE);
        this.shipStormAccum.set(ship.id, accum - holes * STORM_HOLE_DAMAGE);
        // A breaking sea stoves a plank on the face turned AWAY from shelter,
        // somewhere along that face inside the waterline band.
        const stats = SHIP_STATS[ship.type];
        const beam = Math.abs(lx) > Math.abs(lz);
        const spread = (this.stormHolePhase = (this.stormHolePhase * 1103515245 + 12345) & 0x7fffffff)
          / 0x7fffffff - 0.5;
        const bandY = FLOODING.HOLE_BAND_Y.min
          + (FLOODING.HOLE_BAND_Y.max - FLOODING.HOLE_BAND_Y.min) * ((spread + 0.5) * 0.999);
        hooks.openHoleAt(ship, beam
          ? { x: Math.sign(lx || 1) * stats.width * 0.5, y: bandY, z: spread * stats.length * 0.6 }
          : { x: spread * stats.width * 0.6, y: bandY, z: Math.sign(lz || 1) * stats.length * 0.42 },
          holes);
      } else {
        this.shipStormAccum.set(ship.id, accum);
      }
    }

    for (const player of players) {
      // Downed players outside the ring already bleed out twice as fast — the
      // storm DoT skips them so bleed-out (with its kill credit) resolves them.
      if (
        player.state === 'eliminated'
        || player.state === 'respawning'
        || player.state === 'downed'
        || player.respawnProtectionTimer > 0
        || hooks.hasStormGrace?.(player.id)
      ) continue;
      const d = dist2D(player.position.x, player.position.z, storm.centerX, storm.centerZ);
      if (d > storm.safeRadius) {
        const excess = (d - storm.safeRadius) / Math.max(1, storm.safeRadius);
        // THE WEATHER DOES NOT ERASE THE CAPTAIN WHO CHIPPED YOU (CREDIT-01,
        // storm-19). Nulling lastDamagedById here meant chip-then-ring paid
        // nobody: the pirate you shot to 10 hp walked into the wall and the feed
        // credited the storm. The tag is FILED, not wiped — handlePlayerDeath
        // pays the attacker inside MATCH_END.ASSIST_CREDIT_WINDOW and the death
        // CAUSE still reads honestly off lastDamageSourceById.
        player.lastEnvDamage = { cause: 'storm', at: t };
        player.health -= dmg * (1 + excess * 0.75);
      }
    }
  }

  isOutside(x: number, z: number, storm: StormState): boolean {
    return dist2D(x, z, storm.centerX, storm.centerZ) > storm.safeRadius;
  }

  private pickNextSafeCenter(centerX: number, centerZ: number, currentRadius: number, nextRadius: number) {
    const allowedDrift = Math.max(0, currentRadius - nextRadius - 8);
    const worldBound = Math.max(0, WORLD.HALF - nextRadius - 36);
    const roll = () => {
      const drift = allowedDrift * (0.22 + this.rng() * 0.68);
      const angle = this.rng() * Math.PI * 2;
      return {
        x: Math.max(-worldBound, Math.min(worldBound, centerX + Math.cos(angle) * drift)),
        z: Math.max(-worldBound, Math.min(worldBound, centerZ + Math.sin(angle) * drift)),
      };
    };
    // Small end circles must be sailable water, not a volcano. Re-roll (bounded)
    // and keep the driest candidate; every draw comes from the storm's own
    // match rng stream (RNG-01), so island generation (its own seeded rng) is untouched.
    if (nextRadius > RING_LAND_CHECK_RADIUS || this.islands.length === 0) return roll();
    let best: { x: number; z: number; land: number } | null = null;
    for (let i = 0; i < RING_CENTER_TRIES; i++) {
      const candidate = roll();
      const land = this.ringLandFraction(candidate.x, candidate.z, nextRadius);
      if (land <= RING_LAND_REJECT_FRACTION) return candidate;
      if (!best || land < best.land) best = { ...candidate, land };
    }
    return { x: best!.x, z: best!.z };
  }

  /** Fraction of a ring's area that is dry land, sampled on a coarse polar grid. */
  private ringLandFraction(cx: number, cz: number, radius: number): number {
    let dry = 0;
    let total = 0;
    for (const fraction of [0, 0.45, 0.8]) {
      const steps = fraction === 0 ? 1 : 8;
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const x = cx + Math.cos(angle) * radius * fraction;
        const z = cz + Math.sin(angle) * radius * fraction;
        total++;
        for (const island of this.islands) {
          if (getIslandSurfaceY(island, x, z) > 0.2) { dry++; break; }
        }
      }
    }
    return total === 0 ? 0 : dry / total;
  }
}
