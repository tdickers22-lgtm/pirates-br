import { v4 as uuid } from 'uuid';
import type { GameState, Player, Vec3, WildlifeAnimal } from '../../shared/types/index.js';
import { SHARK, WILDLIFE, WORLD } from '../../shared/constants/index.js';
import { dist2D, getIslandSurfaceY, isPointInsideIslandFootprint, randRange } from '../../shared/utils/index.js';

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

export class FaunaSystem {
  private sharkSpawnCooldown = 0;

  constructor(private readonly rng: () => number, private readonly hooks: FaunaHooks) {}

  /** Seconds until the next shark may spawn — Match reads/writes nothing here,
   *  but the sinking-scene suites assert the cooldown exists. */
  get spawnCooldown(): number {
    return this.sharkSpawnCooldown;
  }

  updateSharks(dt: number, state: GameState) {
    const { sharks, players, islands } = state;
    this.sharkSpawnCooldown = Math.max(0, this.sharkSpawnCooldown - dt);

    if (sharks.length < SHARK.MAX_WORLD && this.sharkSpawnCooldown <= 0 && this.rng() < SHARK.SPAWN_CHANCE_PER_TICK) {
      const swimmers = players.filter(p => p.state === 'swimming' && p.swimTimer >= SHARK.SPAWN_SWIM_GRACE);
      if (swimmers.length) {
        const p = swimmers[Math.floor(this.rng() * swimmers.length)];
        const ang = this.rng() * Math.PI * 2;
        const dist = randRange(SHARK.SPAWN_MIN_DIST, SHARK.SPAWN_MAX_DIST, this.rng);
        const x = p.position.x + Math.sin(ang) * dist;
        const z = p.position.z + Math.cos(ang) * dist;
        if (Math.abs(x) < WORLD.HALF - 24 && Math.abs(z) < WORLD.HALF - 24) {
          let blocked = false;
          for (const island of islands) {
            if (isPointInsideIslandFootprint(island, x, z, 2.8)) {
              blocked = true;
              break;
            }
          }
          for (const shark of sharks) {
            if (dist2D(shark.position.x, shark.position.z, x, z) < SHARK.SPAWN_MIN_DIST) {
              blocked = true;
              break;
            }
          }
          if (!blocked) {
            sharks.push({
              id: uuid(),
              position: { x, y: 0.38, z },
              rotation: 0,
              velocity: { x: 0, y: 0, z: 0 },
              health: SHARK.HEALTH,
              biteCooldown: 1.2,
              attackState: 'cruise',
              attackTimer: 0,
              lungeDirX: 0,
              lungeDirZ: 0,
              targetId: p.id,
            });
            this.sharkSpawnCooldown = randRange(SHARK.SPAWN_COOLDOWN_MIN, SHARK.SPAWN_COOLDOWN_MAX, this.rng);
          }
        }
      }
    }

    for (let i = sharks.length - 1; i >= 0; i--) {
      const s = sharks[i];
      if (s.health <= 0) {
        sharks.splice(i, 1);
        continue;
      }
      s.biteCooldown = Math.max(0, s.biteCooldown - dt);

      let target = this.hooks.getPlayer(s.targetId);
      if (target?.state !== 'swimming') target = null;
      if (!target) {
        const candidates = players.filter(pl => pl.state === 'swimming');
        target = candidates
          .map(pl => ({
            pl,
            d: dist2D(pl.position.x, pl.position.z, s.position.x, s.position.z),
          }))
          .sort((a, b) => a.d - b.d)[0]?.pl ?? null;
        s.targetId = target?.id ?? null;
      }

      if (!target && s.attackState === 'cruise') {
        // Frame-rate-independent decay preserving the previous per-16ms feel.
        const idleDamp = Math.pow(0.92, dt / 0.016);
        s.velocity.x *= idleDamp;
        s.velocity.z *= idleDamp;
        s.position.x += s.velocity.x * dt;
        s.position.z += s.velocity.z * dt;
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
      s.position.y = 0.38;

      // Sharks stay in OPEN WATER — shove them back out of any island footprint
      // so they never chase under the terrain (where they'd be invisible and bite
      // the swimmer from inside the rock = "random" damage).
      let inLand = false;
      for (const island of islands) {
        if (!isPointInsideIslandFootprint(island, s.position.x, s.position.z, 4)) continue;
        const ax = s.position.x - island.position.x;
        const az = s.position.z - island.position.z;
        const al = Math.hypot(ax, az) || 1;
        let px = s.position.x, pz = s.position.z;
        for (let step = 0; step < 40 && isPointInsideIslandFootprint(island, px, pz, 4); step++) {
          px += (ax / al) * 1.5; pz += (az / al) * 1.5;
        }
        s.position.x = px; s.position.z = pz;
        s.velocity.x *= 0.25; s.velocity.z *= 0.25;
        inLand = true;
      }

      // Only wind up from open water (not from inside the shore rock) — the
      // 1.9× bite range gives the windup brake room before the lunge fires.
      if (
        s.attackState === 'cruise'
        && target
        && !inLand
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
        } else if (s.attackTimer <= 0) {
          s.attackState = 'recover';
          s.attackTimer = SHARK.RECOVER_TIME;
        }
      }
    }
  }

