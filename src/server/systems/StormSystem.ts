import type { StormState, Ship, Player, HullSections } from '../../shared/types/index.js';
import { STORM_PHASES, WORLD, FLOODING } from '../../shared/constants/index.js';
import { dist2D, lerp } from '../../shared/utils/index.js';

export interface StormDamageHooks {
  /** Route storm damage through PhysicsSystem.openHole so the tempest punches
   *  real holes into the seaward face that then flood — the SoT damage loop —
   *  instead of an abstract HP drain. */
  openHole?: (ship: Ship, section: keyof HullSections, count: number) => void;
}

/** Accumulated storm damage (per outside-ring second, phase-scaled) that stoves
 *  a fresh hole into the seaward hull section. */
const STORM_HOLE_DAMAGE = 30;

export class StormSystem {
  /** Per-ship storm-damage accumulation toward the next punched hole. */
  private shipStormAccum = new Map<string, number>();

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

  update(dt: number, storm: StormState, ships: Ship[], players: Player[], hooks?: StormDamageHooks): void {
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

    const open = hooks?.openHole
      ?? ((target: Ship, section: keyof HullSections, count: number) => {
        target.holes[section] = Math.min(FLOODING.MAX_HOLES_PER_SECTION, target.holes[section] + count);
      });
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
      const seaward: keyof HullSections = Math.abs(lz) >= Math.abs(lx)
        ? (lz >= 0 ? 'bow' : 'stern')
        : (lx >= 0 ? 'starboard' : 'port');
      const accum = (this.shipStormAccum.get(ship.id) ?? 0) + scaled;
      if (accum >= STORM_HOLE_DAMAGE) {
        const holes = Math.floor(accum / STORM_HOLE_DAMAGE);
        this.shipStormAccum.set(ship.id, accum - holes * STORM_HOLE_DAMAGE);
        open(ship, seaward, holes);
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
    const drift = allowedDrift * (0.22 + Math.random() * 0.68);
    const angle = Math.random() * Math.PI * 2;
    const worldBound = Math.max(0, WORLD.HALF - nextRadius - 36);
    return {
      x: Math.max(-worldBound, Math.min(worldBound, centerX + Math.cos(angle) * drift)),
      z: Math.max(-worldBound, Math.min(worldBound, centerZ + Math.sin(angle) * drift)),
    };
  }
}
