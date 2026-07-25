import type { StormState, Ship, Player, Island } from '../../shared/types/index.js';
import { STORM_PHASES, WORLD, FLOODING } from '../../shared/constants/index.js';
import { dist2D, lerp, getIslandSurfaceY } from '../../shared/utils/index.js';
import { SHIP_STATS } from '../../shared/constants/index.js';

interface StormDamageHooks {
  /** Route storm damage through PhysicsSystem.openHoleAt so the tempest stoves
   *  REAL breaches into the seaward planking — at a point on that face, not an
   *  abstract section counter — which then flood. Required: the storm has no
   *  business inventing its own damage model. */
  openHoleAt: (ship: Ship, local: { x: number; y: number; z: number }, count: number) => void;
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
  /** Per-ship storm-damage accumulation toward the next punched hole. */
  private shipStormAccum = new Map<string, number>();
  /** Deterministic LCG for where along the seaward face a sea breaks through. */
  private stormHolePhase = 0x51f3c7;
  /** Islands, for keeping the late rings off dry land (Old Maw Caldera sits at
   *  the world origin, which is exactly where the ring converges). */
  private islands: Island[] = [];

  /** Match hands the world in once at setup — purely read-only sampling. */
  setIslands(islands: Island[]): void {
    this.islands = islands;
  }

  buildInitialState(): StormState {
    const phase = STORM_PHASES[0];
    const nextCenter = this.pickNextSafeCenter(0, 0, phase.startRadius, phase.endRadius);
    return {
      phase: 0,
      centerX: 0,
      centerZ: 0,
      nextCenterX: nextCenter.x,
      nextCenterZ: nextCenter.z,
      shrinkStartCenterX: 0,
      shrinkStartCenterZ: 0,
      shrinkStartRadius: phase.startRadius,
      safeRadius: phase.startRadius,
      nextRadius: phase.endRadius,
      shrinking: false,
      shrinkTimer: phase.waitSec,
      shrinkDuration: phase.shrinkSec,
      shrinkProgress: 0,
      damagePerSec: phase.dmgPerSec,
    };
  }

  update(dt: number, storm: StormState, ships: Ship[], players: Player[], hooks: StormDamageHooks): void {
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
      ) continue;
      const d = dist2D(player.position.x, player.position.z, storm.centerX, storm.centerZ);
      if (d > storm.safeRadius) {
        const excess = (d - storm.safeRadius) / Math.max(1, storm.safeRadius);
        player.lastDamagedById = null;
        player.lastDamagedAt = null;
        player.lastDamageWasHeadshot = false;
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
      const drift = allowedDrift * (0.22 + Math.random() * 0.68);
      const angle = Math.random() * Math.PI * 2;
      return {
        x: Math.max(-worldBound, Math.min(worldBound, centerX + Math.cos(angle) * drift)),
        z: Math.max(-worldBound, Math.min(worldBound, centerZ + Math.sin(angle) * drift)),
      };
    };
    // Small end circles must be sailable water, not a volcano. Re-roll (bounded)
    // and keep the driest candidate; every draw comes from the storm's own
    // Math.random stream, so island generation (its own seeded rng) is untouched.
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
