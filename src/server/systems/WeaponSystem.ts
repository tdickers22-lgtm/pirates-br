import { v4 as uuid } from 'uuid';
import type { CannonAmmoType, CannonLoadedShot, Player, Ship, Projectile, ProjectileType, Vec3, WeaponId } from '../../shared/types/index.js';
import { WEAPONS, SHIP, PLAYER, SHIP_UPGRADES, WRECKERS_GLASS_SPAWN_RESERVE } from '../../shared/constants/index.js';
import { angleWrap, degreesToRad } from '../../shared/utils/index.js';
import { getConstrainedCannonAim } from '../../shared/interactions.js';
import { truceRefusesCannon } from '../../shared/truce.js';
import { cannonLaunchVelocity, cannonMuzzlePosition, hullRatesOf } from '../../shared/ballistics.js';

/** Why a fire or reload press did nothing (b1.6e): Match turns it into an
 *  interact_refused nudge so a dead trigger or a dead R is never silent. */
export type WeaponRefusal = 'no_ammo' | 'truce' | 'unloaded';

/** D20 (b3.5b): seconds to ram one shot into a gun (R / gamepad X / touch Load,
 *  or the auto-load). It runs under the 3.5 s SHIP.CANNON_RELOAD barrel
 *  cooldown, so an auto-loader keeps today's 3.5 s cadence exactly. */
export const CANNON_LOAD_SECONDS = 1.6;

/** Stores item behind each cannon shot type. */
const CANNON_STORE_ITEM: Record<CannonAmmoType, string> = {
  cannonball: 'cannonball',
  chainshot: 'chainshot',
  firebomb: 'firebomb_ball',
};
/** D20 fallback order when the selected type is out: CHEAPEST stocked first
 *  (SHOP_PRICES: cannonball 30 < chainshot 90 < firebomb 130). */
export const CANNON_FALLBACK_ORDER: readonly CannonAmmoType[] = ['cannonball', 'chainshot', 'firebomb'];

/** What the last successful load rammed (Match turns it into 'cannon_loaded'). */
export interface CannonLoadRecord {
  shipId: string;
  cannonIndex: number;
  shot: CannonLoadedShot;
  selected: CannonAmmoType;
  fallback: boolean;
}

/** Size the per-gun load arrays to the battery (hand-built hulls, old saves). */
export function ensureCannonLoads(ship: Ship): { loaded: (CannonLoadedShot | null)[]; left: number[] } {
  const n = ship.cannonCooldowns.length;
  if (!ship.cannonLoaded) ship.cannonLoaded = [];
  if (!ship.cannonLoadLeft) ship.cannonLoadLeft = [];
  while (ship.cannonLoaded.length < n) ship.cannonLoaded.push(null);
  while (ship.cannonLoadLeft.length < n) ship.cannonLoadLeft.push(0);
  return { loaded: ship.cannonLoaded, left: ship.cannonLoadLeft };
}

/** 'empty' | 'loading' | 'loaded' for one gun (server and tests read the same). */
export function cannonLoadState(ship: Ship, cannonIndex: number): 'empty' | 'loading' | 'loaded' {
  const shot = ship.cannonLoaded?.[cannonIndex] ?? null;
  if (!shot) return 'empty';
  return (ship.cannonLoadLeft?.[cannonIndex] ?? 0) > 0 ? 'loading' : 'loaded';
}

