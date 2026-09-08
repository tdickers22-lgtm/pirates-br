import type { StormState, Ship, Player, Island } from '../../shared/types/index.js';
import { STORM_PHASES, STORM_ARC_SECONDS, STORM_DOCK_COVER_MARGIN, WORLD, FLOODING, STORM_LIGHTNING, SHIP_UPGRADES } from '../../shared/constants/index.js';
import { dist2D, lerp, getIslandSurfaceY } from '../../shared/utils/index.js';
import { SHIP_STATS } from '../../shared/constants/index.js';

interface StormDamageHooks {
  /** Route storm damage through PhysicsSystem.openHoleAt so the tempest stoves
   *  REAL breaches into the seaward planking — at a point on that face, not an
   *  abstract section counter — which then flood. Required: the storm has no
   *  business inventing its own damage model. */
  openHoleAt: (ship: Ship, local: { x: number; y: number; z: number }, count: number) => void;
  /** True while the WORLD may not stove this hull in — she's tied up in her own
   *  berth during the opening storm phases. PhysicsSystem owns the answer so
   *  every environmental source (seabed, reef, tempest) agrees on shelter. */
  isSheltered?: (shipId: string) => boolean;
  /** True while a pirate is inside his post-respawn storm reprieve. Match owns
   *  the clock (see grantStormRespawnGrace) — the tempest just asks. Without it
   *  a respawn the ring had already crossed died again in six seconds, forever. */
  hasStormGrace?: (playerId: string) => boolean;
}

/** Accumulated storm damage (per outside-ring second, phase-scaled) that stoves
 *  a fresh hole into the seaward hull section. Lowered 30 -> 18 with STORM-01:
 *  the tempest's lethality moved OFF the crew's health bar and ONTO the planking,
 *  so the hull has to take holes fast enough that the bail/repair fight is the
 *  thing keeping you afloat. At phase 2, 60 m outside, that is a breach every
 *  12 s instead of every 20 s. */
const STORM_HOLE_DAMAGE = 18;

/** Weather bills a pirate in the water or on a beach at twice the rate it bills
 *  a deck (STORM-01). Being caught OFF a hull is the lethal state now — a
 *  swimmer 60 m outside the phase-2 wall is gone in ~33 s. */
const STORM_EXPOSED_MULT = 2;

/** Exposure aboard: a crew standing on a floating hull takes no drain at all
 *  UNTIL she is already at the end of her rope. Without this a hull whose bail
 *  rate beats the ingress would carry an immortal crew around outside the ring
 *  forever (the verifier's stall risk on storm-01); with it, a doomed crew
 *  still resolves and a healthy one gets the fight the storm holes exist for. */
const STORM_EXPOSURE_HEALTH = 25;

/** The fastest the wall may close on the hull it is chasing, m/s (gameplay-08).
 *  A sloop at the half sail the horn hands out makes 6.75 m/s and 10.5 m/s with
 *  the storm gale behind her; a phase-2 ring drifting at the old maximum closed
 *  at 11.79 m/s, which no canvas in the game could answer from the far side.
 *  The drift — never the shrink — is capped to hold this line. */
export const STORM_MAX_EDGE_SPEED = 8;

/** Fraction of the final circle that may sit on dry land before a candidate
 *  centre is rejected (rings this small are the endgame arena). Tightened
 *  0.4 -> 0.2 with END-01: 40 % dry land in a 35 m arena is not an arena, and
 *  the 17-sample grid it was measured on could not see a 20 % answer anyway
 *  (see ringLandFraction). */
const RING_LAND_REJECT_FRACTION = 0.2;

/** Seconds after the arc runs out before the eye is fully closed (END-01,
 *  gameplay-06). The final circle used to hold FOREVER: two crews who did not
 *  sink each other produced a match with no end, the sky pinned at
 *  matchProgress 1 and the HUD clock reading 0. */
const EYE_COLLAPSE_RAMP_SECONDS = 60;
/** Damage per second the closed eye does at full collapse, to hull and hand
 *  alike, wherever they are standing. Matches the phase-7 outside rate: there
 *  is no longer anywhere on the map that is not the storm. */
const EYE_COLLAPSE_DMG_PER_SEC = 12;

/** Seconds after the arc at which the match resolves DETERMINISTICALLY, whatever
 *  is still afloat (END-01). The collapse itself is 60 s and kills everything
 *  left; this is the backstop for the cases it cannot resolve — a simultaneous
 *  wipe, a hull the eye cannot reach, a stalemate at anchor. Match reads it. */
