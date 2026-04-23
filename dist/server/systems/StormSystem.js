import { STORM_PHASES } from '../../shared/constants/index.js';
import { dist2D, lerp } from '../../shared/utils/index.js';
export class StormSystem {
    buildInitialState() {
        const phase = STORM_PHASES[0];
        return {
            phase: 0,
            centerX: 0,
            centerZ: 0,
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
                storm.safeRadius = storm.nextRadius;
                storm.shrinking = false;
                // Advance phase
                storm.phase++;
                if (storm.phase < STORM_PHASES.length) {
                    const next = STORM_PHASES[storm.phase];
                    storm.nextRadius = next.endRadius;
                    storm.shrinkTimer = next.waitSec;
                    storm.shrinkDuration = next.shrinkSec;
                    storm.shrinkProgress = 0;
                    storm.damagePerSec = next.dmgPerSec;
                }
            }
            else {
                storm.safeRadius = lerp(STORM_PHASES[storm.phase]?.startRadius ?? STORM_PHASES[0].startRadius, storm.nextRadius, storm.shrinkProgress);
            }
        }
        else {
            storm.shrinkTimer -= dt;
            if (storm.shrinkTimer <= 0 && storm.phase < STORM_PHASES.length) {
                storm.shrinking = true;
                storm.shrinkProgress = 0;
                // Fortnite-style: new safe-zone center is a random point within the current
                // safe zone — this creates the dramatic "circle moved away from you" moments.
                const driftFraction = 0.25 + Math.random() * 0.45; // 25–70% of current radius
                const driftAngle = Math.random() * Math.PI * 2;
                storm.centerX += Math.cos(driftAngle) * storm.safeRadius * driftFraction;
                storm.centerZ += Math.sin(driftAngle) * storm.safeRadius * driftFraction;
                // Keep within world bounds
                const worldBound = 750;
                storm.centerX = Math.max(-worldBound, Math.min(worldBound, storm.centerX));
                storm.centerZ = Math.max(-worldBound, Math.min(worldBound, storm.centerZ));
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
}
