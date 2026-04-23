import { SHIP_STATS, SHIP } from '../../shared/constants/index.js';
import { dist2D, randAngle, angleWrap, sampleWind, getIslandSurfaceY } from '../../shared/utils/index.js';
export class BotSystem {
    constructor() {
        this.bots = new Map();
    }
    registerBot(player, ship, difficulty = 'medium') {
        this.bots.set(player.id, {
            playerId: player.id,
            shipId: ship.id,
            behavior: 'patrol',
            targetShipId: null,
            targetIslandId: null,
            patrolAngle: randAngle(),
            aimYaw: 0,
            aimPitch: 0.1,
            fireTimer: 2 + Math.random() * 3,
            difficulty,
            stateTimer: 5 + Math.random() * 10,
        });
    }
    update(dt, t, players, ships, islands, storm, weaponSystem) {
        for (const [pid, bot] of this.bots) {
            const player = players.find(p => p.id === pid);
            const ship = ships.find(s => s.id === bot.shipId);
            if (!player || !ship || player.state === 'eliminated' || !ship.alive)
                continue;
            bot.stateTimer -= dt;
            // Decide behavior
            this.decideBehavior(bot, ship, ships, islands, storm);
            // Execute behavior
            this.executeBehavior(bot, player, ship, ships, islands, storm, dt, t, weaponSystem);
        }
    }
    decideBehavior(bot, ship, ships, islands, storm) {
        const distToCenter = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
        const distRatio = distToCenter / Math.max(1, storm.safeRadius);
        // Flee preemptively: if the circle is shrinking bail at 65% of radius;
        // when the circle is static give more breathing room (85%).
        // Always flee if actually outside.
        const dangerThreshold = storm.shrinking ? 0.65 : 0.85;
        const inDanger = distRatio > dangerThreshold;
        // Flee storm
        if (inDanger) {
            bot.behavior = 'flee';
            bot.targetShipId = null;
            return;
        }
        // Low hull → flee
        const avgHull = (ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard) / 4;
        if (avgHull < 0.2 && bot.behavior !== 'flee') {
            bot.behavior = 'flee';
            bot.stateTimer = 15;
            return;
        }
        if (bot.stateTimer <= 0) {
            // Re-evaluate behavior
            bot.stateTimer = 8 + Math.random() * 12;
            // Find nearest enemy ship
            let nearest = null;
            let nearestDist = Infinity;
            for (const other of ships) {
                if (other.id === ship.id || !other.alive)
                    continue;
                const d = dist2D(ship.position.x, ship.position.z, other.position.x, other.position.z);
                if (d < nearestDist) {
                    nearestDist = d;
                    nearest = other;
                }
            }
            // Find island for looting
            let nearIsland = null;
            let nearIslandDist = Infinity;
            for (const isl of islands) {
                if (isl.chests.every(c => c.opened || c.carriedByPlayerId || c.storedOnShipId || c.floating))
                    continue;
                const d = dist2D(ship.position.x, ship.position.z, isl.position.x, isl.position.z);
                if (d < nearIslandDist) {
                    nearIslandDist = d;
                    nearIsland = isl;
                }
            }
            if (nearestDist < 400) {
                bot.behavior = 'engage';
                bot.targetShipId = nearest?.id ?? null;
            }
            else if (nearIsland && nearIslandDist < 500 && Math.random() < 0.3) {
                bot.behavior = 'loot';
                bot.targetIslandId = nearIsland.id;
            }
            else {
                bot.behavior = 'patrol';
                bot.patrolAngle = randAngle();
            }
        }
    }
    executeBehavior(bot, player, ship, ships, islands, storm, dt, t, weaponSystem) {
        switch (bot.behavior) {
            case 'patrol':
                this.steerToward(ship, bot.patrolAngle, dt);
                ship.sailHeight = Math.min(ship.sailHeight + dt * 0.08, 0.35);
                ship.anchored = false;
                ship.anchorRaiseProgress = 0;
                this.trimSails(ship, t);
                break;
            case 'engage': {
                const target = ships.find(s => s.id === bot.targetShipId && s.alive);
                if (!target) {
                    bot.behavior = 'patrol';
                    break;
                }
                const dx = target.position.x - ship.position.x;
                const dz = target.position.z - ship.position.z;
                const d = Math.sqrt(dx * dx + dz * dz);
                const angleToTarget = Math.atan2(dx, dz);
                // Orbit at cannon range
                const orbitRange = 80;
                if (d > orbitRange * 1.5) {
                    this.steerToward(ship, angleToTarget, dt);
                    ship.sailHeight = Math.min(ship.sailHeight + dt * 0.12, 0.48);
                }
                else if (d < orbitRange * 0.7) {
                    this.steerToward(ship, angleToTarget + Math.PI, dt);
                    ship.sailHeight = 0.22;
                }
                else {
                    // Broadside — turn to expose cannons
                    this.steerToward(ship, angleToTarget + Math.PI * 0.5, dt);
                    ship.sailHeight = 0.14;
                }
                ship.anchored = false;
                ship.anchorRaiseProgress = 0;
                this.trimSails(ship, t);
                // Aim and fire cannons — hard bots lead the shot
                if (bot.difficulty === 'hard' && d > 10) {
                    const timeToReach = d / SHIP.CANNON_SPEED;
                    const predictedX = target.position.x + target.velocity.x * timeToReach;
                    const predictedZ = target.position.z + target.velocity.z * timeToReach;
                    bot.aimYaw = Math.atan2(predictedX - ship.position.x, predictedZ - ship.position.z);
                }
                else {
                    bot.aimYaw = angleToTarget;
                }
                bot.aimPitch = this.calculateCannonPitch(ship, target);
                bot.fireTimer -= dt;
                const fireDelay = bot.difficulty === 'hard' ? 4.0 : bot.difficulty === 'medium' ? 6.5 : 9.5;
                if (bot.fireTimer <= 0 && d < 220) {
                    bot.fireTimer = fireDelay + Math.random() * 2.5;
                    player.atCannon = true;
                    player.cannonIndex = 0;
                    weaponSystem.tryFire(player, ship, bot.aimYaw, bot.aimPitch, 0);
                    player.atCannon = false;
                }
                break;
            }
            case 'flee': {
                // Race to storm center with full sails
                const angleToCenter = Math.atan2(storm.centerX - ship.position.x, storm.centerZ - ship.position.z);
                this.steerToward(ship, angleToCenter, dt);
                ship.sailHeight = Math.min(ship.sailHeight + dt * 0.5, 1.0); // Max sails, fast raise
                ship.anchored = false;
                ship.anchorRaiseProgress = 0;
                this.trimSails(ship, t);
                // Once comfortably inside and circle not moving, resume normal behaviour
                const distToCenter = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
                if (distToCenter < storm.safeRadius * 0.48 && !storm.shrinking) {
                    bot.behavior = 'patrol';
                    bot.patrolAngle = Math.random() * Math.PI * 2;
                    bot.stateTimer = 5 + Math.random() * 8;
                }
                break;
            }
            case 'loot': {
                const island = islands.find(i => i.id === bot.targetIslandId);
                if (!island || island.chests.every(c => c.opened || c.carriedByPlayerId || c.storedOnShipId || c.floating)) {
                    bot.behavior = 'patrol';
                    break;
                }
                const angleToIsland = Math.atan2(island.position.x - ship.position.x, island.position.z - ship.position.z);
                const d = dist2D(ship.position.x, ship.position.z, island.position.x, island.position.z);
                if (d > island.radius + 40) {
                    this.steerToward(ship, angleToIsland, dt);
                    ship.sailHeight = 0.32;
                    ship.anchored = false;
                    ship.anchorRaiseProgress = 0;
                    this.trimSails(ship, t);
                }
                else {
                    ship.anchored = true;
                    ship.anchorRaiseProgress = 0;
                    ship.sailHeight = 0;
                    ship.sailAngle *= 0.9;
                    const chest = island.chests.find(candidate => !candidate.opened && !candidate.carriedByPlayerId && !candidate.storedOnShipId && !candidate.floating);
                    if (!chest) {
                        bot.behavior = 'return';
                        bot.stateTimer = 8 + Math.random() * 6;
                        ship.anchored = false;
                        ship.anchorRaiseProgress = 0;
                        break;
                    }
                    player.onShipId = null;
                    player.state = 'alive';
                    player.position.x = chest.position.x;
                    const groundY = getIslandSurfaceY(island, chest.position.x, chest.position.z);
                    player.position.y = groundY + 0.18;
                    player.position.z = chest.position.z;
                    if (chest.buried) {
                        chest.digProgress = 1;
                        chest.position.y = groundY + 0.32;
                    }
                    player.nearChestId = chest.id;
                }
                break;
            }
            case 'return': {
                const island = islands.find(candidate => candidate.id === bot.targetIslandId);
                if (!island) {
                    bot.behavior = 'patrol';
                    break;
                }
                const awayAngle = Math.atan2(ship.position.x - island.position.x, ship.position.z - island.position.z);
                const distance = dist2D(ship.position.x, ship.position.z, island.position.x, island.position.z);
                if (distance < island.radius + 115) {
                    this.steerToward(ship, awayAngle, dt);
                    ship.sailHeight = Math.min(ship.sailHeight + dt * 0.14, 0.44);
                    ship.anchored = false;
                    ship.anchorRaiseProgress = 0;
                    this.trimSails(ship, t);
                }
                else {
                    bot.behavior = 'patrol';
                    bot.targetIslandId = null;
                    bot.patrolAngle = awayAngle + (Math.random() - 0.5) * 0.8;
                    bot.stateTimer = 7 + Math.random() * 8;
                }
                break;
            }
        }
    }
    steerToward(ship, targetAngle, dt) {
        const stats = SHIP_STATS[ship.type];
        const diff = angleWrap(targetAngle - ship.rotation);
        const maxOmega = stats.turnRate * (0.36 + ship.sailHeight * 0.52);
        const targetOmega = Math.max(-maxOmega, Math.min(maxOmega, diff * 1.18));
        const blend = 1 - Math.exp(-dt * SHIP.RUDDER_SLEW * 0.78);
        ship.angularVelocity += (targetOmega - ship.angularVelocity) * blend;
        ship.rotation += ship.angularVelocity * dt;
    }
    trimSails(ship, t) {
        const wind = sampleWind(t);
        const signedRelative = angleWrap(wind.direction - ship.rotation);
        const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.95;
        const delta = desiredTrim - ship.sailAngle;
        const step = Math.sign(delta) * Math.min(Math.abs(delta), SHIP.SAIL_TRIM_RATE * 0.9 * (1 / 20));
        ship.sailAngle += step;
    }
    calculateCannonPitch(ship, target) {
        const dx = target.position.x - ship.position.x;
        const dz = target.position.z - ship.position.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        // Rough elevation angle for arc (gravity compensation)
        const elevAngle = Math.atan2(d * 0.05, d) + 0.15;
        return Math.min(elevAngle, 0.6);
    }
    removeBot(playerId) {
        this.bots.delete(playerId);
    }
    getBotCount() {
        return this.bots.size;
    }
}
