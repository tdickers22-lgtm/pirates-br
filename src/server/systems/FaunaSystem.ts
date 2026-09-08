import { v4 as uuid } from 'uuid';
import type { GameState, Island, Player, SeaRock, Shark, Ship, Vec3, WildlifeAnimal, WildlifeType } from '../../shared/types/index.js';
import { SHARK, SHIP_STATS, WILDLIFE, WORLD } from '../../shared/constants/index.js';
import {
  WAVE_PARAMS,
  dist2D,
  gerstnerHeight,
  getIslandSurfaceY,
  getSeaRockBoundsRadius,
  getSeaRockColliders,
  getStormWaveIntensity,
  isInsideSwimHullFootprint,
  isPointInsideIslandFootprint,
  pushOutOfSwimHullFootprint,
  randRange,
  seaRockColliderWorldCenter,
} from '../../shared/utils/index.js';
import { toShipLocalPoint, toShipWorldPoint } from '../../shared/interactions.js';
import { resolveWalkerAgainstIsland, type WalkerLimits, type WalkerStep } from '../../shared/locomotion.js';

/** How each animal is allowed to walk (WILD-01 slice c). Built once at module
 *  load: a fresh limits object per animal per tick would be 70 allocations a
 *  tick for five numbers that never change. */
const WALK_LIMITS: Record<WildlifeType, WalkerLimits> = {
  crab: { radius: WILDLIFE.HIT_RADIUS.crab, footprintPad: -2, minGroundY: WILDLIFE.MIN_GROUND_Y.crab, maxSlope: WILDLIFE.MAX_STEP_SLOPE, cavePad: WILDLIFE.CAVE_PAD },
  chicken: { radius: WILDLIFE.HIT_RADIUS.chicken, footprintPad: -2, minGroundY: WILDLIFE.MIN_GROUND_Y.chicken, maxSlope: WILDLIFE.MAX_STEP_SLOPE, cavePad: WILDLIFE.CAVE_PAD },
  pig: { radius: WILDLIFE.HIT_RADIUS.pig, footprintPad: -2, minGroundY: WILDLIFE.MIN_GROUND_Y.pig, maxSlope: WILDLIFE.MAX_STEP_SLOPE, cavePad: WILDLIFE.CAVE_PAD },
  // A perched gull potters on foot and obeys the same ground rules; a flying
  // one is resolved by the state machine and never asks.
  gull: { radius: WILDLIFE.HIT_RADIUS.gull, footprintPad: -2, minGroundY: WILDLIFE.MIN_GROUND_Y.gull, maxSlope: WILDLIFE.MAX_STEP_SLOPE, cavePad: WILDLIFE.CAVE_PAD },
};

/**
 * Every living thing in the world that is not a pirate.
 *
 * Lifted VERBATIM out of Match.ts (WILD-01 slice a, the split-as-you-touch rule
 * in PLAN 2.7): `updateSharks` and `updateWildlife` were 250 lines of animal AI
 * living inside the 8.7k-line match object, and every later wildlife slice
 * (flee, gull states, carcasses, walker collision) would have grown them there.
 * The tick order is unchanged — Match still calls sharks then wildlife, in the
 * same place in `tick`, with the same `dt`.
 *
 * The system owns no world state: it is handed `state` per call and reaches back
 * into the match only through `FaunaHooks` (player lookup + the damage ledger),
 * so it stays as testable as the pure systems around it.
 */
/** The only damage cause fauna can file. Match's own DamageSource union is a
 *  superset, so Match satisfies these hooks by passing its methods straight in. */
type FaunaDamageSource = 'shark';

export interface FaunaHooks {
  /** Match clock, seconds. */
  now(): number;
  getPlayer(id: string | null | undefined): Player | null;
  absorbWithArmor(target: Player, amount: number): number;
  noteDamageSource(playerId: string, source: FaunaDamageSource): void;
  noteEnvironmentalDamage(player: Player, source: FaunaDamageSource, amount: number, origin?: Vec3): void;
}

/** How deep in the hull section a shark is resolved: half-way down the bilge
 *  curve, which is where its body actually is under the waterline. */
const SHARK_HULL_VERTICAL_T = 0.5;

export class FaunaSystem {
  private sharkSpawnCooldown = 0;
  /** Reused per tick — never reallocated in the 62.5 Hz shark loop. */
  private readonly swimmers: Player[] = [];
  private readonly separationOrder: Shark[] = [];
  /** One reused walker result — the wander runs 70 times a tick forever. */
  private readonly stepOut: WalkerStep = { x: 0, z: 0, groundY: 0, blocked: false, reason: 'none' };

  constructor(private readonly rng: () => number, private readonly hooks: FaunaHooks) {}

