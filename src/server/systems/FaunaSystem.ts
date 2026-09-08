import { v4 as uuid } from 'uuid';
import type { GameState, Island, Player, Vec3, WildlifeAnimal } from '../../shared/types/index.js';
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
      const allowed = speed > 0 && isPointInsideIslandFootprint(island, nextX, nextZ, -2);

      if (allowed) {
        animal.position.x = nextX;
        animal.position.z = nextZ;
        animal.velocity.x = vx;
        animal.velocity.z = vz;
      } else {
        if (speed > 0) animal.wanderAngle += Math.PI + randRange(-0.45, 0.45, this.rng);
        animal.velocity.x = 0;
        animal.velocity.z = 0;
      }

      animal.position.y = getIslandSurfaceY(island, animal.position.x, animal.position.z) + 0.06;

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
        const step = WILDLIFE.SPEED.gull * 0.22 * dt;
        const nextX = animal.position.x + Math.cos(animal.wanderAngle) * step;
        const nextZ = animal.position.z + Math.sin(animal.wanderAngle) * step;
        if (isPointInsideIslandFootprint(island, nextX, nextZ, -2)) {
          animal.position.x = nextX;
          animal.position.z = nextZ;
        } else {
          animal.wanderAngle += Math.PI + randRange(-0.45, 0.45, this.rng);
        }
        animal.position.y = getIslandSurfaceY(island, animal.position.x, animal.position.z) + 0.05;
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