export const STORM_EYE_RESOLUTION_SECONDS = 150;
/** Rings at or below this radius get the land check — earlier rings are large
 *  enough that an island inside them is a feature, not a dead arena. */
const RING_LAND_CHECK_RADIUS = 200;
/** Rejection-sampling budget per pick (deterministic bound; last candidate wins). */
const RING_CENTER_TRIES = 12;

export class StormSystem {
  /** Match-seeded stream (RNG-01): ring centres draw from it, so a seeded
   *  match replays. Unseeded it is Math.random (no behaviour change). */
  constructor(private readonly rng: () => number = Math.random) {}
  /** Per-ship storm-damage accumulation toward the next punched hole. */
  private shipStormAccum = new Map<string, number>();
  /** Hulls the tempest is actually working on THIS tick (outside the wall,
   *  afloat, unsheltered). The player loop reads it so a pirate aboard gets his
   *  hull's verdict instead of his own — reused across ticks, never realloc'd
   *  (the server tick is a hot path). */
  private hullsInTheWeather = new Set<string>();
  /** Floating hulls by id, rebuilt each tick from the ships array — the player
   *  loop needs to know whether the deck under a pirate is still a deck. */
  private floatingHulls = new Map<string, Ship>();
  /** Deterministic LCG for where along the seaward face a sea breaks through. */
  private stormHolePhase = 0x51f3c7;
  /** Seconds until the next bolt. Counts down on the seeded stream, so a seeded
   *  match replays its sky exactly (scripts/test-storm-lightning.mjs). */
  private strikeTimer: number = STORM_LIGHTNING.INTERVAL_MIN;
  /** Islands, for keeping the late rings off dry land (Old Maw Caldera sits at
   *  the world origin, which is exactly where the ring converges). */
  private islands: Island[] = [];
  /** Radius the first ring settles at — STORM_PHASES[0].endRadius, widened if
   *  this world put a spawn dock further out than the table assumed. */
  private firstRingRadius = STORM_PHASES[0].endRadius;

  /** Match hands the world in once at setup — purely read-only sampling. */
  setIslands(islands: Island[]): void {
    this.islands = islands;
    this.firstRingRadius = this.computeFirstRingRadius();
  }

  /**
   * THE FIRST RING IS SIZED OFF THE DOCKS, NOT OFF A GUESS.
   *
   * Every crew starts at a berth: hull alongside the pier, pirate standing on
   * the planking. If the opening circle closes inside that berth line, a player
   * who is still learning the stations is taking storm damage where the game
   * put him — the exact death the phase-1 comment ("explore, loot, get your
   * bearings") promises he will not have. So the ring takes the furthest dock
   * in the world — measured to BOTH the berth and the pier respawn point — adds
   * STORM_DOCK_COVER_MARGIN, and never settles inside that.
   *
   * The table value wins whenever it is already generous enough, and the answer
   * can never exceed the opening radius (a ring that "shrinks" outward would be
   * a bug the HUD would happily draw).
   */
  private computeFirstRingRadius(): number {
    const phase = STORM_PHASES[0];
    let furthest = 0;
    for (const island of this.islands) {
      const dock = island.dock;
      if (!dock) continue;
      furthest = Math.max(
        furthest,
        Math.hypot(dock.berthPosition.x, dock.berthPosition.z),
        Math.hypot(dock.respawnPoint.x, dock.respawnPoint.z),
      );
    }
    if (furthest <= 0) return phase.endRadius;
    return Math.min(
      phase.startRadius,
      Math.max(phase.endRadius, furthest + STORM_DOCK_COVER_MARGIN),
    );
  }

  /** The radius the opening circle settles at in THIS world (test + Match read
   *  it to assert the docks are covered). */
  getFirstRingRadius(): number {
    return this.firstRingRadius;
  }

  buildInitialState(): StormState {
    const phase = STORM_PHASES[0];
    // The first circle closes ON THE WORLD, not on a corner of it: drifting the
    // opening ring off-origin is what put outer berths outside a circle that is
    // otherwise wide enough for all of them. Every LATER ring still drifts —
    // that is the whole tension of the arc — but the one that closes while
    // crews are still at their moorings stays honest and centred.
    return {
      phase: 0,
      centerX: 0,
      centerZ: 0,
      nextCenterX: 0,
      nextCenterZ: 0,
      shrinkStartCenterX: 0,
      shrinkStartCenterZ: 0,
      shrinkStartRadius: phase.startRadius,
      safeRadius: phase.startRadius,
      nextRadius: this.firstRingRadius,
      shrinking: false,
      shrinkTimer: phase.waitSec,
      shrinkDuration: phase.shrinkSec,
      shrinkProgress: 0,
      damagePerSec: phase.dmgPerSec,
      eyeCollapse: 0,
      strikes: [],
    };
  }