  /** Seconds until the next shark may spawn — Match reads/writes nothing here,
   *  but the sinking-scene suites assert the cooldown exists. */
  get spawnCooldown(): number {
    return this.sharkSpawnCooldown;
  }

  updateSharks(dt: number, state: GameState) {
    const { sharks, players } = state;
    // The sea the shark swims in is the sea the client DRAWS: same gerstner
    // sample, same clock, same storm term (physics-29).
    const t = this.hooks.now();
    this.sharkSpawnCooldown = Math.max(0, this.sharkSpawnCooldown - dt);

    // Reused, never reallocated: this loop runs at 62.5 Hz for the whole match.
    const swimmers = this.swimmers;
    swimmers.length = 0;
    for (const p of players) {
      if (p.state === 'swimming' && p.health > 0) swimmers.push(p);
    }

    if (sharks.length < SHARK.MAX_WORLD && this.sharkSpawnCooldown <= 0 && this.rng() < SHARK.SPAWN_CHANCE_PER_TICK) {
      let eligible = 0;
      for (const p of swimmers) if (p.swimTimer >= SHARK.SPAWN_SWIM_GRACE) eligible++;
      if (eligible > 0) {
        let pick = Math.floor(this.rng() * eligible);
        let chosen: Player | null = null;
        for (const p of swimmers) {
          if (p.swimTimer < SHARK.SPAWN_SWIM_GRACE) continue;
          if (pick-- === 0) { chosen = p; break; }
        }
        if (chosen) this.trySpawnSharkNear(state, chosen, t);
      }
    }

    for (let i = sharks.length - 1; i >= 0; i--) {
      const s = sharks[i];
      if (s.health <= 0) {
        sharks.splice(i, 1);
        continue;
      }
      // A shark that has given up glides out, fading, and then it is gone: the
      // 4-slot cap used to fill with sharks parked where somebody swam ten
      // minutes ago, so late swimmers never met one (bots-10).
      if (s.despawnTimer !== undefined) {
        s.despawnTimer -= dt;
        if (s.despawnTimer <= 0) {
          sharks.splice(i, 1);
          continue;
        }
      }
      s.biteCooldown = Math.max(0, s.biteCooldown - dt);
      if (s.anchorX === undefined || s.anchorZ === undefined) {
        s.anchorX = s.position.x;
        s.anchorZ = s.position.z;
      }

      let target = this.hooks.getPlayer(s.targetId);
      if (target && (target.state !== 'swimming' || target.health <= 0)) target = null;
      // ── The leash ────────────────────────────────────────────────────────
      // CHASE_SPEED (5.4) beats PLAYER.SWIM_SPEED (5.2), so a chase the shark
      // never abandons is a chase no swimmer can survive except by boarding.
      // Open 60 m of water between the shark and where it took you and it
      // turns away: swimming for it is a real out, and a shark can no longer
      // follow you across the map.
      if (target && dist2D(s.position.x, s.position.z, s.anchorX, s.anchorZ) > SHARK.LEASH_RANGE) {
        target = null;
        this.beginDespawn(s);
      }

      if (!target && s.despawnTimer === undefined) {
        let best: Player | null = null;
        let bestD = Infinity;
        for (const pl of swimmers) {
          const d = dist2D(pl.position.x, pl.position.z, s.position.x, s.position.z);
          if (d < bestD) { bestD = d; best = pl; }
        }
        if (best && bestD <= SHARK.AGGRO_RANGE) {
          // A new hunt re-anchors the leash where the shark stands now.
          target = best;
          s.targetId = best.id;
          s.anchorX = s.position.x;
          s.anchorZ = s.position.z;
          s.idleTime = 0;
        } else {
          s.targetId = null;
          s.idleTime = (s.idleTime ?? 0) + dt;
          if (s.idleTime > SHARK.DESPAWN_IDLE_TIME || (best !== null && bestD > SHARK.DESPAWN_RANGE)) {
            this.beginDespawn(s);
          }
        }
      } else if (target) {
        s.idleTime = 0;
      }

      if (!target && s.attackState === 'cruise') {
        // Frame-rate-independent decay preserving the previous per-16ms feel.
        const idleDamp = Math.pow(0.92, dt / 0.016);
        s.velocity.x *= idleDamp;
        s.velocity.z *= idleDamp;
        s.position.x += s.velocity.x * dt;
        s.position.z += s.velocity.z * dt;
        this.settleShark(s, state, t);
        continue;
      }

      // ── Telegraphed attack state machine ──────────────────────────────────
      // cruise → (in range, off cooldown) windup: hard brake, aim LOCKED at the
      // target's position at windup start → lunge: dash along the locked vector,
      // biting anything (the target) inside LUNGE_HIT_RADIUS → recover: drift,
      // harmless. A swimmer strafing perpendicular during the windup leaves the
      // lunge corridor — the bite is dodgeable, unlike the old proximity check.
      // A target lost mid-attack (boarded, died) still plays the phase out.
      const dx = target ? target.position.x - s.position.x : 0;
      const dz = target ? target.position.z - s.position.z : 0;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      switch (s.attackState) {
        case 'cruise': {
          s.rotation = Math.atan2(dx, dz);
          s.velocity.x = (dx / d) * SHARK.CHASE_SPEED;
          s.velocity.z = (dz / d) * SHARK.CHASE_SPEED;
          break;
        }
        case 'windup': {
          const brake = Math.pow(0.85, dt / 0.016);
          s.velocity.x *= brake;
          s.velocity.z *= brake;
          s.attackTimer -= dt;
          if (s.attackTimer <= 0) {
            s.attackState = 'lunge';
            s.attackTimer = SHARK.LUNGE_TIME;
          }
          break;
        }
        case 'lunge': {
          s.velocity.x = s.lungeDirX * SHARK.LUNGE_SPEED;
          s.velocity.z = s.lungeDirZ * SHARK.LUNGE_SPEED;
          s.attackTimer -= dt;
          break;
        }
        case 'recover': {
          const drift = Math.pow(0.9, dt / 0.016);
          s.velocity.x *= drift;
          s.velocity.z *= drift;
          s.attackTimer -= dt;
          if (s.attackTimer <= 0) s.attackState = 'cruise';
          break;
        }
      }
      s.position.x += s.velocity.x * dt;
      s.position.z += s.velocity.z * dt;

      const inLand = this.settleShark(s, state, t);

      // Only wind up from open water (not from inside the shore rock) — the
      // 1.9× bite range gives the windup brake room before the lunge fires.
      if (
        s.attackState === 'cruise'
        && target
        && !inLand
        && s.despawnTimer === undefined
        && d < SHARK.BITE_RANGE * 1.9
        && s.biteCooldown <= 0
      ) {
        s.attackState = 'windup';
        s.attackTimer = SHARK.WINDUP_TIME;
        s.lungeDirX = dx / d;
        s.lungeDirZ = dz / d;
        s.rotation = Math.atan2(s.lungeDirX, s.lungeDirZ);
      }

      // The lunge only connects while dashing: CURRENT distance to the target,
      // one bite max, then straight into the vulnerable recover drift.
      if (s.attackState === 'lunge') {
        if (target && dist2D(target.position.x, target.position.z, s.position.x, s.position.z) < SHARK.LUNGE_HIT_RADIUS) {
          this.hooks.noteDamageSource(target.id, 'shark');
          const bite = this.hooks.absorbWithArmor(target, SHARK.BITE_DAMAGE);
          target.health -= bite;
          // A shark bite took a fifth of your health and put NOTHING on screen —
          // no number, no name, no bearing. It is the one environmental source
          // with real jaws, so the wedge points at them.
          this.hooks.noteEnvironmentalDamage(target, 'shark', bite, {
            x: s.position.x, y: s.position.y + 0.4, z: s.position.z,
          });
          // Filed, not wiped (CREDIT-01): a pirate knocked overboard and then
          // taken by a shark was somebody's play, and the feed owes them the
          // kill. The CAUSE stays 'shark' through lastDamageSourceById above.
          target.lastEnvDamage = { cause: 'shark', at: this.hooks.now() };
          s.biteCooldown = SHARK.BITE_COOLDOWN;
          s.attackState = 'recover';
          s.attackTimer = SHARK.RECOVER_TIME;
          // Bite stagger (liveplay-12): the second jaw on the same swimmer
          // waits half a cooldown, so a pack is a sequence of dodgeable bites
          // and not two hits on one tick.
          for (const other of sharks) {
            if (other === s || other.targetId !== target.id) continue;
            other.biteCooldown = Math.max(other.biteCooldown, SHARK.BITE_COOLDOWN * 0.5);
          }
        } else if (s.attackTimer <= 0) {
          s.attackState = 'recover';
          s.attackTimer = SHARK.RECOVER_TIME;
        }
      }
    }

    this.separateSharks(sharks, dt);
    // Separation moved them; re-seat every shark on the sea and out of the
    // solids one last time so no shark ends the tick inside a hull or a rock.
    for (const s of sharks) this.settleShark(s, state, t);
  }