  updateWildlife(dt: number, state: GameState) {
    const t = this.hooks.now();
    for (const animal of state.wildlife) {
      if (animal.health <= 0) continue;
      const island = state.islands.find((candidate) => candidate.id === animal.islandId);
      if (!island) {
        animal.health = 0;
        continue;
      }

      animal.wanderTimer -= dt;
      if (animal.wanderTimer <= 0) {
        const homeAngle = Math.atan2(animal.spawnPosition.z - animal.position.z, animal.spawnPosition.x - animal.position.x);
        const farFromHome = dist2D(animal.position.x, animal.position.z, animal.spawnPosition.x, animal.spawnPosition.z) > island.radius * 0.32;
        animal.wanderAngle = farFromHome
          ? homeAngle + randRange(-0.55, 0.55, this.rng)
          : animal.wanderAngle + randRange(-1.35, 1.35, this.rng);
        animal.wanderTimer = randRange(0.7, animal.type === 'gull' ? 2.0 : 3.0, this.rng);
      }

      const speed = WILDLIFE.SPEED[animal.type];
      const moveScale = animal.type === 'crab' ? (0.55 + Math.abs(Math.sin(t * 3.5 + animal.position.x)) * 0.55) : 1;
      const vx = Math.cos(animal.wanderAngle) * speed * moveScale;
      const vz = Math.sin(animal.wanderAngle) * speed * moveScale;
      const nextX = animal.position.x + vx * dt;
      const nextZ = animal.position.z + vz * dt;
      const allowed = isPointInsideIslandFootprint(island, nextX, nextZ, animal.type === 'gull' ? -4 : -2);

      if (allowed) {
        animal.position.x = nextX;
        animal.position.z = nextZ;
        animal.velocity.x = vx;
        animal.velocity.z = vz;
      } else {
        animal.wanderAngle += Math.PI + randRange(-0.45, 0.45, this.rng);
        animal.velocity.x = 0;
        animal.velocity.z = 0;
      }

      const groundY = getIslandSurfaceY(island, animal.position.x, animal.position.z);
      animal.position.y = animal.type === 'gull'
        ? groundY + 1.8 + Math.sin(t * 3.2 + animal.position.x * 0.04) * 0.35
        : groundY + 0.06;

      if (Math.abs(animal.velocity.x) + Math.abs(animal.velocity.z) > 0.01) {
        animal.rotation = Math.atan2(animal.velocity.x, animal.velocity.z);
      }
    }

    state.wildlife = state.wildlife.filter((animal: WildlifeAnimal) => animal.health > 0);
  }

}