  update(dt: number, storm: StormState, ships: Ship[], players: Player[], hooks: StormDamageHooks, t = 0): void {
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
          const nextCenter = this.pickNextSafeCenter(
            storm.centerX, storm.centerZ, storm.safeRadius, next.endRadius, next.shrinkSec,
          );
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
        } else {
          storm.nextCenterX = storm.centerX;
          storm.nextCenterZ = storm.centerZ;
          storm.shrinkStartCenterX = storm.centerX;
          storm.shrinkStartCenterZ = storm.centerZ;
          storm.shrinkStartRadius = storm.safeRadius;
          storm.shrinkTimer = 0;
        }
      } else {
        storm.centerX = lerp(storm.shrinkStartCenterX, storm.nextCenterX, storm.shrinkProgress);
        storm.centerZ = lerp(storm.shrinkStartCenterZ, storm.nextCenterZ, storm.shrinkProgress);
        storm.safeRadius = lerp(storm.shrinkStartRadius, storm.nextRadius, storm.shrinkProgress);
      }
    } else if (storm.phase >= STORM_PHASES.length) {
      // Terminal phase — the storm holds at its final circle. Pin the timer at
      // 0 instead of decrementing forever (the HUD reads it directly).
      storm.shrinkTimer = 0;
    } else {
      storm.shrinkTimer -= dt;
      if (storm.shrinkTimer <= 0) {
        storm.shrinking = true;
        storm.shrinkProgress = 0;
        storm.shrinkStartCenterX = storm.centerX;
        storm.shrinkStartCenterZ = storm.centerZ;
        storm.shrinkStartRadius = storm.safeRadius;
      }
    }

    // THE EYE CLOSES (END-01, gameplay-06). Once the arc has run out the final
    // circle used to hold forever: two crews who could not or would not sink
    // each other, a marooned pirate inside the ring, a passive pair of friends
    // — all produced a match with no end, the sky pinned at matchProgress 1 and
    // the storm clock reading 0. Now the eye itself closes over
    // EYE_COLLAPSE_RAMP_SECONDS and the arena becomes the weather: hull and
    // hand take it wherever they are standing, so the last fight resolves.
    storm.eyeCollapse = storm.phase >= STORM_PHASES.length
      ? Math.max(0, Math.min(1, (t - STORM_ARC_SECONDS) / EYE_COLLAPSE_RAMP_SECONDS))
      : 0;
    const eyeDmg = EYE_COLLAPSE_DMG_PER_SEC * storm.eyeCollapse * dt;

    // Apply damage to entities outside safe zone (scaled excess ramps gently)
    const dmg = storm.damagePerSec * dt;

    this.hullsInTheWeather.clear();
    this.floatingHulls.clear();
    for (const ship of ships) {
      if (!ship.alive || ship.sinking) {
        this.shipStormAccum.delete(ship.id);
        continue;
      }
      this.floatingHulls.set(ship.id, ship);
      const d = dist2D(ship.position.x, ship.position.z, storm.centerX, storm.centerZ);
      // A HULL IS TESTED BY HER NEAREST-INBOARD POINT, NOT BY HER CENTRE
      // (storm-23). The final ring is smaller than every hull in the game, so
      // in the endgame a centre test says "safe" while the pirate standing at
      // the stern is metres outside the wall — the two verdicts disagreed and
      // the endgame became a footrace to the inboard rail. One reading now:
      // if any part of her is in shelter, she is in shelter.
      const inboard = d - SHIP_STATS[ship.type].length * 0.5;
      if (inboard <= storm.safeRadius && eyeDmg <= 0) {
        this.shipStormAccum.delete(ship.id);
        continue;
      }
      // A hull moored in her berth during the opening phases is under shelter:
      // the ring starts at 950 m in a 1000 m world, so half the outer docks sat
      // OUTSIDE the very first circle and quietly took a breach a minute while
      // nobody was even aboard. The storm collects on her once phase 2 lands.
      const outside = inboard > storm.safeRadius;
      if (outside && hooks.isSheltered?.(ship.id)) {
        if (eyeDmg <= 0) { this.shipStormAccum.delete(ship.id); continue; }
      } else if (outside) {
        // Her crew reads this verdict below — one answer for hull and hands.
        this.hullsInTheWeather.add(ship.id);
      }
      const excess = (d - storm.safeRadius) / Math.max(1, storm.safeRadius);
      // A closed eye bills every hull afloat, inside the circle or out: there is
      // no longer anywhere on the map that is not the storm.
      const scaled = (this.hullsInTheWeather.has(ship.id) ? dmg * (1 + excess * 0.75) : 0) + eyeDmg;
      // The storm batters the seaward face: the section facing away from the
      // safe zone accumulates damage until it stoves in a hole (which then
      // floods — the storm kills ships the SoT way, a real repair/bail fight).
      // The cadence scales with the storm phase's damagePerSec, so the late
      // storm punches holes fast while the early one only nags a lingering ship.
      const inv = 1 / Math.max(0.001, d);
      const dxN = (ship.position.x - storm.centerX) * inv;
      const dzN = (ship.position.z - storm.centerZ) * inv;
      const cosR = Math.cos(ship.rotation);
      const sinR = Math.sin(ship.rotation);
      const lx = dxN * cosR - dzN * sinR;
      const lz = dxN * sinR + dzN * cosR;
      const accum = (this.shipStormAccum.get(ship.id) ?? 0) + scaled;
      if (accum >= STORM_HOLE_DAMAGE) {
        const holes = Math.floor(accum / STORM_HOLE_DAMAGE);
        this.shipStormAccum.set(ship.id, accum - holes * STORM_HOLE_DAMAGE);
        // A breaking sea stoves a plank on the face turned AWAY from shelter,
        // somewhere along that face inside the waterline band.
        const stats = SHIP_STATS[ship.type];
        const beam = Math.abs(lx) > Math.abs(lz);
        const spread = (this.stormHolePhase = (this.stormHolePhase * 1103515245 + 12345) & 0x7fffffff)
          / 0x7fffffff - 0.5;
        const bandY = FLOODING.HOLE_BAND_Y.min
          + (FLOODING.HOLE_BAND_Y.max - FLOODING.HOLE_BAND_Y.min) * ((spread + 0.5) * 0.999);
        hooks.openHoleAt(ship, beam
          ? { x: Math.sign(lx || 1) * stats.width * 0.5, y: bandY, z: spread * stats.length * 0.6 }
          : { x: spread * stats.width * 0.6, y: bandY, z: Math.sign(lz || 1) * stats.length * 0.42 },
          holes);
      } else {
        this.shipStormAccum.set(ship.id, accum);
      }
    }

    for (const player of players) {
      // Downed players outside the ring already bleed out twice as fast — the
      // storm DoT skips them so bleed-out (with its kill credit) resolves them.
      if (
        player.state === 'eliminated'
        || player.state === 'respawning'
        || player.state === 'downed'
        || player.respawnProtectionTimer > 0
        || hooks.hasStormGrace?.(player.id)
      ) continue;
      // The closed eye reaches everyone the ring's protections still shield —
      // deck, beach or open water alike (END-01).
      if (eyeDmg > 0) {
        player.lastEnvDamage = { cause: 'storm', at: t };
        player.health -= eyeDmg;
      }
      // THE STORM SINKS THE SHIP; IT DOES NOT ERASE THE CREW (STORM-01).
      //
      // Every non-downed pirate outside the wall used to bleed whether he was
      // swimming, standing on a beach or standing on his own quarterdeck — so
      // at phase 2 a full-health pirate died at 77 s while the hull under him
      // had taken four holes of the eight she needed to founder. The plank
      // patch, the bilge and the hole-facing were all irrelevant: the crew was
      // always dead first. So a pirate ABOARD A FLOATING HULL takes the HULL's
      // verdict — sheltered, inboard or safe means he is too — and the weather
      // spends itself on her planking instead. Off a deck it is worse than it
      // was (STORM_EXPOSED_MULT): the water is where the tempest kills people.
      const deck = player.onShipId ? this.floatingHulls.get(player.onShipId) : undefined;
      if (deck) {
        // Her planking is taking it, or nothing is. Exposure only bites a crew
        // already at the end of her rope, so a doomed hull still resolves.
        if (!this.hullsInTheWeather.has(deck.id)) continue;
        if (player.health >= STORM_EXPOSURE_HEALTH) continue;
        player.lastEnvDamage = { cause: 'storm', at: t };
        player.health -= dmg;
        continue;
      }
      const d = dist2D(player.position.x, player.position.z, storm.centerX, storm.centerZ);
      if (d > storm.safeRadius) {
        const excess = (d - storm.safeRadius) / Math.max(1, storm.safeRadius);
        // THE WEATHER DOES NOT ERASE THE CAPTAIN WHO CHIPPED YOU (CREDIT-01,
        // storm-19). Nulling lastDamagedById here meant chip-then-ring paid
        // nobody: the pirate you shot to 10 hp walked into the wall and the feed
        // credited the storm. The tag is FILED, not wiped — handlePlayerDeath
        // pays the attacker inside MATCH_END.ASSIST_CREDIT_WINDOW and the death
        // CAUSE still reads honestly off lastDamageSourceById.
        player.lastEnvDamage = { cause: 'storm', at: t };
        player.health -= dmg * (1 + excess * 0.75) * STORM_EXPOSED_MULT;
      }
    }

    this.rollLightning(dt, storm, ships, players, hooks, t);
  }

  /**
   * THE BOLTS ARE ROLLED HERE, NOT DRAWN HERE (STORMUP-01 / storm-04).
   *
   * Lightning was `Math.random` inside EnvironmentFx: private to each client,
   * hitting nothing, and 32 % of it landing INSIDE the safe ring — the sky
   * contradicting the one rule the ring states. Now the storm rolls a strike
   * off the match-seeded stream into a replicated ring buffer, in the band
   * [1.02, 1.35] x safeRadius, and the client only draws what it is sent.
   *
   * THE MAINMAST IS THE CONDUCTOR. A hull already in the weather within
   * MAST_SEEK_RADIUS of the rolled point takes the bolt down her mast: a hole
   * stoved at the step and the mast alight, unless she is carrying a lightning
   * rod, which grounds the charge for nothing. That is the whole point of
   * storm-08 — a prepared crew CHOOSES the weather.
   */
  private rollLightning(
    dt: number, storm: StormState, ships: Ship[], players: Player[], hooks: StormDamageHooks, t: number,
  ): void {
    if (!storm.strikes) storm.strikes = [];
    this.strikeTimer -= dt;
    if (this.strikeTimer > 0) return;
    this.strikeTimer = Math.max(
      1.2,
      STORM_LIGHTNING.INTERVAL_MIN + this.rng() * STORM_LIGHTNING.INTERVAL_RANGE
        - storm.phase * STORM_LIGHTNING.INTERVAL_PER_PHASE,
    );

    const angle = this.rng() * Math.PI * 2;
    const band = STORM_LIGHTNING.BAND_MIN + this.rng() * STORM_LIGHTNING.BAND_RANGE;
    const radius = Math.max(1, storm.safeRadius) * band;
    let x = storm.centerX + Math.cos(angle) * radius;
    let z = storm.centerZ + Math.sin(angle) * radius;

    // Only a hull the tempest already has her hands on (outside the wall and
    // not sheltered in her berth) can be struck — hullsInTheWeather is the same
    // verdict the holes and the crew's exposure read, so nothing disagrees.
    let target: Ship | null = null;
    let best: number = STORM_LIGHTNING.MAST_SEEK_RADIUS;
    for (const ship of ships) {
      if (!ship.alive || ship.sinking) continue;
      if (!this.hullsInTheWeather.has(ship.id)) continue;
      const d = dist2D(ship.position.x, ship.position.z, x, z);
      if (d < best) { best = d; target = ship; }
    }

    let grounded = false;
    if (target) {
      x = target.position.x;
      z = target.position.z;
      grounded = SHIP_UPGRADES.LIGHTNING_ROD_GROUNDS
        && (target.upgrades ?? []).some((u) => u.type === 'lightning_rod');
      if (!grounded) {
        const stats = SHIP_STATS[target.type];
        const bandY = (FLOODING.HOLE_BAND_Y.min + FLOODING.HOLE_BAND_Y.max) * 0.5;
        // The charge runs down the mast and blows the planking at the STEP —
        // amidships, on the centreline, which is why this hole is not on the
        // seaward face like the ones the seas stove in.
        hooks.openHoleAt(target, { x: 0, y: bandY, z: stats.length * 0.06 }, STORM_LIGHTNING.MAST_HOLES);
        // A second bolt into a mast that is ALREADY burning adds the hole, not a
        // second full burn. Without this a 90 s crossing could stack two 12 s
        // fires at 4 hp/s onto a crew that has no way to fight them yet, take
        // them under STORM_EXPOSURE_HEALTH, and hand the tempest the crew kill
        // STORM-01 took off it.
        if (!target.onFire) {
          target.onFire = true;
          target.fireTimer = Math.max(target.fireTimer, STORM_LIGHTNING.FIRE_SECONDS);
        }
      }
    } else {
      // Open water. A pirate swimming under the strike is cooked; a pirate on a
      // deck is not (his mast took it, or nothing did).
      for (const player of players) {
        if (player.onShipId) continue;
        if (
          player.state === 'eliminated'
          || player.state === 'respawning'
          || player.state === 'downed'
          || player.respawnProtectionTimer > 0
          || hooks.hasStormGrace?.(player.id)
        ) continue;
        if (dist2D(player.position.x, player.position.z, x, z) > STORM_LIGHTNING.SWIMMER_RADIUS) continue;
        player.lastEnvDamage = { cause: 'storm', at: t };
        player.health -= STORM_LIGHTNING.SWIMMER_DAMAGE;
      }
    }

    storm.strikes.push({ t, x, z, shipId: target?.id ?? null, grounded });
    while (storm.strikes.length > STORM_LIGHTNING.MAX_REPLICATED) storm.strikes.shift();
  }

  isOutside(x: number, z: number, storm: StormState): boolean {
    return dist2D(x, z, storm.centerX, storm.centerZ) > storm.safeRadius;
  }

  private pickNextSafeCenter(
    centerX: number, centerZ: number, currentRadius: number, nextRadius: number,
    shrinkSec = Infinity,
  ) {
    const slack = Math.max(0, currentRadius - nextRadius - 8);
    // THE WALL MAY NOT CLOSE FASTER THAN CANVAS CAN ANSWER (gameplay-08). The
    // hull on the far side of a drifting ring is chased by the shrink AND by
    // the drift, and in phase 2 that summed to 11.79 m/s against a half-sail
    // sloop making 10.5 m/s with the gale — caught on any heading, the exact
    // "died where the game put you" death phase 1 promises never to repeat.
    // The shrink is the design; the DRIFT is the lever, so the drift is what
    // gives way. Every other phase is already under the line and is untouched.
    const speedBudget = shrinkSec * STORM_MAX_EDGE_SPEED - (currentRadius - nextRadius);
    const allowedDrift = Math.max(0, Math.min(slack, speedBudget));
    const worldBound = Math.max(0, WORLD.HALF - nextRadius - 36);
    const roll = () => {
      const drift = allowedDrift * (0.22 + this.rng() * 0.68);
      const angle = this.rng() * Math.PI * 2;
      return {
        x: Math.max(-worldBound, Math.min(worldBound, centerX + Math.cos(angle) * drift)),
        z: Math.max(-worldBound, Math.min(worldBound, centerZ + Math.sin(angle) * drift)),
      };
    };
    // Small end circles must be sailable water, not a volcano. Re-roll (bounded)
    // and keep the driest candidate; every draw comes from the storm's own
    // match rng stream (RNG-01), so island generation (its own seeded rng) is untouched.
    if (nextRadius > RING_LAND_CHECK_RADIUS || this.islands.length === 0) return roll();
    let best: { x: number; z: number; land: number } | null = null;
    for (let i = 0; i < RING_CENTER_TRIES; i++) {
      const candidate = roll();
      const land = this.ringLandFraction(candidate.x, candidate.z, nextRadius);
      if (land <= RING_LAND_REJECT_FRACTION) return candidate;
      if (!best || land < best.land) best = { ...candidate, land };
    }
    return { x: best!.x, z: best!.z };
  }

  /** Fraction of a ring's area that is dry land, sampled on a coarse polar grid. */
  private ringLandFraction(cx: number, cz: number, radius: number): number {
    let dry = 0;
    let total = 0;
    // 33 SAMPLES, NOT 17 (END-01). The old grid was one centre point and two
    // rings of 8: its finest resolution was 1/17 = 5.9 %, and a 20 % reject
    // threshold read on it is mostly quantisation. Three rings of 8/8/16 plus
    // the centre resolves 3 %, and weights the OUTER annulus — which is most of
    // a disc's area, and where a beach actually eats an arena.
    for (const [fraction, steps] of [[0, 1], [0.35, 8], [0.65, 8], [0.9, 16]] as const) {
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const x = cx + Math.cos(angle) * radius * fraction;
        const z = cz + Math.sin(angle) * radius * fraction;
        total++;
        for (const island of this.islands) {
          if (getIslandSurfaceY(island, x, z) > 0.2) { dry++; break; }
        }
      }
    }
    return total === 0 ? 0 : dry / total;
  }
}
