import type { Ship, Player, Projectile, Island, Vec3 } from '../../shared/types/index.js';
import { PHYSICS, SHIP_STATS, SHIP, PLAYER, SHIP_UPGRADES } from '../../shared/constants/index.js';
import {
  gerstnerHeight,
  WAVE_PARAMS,
  angleWrap,
  clamp,
  getNearestShipBoardingLadder,
  getShipBoardingLadderLocals,
  getIslandSurfacePoint,
  getIslandSurfaceY,
  isPointInsideIslandFootprint,
  sampleWind,
  getCrowNestStandingY,
} from '../../shared/utils/index.js';

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
      section: keyof Ship['hull'];
      remainingSection: number;
      remainingHull: number;
      milestone: 'half' | 'critical' | null;
    };

export class PhysicsSystem {
  private combatEvents: PhysicsCombatEvent[] = [];

  update(
    dt: number,
    t: number,
    ships: Ship[],
    players: Player[],
    projectiles: Projectile[],
    islands: Island[],
  ) {
    this.updateProjectiles(dt, projectiles, ships, players);
    this.updateShips(dt, t, ships, islands);
      this.updatePlayers(dt, t, players, ships, islands);
  }

  flushCombatEvents(): PhysicsCombatEvent[] {
    return this.combatEvents.splice(0);
  }

