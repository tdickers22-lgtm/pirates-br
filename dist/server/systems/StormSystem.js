import { STORM_PHASES, WORLD } from '../../shared/constants/index.js';
import { dist2D, lerp } from '../../shared/utils/index.js';
export class StormSystem {
    buildInitialState() {
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
    update(dt, storm, ships, players) {
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
                }
                else {
                    storm.nextCenterX = storm.centerX;
                    storm.nextCenterZ = storm.centerZ;
                    storm.shrinkStartCenterX = storm.centerX;
                    storm.shrinkStartCenterZ = storm.centerZ;
                    storm.shrinkStartRadius = storm.safeRadius;
                }
            }
            else {
                storm.centerX = lerp(storm.shrinkStartCenterX, storm.nextCenterX, storm.shrinkProgress);
                storm.centerZ = lerp(storm.shrinkStartCenterZ, storm.nextCenterZ, storm.shrinkProgress);
                storm.safeRadius = lerp(storm.shrinkStartRadius, storm.nextRadius, storm.shrinkProgress);
            }
        }
        else {
            storm.shrinkTimer -= dt;
            if (storm.shrinkTimer <= 0 && storm.phase < STORM_PHASES.length) {
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
            if (!ship.alive)
                continue;
            const d = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
            if (d > storm.safeRadius) {
                const excess = (d - storm.safeRadius) / Math.max(1, storm.safeRadius);
                const scaled = dmg * (1 + excess * 0.75);
                const ratio = scaled / ship.maxHull;
                for (const section of ['bow', 'stern', 'port', 'starboard']) {
                    ship.hull[section] = Math.max(0, ship.hull[section] - ratio * 0.25);
                }
            }
        }
        for (const player of players) {
            if (player.state === 'eliminated' || player.state === 'respawning' || player.respawnProtectionTimer > 0)
                continue;
            const d = dist2D(player.position.x, player.position.z, storm.centerX, storm.centerZ);
            if (d > storm.safeRadius) {
                const excess = (d - storm.safeRadius) / Math.max(1, storm.safeRadius);
                player.lastDamageWasHeadshot = false;
                player.health -= dmg * (1 + excess * 0.75);
            }
        }
    }
    isOutside(x, z, storm) {
        return dist2D(x, z, storm.centerX, storm.centerZ) > storm.safeRadius;
    }
    pickNextSafeCenter(centerX, centerZ, currentRadius, nextRadius) {
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