  /** Put a spawned shark in open water near a swimmer, or leave the slot free. */
  private trySpawnSharkNear(state: GameState, p: Player, t: number) {
    const { sharks, islands } = state;
    const ang = this.rng() * Math.PI * 2;
    const dist = randRange(SHARK.SPAWN_MIN_DIST, SHARK.SPAWN_MAX_DIST, this.rng);
    const x = p.position.x + Math.sin(ang) * dist;
    const z = p.position.z + Math.cos(ang) * dist;
    if (Math.abs(x) >= WORLD.HALF - 24 || Math.abs(z) >= WORLD.HALF - 24) return;
    for (const island of islands) {
      // ONE margin with the shove (bots-18): a shark spawned in the 2.8-4 m
      // band used to be teleported out of the terrain on its very first tick.
      if (isPointInsideIslandFootprint(island, x, z, SHARK.SHORE_MARGIN)) return;
    }
    for (const shark of sharks) {
      if (dist2D(shark.position.x, shark.position.z, x, z) < SHARK.SPAWN_MIN_DIST) return;
    }
    sharks.push({
      id: uuid(),
      position: { x, y: this.seaY(state, x, z, t), z },
      rotation: 0,
      velocity: { x: 0, y: 0, z: 0 },
      health: SHARK.HEALTH,
      biteCooldown: 1.2,
      attackState: 'cruise',
      attackTimer: 0,
      lungeDirX: 0,
      lungeDirZ: 0,
      targetId: p.id,
      anchorX: x,
      anchorZ: z,
      idleTime: 0,
    });
    this.sharkSpawnCooldown = randRange(SHARK.SPAWN_COOLDOWN_MIN, SHARK.SPAWN_COOLDOWN_MAX, this.rng);
  }

