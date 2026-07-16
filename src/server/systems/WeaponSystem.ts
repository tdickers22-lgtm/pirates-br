import { v4 as uuid } from 'uuid';
import type { Player, Ship, Projectile, ProjectileType, Vec3, WeaponId } from '../../shared/types/index.js';
import { WEAPONS, SHIP, SHIP_STATS, PLAYER, SHIP_UPGRADES } from '../../shared/constants/index.js';
import { angleWrap, degreesToRad } from '../../shared/utils/index.js';

export interface HitscanTrace {
  origin: Vec3;
  direction: Vec3;
  range: number;
  damage: number;
  knockback: number;
  weaponId: WeaponId;
  /** Where the tracer FX should start (the gun muzzle). Hit tests always run
   *  from `origin` — the camera eye — so shots land on the reticle. */
  visualOrigin?: Vec3;
}

export class WeaponSystem {
  private pendingProjectiles: Projectile[] = [];

  update(dt: number, players: Player[]) {
    for (const player of players) {
      if (player.state === 'eliminated') continue;
      for (const w of player.weapons) {
        if (!w) continue;
        if (w.reloading) {
          w.reloadTimer -= dt;
          if (w.reloadTimer <= 0) {
            const def = WEAPONS[w.weaponId];
            // Reloads pull from the finite reserve — ammo pickups matter.
            const refill = Math.min(Math.max(0, def.ammoMax - w.ammo), Math.max(0, w.reserve));
            w.ammo += refill;
            w.reserve -= refill;
            w.reloading = false;
            w.reloadTimer = 0;
          }
        }
      }
    }
  }

  tryFire(
    player: Player,
    ship: Ship | null,
    yaw: number, pitch: number,
    cannonIndex: number,
    options?: {
      aiming?: boolean;
      aimPoint?: Vec3 | null;
      /** Camera eye — when provided, hit tests run from here so the shot
       *  follows the reticle ray exactly (the muzzle is visual-only). */
      aimOrigin?: Vec3 | null;
    },
  ): HitscanTrace[] {
    // Downed pirates crawl — weapons are locked until revived.
    if (player.state === 'eliminated' || player.state === 'downed') return [];

    // If player is at a cannon, fire ship cannon
    if (player.atCannon && ship) {
      this.fireShipCannon(player, ship, yaw, pitch, cannonIndex);
      return [];
    }

    const weapon = player.weapons[player.activeSlot];
    if (!weapon) return [];

    if (weapon.reloading || weapon.ammo <= 0) {
      this.startReload(player);
      return [];
    }

    const def = WEAPONS[weapon.weaponId];
    if (def.melee) {
      // Melee handled server-side as immediate hit
      return [];
    }

    const dirX = Math.sin(yaw) * Math.cos(pitch);
    const dirY = Math.sin(pitch);
    const dirZ = Math.cos(yaw) * Math.cos(pitch);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const muzzleForward = player.state === 'swimming' ? 0.86 : 0.68;
    const muzzleRight = weapon.weaponId === 'eye_of_reach' || weapon.weaponId === 'blunderbuss' ? 0.2 : 0.14;
    const muzzleHeight = player.state === 'swimming' ? 0.72 : 1.34;
    const muzzleLift = dirY * (player.state === 'swimming' ? 0.22 : 0.14);
    const spawnPosition = {
      x: player.position.x + dirX * muzzleForward + rightX * muzzleRight,
      y: player.position.y + muzzleHeight + muzzleLift,
      z: player.position.z + dirZ * muzzleForward + rightZ * muzzleRight,
    };

    weapon.ammo = Math.max(0, weapon.ammo - 1);
    if (weapon.ammo <= 0) {
      this.startReload(player);
    }

    if (weapon.weaponId === 'flintknock') {
      const recoil = def.knockback * 1.45;
      player.knockbackVelocity.x -= dirX * recoil;
      player.knockbackVelocity.y += Math.max(recoil * 0.38, -dirY * recoil + recoil * 0.18);
      player.knockbackVelocity.z -= dirZ * recoil;
      player.velocity.y = Math.max(player.velocity.y, recoil * 0.18);
      player.shipBoundaryGraceTimer = Math.max(
        player.shipBoundaryGraceTimer,
        PLAYER.SHIP_EXIT_GRACE_TIME + 0.35,
      );
    }

    // Hit tests run from the camera eye when the caller provides it, so the
    // shot rides the crosshair ray at EVERY distance (a muzzle-origin ray only
    // converges with the reticle at max range — sniper shots landed low-right
    // at all combat ranges). The muzzle stays as the tracer's visual start.
    const hitOrigin = options?.aimOrigin ?? spawnPosition;
    const aimPoint = options?.aimPoint ?? {
      x: hitOrigin.x + dirX * def.range,
      y: hitOrigin.y + dirY * def.range,
      z: hitOrigin.z + dirZ * def.range,
    };
    const baseDirection = this.normalizeVector(
      {
        x: aimPoint.x - hitOrigin.x,
        y: aimPoint.y - hitOrigin.y,
        z: aimPoint.z - hitOrigin.z,
      },
      { x: dirX, y: dirY, z: dirZ },
    );
    const spreadMultiplier = this.getSpreadMultiplier(player, weapon.weaponId, options?.aiming ?? false);

    const traces: HitscanTrace[] = [];
    for (let p = 0; p < def.pellets; p++) {
      const spreadRad = degreesToRad(def.spread * spreadMultiplier);
      const direction = spreadRad > 0.0001
        ? this.applyConeSpread(baseDirection, spreadRad)
        : { ...baseDirection };
      const isKnockback = weapon.weaponId === 'flintknock';
      traces.push({
        origin: { ...hitOrigin },
        visualOrigin: { ...spawnPosition },
        direction,
        range: def.range,
        damage: def.damage,
        knockback: isKnockback ? def.knockback * 1.35 : (def.knockback * 0.1),
        weaponId: weapon.weaponId,
      });
    }

    return traces;
  }