  private updateShips(dt: number, t: number, ships: Ship[], islands: Island[]) {
    const wind = sampleWind(t);

    for (const ship of ships) {
      if (!ship.alive) continue;
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
      const floodedSections =
        Number(ship.hull.bow < 0.5) +
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
      const sailDeployment =
        (chainshotted ? 0.42 : 1) * ship.sailHeight * clamp(ship.sailIntegrity, 0, 1);
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

      // Ship-ship collision (push apart)
      for (const other of ships) {
        if (other.id === ship.id || !other.alive) continue;
        if (ship.id > other.id) continue;
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

          // Damage on hard collision
          const relSpd = Math.abs(
            (ship.velocity.x - other.velocity.x) * nx +
            (ship.velocity.z - other.velocity.z) * nz
          );
          if (relSpd > 3) {
            const dmg = relSpd * 8;
            this.damageHullSection(ship, 'bow', dmg * 0.5);
            this.damageHullSection(other, 'bow', dmg * 0.5);
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
          const sections = ['bow', 'stern', 'port', 'starboard'] as const;
          const weakestSection = sections.reduce((weakest, section) => (
            ship.hull[section] < ship.hull[weakest] ? section : weakest
          ), sections[0]);
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

  private updatePlayers(dt: number, t: number, players: Player[], ships: Ship[], islands: Island[]) {
    for (const player of players) {
      if (player.respawnProtectionTimer > 0) {
        player.respawnProtectionTimer = Math.max(0, player.respawnProtectionTimer - dt);
      }
      if (player.shipBoundaryGraceTimer > 0) {
        player.shipBoundaryGraceTimer = Math.max(0, player.shipBoundaryGraceTimer - dt);
      }
      if (player.state === 'eliminated' || player.state === 'respawning') continue;

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
          player.cannonBallistic = false;
          const waveY = gerstnerHeight(player.position.x, player.position.z, t, WAVE_PARAMS);
          const waterSurface = waveY + 0.28;
          player.position.y = waterSurface - 0.18;
          player.velocity.x *= 0.6;
          player.velocity.z *= 0.6;
          player.velocity.y = Math.min(player.velocity.y, -0.4);
          player.state = 'swimming';
          continue;
        }
        player.state = 'alive';
        player.velocity.x *= Math.pow(PHYSICS.AIR_DRAG, dt * 60);
        player.velocity.z *= Math.pow(PHYSICS.AIR_DRAG, dt * 60);
        player.velocity.y += PHYSICS.GRAVITY * dt;
        player.position.x += player.velocity.x * dt;
        player.position.y += player.velocity.y * dt;
        player.position.z += player.velocity.z * dt;

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
          player.position.y = groundY;
          player.velocity.y = 0;
          player.cannonFlightTimer = 0;
          player.cannonBallistic = false;
          player.swimTimer = 0;
          continue;
        }

        const waveY = gerstnerHeight(player.position.x, player.position.z, t, WAVE_PARAMS);
        const waterSurface = waveY + 0.28;
        if (player.position.y <= waterSurface) {
          player.position.y = waterSurface - 0.18;
          player.velocity.x *= 0.6;
          player.velocity.z *= 0.6;
          player.velocity.y = Math.min(player.velocity.y, -0.4);
          player.cannonFlightTimer = 0;
          player.cannonBallistic = false;
          player.state = 'swimming';
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

        player.swimTimer = 0;
        player.state = 'alive';
        if (onShip.onFire && player.respawnProtectionTimer <= 0) {
          player.lastDamagedById = null;
          player.lastDamageWasHeadshot = false;
          player.health -= SHIP.FIRE_PLAYER_DAMAGE_PER_SEC * dt;
        }
      } else {
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
        } else {
          // If we ever end up spatially inside island or dock geometry, snap back to solid ground.
          let rescueY = -Infinity;
          for (const island of islands) {
            if (isPointInsideIslandFootprint(island, player.position.x, player.position.z, 6)) {
              rescueY = Math.max(rescueY, getIslandSurfaceY(island, player.position.x, player.position.z));
            }
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
            player.state = 'alive';
            continue;
          }

          // Not on any surface — airborne above sea or in water
          const waveY = gerstnerHeight(player.position.x, player.position.z, t, WAVE_PARAMS);
          const surfaceY = waveY + 0.32;

          if (player.position.y > surfaceY + 1.0) {
            // High enough above water to be airborne: plain gravity so jumps off docks/islands
            // arc naturally and can land on ship decks without being killed by water drag
            player.velocity.y += PHYSICS.GRAVITY * dt;
            player.position.y += player.velocity.y * dt;
            // state intentionally not changed — stays 'alive' while falling through air
          } else {
            // Near or in water — full swimming physics
            const maxDiveDepth = waveY - 8.5;
            const maxBreachHeight = waveY + 0.86;
            const buoyancyBias = player.velocity.y < -0.35 ? 0.52 : player.velocity.y > 0.45 ? 0.88 : 0.72;
            const buoyancy = clamp((surfaceY - player.position.y) * 4.2 * buoyancyBias, -2.6, 4.4);
            player.velocity.y += buoyancy * dt;
            player.velocity.y *= Math.pow(0.9, dt * 60);
            player.position.y += player.velocity.y * dt;
            if (player.position.y < maxDiveDepth) {
              player.position.y = maxDiveDepth;
              if (player.velocity.y < 0) player.velocity.y *= -0.08;
            }
            if (player.position.y > maxBreachHeight) {
              player.position.y = maxBreachHeight;
              if (player.velocity.y > 0) player.velocity.y *= 0.12;
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

      // Fall damage from knockback
      if (player.velocity.y < -12 && onShip && player.respawnProtectionTimer <= 0) {
        const fallDmg = Math.abs(player.velocity.y + 12) * 4;
        player.lastDamageWasHeadshot = false;
        player.health -= fallDmg;
      }

      // World boundary
      player.position.x = clamp(player.position.x, -990, 990);
      player.position.z = clamp(player.position.z, -990, 990);

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
          if (!barrel.opened) {
            const dx = player.position.x - barrel.position.x;
            const dz = player.position.z - barrel.position.z;
            if (Math.sqrt(dx * dx + dz * dz) < PLAYER.INTERACT_RANGE) {
              player.nearBarrelId = barrel.id;
            }
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
    }
  }

  private updateProjectiles(dt: number, projectiles: Projectile[], ships: Ship[], players: Player[]) {
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

      // Gravity
      proj.velocity.y += PHYSICS.GRAVITY * dt * (proj.type === 'bullet' ? 0.3 : SHIP.CANNON_GRAVITY_MULT);

      proj.position.x += proj.velocity.x * dt;
      proj.position.y += proj.velocity.y * dt;
      proj.position.z += proj.velocity.z * dt;

      // Water hit
      if (proj.position.y < 0) { proj.alive = false; continue; }

      // Ship hit
      for (const ship of ships) {
        if (!ship.alive || ship.id === proj.ownerShipId) continue;
        if (this.isProjectileInsideShipHull(proj, ship)) {
          this.onProjectileHitShip(proj, ship);
          proj.alive = false;
          break;
        }
      }
      if (!proj.alive) continue;

      // Player hit
      for (const player of players) {
        if (
          player.id === proj.ownerId
          || player.state === 'eliminated'
          || player.state === 'respawning'
          || player.respawnProtectionTimer > 0
        ) continue;
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

  private onProjectileHitShip(proj: Projectile, ship: Ship) {
    if (proj.type === 'bullet') return;

    const dx = proj.position.x - ship.position.x;
    const dz = proj.position.z - ship.position.z;
    const angle = Math.atan2(dz, dx) - ship.rotation;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    let section: keyof typeof ship.hull;
    if (Math.abs(cos) > Math.abs(sin)) {
      section = cos > 0 ? 'starboard' : 'port';
    } else {
      section = sin > 0 ? 'bow' : 'stern';
    }

    const beforeHull = this.getAverageHull(ship);
    const dmg = proj.damage / ship.maxHull;
    this.damageHullSection(ship, section, dmg);
    const splashRatio = proj.type === 'chainshot' ? 0.04 : 0.14;
    for (const otherSection of Object.keys(ship.hull) as Array<keyof typeof ship.hull>) {
      if (otherSection === section) continue;
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
      ship.sailIntegrity = Math.max(0, ship.sailIntegrity - SHIP.CHAINSHOT_SAIL_DAMAGE);
    }
  }

  private onProjectileHitPlayer(proj: Projectile, player: Player) {
    if (player.respawnProtectionTimer > 0 || player.state === 'respawning') return;
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

  damageHullSection(ship: Ship, section: keyof Ship['hull'], dmgRatio: number) {
    ship.hull[section] = Math.max(0, ship.hull[section] - dmgRatio);
    ship.repairCooldown = Math.max(ship.repairCooldown, SHIP.FIELD_REPAIR_DELAY);
    ship.autoRepairProgress = 0;
  }

  private getAverageHull(ship: Ship) {
    return (ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard) / 4;
  }

  repairHullSection(ship: Ship, section: keyof Ship['hull'], amount: number) {
    ship.hull[section] = Math.min(1, ship.hull[section] + amount / ship.maxHull);
  }

  /** While swimming, block passing through the ship’s horizontal hull; keep a gap at side boarding ladders. */
  private resolveSwimmerShipCollision(player: Player, ships: Ship[]) {
    if (player.state !== 'swimming' || player.cannonBallistic || player.onShipId) return;

    for (const ship of ships) {
      if (!ship.alive || ship.sinking) continue;
      const stats = SHIP_STATS[ship.type];
      const deckY = ship.position.y + stats.height + 0.1;
      if (player.position.y < ship.position.y - 0.55) continue;
      if (player.position.y > deckY + 0.28) continue;

      const local = this.toShipLocal(player.position, ship);
      if (this.isSwimmerNearBoardingLadderLocal(local, ship.type)) continue;

      if (!this.isInsideShipDeckFootprint(local, stats, 0.1)) continue;

      const out = this.pushLocalOutwardFromDeck(local, stats);
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

  private isSwimmerNearBoardingLadderLocal(local: { x: number; z: number }, shipType: Ship['type']) {
    const pad = 1.12;
    for (const lad of getShipBoardingLadderLocals(shipType)) {
      if (Math.hypot(local.x - lad.x, local.z - lad.z) < pad) return true;
    }
    return false;
  }

  private pushLocalOutwardFromDeck(
    local: { x: number; z: number },
    stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS],
  ): { x: number; z: number; pushed: boolean } {
    if (!this.isInsideShipDeckFootprint(local, stats, 0.02)) {
      return { x: local.x, z: local.z, pushed: false };
    }
    const len = Math.hypot(local.x, local.z);
    const ux = len > 0.02 ? local.x / len : 1;
    const uz = len > 0.02 ? local.z / len : 0;
    let x = local.x;
    let z = local.z;
    const step = 0.14;
    for (let i = 0; i < 32; i++) {
      if (!this.isInsideShipDeckFootprint({ x, z }, stats, 0)) {
        return { x, z, pushed: true };
      }
      x += ux * step;
      z += uz * step;
    }
    return { x: local.x + ux * 0.45, z: local.z + uz * 0.45, pushed: true };
  }

  private findPlayerShip(player: Player, ships: Ship[]): Ship | null {
    if (player.cannonBallistic) return null;

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

    // Auto-detect: player has no onShipId (e.g. spawned at dock) — check if physically on a deck
    for (const ship of ships) {
      if (!ship.alive) continue;
      const stats = SHIP_STATS[ship.type];
      const local = this.toShipLocal(player.position, ship);
      const deckY = ship.position.y + stats.height + 0.1;
      const aboveDeckLine = player.position.y > ship.position.y + stats.height * 0.35;
      const withinDeckXZ = this.isInsideShipDeckFootprint(local, stats, 0.2);
      if (aboveDeckLine && withinDeckXZ && player.position.y <= deckY + 0.6) return ship;
    }

    return null;
  }

  private findPlayerIsland(player: Player, islands: Island[]): Island | null {
    for (const island of islands) {
      if (isPointInsideIslandFootprint(island, player.position.x, player.position.z, 1.0)) return island;
    }
    return null;
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
    const dx = position.x - ship.position.x;
    const dz = position.z - ship.position.z;
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return {
      x: dx * cos - dz * sin,
      z: dx * sin + dz * cos,
    };
  }

  private toShipWorld(x: number, z: number, ship: Ship) {
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return {
      x: ship.position.x + x * cos + z * sin,
      z: ship.position.z + z * cos - x * sin,
    };
  }

  private toDockLocal(position: Vec3, dock: NonNullable<Island['dock']>) {
    const dx = position.x - dock.position.x;
    const dz = position.z - dock.position.z;
    const cos = Math.cos(dock.rotation);
    const sin = Math.sin(dock.rotation);
    return {
      x: dx * cos - dz * sin,
      z: dx * sin + dz * cos,
    };
  }

  private pushShipOutOfIsland(ship: Ship, island: Island) {
    const samples = this.getShipCollisionSamples(ship);
    let deepest: { nx: number; nz: number; penetration: number } | null = null;

    for (const sample of samples) {
      const dx = sample.x - island.position.x;
      const dz = sample.z - island.position.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const angle = Math.atan2(dz, dx);
      const boundaryPoint = getIslandSurfacePoint(island, 1.02, angle);
      const boundaryRadius = Math.sqrt(
        (boundaryPoint.x - island.position.x) * (boundaryPoint.x - island.position.x)
        + (boundaryPoint.z - island.position.z) * (boundaryPoint.z - island.position.z),
      );
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

    if (!deepest) return;
    ship.position.x += deepest.nx * deepest.penetration;
    ship.position.z += deepest.nz * deepest.penetration;
    const relVel = ship.velocity.x * deepest.nx + ship.velocity.z * deepest.nz;
    if (relVel < 0) {
      ship.velocity.x -= relVel * deepest.nx * 1.2;
      ship.velocity.z -= relVel * deepest.nz * 1.2;
    }
  }

  private getShipCollisionSamples(ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const locals = [
      { x: 0, z: stats.length * 0.52, radius: stats.width * 0.32 },
      { x: 0, z: stats.length * 0.14, radius: stats.width * 0.42 },
      { x: stats.width * 0.46, z: 0, radius: stats.width * 0.2 },
      { x: -stats.width * 0.46, z: 0, radius: stats.width * 0.2 },
      { x: 0, z: -stats.length * 0.45, radius: stats.width * 0.3 },
    ];
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return locals.map((sample) => ({
      x: ship.position.x + sample.x * cos + sample.z * sin,
      z: ship.position.z + sample.z * cos - sample.x * sin,
      radius: sample.radius,
    }));
  }

  private isProjectileInsideShipHull(projectile: Projectile, ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const local = this.toShipLocal(projectile.position, ship);
    return Math.abs(projectile.position.y - ship.position.y) < stats.height + 1.1
      && this.isInsideShipDeckFootprint(local, stats, 0.38);
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
      const descent = clamp((stair.frontZ - local.z) / Math.max(0.001, stair.frontZ - stair.backZ), 0, 1);
      return deckY + (holdFloor - deckY) * descent;
    }
    if (this.isInsideShipHoldFootprint(local, stats, 0.08) && position.y < deckY - 0.25) {
      return holdFloor;
    }
    return deckY;
  }

  private getShipStairConfig(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    return {
      x: stats.width * 0.12,
      halfWidth: stats.width * 0.16,
      frontZ: stats.length * 0.16,
      backZ: -stats.length * 0.16,
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
    const sternLen = stats.length * 0.52;
    const bowLen = stats.length * 0.58;
    if (localZ >= 0) {
      const bowRatio = clamp(localZ / Math.max(0.001, bowLen), 0, 1);
      return stats.width * (0.48 - bowRatio * 0.2) + margin;
    }
    const sternRatio = clamp(Math.abs(localZ) / Math.max(0.001, sternLen), 0, 1);
    return stats.width * (0.5 - sternRatio * 0.12) + margin;
  }
}