  /** The shark has given up. It glides out while the client fades it. */
  private beginDespawn(s: Shark) {
    if (s.despawnTimer !== undefined) return;
    s.despawnTimer = SHARK.DESPAWN_FADE;
    s.targetId = null;
    s.attackState = 'cruise';
    s.attackTimer = 0;
  }

  /** The drawn sea surface at (x, z) — the SAME sample the ocean shader takes. */
  private seaY(state: GameState, x: number, z: number, t: number): number {
    const sea = getStormWaveIntensity(state.storm, x, z);
    return gerstnerHeight(x, z, t, WAVE_PARAMS, sea) - SHARK.SURFACE_DEPTH;
  }

  /** Resolve one shark against the solid world and seat it on the sea.
   *  Returns true when it was inside an island footprint (windup is suppressed
   *  there — a shark biting from inside the shore rock reads as random damage).
   *  Order is land → hull → rock → surface: the last constraint wins, and the
   *  surface is the one no other constraint can violate. */
  private settleShark(s: Shark, state: GameState, t: number): boolean {
    const inLand = this.shoveSharkOutOfLand(s, state.islands);
    this.shoveSharkOutOfHulls(s, state.ships);
    this.shoveSharkOutOfRocks(s, state.seaRocks, state, t);
    s.position.y = this.seaY(state, s.position.x, s.position.z, t);
    return inLand;
  }

  /** Sharks stay in OPEN WATER. The old shove was 60 m of pure radial push from
   *  the island CENTRE, and islands reach 157 m: on a lobed island a shark
   *  stayed buried and crept at a quarter speed under the terrain (bots-18).
   *  Now it walks DOWNHILL along the surface gradient (which always reaches the
   *  sea) with a radial bias, then falls back to a radial shove long enough to
   *  clear any footprint, and despawns if even that fails. */
  private shoveSharkOutOfLand(s: Shark, islands: Island[]): boolean {
    let inLand = false;
    for (let pass = 0; pass < 3; pass++) {
      let movedThisPass = false;
      for (const island of islands) {
        if (!isPointInsideIslandFootprint(island, s.position.x, s.position.z, SHARK.SHORE_MARGIN)) continue;
        inLand = true;
        movedThisPass = true;
        let px = s.position.x;
        let pz = s.position.z;
        let dirX = 0;
        let dirZ = 0;
        for (let step = 0; step < 60; step++) {
          if (!isPointInsideIslandFootprint(island, px, pz, SHARK.SHORE_MARGIN)) break;
          if (step % 5 === 0) {
            // Downhill = toward the water, on every lobe shape, unlike radial.
            const gx = getIslandSurfaceY(island, px + 2, pz) - getIslandSurfaceY(island, px - 2, pz);
            const gz = getIslandSurfaceY(island, px, pz + 2) - getIslandSurfaceY(island, px, pz - 2);
            const gl = Math.hypot(gx, gz);
            const rx = px - island.position.x;
            const rz = pz - island.position.z;
            const rl = Math.hypot(rx, rz) || 1;
            const bx = (gl > 1e-4 ? -gx / gl : rx / rl) * 0.65 + (rx / rl) * 0.35;
            const bz = (gl > 1e-4 ? -gz / gl : rz / rl) * 0.65 + (rz / rl) * 0.35;
            const bl = Math.hypot(bx, bz) || 1;
            dirX = bx / bl;
            dirZ = bz / bl;
          }
          px += dirX * 1.5;
          pz += dirZ * 1.5;
        }
        if (isPointInsideIslandFootprint(island, px, pz, SHARK.SHORE_MARGIN)) {
          // Straight out from the centre is monotone in distance-from-centre,
          // so 180 m clears every footprint on the roster (max radius 157 m).
          const ax = s.position.x - island.position.x;
          const az = s.position.z - island.position.z;
          const al = Math.hypot(ax, az) || 1;
          px = s.position.x;
          pz = s.position.z;
          for (let step = 0; step < 120 && isPointInsideIslandFootprint(island, px, pz, SHARK.SHORE_MARGIN); step++) {
            px += (ax / al) * 1.5;
            pz += (az / al) * 1.5;
          }
        }
        s.position.x = px;
        s.position.z = pz;
        s.velocity.x *= 0.25;
        s.velocity.z *= 0.25;
      }
      if (!movedThisPass) break;
    }
    // Shoved out of one lobe and into another three times over: the shark is in
    // terrain nobody can see it in, so it leaves rather than bite from inside.
    for (const island of islands) {
      if (isPointInsideIslandFootprint(island, s.position.x, s.position.z, SHARK.SHORE_MARGIN)) {
        this.beginDespawn(s);
        break;
      }
    }
    return inLand;
  }