  tryMeleeAttack(
    attacker: Player,
    targets: Player[],
    yaw: number,
    options?: {
      damageMultiplier?: number;
      rangeMultiplier?: number;
      knockbackMultiplier?: number;
    },
  ): Array<{ targetId: string; damage: number; knockback: number }> {
    if (attacker.state === 'downed') return [];
    const weapon = attacker.weapons[attacker.activeSlot];
    if (!weapon) return [];
    const def = WEAPONS[weapon.weaponId];
    if (!def.melee) return [];

    const damageMultiplier = options?.damageMultiplier ?? 1;
    const rangeMultiplier = options?.rangeMultiplier ?? 1;
    const knockbackMultiplier = options?.knockbackMultiplier ?? 1;
    const results: Array<{ targetId: string; damage: number; knockback: number }> = [];
    for (const target of targets) {
      if (target.id === attacker.id || target.state === 'eliminated') continue;
      const dx = target.position.x - attacker.position.x;
      const dz = target.position.z - attacker.position.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < def.range * rangeMultiplier) {
        // Check frontal arc (120 degree cone)
        const angle = Math.atan2(dx, dz);
        const diff = Math.abs(angleWrap(angle - yaw));
        if (diff < Math.PI * 0.67) {
          results.push({
            targetId: target.id,
            damage: def.damage * damageMultiplier,
            knockback: def.knockback * knockbackMultiplier,
          });
        }
      }
    }
    return results;
  }

  private fireShipCannon(
    player: Player, ship: Ship,
    yaw: number, pitch: number,
    cannonIndex: number,
  ): Projectile[] {
    if (cannonIndex >= ship.cannonCooldowns.length) return [];
    if (ship.cannonCooldowns[cannonIndex] > 0) return [];

    // Ship cannons spend shared stores; the HUD shows the same finite counts.
    const cannonballIdx = ship.inventory.findIndex(s => s.item === 'cannonball' && s.qty > 0);
    const firebombIdx = ship.inventory.findIndex(s => s.item === 'firebomb_ball' && s.qty > 0);
    const chainshotIdx = ship.inventory.findIndex(s => s.item === 'chainshot' && s.qty > 0);

    const preferredAmmo = player.selectedCannonAmmo;
    let projType: ProjectileType = preferredAmmo;
    let usedIdx = -1;
    let consumesInventory = false;

    if (preferredAmmo === 'firebomb') {
      if (firebombIdx >= 0) {
        usedIdx = firebombIdx;
        consumesInventory = true;
      } else if (chainshotIdx >= 0) {
        projType = 'chainshot';
        usedIdx = chainshotIdx;
        consumesInventory = true;
      } else if (cannonballIdx >= 0) {
        projType = 'cannonball';
        usedIdx = cannonballIdx;
        consumesInventory = true;
      }
    } else if (preferredAmmo === 'chainshot') {
      if (chainshotIdx >= 0) {
        usedIdx = chainshotIdx;
        consumesInventory = true;
      } else if (firebombIdx >= 0) {
        projType = 'firebomb';
        usedIdx = firebombIdx;
        consumesInventory = true;
      } else if (cannonballIdx >= 0) {
        projType = 'cannonball';
        usedIdx = cannonballIdx;
        consumesInventory = true;
      }
    } else {
      // Cannonball preference falls back like the other ammo types: super
      // shots keep their cannonball-only gate, then firebomb, then chainshot —
      // an empty ball rack no longer silently refuses to fire.
      projType = 'cannonball';
      if (cannonballIdx >= 0) {
        usedIdx = cannonballIdx;
        consumesInventory = true;
      } else if (player.superCannonballs > 0) {
        // No inventory consumed — the super-shot path below takes over.
      } else if (firebombIdx >= 0) {
        projType = 'firebomb';
        usedIdx = firebombIdx;
        consumesInventory = true;
      } else if (chainshotIdx >= 0) {
        projType = 'chainshot';
        usedIdx = chainshotIdx;
        consumesInventory = true;
      }
    }

    const usesSuperShot = projType === 'cannonball' && player.superCannonballs > 0;
    if (!usesSuperShot && (!consumesInventory || usedIdx < 0)) return [];
    if (usesSuperShot) {
      player.superCannonballs = Math.max(0, player.superCannonballs - 1);
    } else if (consumesInventory) {
      ship.inventory[usedIdx].qty--;
      if (ship.inventory[usedIdx].qty <= 0) ship.inventory.splice(usedIdx, 1);
    }
    ship.cannonCooldowns[cannonIndex] = SHIP.CANNON_RELOAD;

    const constrained = this.getConstrainedCannonAim(ship, cannonIndex, yaw, pitch);
    yaw = constrained.yaw;
    pitch = constrained.pitch;

    // Cannon position on ship side
    const speed = SHIP.CANNON_SPEED;
    const vx = Math.sin(yaw) * Math.cos(pitch) * speed;
    const vy = Math.sin(pitch) * speed + 5; // slight upward arc
    const vz = Math.cos(yaw) * Math.cos(pitch) * speed;

    const muzzle = this.getCannonMuzzlePosition(ship, cannonIndex, yaw, pitch);
    const proj: Projectile = {
      id: uuid(),
      type: projType,
      ownerId: player.id,
      ownerShipId: ship.id,
      position: muzzle,
      velocity: { x: vx, y: vy, z: vz },
      alive: true,
      age: 0,
      maxAge: 8,
      damage: SHIP.CANNON_DAMAGE_HULL
        * (ship.upgrades.some(u => u.type === 'charged_cannons') ? SHIP_UPGRADES.CANNON_DAMAGE_MULT : 1)
        * (usesSuperShot ? 5 : 1),
      knockback: 0,
      visualOnly: false,
      showImpact: true,
      special: usesSuperShot ? 'super_cannonball' : undefined,
    };

    this.pendingProjectiles.push(proj);
    return [proj];
  }

  startReload(player: Player) {
    const weapon = player.weapons[player.activeSlot];
    if (!weapon || weapon.reloading) return;
    const def = WEAPONS[weapon.weaponId];
    if (def.melee || weapon.ammo >= def.ammoMax) return;
    if (weapon.reserve <= 0) return; // nothing left to load — find an ammo pickup
    weapon.reloading = true;
    weapon.reloadTimer = def.reloadTime;
  }

  tickCannons(dt: number, ships: Ship[]) {
    for (const ship of ships) {
      for (let i = 0; i < ship.cannonCooldowns.length; i++) {
        if (ship.cannonCooldowns[i] > 0) {
          ship.cannonCooldowns[i] = Math.max(0, ship.cannonCooldowns[i] - dt);
        }
      }
    }
  }

  flushProjectiles(): Projectile[] {
    const out = this.pendingProjectiles.splice(0);
    return out;
  }

  queueProjectile(projectile: Projectile) {
    this.pendingProjectiles.push(projectile);
  }

  createDefaultWeapons(): Player['weapons'] {
    return [
      { weaponId: 'blunderbuss' as WeaponId, ammo: 1, reserve: 5, reloading: false, reloadTimer: 0 },
      { weaponId: 'eye_of_reach' as WeaponId, ammo: 1, reserve: 5, reloading: false, reloadTimer: 0 },
      { weaponId: 'flintknock' as WeaponId, ammo: 1, reserve: 5, reloading: false, reloadTimer: 0 },
      { weaponId: 'cutlass' as WeaponId, ammo: 0, reserve: 0, reloading: false, reloadTimer: 0 },
    ];
  }

  private getSpreadMultiplier(player: Player, weaponId: WeaponId, aiming: boolean) {
    const moveSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    let multiplier = 1;

    if (aiming) {
      multiplier *= weaponId === 'eye_of_reach' ? 0.12 : 0.55;
    } else if (weaponId === 'eye_of_reach') {
      multiplier *= 0.38;
    }

    if (player.state === 'swimming') {
      multiplier *= 1.7;
    } else if (moveSpeed > 0.1) {
      multiplier *= 1.35;
    } else {
      multiplier *= 0.92;
    }

    if (weaponId === 'blunderbuss') {
      multiplier *= aiming ? 0.82 : 1.08;
    }

    return multiplier;
  }

  private applyConeSpread(baseDirection: Vec3, spreadRad: number): Vec3 {
    const fallbackUp = Math.abs(baseDirection.y) > 0.96
      ? { x: 1, y: 0, z: 0 }
      : { x: 0, y: 1, z: 0 };
    const right = this.normalizeVector(this.cross(baseDirection, fallbackUp), { x: 1, y: 0, z: 0 });
    const up = this.normalizeVector(this.cross(right, baseDirection), { x: 0, y: 1, z: 0 });
    const yawOffset = (Math.random() - 0.5) * 2 * Math.tan(spreadRad);
    const pitchOffset = (Math.random() - 0.5) * 2 * Math.tan(spreadRad);
    return this.normalizeVector(
      {
        x: baseDirection.x + right.x * yawOffset + up.x * pitchOffset,
        y: baseDirection.y + right.y * yawOffset + up.y * pitchOffset,
        z: baseDirection.z + right.z * yawOffset + up.z * pitchOffset,
      },
      baseDirection,
    );
  }

  private normalizeVector(vector: Vec3, fallback: Vec3): Vec3 {
    const length = Math.hypot(vector.x, vector.y, vector.z);
    if (length < 0.0001) {
      return { ...fallback };
    }
    return {
      x: vector.x / length,
      y: vector.y / length,
      z: vector.z / length,
    };
  }

  private cross(a: Vec3, b: Vec3): Vec3 {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  /** Single source of truth for cannon muzzle placement — Match delegates here. */
  getCannonMuzzlePosition(ship: Ship, cannonIndex: number, yaw: number, pitch: number): Vec3 {
    const stats = SHIP_STATS[ship.type];
    const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
    const slotWithinSide = cannonIndex % cannonsPerSide;
    const starboardSide = cannonIndex < cannonsPerSide;
    const cannonSpacing = cannonsPerSide <= 1
      ? 0
      : stats.length * 0.5 / (cannonsPerSide - 1);
    const localX = (starboardSide ? 1 : -1) * (stats.width * 0.5 + 0.08);
    const localZ = stats.length * 0.2 - slotWithinSide * cannonSpacing;
    const baseX = ship.position.x + localX * Math.cos(ship.rotation) + localZ * Math.sin(ship.rotation);
    const baseY = ship.position.y + stats.height + 0.18;
    const baseZ = ship.position.z + localZ * Math.cos(ship.rotation) - localX * Math.sin(ship.rotation);
    return {
      x: baseX + Math.sin(yaw) * Math.cos(pitch) * 0.82,
      y: baseY + Math.sin(pitch) * 0.4,
      z: baseZ + Math.cos(yaw) * Math.cos(pitch) * 0.82,
    };
  }

  /** World yaw this cannon's broadside faces — bot gunnery and the aim clamp
   *  below share it so "which rail can hit the target" is a single truth. */
  getCannonBroadsideYaw(ship: Ship, cannonIndex: number): number {
    const cannonsPerSide = Math.max(1, SHIP_STATS[ship.type].cannonCount / 2);
    return ship.rotation + (cannonIndex < cannonsPerSide ? Math.PI * 0.5 : -Math.PI * 0.5);
  }

  private getConstrainedCannonAim(ship: Ship, cannonIndex: number, yaw: number, pitch: number) {
    const broadsideYaw = this.getCannonBroadsideYaw(ship, cannonIndex);
    return {
      yaw: broadsideYaw + Math.max(-SHIP.CANNON_YAW_ARC, Math.min(SHIP.CANNON_YAW_ARC, angleWrap(yaw - broadsideYaw))),
      pitch: Math.max(SHIP.CANNON_PITCH_MIN, Math.min(SHIP.CANNON_PITCH_MAX, pitch)),
    };
  }
}
