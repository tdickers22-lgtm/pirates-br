import { PHYSICS, SHIP_STATS, SHIP, PLAYER, SHIP_UPGRADES, SEA_ROCKS } from '../../shared/constants/index.js';
import { gerstnerHeight, WAVE_PARAMS, angleWrap, clamp, getNearestShipBoardingLadder, getShipBoardingLadderLocals, getIslandSurfacePoint, getIslandSurfaceY, isPointInsideIslandFootprint, sampleWind, getCrowNestStandingY, getMainMastLocalZ, getShipCompanionwayConfig, getSeaRockBoundsRadius, getSeaRockColliders, intersectRaySeaRock, seaRockColliderWorldCenter, } from '../../shared/utils/index.js';
export class PhysicsSystem {
    constructor() {
        this.combatEvents = [];
    }
    update(dt, t, ships, players, projectiles, islands, seaRocks = []) {
        this.updateProjectiles(dt, projectiles, ships, players, seaRocks);
        this.updateShips(dt, t, ships, islands, seaRocks);
        this.updatePlayers(dt, t, players, ships, islands, seaRocks);
    }
    flushCombatEvents() {
        return this.combatEvents.splice(0);
    }
    updateShips(dt, t, ships, islands, seaRocks) {
        const wind = sampleWind(t);
        for (const ship of ships) {
            if (!ship.alive)
                continue;
            if (ship.sinking) {
                ship.sinkProgress += dt / SHIP.SINK_TIME;
                ship.position.y -= dt * 1.5;
                ship.velocity.x *= 0.94;
                ship.velocity.z *= 0.94;
                ship.angularVelocity *= 0.9;
                if (ship.sinkProgress >= 1) {
                    ship.alive = false;
                }
                continue;
            }
            const stats = SHIP_STATS[ship.type];
            const chainshotted = Date.now() / 1000 < ship.chainshottedUntil;
            const cosR = Math.cos(ship.rotation);
            const sinR = Math.sin(ship.rotation);
            const currentFwd = sinR * ship.velocity.x + cosR * ship.velocity.z;
            const currentLat = cosR * ship.velocity.x - sinR * ship.velocity.z;
            const floodedSections = Number(ship.hull.bow < 0.5) +
                Number(ship.hull.stern < 0.5) +
                Number(ship.hull.port < 0.5) +
                Number(ship.hull.starboard < 0.5);
            const floodPenalty = Math.max(0.48, 1 - floodedSections * SHIP.FLOOD_SPEED_PENALTY);
            const signedRelative = angleWrap(wind.direction - ship.rotation);
            const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
            const trimError = Math.abs(angleWrap(ship.sailAngle - desiredTrim)) / SHIP.MAX_SAIL_ANGLE;
            const trimEfficiency = 1 - Math.pow(Math.min(1, trimError), 1.15);
            // Beam reach (broadside to wind) is strongest — closer to Sea of Thieves sailing
            const windForward = (Math.cos(signedRelative) + 1) * 0.5;
            const windBeam = 1 - Math.abs(Math.cos(signedRelative));
            const reach = Math.sqrt(Math.max(0, windForward * windBeam)) * 1.15;
            const windAssist = 0.34 + windForward * 0.24 + windBeam * 0.36 + reach * 0.14;
            const sailDeployment = (chainshotted ? 0.42 : 1) * ship.sailHeight * clamp(ship.sailIntegrity, 0, 1);
            const speedMult = ship.upgrades.some(u => u.type === 'swift_sails') ? SHIP_UPGRADES.SWIFT_SPEED_MULT : 1;
            const targetSpeed = ship.anchored
                ? 0
                : stats.maxSpeed * speedMult * sailDeployment * (0.16 + trimEfficiency * 0.84) * windAssist * wind.strength * floodPenalty;
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
            const boundary = 950;
            if (Math.abs(ship.position.x) > boundary) {
                ship.velocity.x *= -0.5;
                ship.position.x = Math.sign(ship.position.x) * boundary;
            }
            if (Math.abs(ship.position.z) > boundary) {
                ship.velocity.z *= -0.5;
                ship.position.z = Math.sign(ship.position.z) * boundary;
            }
            const waveY = gerstnerHeight(ship.position.x, ship.position.z, t, WAVE_PARAMS);
            const targetY = waveY;
            ship.position.y += (targetY - ship.position.y) * PHYSICS.BUOYANCY_SPRING * dt;
            // Ship-island collision
            for (const island of islands) {
                this.pushShipOutOfIsland(ship, island);
            }
            for (const rock of seaRocks) {
                this.pushShipOutOfSeaRock(ship, rock);
            }
            // Ship-ship collision (push apart + T-bone damage scaling)
            for (const other of ships) {
                if (other.id === ship.id || !other.alive)
                    continue;
                if (ship.id > other.id)
                    continue;
                const dx = ship.position.x - other.position.x;
                const dz = ship.position.z - other.position.z;
                const d = Math.sqrt(dx * dx + dz * dz);
                const minD = (stats.length + SHIP_STATS[other.type].length) * 0.45;
                if (d < minD && d > 0.1) {
                    const nx = dx / d, nz = dz / d;
                    const overlap = (minD - d) * 0.5;
                    ship.position.x += nx * overlap;
                    ship.position.z += nz * overlap;
                    other.position.x -= nx * overlap;
                    other.position.z -= nz * overlap;
                    // Damage on hard collision — T-bone (broadside) victims take heavier damage
                    // than rammers hitting with their bow/stern. Both ships still take some.
                    const relSpd = Math.abs((ship.velocity.x - other.velocity.x) * nx +
                        (ship.velocity.z - other.velocity.z) * nz);
                    if (relSpd > 2.5) {
                        // Convert damage to a proper hull-fraction so light bumps are survivable
                        // and a hard T-bone is genuinely punishing.
                        const baseDmg = relSpd * 12;
                        // The face of each ship that touched the other = direction from that ship toward the other.
                        const shipImpact = this.rotateWorldToShipLocal(-nx, -nz, ship.rotation);
                        const otherImpact = this.rotateWorldToShipLocal(nx, nz, other.rotation);
                        const shipFactor = this.tboneDamageFactor(shipImpact);
                        const otherFactor = this.tboneDamageFactor(otherImpact);
                        const shipSection = this.impactHullSection(shipImpact);
                        const otherSection = this.impactHullSection(otherImpact);
                        const shipDmg = (baseDmg * shipFactor) / ship.maxHull;
                        const otherDmg = (baseDmg * otherFactor) / other.maxHull;
                        this.damageHullSection(ship, shipSection, shipDmg);
                        this.damageHullSection(other, otherSection, otherDmg);
                        // True T-bones (factor > 1) wrap damage to neighbouring sections —
                        // a perpendicular slam shears bow/stern adjacent to the broadside hit.
                        const shipSplash = Math.max(0, shipFactor - 1.0) * 0.4;
                        const otherSplash = Math.max(0, otherFactor - 1.0) * 0.4;
                        if (shipSplash > 0) {
                            for (const adj of this.adjacentSections(shipSection)) {
                                this.damageHullSection(ship, adj, shipDmg * shipSplash);
                            }
                        }
                        if (otherSplash > 0) {
                            for (const adj of this.adjacentSections(otherSection)) {
                                this.damageHullSection(other, adj, otherDmg * otherSplash);
                            }
                        }
                    }
                    // Elastic collision response
                    const rv = (ship.velocity.x - other.velocity.x) * nx + (ship.velocity.z - other.velocity.z) * nz;
                    if (rv < 0) {
                        ship.velocity.x -= rv * nx * 0.4;
                        ship.velocity.z -= rv * nz * 0.4;
                        other.velocity.x += rv * nx * 0.4;
                        other.velocity.z += rv * nz * 0.4;
                    }
                }
            }
            if (ship.onFire) {
                ship.fireTimer = Math.max(0, ship.fireTimer - dt);
                ship.fireDamageAccum += SHIP.FIRE_HULL_DAMAGE_PER_SEC * dt;
                if (ship.fireDamageAccum >= 1) {
                    const dmg = Math.floor(ship.fireDamageAccum);
                    ship.fireDamageAccum -= dmg;
                    const sections = ['bow', 'stern', 'port', 'starboard'];
                    const weakestSection = sections.reduce((weakest, section) => (ship.hull[section] < ship.hull[weakest] ? section : weakest), sections[0]);
                    this.damageHullSection(ship, weakestSection, dmg / ship.maxHull);
                }
                if (ship.fireTimer <= 0) {
                    ship.onFire = false;
                    ship.fireTimer = 0;
                    ship.fireDamageAccum = 0;
                }
            }
        }
    }
    updatePlayers(dt, t, players, ships, islands, seaRocks) {
        for (const player of players) {
            if (player.respawnProtectionTimer > 0) {
                player.respawnProtectionTimer = Math.max(0, player.respawnProtectionTimer - dt);
            }
            if (player.shipBoundaryGraceTimer > 0) {
                player.shipBoundaryGraceTimer = Math.max(0, player.shipBoundaryGraceTimer - dt);
            }
            if (player.state === 'eliminated' || player.state === 'respawning')
                continue;
            // Apply knockback velocity decay
            player.knockbackVelocity.x *= 0.9;
            player.knockbackVelocity.y *= 0.9;
            player.knockbackVelocity.z *= 0.9;
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
                let landedShip = null;
                if (player.shipBoundaryGraceTimer <= 0.2) {
                    for (const ship of ships) {
                        if (!ship.alive)
                            continue;
                        const stats = SHIP_STATS[ship.type];
                        const local = this.toShipLocal(player.position, ship);
                        const deckY = ship.position.y + stats.height + 0.1;
                        if (this.isInsideShipDeckFootprint(local, stats, 0.32)
                            && player.position.y <= deckY + 0.42
                            && player.position.y >= deckY - 1) {
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
                const groundY = Math.max(onIsland ? getIslandSurfaceY(onIsland, player.position.x, player.position.z) : -Infinity, onDock ? onDock.position.y + 0.14 : -Infinity);
                if (groundY > -Infinity && player.position.y <= groundY) {
                    player.position.y = groundY;
                    player.velocity.y = 0;
                    player.cannonFlightTimer = 0;
                    player.cannonBallistic = false;
                    player.swimTimer = 0;
                    continue;
                }
                const waveY = gerstnerHeight(player.position.x, player.position.z, t, WAVE_PARAMS);
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
                const deckY = onShip.position.y + stats.height + 0.1;
                const localBeforeCarry = this.toShipLocal(player.position, onShip);
                // Passengers need to inherit both ship translation and turn so the hold feels welded to the hull.
                player.position.x += onShip.velocity.x * dt;
                player.position.z += onShip.velocity.z * dt;
                if (!player.atHelm && !player.atCannon) {
                    const turnDelta = onShip.angularVelocity * dt;
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
                // Gravity (crow's nest: fixed height, no gravity)
                if (player.atCrowNest) {
                    const nestY = onShip.position.y + getCrowNestStandingY(stats);
                    player.position.y = nestY;
                    player.velocity.y = 0;
                    player.velocity.x = 0;
                    player.velocity.z = 0;
                }
                else {
                    player.velocity.y += PHYSICS.GRAVITY * dt;
                    player.position.y += player.velocity.y * dt;
                    if (player.position.y < floorY) {
                        player.position.y = floorY;
                        player.velocity.y = 0;
                    }
                }
                // Invisible deck rails: stay aboard unless the player explicitly jumps out.
                if (player.position.y >= deckY - 0.3
                    && player.shipBoundaryGraceTimer <= 0
                    && !player.atHelm
                    && !player.atCannon
                    && !player.atSails
                    && !player.atCrowNest) {
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
                if (player.position.y >= deckY - 0.25
                    && !player.atHelm
                    && !player.atCannon
                    && !player.atSails
                    && !player.atCrowNest) {
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
                player.state = 'alive';
                if (onShip.onFire && player.respawnProtectionTimer <= 0) {
                    player.lastDamagedById = null;
                    player.lastDamageWasHeadshot = false;
                    player.health -= SHIP.FIRE_PLAYER_DAMAGE_PER_SEC * dt;
                }
            }
            else {
                player.onShipId = null;
                const onIsland = this.findPlayerIsland(player, islands);
                const onDock = this.findPlayerDock(player, islands);
                const islandFloor = onIsland
                    ? getIslandSurfaceY(onIsland, player.position.x, player.position.z)
                    : -Infinity;
                const dockFloor = onDock ? onDock.position.y + 0.14 : -Infinity;
                const groundY = Math.max(islandFloor, dockFloor);
                if (groundY > -Infinity) {
                    player.velocity.y += PHYSICS.GRAVITY * dt;
                    player.position.y += player.velocity.y * dt;
                    if (player.position.y < groundY - 0.6) {
                        player.position.y = groundY;
                        player.velocity.y = 0;
                    }
                    // Only snap to terrain when falling — prevents slope-snap lofting player upward when jumping
                    if (player.position.y < groundY && player.velocity.y <= 0) {
                        player.position.y = groundY;
                        player.velocity.y = 0;
                    }
                    player.swimTimer = 0;
                    player.state = 'alive';
                }
                else {
                    // If we ever end up spatially inside dock geometry, snap back to solid ground.
                    // Do not rescue against the wider island footprint here: just past a cliff
                    // edge that reads as an invisible platform over open water.
                    let rescueY = -Infinity;
                    for (const island of islands) {
                        if (!island.dock)
                            continue;
                        const local = this.toDockLocal(player.position, island.dock);
                        if (Math.abs(local.x) <= island.dock.width * 0.5 + 0.75 && Math.abs(local.z) <= island.dock.length * 0.5 + 0.75) {
                            rescueY = Math.max(rescueY, island.dock.position.y + 0.14);
                        }
                    }
                    if (rescueY > -Infinity && player.position.y < rescueY - 0.75) {
                        player.position.y = rescueY;
                        player.velocity.y = 0;
                        player.swimTimer = 0;
                        player.state = 'alive';
                        continue;
                    }
                    // Not on any surface — airborne above sea or in water
                    const waveY = gerstnerHeight(player.position.x, player.position.z, t, WAVE_PARAMS);
                    const surfaceY = waveY + 0.32;
                    const alreadySwimming = player.state === 'swimming';
                    if (!alreadySwimming && player.position.y > surfaceY) {
                        // Airborne until the player's feet actually cross the waterline. Applying
                        // swimming drag a metre above the surface made dock jumps and cannon arcs
                        // feel like they hit an invisible platform instead of plunging through.
                        player.velocity.y += PHYSICS.GRAVITY * dt;
                        player.position.y += player.velocity.y * dt;
                        // state intentionally not changed — stays 'alive' while falling through air
                    }
                    else {
                        // Near or in water — full swimming physics
                        if (!alreadySwimming) {
                            player.velocity.x *= 0.78;
                            player.velocity.z *= 0.78;
                            // Water absorbs ~10% of vertical impact velocity on entry. Was 18% which
                            // killed too much plunge — a 4 m fall barely dipped your head under.
                            if (player.velocity.y < 0)
                                player.velocity.y *= 0.90;
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
                            if (player.velocity.y < 0)
                                player.velocity.y *= -0.08;
                        }
                        // Only clamp the breach height when player is actively rising — a falling
                        // player should slip beneath the surface, not be teleported down to it.
                        if (player.position.y > maxBreachHeight && player.velocity.y >= 0) {
                            player.position.y = maxBreachHeight;
                            player.velocity.y *= 0.12;
                        }
                        player.state = 'swimming';
                        // Drowning
                        player.swimTimer += dt;
                        if (player.swimTimer > PLAYER.DROWN_TIME && player.respawnProtectionTimer <= 0) {
                            player.lastDamagedById = null;
                            player.lastDamageWasHeadshot = false;
                            player.health -= PLAYER.DROWN_DAMAGE * dt;
                        }
                    }
                }
            }
            this.resolveSwimmerShipCollision(player, ships);
            this.resolvePlayerSeaRockCollision(player, seaRocks, false);
            // World boundary
            player.position.x = clamp(player.position.x, -990, 990);
            player.position.z = clamp(player.position.z, -990, 990);
            player.health = clamp(player.health, 0, PLAYER.MAX_HEALTH);
            // Check chest proximity
            player.nearChestId = null;
            if (!player.carryingChestId) {
                let bestChestDistance = PLAYER.INTERACT_RANGE;
                for (const island of islands) {
                    for (const chest of island.chests) {
                        if (chest.opened || chest.carriedByPlayerId === player.id)
                            continue;
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
                    if (barrel.opened && barrel.loot.length === 0)
                        continue;
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
                if (!ship.alive)
                    continue;
                const ladder = getNearestShipBoardingLadder(ship, player.position);
                if (!ladder)
                    continue;
                if (player.state === 'swimming' && ladder.distance < 3.5) {
                    player.nearShipId = ship.id;
                }
                else if (onIslandNow && ladder.distance < 3.0) {
                    player.nearShipId = ship.id;
                }
            }
        }
    }
    updateProjectiles(dt, projectiles, ships, players, seaRocks) {
        for (const proj of projectiles) {
            if (!proj.alive)
                continue;
            proj.age += dt;
            if (proj.age > proj.maxAge) {
                proj.alive = false;
                continue;
            }
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
            // Water hit
            if (proj.position.y < 0) {
                proj.alive = false;
                continue;
            }
            // Ship hit
            for (const ship of ships) {
                if (!ship.alive || ship.id === proj.ownerShipId)
                    continue;
                if (this.isProjectileInsideShipHull(proj, ship)) {
                    this.onProjectileHitShip(proj, ship);
                    proj.alive = false;
                    break;
                }
            }
            if (!proj.alive)
                continue;
            // Player hit
            for (const player of players) {
                if (player.id === proj.ownerId
                    || player.state === 'eliminated'
                    || player.state === 'respawning'
                    || player.respawnProtectionTimer > 0)
                    continue;
                const dx = proj.position.x - player.position.x;
                const dy = proj.position.y - player.position.y;
                const dz = proj.position.z - player.position.z;
                if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 0.8) {
                    this.onProjectileHitPlayer(proj, player);
                    proj.alive = false;
                    break;
                }
            }
        }
    }
    onProjectileHitShip(proj, ship) {
        if (proj.type === 'bullet')
            return;
        const dx = proj.position.x - ship.position.x;
        const dz = proj.position.z - ship.position.z;
        const angle = Math.atan2(dz, dx) - ship.rotation;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        let section;
        if (Math.abs(cos) > Math.abs(sin)) {
            section = cos > 0 ? 'starboard' : 'port';
        }
        else {
            section = sin > 0 ? 'bow' : 'stern';
        }
        const beforeHull = this.getAverageHull(ship);
        const dmg = proj.damage / ship.maxHull;
        this.damageHullSection(ship, section, dmg);
        const splashRatio = proj.type === 'chainshot' ? 0.04 : 0.14;
        for (const otherSection of Object.keys(ship.hull)) {
            if (otherSection === section)
                continue;
            this.damageHullSection(ship, otherSection, dmg * splashRatio);
        }
        const remainingHull = this.getAverageHull(ship);
        const milestone = beforeHull > 0.5 && remainingHull <= 0.5
            ? 'half'
            : beforeHull > 0.25 && remainingHull <= 0.25
                ? 'critical'
                : null;
        this.combatEvents.push({
            type: 'ship_hit',
            attackerId: proj.ownerId,
            targetId: ship.id,
            damage: proj.damage,
            position: { ...proj.position },
            projectileType: proj.type,
            section,
            remainingSection: ship.hull[section],
            remainingHull,
            milestone,
        });
        if (proj.type === 'firebomb') {
            ship.onFire = true;
            ship.fireTimer = Math.max(ship.fireTimer, SHIP.FIRE_DURATION);
        }
        if (proj.type === 'chainshot') {
            ship.chainshottedUntil = Date.now() / 1000 + 30;
            const torn = SHIP.CHAINSHOT_SAIL_DAMAGE;
            ship.sailIntegrity = Math.max(0, ship.sailIntegrity - torn);
            // Sea-of-Thieves style: the canvas physically collapses on hit. Sails drop
            // proportional to how much they were carrying, and only the repair station
            // can hoist them back up.
            const drop = torn * SHIP.CHAINSHOT_SAIL_DROP_FACTOR;
            ship.sailHeight = Math.max(0, ship.sailHeight - drop);
        }
    }
    onProjectileHitPlayer(proj, player) {
        if (player.respawnProtectionTimer > 0 || player.state === 'respawning')
            return;
        player.lastDamagedById = proj.ownerId;
        player.lastDamageWasHeadshot = false;
        player.health -= proj.damage;
        this.combatEvents.push({
            type: 'player_hit',
            attackerId: proj.ownerId,
            targetId: player.id,
            damage: proj.damage,
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
    damageHullSection(ship, section, dmgRatio) {
        ship.hull[section] = Math.max(0, ship.hull[section] - dmgRatio);
        ship.repairCooldown = Math.max(ship.repairCooldown, SHIP.FIELD_REPAIR_DELAY);
        ship.autoRepairProgress = 0;
    }
    /** Rotate a world-space direction into a ship's local frame. +z = forward, +x = starboard. */
    rotateWorldToShipLocal(wx, wz, rotation) {
        const c = Math.cos(-rotation);
        const s = Math.sin(-rotation);
        return { x: wx * c - wz * s, z: wx * s + wz * c };
    }
    /**
     * Damage multiplier based on impact angle relative to the ship's hull.
     * - 1.0 when the hit is along the bow/stern axis (the rammer)
     * - up to 1.9 when the hit is fully broadside (the T-boned victim)
     */
    tboneDamageFactor(localImpact) {
        const len = Math.hypot(localImpact.x, localImpact.z) || 1;
        const lateral = Math.abs(localImpact.x) / len;
        return 1 + lateral * lateral * 0.9;
    }
    /** Pick the hull section (bow/stern/port/starboard) that absorbed the hit. */
    impactHullSection(localImpact) {
        return Math.abs(localImpact.z) >= Math.abs(localImpact.x)
            ? (localImpact.z >= 0 ? 'bow' : 'stern')
            : (localImpact.x >= 0 ? 'starboard' : 'port');
    }
    adjacentSections(section) {
        if (section === 'port' || section === 'starboard')
            return ['bow', 'stern'];
        return ['port', 'starboard'];
    }
    getAverageHull(ship) {
        return (ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard) / 4;
    }
    repairHullSection(ship, section, amount) {
        ship.hull[section] = Math.min(1, ship.hull[section] + amount / ship.maxHull);
    }
    /** While swimming, block passing through the ship's horizontal hull; keep a gap at side boarding ladders. */
    resolveSwimmerShipCollision(player, ships) {
        if (player.state !== 'swimming' || player.cannonBallistic || player.onShipId)
            return;
        for (const ship of ships) {
            if (!ship.alive || ship.sinking)
                continue;
            const stats = SHIP_STATS[ship.type];
            const deckY = ship.position.y + stats.height + 0.1;
            // Hull extends from the keel (~ship.position.y - height*0.2) up to the weather deck.
            // Generous range so a swimmer can't dive a few cm and pass under the ship.
            if (player.position.y < ship.position.y - stats.height * 0.4)
                continue;
            if (player.position.y > deckY + 0.28)
                continue;
            const local = this.toShipLocal(player.position, ship);
            if (this.isSwimmerNearBoardingLadderLocal(local, ship.type))
                continue;
            // Single consistent margin: detect and push to the same boundary so there's never an
            // ambiguous band where collision triggers but the push refuses to fire.
            const margin = 0.18;
            if (!this.isInsideShipDeckFootprint(local, stats, margin))
                continue;
            const out = this.pushLocalOutwardFromDeck(local, stats, margin);
            if (!out.pushed)
                continue;
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
    isSwimmerNearBoardingLadderLocal(local, shipType) {
        // Tighter than before (was 1.12) — a wide ladder gap let swimmers cheese the hull near the
        // boarding zone. Just enough room to grab the ladder, not enough to swim past it.
        const pad = 0.85;
        for (const lad of getShipBoardingLadderLocals(shipType)) {
            if (Math.hypot(local.x - lad.x, local.z - lad.z) < pad)
                return true;
        }
        return false;
    }
    pushLocalOutwardFromDeck(local, stats, margin) {
        if (!this.isInsideShipDeckFootprint(local, stats, margin)) {
            return { x: local.x, z: local.z, pushed: false };
        }
        // Push toward the closest hull edge: pure-X for side overlaps, pure-Z for bow/stern. A radial
        // push from the ship center used to send people stern-ward when they were pinned at the bow.
        const halfWidthHere = this.getDeckHalfWidth(stats, local.z, margin);
        const xDistToSide = halfWidthHere - Math.abs(local.x);
        const zDistToEnd = stats.length * 0.48 + margin - Math.abs(local.z);
        let ux;
        let uz;
        if (xDistToSide <= zDistToEnd) {
            ux = local.x >= 0 ? 1 : -1;
            uz = 0;
        }
        else {
            ux = 0;
            uz = local.z >= 0 ? 1 : -1;
        }
        let x = local.x;
        let z = local.z;
        const step = 0.18;
        for (let i = 0; i < 40; i++) {
            if (!this.isInsideShipDeckFootprint({ x, z }, stats, margin * 0.5)) {
                return { x, z, pushed: true };
            }
            x += ux * step;
            z += uz * step;
        }
        return { x: local.x + ux * 0.6, z: local.z + uz * 0.6, pushed: true };
    }
    findPlayerShip(player, ships) {
        if (player.cannonBallistic)
            return null;
        // Fast path: player knows which ship they're on
        if (player.onShipId) {
            const ship = ships.find((s) => s.id === player.onShipId && s.alive);
            if (!ship)
                return null;
            const stats = SHIP_STATS[ship.type];
            const local = this.toShipLocal(player.position, ship);
            const deckY = ship.position.y + stats.height + 0.1;
            const holdFloor = ship.position.y + 0.35;
            const aboveDeckLine = player.position.y > ship.position.y + stats.height * 0.35;
            const withinDeckXZ = this.isInsideShipDeckFootprint(local, stats, 0.2);
            if (aboveDeckLine && withinDeckXZ)
                return ship;
            const withinHullXZ = this.isInsideShipHoldFootprint(local, stats, 0.18);
            const inHoldY = player.position.y >= holdFloor - 0.6 && player.position.y < deckY - 0.2;
            if (withinHullXZ && inHoldY)
                return ship;
            return null;
        }
        // Auto-detect: player has no onShipId (e.g. spawned at dock, jumped from island).
        // Be generous on the upper Y bound so a mid-air jumper doesn't oscillate between
        // "on island" and "on ship" while descending — once they're over the ship's
        // deck XZ and within ~1.8m of the deck, claim the ship and let on-ship gravity
        // bring them down to it.
        for (const ship of ships) {
            if (!ship.alive)
                continue;
            const stats = SHIP_STATS[ship.type];
            const local = this.toShipLocal(player.position, ship);
            const deckY = ship.position.y + stats.height + 0.1;
            const aboveDeckLine = player.position.y > ship.position.y + stats.height * 0.25;
            const withinDeckXZ = this.isInsideShipDeckFootprint(local, stats, 0.3);
            if (aboveDeckLine && withinDeckXZ && player.position.y <= deckY + 1.8)
                return ship;
        }
        return null;
    }
    findPlayerIsland(player, islands) {
        for (const island of islands) {
            if (isPointInsideIslandFootprint(island, player.position.x, player.position.z, 0))
                return island;
        }
        return null;
    }
    findPlayerDock(player, islands) {
        for (const island of islands) {
            if (!island.dock)
                continue;
            const local = this.toDockLocal(player.position, island.dock);
            if (Math.abs(local.x) <= island.dock.width * 0.5 + 0.45 && Math.abs(local.z) <= island.dock.length * 0.5 + 0.45) {
                return island.dock;
            }
        }
        return null;
    }
    toShipLocal(position, ship) {
        const dx = position.x - ship.position.x;
        const dz = position.z - ship.position.z;
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        return {
            x: dx * cos - dz * sin,
            z: dx * sin + dz * cos,
        };
    }
    toShipWorld(x, z, ship) {
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        return {
            x: ship.position.x + x * cos + z * sin,
            z: ship.position.z + z * cos - x * sin,
        };
    }
    toDockLocal(position, dock) {
        const dx = position.x - dock.position.x;
        const dz = position.z - dock.position.z;
        const cos = Math.cos(dock.rotation);
        const sin = Math.sin(dock.rotation);
        return {
            x: dx * cos - dz * sin,
            z: dx * sin + dz * cos,
        };
    }
    pushShipOutOfIsland(ship, island) {
        const samples = this.getShipCollisionSamples(ship);
        let deepest = null;
        for (const sample of samples) {
            const dx = sample.x - island.position.x;
            const dz = sample.z - island.position.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            const angle = Math.atan2(dz, dx);
            const boundaryPoint = getIslandSurfacePoint(island, 1.02, angle);
            const boundaryRadius = Math.sqrt((boundaryPoint.x - island.position.x) * (boundaryPoint.x - island.position.x)
                + (boundaryPoint.z - island.position.z) * (boundaryPoint.z - island.position.z));
            const penetration = boundaryRadius + sample.radius - d;
            if (penetration > 0 && (!deepest || penetration > deepest.penetration)) {
                const inv = d > 0.001 ? 1 / d : 0;
                deepest = {
                    nx: d > 0.001 ? dx * inv : Math.cos(angle),
                    nz: d > 0.001 ? dz * inv : Math.sin(angle),
                    penetration,
                };
            }
        }
        if (!deepest)
            return;
        ship.position.x += deepest.nx * deepest.penetration;
        ship.position.z += deepest.nz * deepest.penetration;
        const relVel = ship.velocity.x * deepest.nx + ship.velocity.z * deepest.nz;
        if (relVel < 0) {
            ship.velocity.x -= relVel * deepest.nx * 1.2;
            ship.velocity.z -= relVel * deepest.nz * 1.2;
        }
    }
    pushShipOutOfSeaRock(ship, rock) {
        const samples = this.getShipCollisionSamples(ship);
        let deepest = null;
        const stats = SHIP_STATS[ship.type];
        const shipMinY = ship.position.y - stats.height * 0.45;
        const shipMaxY = ship.position.y + stats.height + 1.2;
        for (const sample of samples) {
            if (Math.hypot(sample.x - rock.position.x, sample.z - rock.position.z) > getSeaRockBoundsRadius(rock) + sample.radius)
                continue;
            for (const collider of getSeaRockColliders(rock)) {
                const minY = rock.position.y + collider.minY;
                const maxY = rock.position.y + collider.maxY;
                if (maxY < shipMinY || minY > shipMaxY)
                    continue;
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
        if (!deepest)
            return;
        ship.position.x += deepest.nx * deepest.penetration;
        ship.position.z += deepest.nz * deepest.penetration;
        const relVel = ship.velocity.x * deepest.nx + ship.velocity.z * deepest.nz;
        if (relVel < 0) {
            const impactSpeed = -relVel;
            ship.velocity.x -= relVel * deepest.nx * 1.45;
            ship.velocity.z -= relVel * deepest.nz * 1.45;
            ship.angularVelocity += (deepest.sampleX - ship.position.x) * deepest.nz * 0.012
                - (deepest.sampleZ - ship.position.z) * deepest.nx * 0.012;
            if (impactSpeed > 2.2) {
                const damage = Math.min(120, (impactSpeed - 2.2) * SEA_ROCKS.SHIP_DAMAGE_PER_SPEED) / ship.maxHull;
                this.damageHullSection(ship, deepest.section, damage);
            }
        }
    }
    resolvePlayerSeaRockCollision(player, seaRocks, ballistic) {
        if (player.onShipId || player.state === 'eliminated' || player.state === 'respawning')
            return false;
        let best = null;
        const playerMinY = player.position.y - (player.state === 'swimming' ? 0.45 : 0.04);
        const playerMaxY = player.position.y + (player.state === 'swimming' ? PLAYER.HEIGHT * 0.55 : PLAYER.HEIGHT * 0.92);
        for (const rock of seaRocks) {
            if (Math.hypot(player.position.x - rock.position.x, player.position.z - rock.position.z) > getSeaRockBoundsRadius(rock) + PLAYER.RADIUS + 0.65)
                continue;
            for (const collider of getSeaRockColliders(rock)) {
                const center = seaRockColliderWorldCenter(rock, collider);
                const minY = rock.position.y + collider.minY;
                const maxY = rock.position.y + collider.maxY;
                const radius = collider.radius + PLAYER.RADIUS;
                const dx = player.position.x - center.x;
                const dz = player.position.z - center.z;
                const d = Math.hypot(dx, dz);
                if (d >= radius)
                    continue;
                const topLanding = player.velocity.y <= 0
                    && player.position.y >= maxY - (ballistic ? 0.75 : 0.34)
                    && player.position.y <= maxY + (ballistic ? 0.55 : 0.2);
                const overlapsVertical = playerMaxY >= minY && playerMinY <= maxY;
                if (!topLanding && !overlapsVertical)
                    continue;
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
        if (!best)
            return false;
        if (best.topLanding) {
            player.position.y = best.topY;
            if (player.velocity.y < 0)
                player.velocity.y = 0;
            player.swimTimer = 0;
            player.state = 'alive';
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
    isProjectileInsideSeaRock(projectile, seaRocks) {
        const padding = projectile.type === 'cannonball' || projectile.type === 'firebomb' || projectile.type === 'chainshot' ? 0.28 : 0.05;
        for (const rock of seaRocks) {
            if (Math.hypot(projectile.position.x - rock.position.x, projectile.position.z - rock.position.z) > getSeaRockBoundsRadius(rock) + padding)
                continue;
            for (const collider of getSeaRockColliders(rock)) {
                const minY = rock.position.y + collider.minY - padding;
                const maxY = rock.position.y + collider.maxY + padding;
                if (projectile.position.y < minY || projectile.position.y > maxY)
                    continue;
                const center = seaRockColliderWorldCenter(rock, collider);
                if (Math.hypot(projectile.position.x - center.x, projectile.position.z - center.z) <= collider.radius + padding) {
                    return true;
                }
            }
        }
        return false;
    }
    didProjectileHitSeaRock(previousPosition, projectile, seaRocks) {
        const dx = projectile.position.x - previousPosition.x;
        const dy = projectile.position.y - previousPosition.y;
        const dz = projectile.position.z - previousPosition.z;
        const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (range < 0.0001)
            return this.isProjectileInsideSeaRock(projectile, seaRocks);
        const direction = { x: dx / range, y: dy / range, z: dz / range };
        const padding = projectile.type === 'cannonball' || projectile.type === 'firebomb' || projectile.type === 'chainshot' ? 0.28 : 0.05;
        for (const rock of seaRocks) {
            const distance = intersectRaySeaRock(previousPosition, direction, range, rock, padding);
            if (distance !== null)
                return true;
        }
        return false;
    }
    getShipCollisionSamples(ship) {
        const stats = SHIP_STATS[ship.type];
        const locals = [
            { x: 0, z: stats.length * 0.52, radius: stats.width * 0.3, section: 'bow' },
            { x: stats.width * 0.43, z: stats.length * 0.24, radius: stats.width * 0.18, section: 'starboard' },
            { x: -stats.width * 0.43, z: stats.length * 0.24, radius: stats.width * 0.18, section: 'port' },
            { x: 0, z: stats.length * 0.14, radius: stats.width * 0.36, section: 'bow' },
            { x: stats.width * 0.48, z: 0, radius: stats.width * 0.2, section: 'starboard' },
            { x: -stats.width * 0.48, z: 0, radius: stats.width * 0.2, section: 'port' },
            { x: stats.width * 0.4, z: -stats.length * 0.24, radius: stats.width * 0.18, section: 'starboard' },
            { x: -stats.width * 0.4, z: -stats.length * 0.24, radius: stats.width * 0.18, section: 'port' },
            { x: 0, z: -stats.length * 0.45, radius: stats.width * 0.3, section: 'stern' },
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
    isProjectileInsideShipHull(projectile, ship) {
        const stats = SHIP_STATS[ship.type];
        const local = this.toShipLocal(projectile.position, ship);
        return Math.abs(projectile.position.y - ship.position.y) < stats.height + 1.1
            && this.isInsideShipDeckFootprint(local, stats, 0.38);
    }
    getShipFloorY(position, ship, providedLocal) {
        const stats = SHIP_STATS[ship.type];
        const deckY = ship.position.y + stats.height + 0.1;
        const holdFloor = ship.position.y + 0.35;
        const local = providedLocal ?? this.toShipLocal(position, ship);
        const stair = this.getShipStairConfig(stats);
        if (Math.abs(local.x - stair.x) <= stair.halfWidth
            && local.z <= stair.frontZ
            && local.z >= stair.backZ) {
            const descent = clamp((stair.frontZ - local.z) / Math.max(0.001, stair.frontZ - stair.backZ), 0, 1);
            return deckY + (holdFloor - deckY) * descent;
        }
        if (this.isInsideShipHoldFootprint(local, stats, 0.08) && position.y < deckY - 0.25) {
            return holdFloor;
        }
        return deckY;
    }
    getShipStairConfig(stats) {
        const companionway = getShipCompanionwayConfig(stats);
        return {
            x: companionway.cx,
            halfWidth: companionway.stairHalfWidth,
            frontZ: companionway.stairFrontZ,
            backZ: companionway.stairBackZ,
        };
    }
    isInsideShipDeckFootprint(local, stats, margin = 0) {
        if (Math.abs(local.z) > stats.length * 0.48 + margin)
            return false;
        const halfWidth = this.getDeckHalfWidth(stats, local.z, margin);
        return Math.abs(local.x) <= halfWidth;
    }
    isInsideShipHoldFootprint(local, stats, margin = 0) {
        if (Math.abs(local.z) > stats.length * 0.34 + margin)
            return false;
        const halfWidth = this.getHoldHalfWidth(stats, local.z, margin);
        return Math.abs(local.x) <= halfWidth;
    }
    clampDeckPosition(local, stats) {
        const z = clamp(local.z, -stats.length * 0.46, stats.length * 0.46);
        const halfWidth = this.getDeckHalfWidth(stats, z);
        return {
            x: clamp(local.x, -halfWidth, halfWidth),
            z,
        };
    }
    resolveShipDeckObstacleCollision(local, stats) {
        let x = local.x;
        let z = local.z;
        let pushed = false;
        const pushCircle = (cx, cz, radius) => {
            const dx = x - cx;
            const dz = z - cz;
            const d = Math.hypot(dx, dz);
            if (d >= radius)
                return;
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
        return { x, z, pushed };
    }
    clampHoldPosition(local, stats) {
        const z = clamp(local.z, -stats.length * 0.32, stats.length * 0.32);
        const halfWidth = this.getHoldHalfWidth(stats, z);
        return {
            x: clamp(local.x, -halfWidth, halfWidth),
            z,
        };
    }
    getHoldHalfWidth(stats, localZ, margin = 0) {
        const normalized = clamp(Math.abs(localZ) / Math.max(0.001, stats.length * 0.34), 0, 1);
        const endTaper = normalized > 0.58 ? (normalized - 0.58) / 0.42 : 0;
        return stats.width * (0.38 - endTaper * 0.11) + margin;
    }
    getDeckHalfWidth(stats, localZ, margin = 0) {
        const z = clamp(localZ / Math.max(0.001, stats.length), -0.5, 0.5);
        const stations = [
            { z: -0.5, half: 0.30 },
            { z: -0.36, half: 0.50 },
            { z: -0.08, half: 0.56 },
            { z: 0.22, half: 0.48 },
            { z: 0.42, half: 0.26 },
            { z: 0.5, half: 0.055 },
        ];
        for (let i = 0; i < stations.length - 1; i++) {
            const a = stations[i];
            const b = stations[i + 1];
            if (z >= a.z && z <= b.z) {
                const t = (z - a.z) / Math.max(0.001, b.z - a.z);
                return Math.max(PLAYER.RADIUS + 0.08, stats.width * (a.half + (b.half - a.half) * t) + margin);
            }
        }
        return Math.max(PLAYER.RADIUS + 0.08, stats.width * stations[stations.length - 1].half + margin);
    }
}