  /** A hull is solid to a shark, exactly as it is to the swimmer hiding under
   *  it (physics-29): same shared swim footprint, same push-out, so the shark
   *  slides along the planking instead of passing through it. */
  private shoveSharkOutOfHulls(s: Shark, ships: Ship[]) {
    for (const ship of ships) {
      if (!ship.alive || ship.sinking) continue;
      const stats = SHIP_STATS[ship.type];
      const local = toShipLocalPoint(s.position, ship);
      if (!isInsideSwimHullFootprint(stats, local.x, local.z, SHARK.HULL_MARGIN, SHARK_HULL_VERTICAL_T)) continue;
      const out = pushOutOfSwimHullFootprint(stats, local.x, local.z, SHARK.HULL_MARGIN, SHARK_HULL_VERTICAL_T);
      if (!out.pushed) continue;
      const w = toShipWorldPoint({ x: out.x, z: out.z }, ship);
      const pushX = w.x - s.position.x;
      const pushZ = w.z - s.position.z;
      s.position.x = w.x;
      s.position.z = w.z;
      const pl = Math.hypot(pushX, pushZ);
      if (pl <= 0.002) continue;
      const nx = pushX / pl;
      const nz = pushZ / pl;
      const into = s.velocity.x * nx + s.velocity.z * nz;
      if (into < 0) {
        s.velocity.x -= into * nx;
        s.velocity.z -= into * nz;
      }
    }
  }

  /** Sea stacks are solid too — the same cylinder set the player is resolved
   *  against, so a shark cannot cruise through a rock a swimmer is sheltering
   *  behind. */
  private shoveSharkOutOfRocks(s: Shark, seaRocks: SeaRock[], state: GameState, t: number) {
    const surfaceY = this.seaY(state, s.position.x, s.position.z, t);
    for (const rock of seaRocks) {
      if (dist2D(s.position.x, s.position.z, rock.position.x, rock.position.z)
        > getSeaRockBoundsRadius(rock) + SHARK.HIT_RADIUS + SHARK.ROCK_MARGIN) continue;
      for (const collider of getSeaRockColliders(rock)) {
        const minY = rock.position.y + collider.minY;
        const maxY = rock.position.y + collider.maxY;
        // The shark's body spans the collar either side of the surface it swims
        // under; a rock whose cylinder is entirely above or below it is no wall.
        if (surfaceY + 0.6 < minY || surfaceY - 1.2 > maxY) continue;
        const center = seaRockColliderWorldCenter(rock, collider);
        const radius = collider.radius + SHARK.HIT_RADIUS + SHARK.ROCK_MARGIN;
        const dx = s.position.x - center.x;
        const dz = s.position.z - center.z;
        const d = Math.hypot(dx, dz);
        if (d >= radius) continue;
        const nx = d > 0.001 ? dx / d : 1;
        const nz = d > 0.001 ? dz / d : 0;
        s.position.x = center.x + nx * radius;
        s.position.z = center.z + nz * radius;
        const into = s.velocity.x * nx + s.velocity.z * nz;
        if (into < 0) {
          s.velocity.x -= into * nx;
          s.velocity.z -= into * nz;
        }
      }
    }
  }