/** Bots always auto-load (they obey the same load clock through the same path). */
export function autoLoadsCannons(player: Player): boolean {
  return player.isBot === true || player.autoLoadCannons === true;
}

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
  /** Match-seeded stream (RNG-01): shot spread draws from it. Unseeded it is
   *  Math.random. `clock` is the match's sim seconds since the horn (the truce
   *  clock); unwired it reads as long after the truce. */
  constructor(
    private readonly rng: () => number = Math.random,
    private readonly clock: () => number = () => Infinity,
  ) {}
  private pendingProjectiles: Projectile[] = [];
  /** Why the LAST tryFire / startReload call did nothing, or null when it
   *  acted (or had nothing to say). Single-threaded tick, read right after. */
  lastRefusal: WeaponRefusal | null = null;
  /** The load the LAST loadCannon / tryFire / autoLoadManned rammed, or null. */
  lastLoad: CannonLoadRecord | null = null;

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
    // Downed pirates crawl — weapons are locked until revived. A pirate on the
    // respawn clock is dead: no gun fires for a corpse (Match gates human input
    // earlier; this closes the bot ghost-helm path, BOT-02).
    this.lastRefusal = null;
    this.lastLoad = null;
    if (player.state === 'eliminated' || player.state === 'downed' || player.state === 'respawning') return [];

    // If player is at a cannon, fire ship cannon. THE TRUCE (b1.6e): the guns
    // stay cold for every crew until TRUCE_SECONDS; the press is refused.
    if (player.atCannon && ship) {
      if (truceRefusesCannon(this.clock())) {
        this.lastRefusal = 'truce';
        return [];
      }
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
    if (cannonIndex < 0 || cannonIndex >= ship.cannonCooldowns.length) return [];
    const loads = ensureCannonLoads(ship);
    const state = cannonLoadState(ship, cannonIndex);
    // D20 (b3.5b): a gun fires only what was rammed into it. An empty gun
    // under an auto-loader starts the load (the trigger IS the load button);
    // otherwise the trigger is a dry click that names R.
    if (state !== 'loaded') {
      if (state === 'empty') {
        if (autoLoadsCannons(player)) this.loadCannon(player, ship, cannonIndex);
        else this.lastRefusal = 'unloaded';
      }
      return [];
    }
    if (ship.cannonCooldowns[cannonIndex] > 0) return [];

    const shot = loads.loaded[cannonIndex] as CannonLoadedShot;
    const usesSuperShot = shot === 'super_cannonball';
    const projType: ProjectileType = usesSuperShot ? 'cannonball' : shot;
    loads.loaded[cannonIndex] = null;
    loads.left[cannonIndex] = 0;
    ship.cannonCooldowns[cannonIndex] = SHIP.CANNON_RELOAD;
    // Auto-load: ram the next shot straight away; it finishes under the
    // barrel cooldown. Out of stores is not this shot's refusal (it fired);
    // the NEXT trigger on the empty gun says no_ammo.
    if (autoLoadsCannons(player)) {
      this.loadCannon(player, ship, cannonIndex);
      this.lastRefusal = null;
    }

    const constrained = getConstrainedCannonAim(ship, cannonIndex, yaw, pitch);
    yaw = constrained.yaw;
    pitch = constrained.pitch;

    // D17 (b2.1f): the ball leaves along the barrel at the muzzle speed PLUS
    // everything the gun is doing: her way, omega x r and the heave / roll /
    // pitch rates the physics step measured. No invented upward kick.
    const muzzle = this.getCannonMuzzlePosition(ship, cannonIndex, yaw, pitch);
    const launch = cannonLaunchVelocity(ship, muzzle, yaw, pitch, hullRatesOf(ship));
    const vx = launch.x, vy = launch.y, vz = launch.z;
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

  /** D20: which shot a load takes from the stores. The selected type when
   *  stocked (cannonball selected spends the loader's banked super shot first,
   *  as before); else the CHEAPEST stocked type; null when every rack is empty.
   *  Super shots never stand in for another selected type. */
  pickCannonShot(player: Player, ship: Ship): { shot: CannonLoadedShot; fallback: boolean } | null {
    const selected = player.selectedCannonAmmo ?? 'cannonball';
    const stocked = (t: CannonAmmoType) => ship.inventory.some((s) => s.item === CANNON_STORE_ITEM[t] && s.qty > 0);
    if (selected === 'cannonball' && (player.superCannonballs ?? 0) > 0) return { shot: 'super_cannonball', fallback: false };
    if (stocked(selected)) return { shot: selected, fallback: false };
    for (const t of CANNON_FALLBACK_ORDER) if (stocked(t)) return { shot: t, fallback: true };
    return null;
  }

  /** D20: ram one shot into gun `cannonIndex` (R / gamepad X / touch Load, the
   *  auto-load, and bots all come here). Debits the stores NOW, then the gun is
   *  loaded after CANNON_LOAD_SECONDS whether or not the loader stays. Returns
   *  true when a load started; a gun already loaded or loading is a silent no;
   *  every rack empty sets lastRefusal = 'no_ammo'. */
  loadCannon(player: Player, ship: Ship, cannonIndex: number): boolean {
    this.lastLoad = null;
    if (cannonIndex < 0 || cannonIndex >= ship.cannonCooldowns.length) return false;
    if (player.state === 'eliminated' || player.state === 'downed' || player.state === 'respawning') return false;
    const loads = ensureCannonLoads(ship);
    if (cannonLoadState(ship, cannonIndex) !== 'empty') return false;
    const pick = this.pickCannonShot(player, ship);
    if (!pick) {
      this.lastRefusal = 'no_ammo';
      return false;
    }
    if (pick.shot === 'super_cannonball') {
      player.superCannonballs = Math.max(0, player.superCannonballs - 1);
    } else {
      const item = CANNON_STORE_ITEM[pick.shot];
      const idx = ship.inventory.findIndex((s) => s.item === item && s.qty > 0);
      ship.inventory[idx].qty--;
      if (ship.inventory[idx].qty <= 0) ship.inventory.splice(idx, 1);
    }
    loads.loaded[cannonIndex] = pick.shot;
    loads.left[cannonIndex] = CANNON_LOAD_SECONDS;
    this.lastLoad = {
      shipId: ship.id,
      cannonIndex,
      shot: pick.shot,
      selected: player.selectedCannonAmmo ?? 'cannonball',
      fallback: pick.fallback,
    };
    return true;
  }

  /** D20 auto-load for a pirate manning a gun: an empty barrel under an
   *  auto-loader starts loading (entering the gun, or stores restocked). Silent
   *  when the racks are empty; the trigger reports that. */
  autoLoadManned(player: Player, ship: Ship): boolean {
    this.lastLoad = null;
    if (!player.atCannon || !autoLoadsCannons(player)) return false;
    if (cannonLoadState(ship, player.cannonIndex) !== 'empty') return false;
    const prev = this.lastRefusal;
    const started = this.loadCannon(player, ship, player.cannonIndex);
    this.lastRefusal = prev;
    return started;
  }

  /** The ammo crate: every firearm back to a full magazine and reserve, reloads
   *  cancelled — the one refill path in the game (Match's [X] 'ammo' interaction
   *  and BotSystem.maybeTopUpAmmo both mean exactly this). Returns whether
   *  anything actually changed. */
  refillFirearms(player: Player): boolean {
    let refilled = false;
    for (const weapon of player.weapons) {
      if (!weapon || WEAPONS[weapon.weaponId].melee) continue;
      const def = WEAPONS[weapon.weaponId];
      if (weapon.ammo < def.ammoMax || weapon.reserve < def.reserveMax || weapon.reloading) refilled = true;
      weapon.ammo = def.ammoMax;
      weapon.reserve = def.reserveMax;
      weapon.reloading = false;
      weapon.reloadTimer = 0;
    }
    return refilled;
  }

  /** Returns null when a reload started (or none was needed: melee, a full
   *  magazine, one already under way) and 'no_ammo' when the magazine wants
   *  shot and the reserve is empty (ammo crate aboard refills). The reason is
   *  also left in lastRefusal for the fire path. */
  startReload(player: Player): WeaponRefusal | null {
    const weapon = player.weapons[player.activeSlot];
    if (!weapon || weapon.reloading) return null;
    const def = WEAPONS[weapon.weaponId];
    if (def.melee || weapon.ammo >= def.ammoMax) return null;
    if (weapon.reserve <= 0) {
      this.lastRefusal = 'no_ammo';
      return 'no_ammo';
    }
    weapon.reloading = true;
    weapon.reloadTimer = def.reloadTime;
    return null;
  }

  tickCannons(dt: number, ships: Ship[]) {
    for (const ship of ships) {
      for (let i = 0; i < ship.cannonCooldowns.length; i++) {
        if (ship.cannonCooldowns[i] > 0) {
          ship.cannonCooldowns[i] = Math.max(0, ship.cannonCooldowns[i] - dt);
        }
      }
      // D20: the load clock (arrays sized here so every hull ships them).
      const loads = ensureCannonLoads(ship);
      for (let i = 0; i < loads.left.length; i++) {
        if (loads.left[i] > 0) loads.left[i] = Math.max(0, loads.left[i] - dt);
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
      { weaponId: 'eye_of_reach' as WeaponId, ammo: 1, reserve: WRECKERS_GLASS_SPAWN_RESERVE, reloading: false, reloadTimer: 0 },
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
    const yawOffset = (this.rng() - 0.5) * 2 * Math.tan(spreadRad);
    const pitchOffset = (this.rng() - 0.5) * 2 * Math.tan(spreadRad);
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
    return cannonMuzzlePosition(ship, cannonIndex, yaw, pitch);
  }

}