  /** Two sharks chasing one swimmer used to collapse onto the same coordinates:
   *  one fin, two bites on the same tick (liveplay-12). Pairs are separated in
   *  a fixed id order so the result is identical on every replay. */
  private separateSharks(sharks: Shark[], dt: number) {
    if (sharks.length < 2) return;
    const order = this.separationOrder;
    order.length = 0;
    for (const s of sharks) order.push(s);
    order.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let a = 0; a < order.length; a++) {
      for (let b = a + 1; b < order.length; b++) {
        const p = order[a];
        const q = order[b];
        let dx = q.position.x - p.position.x;
        let dz = q.position.z - p.position.z;
        let d = Math.hypot(dx, dz);
        if (d >= SHARK.SEPARATION_RANGE) continue;
        if (d < 1e-4) {
          // Exactly stacked: split them along a fixed axis rather than 0/0.
          dx = 1;
          dz = 0;
          d = 1e-4;
        }
        const nx = dx / d;
        const nz = dz / d;
        const half = (SHARK.SEPARATION_RANGE - d) * 0.5;
        p.position.x -= nx * half;
        p.position.z -= nz * half;
        q.position.x += nx * half;
        q.position.z += nz * half;
        const impulse = SHARK.SEPARATION_PUSH * Math.min(1, dt * 8);
        p.velocity.x -= nx * impulse;
        p.velocity.z -= nz * impulse;
        q.velocity.x += nx * impulse;
        q.velocity.z += nz * impulse;
      }
    }
  }
  /**
   * A gunshot is the loudest thing on an island: everything inside
   * SHOT_ALERT_RADIUS of the muzzle bolts, whether or not the ball found it
   * (islandworld-07). Called once per firearm trace from Match.
   */
  alertToShot(state: GameState, x: number, z: number) {
    const t = this.hooks.now();
    const r2 = WILDLIFE.SHOT_ALERT_RADIUS * WILDLIFE.SHOT_ALERT_RADIUS;
    for (const animal of state.wildlife) {
      if (animal.health <= 0) continue;
      const dx = animal.position.x - x;
      const dz = animal.position.z - z;
      if (dx * dx + dz * dz > r2) continue;
      this.spook(animal, x, z, t);
    }
  }

  /** Mark an animal spooked and remember what spooked it. */
  private spook(animal: WildlifeAnimal, fromX: number, fromZ: number, t: number) {
    animal.alertUntil = t + WILDLIFE.ALERT_SECONDS;
    animal.fleeX = fromX;
    animal.fleeZ = fromZ;
    // A spooked gull is a gull ON THE WING, always.
    if (animal.type === 'gull' && animal.gullState !== 'circling') {
      animal.gullState = 'circling';
      animal.gullTimer = WILDLIFE.GULL.CIRCLE_MIN;
      animal.gullRadius = animal.gullRadius ?? WILDLIFE.GULL.RADIUS_MIN;
      animal.gullAltitude = animal.gullAltitude ?? WILDLIFE.GULL.ALTITUDE_MIN;
      animal.gullAngle = animal.gullAngle ?? Math.atan2(
        animal.position.z - animal.spawnPosition.z,
        animal.position.x - animal.spawnPosition.x,
      );
    }
  }

  /**
   * Nearest ALIVE pirate on foot inside this animal's flee radius, if any.
   * One squared-distance pass per animal per tick (70 x 12 multiplies at 30 Hz
   * on the server, nothing on any client tier).
   */
  private senseThreat(animal: WildlifeAnimal, players: Player[], t: number) {
    const r = WILDLIFE.FLEE_RADIUS[animal.type];
    const r2 = r * r;
    let bestD2 = r2;
    let bestX = 0;
    let bestZ = 0;
    let found = false;
    for (const p of players) {
      if (p.state !== 'alive') continue;
      const dx = p.position.x - animal.position.x;
      const dz = p.position.z - animal.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD2) continue;
      bestD2 = d2;
      bestX = p.position.x;
      bestZ = p.position.z;
      found = true;
    }
    if (found) this.spook(animal, bestX, bestZ, t);
  }

  updateWildlife(dt: number, state: GameState) {
    const t = this.hooks.now();
    const players = state.players;
    let expired = false;

    for (const animal of state.wildlife) {
      // ── Carcasses (islandworld-09) ───────────────────────────────────────
      // A shot pig used to be deleted the same tick and the client painted the
      // SHARK death bloom over the hole it left. Now it lies where it fell.
      if (animal.health <= 0) {
        if (animal.deadAt === undefined) {
          animal.deadAt = t;
          animal.dead = true;
          animal.alert = undefined;
          animal.alertUntil = undefined;
          animal.velocity.x = 0;
          animal.velocity.y = 0;
          animal.velocity.z = 0;
        }
        if (t - animal.deadAt > WILDLIFE.CARCASS_SECONDS) expired = true;
        continue;
      }

      const island = state.islands.find((candidate) => candidate.id === animal.islandId);
      if (!island) {
        animal.health = 0;
        continue;
      }

      // ── Awareness (islandworld-07) ───────────────────────────────────────
      this.senseThreat(animal, players, t);
      const alerted = (animal.alertUntil ?? 0) > t;
      // Wire bit: `undefined` when calm, so a calm world costs zero bytes.
      animal.alert = alerted ? true : undefined;

      if (animal.type === 'gull') {
        this.updateGull(animal, island, dt, alerted);
        continue;
      }

      animal.wanderTimer -= dt;
      if (animal.wanderTimer <= 0) {
        const homeAngle = Math.atan2(animal.spawnPosition.z - animal.position.z, animal.spawnPosition.x - animal.position.x);
        const farFromHome = dist2D(animal.position.x, animal.position.z, animal.spawnPosition.x, animal.spawnPosition.z) > island.radius * 0.32;
        animal.wanderAngle = farFromHome
          ? homeAngle + randRange(-0.55, 0.55, this.rng)
          : animal.wanderAngle + randRange(-1.35, 1.35, this.rng);
        animal.wanderTimer = randRange(0.7, 3.0, this.rng);
      }

      // A crab does not run: it stops dead and burrows (islandworld-07).
      const burrowing = alerted && animal.type === 'crab';
      if (alerted && !burrowing) {
        // Re-aimed every tick so a pirate who keeps walking keeps being fled
        // FROM, instead of the animal running a fixed bearing into him.
        animal.wanderAngle = Math.atan2(
          animal.position.z - (animal.fleeZ ?? animal.position.z),
          animal.position.x - (animal.fleeX ?? animal.position.x),
        );
        animal.wanderTimer = Math.max(animal.wanderTimer, 0.25);
      }

      const speed = burrowing
        ? 0
        : WILDLIFE.SPEED[animal.type] * (alerted ? WILDLIFE.FLEE_SPEED_MULT : 1);
      const moveScale = animal.type === 'crab' && !alerted
        ? (0.55 + Math.abs(Math.sin(t * 3.5 + animal.position.x)) * 0.55)
        : 1;
      const vx = Math.cos(animal.wanderAngle) * speed * moveScale;
      const vz = Math.sin(animal.wanderAngle) * speed * moveScale;
      const nextX = animal.position.x + vx * dt;
      const nextZ = animal.position.z + vz * dt;
      // THE WALKER, not a footprint test (islandworld-11/32/34, physics-31).
      // Spawn placement always refused water and cave mouths; the wander loop
      // never did, so a pig strolled into an archipelago saddle and was drawn
      // 3 m under the sea, chickens climbed 60-degree flanks, and everything
      // walked through palms, boulders and tent walls.
      const step = speed > 0
        ? resolveWalkerAgainstIsland(
          island,
          animal.position.x, animal.position.z, animal.position.y - 0.06,
          nextX, nextZ,
          WALK_LIMITS[animal.type],
          this.stepOut,
        )
        : null;

      if (step && !step.blocked) {
        animal.position.x = step.x;
        animal.position.z = step.z;
        animal.velocity.x = vx;
        animal.velocity.z = vz;
      } else {
        if (step) {
          // A shove out of a prop still moves it — that is how a walker that
          // spawned inside a collider gets free instead of vibrating in it.
          animal.position.x = step.x;
          animal.position.z = step.z;
          animal.wanderAngle += Math.PI + randRange(-0.45, 0.45, this.rng);
        }
        animal.velocity.x = 0;
        animal.velocity.z = 0;
      }

      animal.position.y = (step ? step.groundY : getIslandSurfaceY(island, animal.position.x, animal.position.z)) + 0.06;

      if (Math.abs(animal.velocity.x) + Math.abs(animal.velocity.z) > 0.01) {
        animal.rotation = Math.atan2(animal.velocity.x, animal.velocity.z);
      }
    }

    // Only when something actually aged out — the old unconditional filter
    // allocated a fresh 70-element array 30 times a second forever.
    if (expired) {
      state.wildlife = state.wildlife.filter(
        (animal: WildlifeAnimal) => animal.health > 0 || t - (animal.deadAt ?? t) <= WILDLIFE.CARCASS_SECONDS,
      );
    }
  }

  /**
   * Gulls fly (islandworld-08). A gull used to hover at a fixed 1.8 m over the
   * terrain and follow its contour like a drone; now it alternates PERCHED (on
   * the ground, wings tucked, pottering) and CIRCLING (8-15 m up, a 12-25 m
   * ring round its spawn at 0.5 rad/s), and anything that spooks it puts it on
   * the wing immediately.
   */
  private updateGull(animal: WildlifeAnimal, island: Island, dt: number, alerted: boolean) {
    const G = WILDLIFE.GULL;
    if (!animal.gullState) {
      animal.gullState = 'perched';
      animal.gullTimer = randRange(0, G.PERCH_MAX, this.rng);
      animal.gullRadius = randRange(G.RADIUS_MIN, G.RADIUS_MAX, this.rng);
      animal.gullAltitude = randRange(G.ALTITUDE_MIN, G.ALTITUDE_MAX, this.rng);
      animal.gullAngle = Math.atan2(
        animal.position.z - animal.spawnPosition.z,
        animal.position.x - animal.spawnPosition.x,
      );
    }

    animal.gullTimer = (animal.gullTimer ?? 0) - dt;
    if (animal.gullTimer <= 0 && !alerted) {
      if (animal.gullState === 'perched') {
        animal.gullState = 'circling';
        animal.gullTimer = randRange(G.CIRCLE_MIN, G.CIRCLE_MAX, this.rng);
        animal.gullRadius = randRange(G.RADIUS_MIN, G.RADIUS_MAX, this.rng);
        animal.gullAltitude = randRange(G.ALTITUDE_MIN, G.ALTITUDE_MAX, this.rng);
      } else {
        animal.gullState = 'perched';
        animal.gullTimer = randRange(G.PERCH_MIN, G.PERCH_MAX, this.rng);
      }
    }

    const prevX = animal.position.x;
    const prevZ = animal.position.z;

    if (animal.gullState === 'circling') {
      const angular = G.ANGULAR_SPEED * (alerted ? 1.6 : 1);
      animal.gullAngle = (animal.gullAngle ?? 0) + angular * dt;
      const radius = animal.gullRadius ?? G.RADIUS_MIN;
      animal.position.x = animal.spawnPosition.x + Math.cos(animal.gullAngle) * radius;
      animal.position.z = animal.spawnPosition.z + Math.sin(animal.gullAngle) * radius;
      const base = Math.max(getIslandSurfaceY(island, animal.position.x, animal.position.z), 0.2);
      const targetY = base + (animal.gullAltitude ?? G.ALTITUDE_MIN);
      animal.position.y = approach(animal.position.y, targetY, G.CLIMB_RATE * dt);
    } else {
      const ground = getIslandSurfaceY(island, animal.position.x, animal.position.z);
      const settled = animal.position.y <= ground + 0.35;
      if (!settled) {
        // Gliding down to the spot: no ground walking in mid-air.
        const dx = animal.spawnPosition.x - animal.position.x;
        const dz = animal.spawnPosition.z - animal.position.z;
        const d = Math.hypot(dx, dz) || 1;
        const glide = WILDLIFE.SPEED.gull * 0.6 * dt;
        if (d > glide) {
          animal.position.x += (dx / d) * glide;
          animal.position.z += (dz / d) * glide;
        }
        animal.position.y = approach(animal.position.y, ground + 0.05, G.CLIMB_RATE * dt);
      } else {
        // Pottering: a quarter-speed shuffle so a perched gull is not a statue.
        animal.wanderTimer -= dt;
        if (animal.wanderTimer <= 0) {
          animal.wanderAngle += randRange(-1.35, 1.35, this.rng);
          animal.wanderTimer = randRange(0.7, 2.0, this.rng);
        }
        const stride = WILDLIFE.SPEED.gull * 0.22 * dt;
        const walked = resolveWalkerAgainstIsland(
          island,
          animal.position.x, animal.position.z, animal.position.y - 0.05,
          animal.position.x + Math.cos(animal.wanderAngle) * stride,
          animal.position.z + Math.sin(animal.wanderAngle) * stride,
          WALK_LIMITS.gull,
          this.stepOut,
        );
        animal.position.x = walked.x;
        animal.position.z = walked.z;
        if (walked.blocked) animal.wanderAngle += Math.PI + randRange(-0.45, 0.45, this.rng);
        animal.position.y = walked.groundY + 0.05;
      }
    }

    animal.velocity.x = (animal.position.x - prevX) / Math.max(dt, 1e-4);
    animal.velocity.z = (animal.position.z - prevZ) / Math.max(dt, 1e-4);
    if (Math.abs(animal.velocity.x) + Math.abs(animal.velocity.z) > 0.01) {
      animal.rotation = Math.atan2(animal.velocity.x, animal.velocity.z);
    }
  }
}

/** Move `value` toward `target` by at most `maxStep`. */
function approach(value: number, target: number, maxStep: number): number {
  const d = target - value;
  if (Math.abs(d) <= maxStep) return target;
  return value + Math.sign(d) * maxStep;
}
