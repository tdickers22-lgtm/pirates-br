import type { WeaponId, ShipType } from '../types/index.js';

// ── World ────────────────────────────────────────────────────
export const WORLD = {
  SIZE: 2000,
  HALF: 1000,
  /** Ships bounce off a soft wall this far inside the world edge. */
  SHIP_MARGIN: 50,
  /** Players hard-clamp this far inside the world edge. */
  PLAYER_MARGIN: 10,
  ISLAND_COUNT: 14,
  SHIP_COUNT: 10,
} as const;

// ── Physics ──────────────────────────────────────────────────
export const PHYSICS = {
  GRAVITY: -18,
  WATER_DRAG: 0.85,
  AIR_DRAG: 0.98,
  BUOYANCY_SPRING: 4,
  WAVE_HEIGHT_MAX: 2.5,
} as const;

// ── Player ───────────────────────────────────────────────────
export const PLAYER = {
  MAX_HEALTH: 100,
  MOVE_SPEED: 5,
  SPRINT_MULT: 1.6,
  SWIM_SPEED: 5.2,
  SWIM_MAX_DEPTH: 42,
  JUMP_FORCE: 6,
  HEIGHT: 1.75,
  RADIUS: 0.35,
  INTERACT_RANGE: 3.5,
  DROWN_TIME: 60,
  DROWN_DAMAGE: 5,
  RESPAWN_TIME: 20,
  RESPAWN_HEALTH: 50,
  RESPAWN_PROTECTION_TIME: 3.5,
  SHIP_EXIT_GRACE_TIME: 0.6,
  BANANA_HEAL: 25,
  KILL_GOLD_REWARD: 275,
  /** Bounty for foundering an enemy ship — the crew is not eliminated by the
   *  sink (they lose their respawn anchor, not the match). */
  SHIP_SINK_GOLD: 400,
  /** Iron Cuirass pool: combat damage chews through this before health.
   *  Bought from the Gold Hoarder (pricey), lost on death — deliberately
   *  a mid/late-game investment, not a lobby pickup. */
  MAX_ARMOR: 50,
  /** PvE skeletons pay a small bounty, not the full pirate reward. */
  SKELETON_KILL_GOLD: 60,
  HEADSHOT_GOLD_BONUS: 40,
  BOARDING_KILL_HEAL: 25,
  BOARDING_GOLD_STEAL_CAP: 180,
  STARTING_KEGS: 2,
  KEG_REPLENISH_COOLDOWN: 60,
} as const;

// ── Down-but-not-out (DBNO) ──────────────────────────────────
// hp ≤ 0 with a living crewmate downs the pirate instead of killing them:
// crawl at 30% speed, no weapons/stations, bleed out over BLEEDOUT_SECONDS
// (2× faster outside the storm ring). A crewmate holding interact for
// REVIVE_SECONDS revives at REVIVE_HEALTH. Any damage can finish the downed.
export const DBNO = {
  /** Seconds from downed to bleed-out death inside the storm safe ring. */
  BLEEDOUT_SECONDS: 30,
  /** Bleed-out drain multiplier while outside the storm safe ring. */
  STORM_BLEEDOUT_MULT: 2,
  /** Vitality pool while downed — damage against it "finishes" the player. */
  DOWNED_HEALTH: 30,
  /** Crawl speed as a fraction of PLAYER.MOVE_SPEED. */
  CRAWL_SPEED_SCALE: 0.3,
  /** Hold-interact seconds for a crewmate to complete a revive. */
  REVIVE_SECONDS: 4,
  /** Max distance (m) between reviver and downed body. */
  REVIVE_RANGE: 2.8,
  /** Health granted on a successful revive (fraction of MAX_HEALTH). */
  REVIVE_HEALTH_RATIO: 0.3,
  /** Interrupted revives decay progress at this rate per second. */
  PROGRESS_DECAY_PER_SEC: 0.5,
  /** Bots only revive crewmates when no enemy is within this range. */
  BOT_REVIVE_SAFE_RADIUS: 40,
  /** Bots walk over and finish downed enemies inside this range. */
  BOT_FINISH_RADIUS: 12,
} as const;

export const ECONOMY = {
  GOLD_WIN_TARGET: 9000,
  PLAYER_HIT_GOLD_MIN: 6,
  PLAYER_HIT_GOLD_MAX: 30,
  PLAYER_HIT_GOLD_RATIO: 0.18,
  CHEST_VALUE_MIN: 650,
  CHEST_VALUE_MAX: 1450,
  CHEST_SELL_MULTIPLIER: 1.65,
  HOARDER_QUEST_CHEST_BONUS: 1.3,
  /** Iron Cuirass price at the Gold Hoarder — ~a chest-and-a-half of gold,
   *  so armor is a real decision against the 9000g win target. */
  ARMOR_PRICE: 1200,
} as const;

// ── Ships ────────────────────────────────────────────────────
export const SHIP_STATS: Record<ShipType, {
  maxHull: number;
  cannonCount: number;
  maxSpeed: number;
  turnRate: number;
  width: number;
  length: number;
  height: number;
  mastCount: number;
}> = {
  sloop: {
    maxHull: 600, cannonCount: 2, maxSpeed: 15,
    turnRate: 0.7, width: 5, length: 12, height: 2.2, mastCount: 1,
  },
  brigantine: {
    maxHull: 900, cannonCount: 4, maxSpeed: 13,
    turnRate: 0.45, width: 7, length: 16, height: 2.8, mastCount: 2,
  },
  galleon: {
    maxHull: 1400, cannonCount: 8, maxSpeed: 10,
    turnRate: 0.25, width: 10, length: 22, height: 3.5, mastCount: 3,
  },
};

export const SHIP = {
  HULL_SECTION_RATIO: 0.25,   // each section is 1/4 of total
  SINK_TIME: 20,              // seconds — the founder is a scene, not a pop
  REPAIR_HP: 100,
  FIELD_REPAIR_DELAY: 10,
  FIELD_REPAIR_INTERVAL: 2.5,
  FIELD_REPAIR_HP: 120,
  MAX_SAIL_ANGLE: Math.PI * 0.48,
  /** Full hoist takes ~2.2s solo, ~1.5s with a crewmate on the rope. */
  SAIL_HOIST_RATE: 0.45,
  SAIL_TRIM_RATE: 1.55,
  RUDDER_SLEW: 3.25,
  RUDDER_DECAY: 4.1,
  /** Physical rudder blade deflection limit (radians). */
  RUDDER_MAX_ANGLE: 0.62,
  /** Half-angle of the upwind no-go cone (~35°) — sails luff inside it. */
  SAIL_NO_GO_ANGLE: 0.611,
  /** Keel depth below the waterline as a fraction of hull height. Berth-depth
   *  planning still uses this conservative figure; grounding and swim-hull
   *  collision measure from HULL_DRAFT_F (the RENDERED keel) instead. */
  KEEL_DRAFT_RATIO: 0.55,
  /** RENDERED hull draft as a fraction of hull height — the single truth for
   *  "how deep the visible keel sits" (ShipRenderer HULL_SHAPES.draftF mirrors
   *  these: sloop 0.80 m, brigantine 1.01 m, galleon 1.23 m). Grounding and the
   *  swim-hull band both read it, so no invisible water is solid and no visible
   *  rock is phantom. */
  HULL_DRAFT_F: { sloop: 0.365, brigantine: 0.36, galleon: 0.35 } as Record<ShipType, number>,
  /** Class-average draft fraction, for callers that only have hull dimensions
   *  (within 3 cm of every class's true draft). */
  HULL_DRAFT_F_FALLBACK: 0.357,
  /** Grounding tests the keel plus this safety bite, so a scrape registers just
   *  before the visible keel would clip the seabed. */
  GROUND_KEEL_SAFETY: 0.25,
  ANCHOR_BRAKE: 4.8,
  ANCHOR_RAISE_TIME: 3.2,
  FIRE_DURATION: 18,
  /** A deck fire chars a fresh hull hole every this-many seconds (burn-through). */
  FIRE_HOLE_INTERVAL: 6,
  FIRE_HULL_DAMAGE_PER_SEC: 1.5,
  FIRE_PLAYER_DAMAGE_PER_SEC: 4,
  FIRE_REPAIR_DOUSE_TIME: 9,
  FLOOD_SPEED_PENALTY: 0.12,  // per damaged section
  CANNON_RELOAD: 3.5,         // seconds
  CANNON_DAMAGE_HULL: 120,
  CANNON_DAMAGE_PLAYER: 60,
  CANNON_RADIUS: 4,           // blast radius
  CANNON_SPEED: 60,
  CANNON_GRAVITY_MULT: 0.7,
  CANNON_YAW_ARC: Math.PI * 0.42,
  CANNON_PITCH_MIN: -0.16,
  CANNON_PITCH_MAX: 0.62,
  CANNON_LAUNCH_SPEED: 62,
  CANNON_LAUNCH_VERTICAL_BIAS: 3.4,
  CANNON_PLAYER_LAUNCH_PITCH_MIN: 0.08,
  CANNON_PLAYER_LAUNCH_PITCH_MAX: 0.38,
  /** Seconds of ballistic arc before normal physics (must cover full trajectory) */
  CANNON_PLAYER_FLIGHT_MAX: 10,
  KEG_FUSE_TIME: 10,
  KEG_PLACE_RANGE: 2.7,
  KEG_DIFFUSE_RANGE: 2.4,
  KEG_PLAYER_RADIUS: 8.5,
  KEG_PLAYER_DAMAGE: 125,
  KEG_PLAYER_MIN_DAMAGE: 8,
  KEG_BLAST_FORCE: 18,
  KEG_PRIMARY_DAMAGE_RATIO: 0.26,
  KEG_SPLASH_DAMAGE_RATIO: 0.08,
  /** Rigging repair at sail station (per second while holding interact + wood) */
  SAIL_REPAIR_RATE: 0.42,
  SAIL_REPAIR_WOOD_INTERVAL: 0.85,
  /** Seconds per hull-plank hammer swing: one plank patches one hole per swing. */
  HULL_REPAIR_SWING_TIME: 0.9,
  CHAINSHOT_SAIL_DAMAGE: 0.38,
  /** When chainshot hits a sail, the canvas physically collapses by this fraction
   *  of the current hoist (multiplied by damage). Repairing at the sail station
   *  hoists the canvas back up at SAIL_HOIST_RATE * SAIL_REPAIR_HOIST_FACTOR. */
  CHAINSHOT_SAIL_DROP_FACTOR: 1.6,
  SAIL_REPAIR_HOIST_FACTOR: 0.55,
} as const;

// ── Flooding / bailing (SoT-style, PURELY hole-based naval damage loop) ──
// There is no hull-HP pool and no per-section bucket. Each cannonball (keg
// blast, ram, rock, grounding, storm sea, fire burn-through) punches a discrete
// HOLE ENTITY at the exact hull-local point the damage landed. Any hole sitting
// at/below the LIVE wave surface (heel/pitch/settle included) takes on water;
// ingress scales with how many open holes are under AND how deep each one sits.
// waterLevel is a normalized 0..1 bilge fill and the ship founders ONLY when it
// reaches 1. A plank patches ONE hole (the one you are standing at); a bucket
// bails water; a passive bilge pump slowly recovers a fully-patched hull.
export const FLOODING = {
  /** Hard cap on hole ENTITIES a single hull carries. This one number is BOTH
   *  the hull shader's discard-slot count and the 10 Hz wire budget: 9 hulls all
   *  simultaneously at the cap is ~3.8 KB of full snapshot, which is what keeps
   *  a fleet-wide gunfight under the 35 KB guard (test-snapshot-size pins it).
   *  Eight unpatched breaches already flood a dry sloop in ~17 s against two
   *  bailers, so the cap is a wire limit, never a mercy: damage on a saturated
   *  hull RE-OPENS the nearest patched hole rather than no-oping, so a hull can
   *  never become immune by being shot enough (the old 3-per-section bug). */
  MAX_HOLES_PER_SHIP: 8,
  /** Hull-local Y band (metres above the design waterline) synthetic breach
   *  points are placed in — rams, rocks, storm seas and keg blasts land here. */
  HOLE_BAND_Y: { min: 0.10, max: 0.45 },
  /** Rendered breach radius (metres) — damage depth reads as MORE holes, not
   *  as one growing disc. */
  HOLE_VISUAL_RADIUS: 0.26,
  /** Planar hull-local distance a pirate can reach a hole from to plank it.
   *  Server truth; the client prompt mirrors it exactly. */
  HOLE_REPAIR_REACH: 2.2,
  /** Hull-local Y a deck fire chars its first hole at — ABOVE the calm
   *  waterline on purpose: a burning ship accumulates dry holes that only start
   *  flooding once the flames burn them DOWN to the sea (see FIRE_BURN_DOWN_RATE)
   *  or storm seas wash over them. Fire is a real threat, not a one-hole douse. */
  FIRE_HOLE_START_Y: 1.05,
  /** Metres/sec an untended fire burns each of its own holes DOWNWARD through
   *  the planking. ~0.06 m/s takes a fresh char from 1.05 m to the waterline in
   *  ~16 s — the length of an untended blaze. */
  FIRE_BURN_DOWN_RATE: 0.06,
  /** Water-level/sec that ONE open, submerged hole lets in (sloop reference).
   *  One bailer (BAIL_RATE 0.014) beats a single hole but loses to two, so a
   *  gushing hull must be planked, not just bailed. ~67 s to founder a sloop on
   *  two open holes, faster with more; a reinforced hull seeps slower still. */
  INGRESS_PER_HOLE: 0.0075,
  /** Ingress scales with how DEEP a hole sits under the live surface:
   *  factor = clamp(1 + depthMetres, MIN, MAX), depth = surfaceY − holeWorldY.
   *  A hole exactly ON the waterline (depth 0) is the INGRESS_PER_HOLE
   *  reference; one washed by wave crests only (depth −0.3 … 0) weeps at
   *  0.7–1×; one dragged half a metre under by the settling bilge gushes at
   *  the 1.5× cap — that is the doom spiral, in one line. The bail-race
   *  relations hold across the whole range (one bailer beats one hole even at
   *  max depth: 0.014 > 0.01125; two holes beat one bailer even at min:
   *  0.0105 ≈ 0.014 only until the hull settles). */
  HOLE_DEPTH_MIN_FACTOR: 0.7,
  HOLE_DEPTH_MAX_FACTOR: 1.5,
  /** Per hull-class scale on ingress — bigger hull, slower to fill.
   *  sloop 50 s / brigantine ~60 s / galleon ~71 s to fill on 2 open sections. */
  INGRESS_CLASS_SCALE: { sloop: 1.0, brigantine: 0.84, galleon: 0.70 } as Record<ShipType, number>,
  /** One player bails this much water-level/sec (beats one open hole, loses to two). */
  BAIL_RATE: 0.014,
  /** Physical bucket bailing is a SCOOP → CARRY → HEAVE cycle: press once to
   *  fill the empty bucket (water drops BAIL_SCOOP_VOLUME), press again to heave
   *  it over the side. Each action locks for BAIL_SCOOP_TIME, so a full cycle is
   *  ~2×BAIL_SCOOP_TIME and clears BAIL_SCOOP_VOLUME → a diligent bailer's net
   *  rate (~0.014/s) still beats one open hole (0.0075/s) and loses to two
   *  (0.015/s), so a real breach demands repair, not just bailing (matches
   *  BAIL_RATE + the code comment; the old 0.03 let one bailer out-drain two holes). */
  BAIL_SCOOP_TIME: 0.6,
  BAIL_SCOOP_VOLUME: 0.017,
  /** Passive bilge pump drain (× BAIL_RATE) when NOTHING is holed-below-waterline. */
  PASSIVE_PUMP_FACTOR: 0.25,
  /** Bots start bailing once standing water exceeds this. */
  BOT_BAIL_THRESHOLD: 0.35,
  /** A hole starts weeping while it sits within this many metres ABOVE the local
   *  surface (wave wash over a near-waterline breach); anything lower floods. */
  HOLE_WATERLINE_DEPTH: 0.30,
  /** Full bilge lowers the buoyancy/heave target this many metres (freeboard loss →
   *  more sections dip under → the doom spiral). */
  FREEBOARD_DROP: 0.8,
  /** Full bilge cuts max speed to (1 − this): 0.38 → 0.62× at waterLevel 1. */
  SPEED_PENALTY: 0.38,
  /** Full bilge dulls rudder authority by this fraction (~40%). */
  RUDDER_PENALTY: 0.40,
} as const;

// ── Geysers ──────────────────────────────────────────────────
// Volcanic vents that erupt on a shared deterministic cycle and launch any
// grounded pirate (players + bots) skyward. Landing is owned by the normal
// fall-damage path, so a big launch onto hard rock genuinely hurts — aim for a
// water landing. Per-vent power/period/phase live on the IslandGeyser record.
export const GEYSER = {
  /** Eruption level (0..1) at/above which a standing pirate is launched. */
  LAUNCH_THRESHOLD: 0.5,
  /** A pirate more than this far above the vent rim is already airborne — the
   *  launch won't re-fire on them until they land back on the vent. */
  TRIGGER_MAX_HEIGHT: 1.6,
  /** Outward horizontal kick as a fraction of the vertical launch — enough that
   *  the ballistic arc genuinely carries a rider clear of the vent footprint
   *  (so an idle pirate can't be relaunched onto the same vent every eruption)
   *  while still usually landing back on the island. */
  OUTWARD_BOOST: 0.24,
  /** Seconds a pirate is immune to re-launch after being thrown — long enough
   *  to cover a full up-and-down arc so one eruption launches them ONCE (no
   *  trampoline death-stack of fall-damage hits). */
  LAUNCH_COOLDOWN: 3.0,
} as const;

export const SHARK = {
  MAX_WORLD: 4,
  SPAWN_CHANCE_PER_TICK: 0.00055,
  SPAWN_SWIM_GRACE: 8,
  SPAWN_COOLDOWN_MIN: 12,
  SPAWN_COOLDOWN_MAX: 20,
  /** A few solid hits will down a shark — still threatening up close, no longer a slog. */
  HEALTH: 110,
  /** Multiplier vs firearm hitscan damage */
  GUN_DAMAGE_MULT: 0.9,
  BITE_DAMAGE: 42,
  BITE_RANGE: 2.35,
  BITE_COOLDOWN: 2.35,
  CHASE_SPEED: 5.4,
  /** Telegraphed attack: windup is the dodge window (direction locks at its
   *  START), the lunge is a straight dash, recovery leaves the shark slow
   *  and biteable. Damage only lands on the lunge if the swimmer is still
   *  inside the locked corridor. */
  AGGRO_RANGE: 26,
  WINDUP_TIME: 0.75,
  LUNGE_TIME: 0.32,
  LUNGE_SPEED: 14,
  RECOVER_TIME: 1.15,
  LUNGE_HIT_RADIUS: 1.7,
  HIT_RADIUS: 1.25,
  SPAWN_MIN_DIST: 26,
  SPAWN_MAX_DIST: 52,
} as const;

export const WILDLIFE = {
  GUN_DAMAGE_MULT: 1,
  HEALTH: {
    crab: 18,
    chicken: 28,
    pig: 52,
    gull: 24,
  },
  SPEED: {
    crab: 0.75,
    chicken: 1.45,
    pig: 0.95,
    gull: 2.8,
  },
  HIT_RADIUS: {
    crab: 0.34,
    chicken: 0.38,
    pig: 0.62,
    gull: 0.42,
  },
  MEAT_DROP: {
    crab: 1,
    chicken: 1,
    pig: 3,
    gull: 1,
  },
  /** Each animal's cut heals differently — pork is the prize, gull is scraps.
   *  Untyped meat (barrels, ship larder) heals the generic POCKET.MEAT_HEAL. */
  MEAT_HEAL: {
    crab: 20,
    chicken: 26,
    pig: 42,
    gull: 18,
  },
  MEAT_NAME: {
    crab: 'crab meat',
    chicken: 'chicken drumstick',
    pig: 'pork shank',
    gull: 'gull cut',
  },
} as const;

export const SEA_ROCKS = {
  COUNT: 36,
  MIN_RADIUS: 8,
  MAX_RADIUS: 30,
  MIN_HEIGHT: 8,
  MAX_HEIGHT: 42,
  SHIP_DAMAGE_PER_SPEED: 18,
} as const;

// ── Ship Upgrades ────────────────────────────────────────────
// Redefined for the hole-based damage model (there is no HP pool to buff):
//  - hull_reinforcement ("Reinforced Hull") → the sea seeps through reinforced
//    planking slower, so open holes flood at HULL_INGRESS_MULT and the passive
//    pump runs faster: you stay afloat far longer and one bailer wins more often.
//  - charged_cannons ("Heavy Shot") → each ball punches CHARGED_EXTRA_HOLES more
//    hole(s) into the section it hits, and still deals more anti-personnel blast.
//  - swift_sails → unchanged top-speed multiplier.
/** Gathering loop: the axe fells palms (wood) and cracks boulders (ore);
 *  upgrade stations consume materials from the pocket+ship pool. Yields and
 *  costs are paced against the ~12.6min storm window: one upgrade ≈ 2-3
 *  minutes of focused gathering, or loot barrels/chests for a shortcut. */
export const HARVEST = {
  CHOP_TIME: 2.2,          // seconds of axe work per palm
  MINE_TIME: 3.0,          // seconds per boulder
  WOOD_PER_TREE_MIN: 2,
  WOOD_PER_TREE_MAX: 4,
  ORE_PER_BOULDER_MIN: 2,
  ORE_PER_BOULDER_MAX: 3,
  RANGE: 3.2,              // how close the axe must be
} as const;

export const UPGRADE_COSTS: Record<'hull_reinforcement' | 'charged_cannons' | 'swift_sails', { wood: number; ore: number }> = {
  hull_reinforcement: { wood: 6, ore: 3 },
  charged_cannons: { wood: 3, ore: 6 },
  swift_sails: { wood: 8, ore: 2 },
};

export const SHIP_UPGRADES = {
  /** Reinforced hull: open holes flood at this fraction of the base rate. */
  HULL_INGRESS_MULT: 0.6,
  /** Reinforced hull: passive bilge pump runs this much faster. */
  HULL_PUMP_MULT: 1.6,
  /** Heavy shot: extra holes punched per cannon hit on the struck section. */
  CHARGED_EXTRA_HOLES: 1,
  /** Heavy shot: anti-personnel cannonball blast multiplier (unchanged). */
  CANNON_DAMAGE_MULT: 1.30,
  SWIFT_SPEED_MULT: 1.20,
} as const;

// ── Weapons ──────────────────────────────────────────────────
export const WEAPONS: Record<WeaponId, {
  name: string;
  damage: number;
  reloadTime: number;
  ammoMax: number;
  reserveMax: number;
  range: number;
  spread: number;         // degrees half-angle
  pellets: number;        // for blunderbuss
  knockback: number;      // force units
  melee: boolean;
  projectileSpeed: number;
  scopeFov: number | null;
}> = {
  flintlock: {
    name: 'Flintlock Pistol', damage: 45, reloadTime: 1.5,
    ammoMax: 1, reserveMax: 5, range: 60, spread: 0.28, pellets: 1,
    knockback: 3, melee: false, projectileSpeed: 120, scopeFov: null,
  },
  eye_of_reach: {
    name: 'Sniper Rifle', damage: 95, reloadTime: 2.35,
    ammoMax: 1, reserveMax: 5, range: 5000, spread: 0.01, pellets: 1,
    knockback: 4, melee: false, projectileSpeed: 220, scopeFov: 14,
  },
  blunderbuss: {
    name: 'Blunderbuss', damage: 17, reloadTime: 2.0,
    ammoMax: 1, reserveMax: 5, range: 22, spread: 5.4, pellets: 7,
    knockback: 7, melee: false, projectileSpeed: 80, scopeFov: null,
  },
  flintknock: {
    name: 'Flintknock Pistol', damage: 42, reloadTime: 1.65,
    ammoMax: 1, reserveMax: 5, range: 50, spread: 0.4, pellets: 1,
    knockback: 28, melee: false, projectileSpeed: 100, scopeFov: null,
  },
  pistol: {
    name: 'Pistol', damage: 25, reloadTime: 0.7,
    ammoMax: 2, reserveMax: 10, range: 50, spread: 0.6, pellets: 1,
    knockback: 2, melee: false, projectileSpeed: 110, scopeFov: null,
  },
  cutlass: {
    name: 'Cutlass', damage: 30, reloadTime: 0.55,
    ammoMax: 0, reserveMax: 0, range: 2.5, spread: 0, pellets: 1,
    knockback: 5, melee: true, projectileSpeed: 0, scopeFov: null,
  },
  ship_cannon: {
    name: 'Ship Cannon', damage: 120, reloadTime: 3.5,
    ammoMax: 1, reserveMax: 20, range: 300, spread: 0.5, pellets: 1,
    knockback: 0, melee: false, projectileSpeed: SHIP.CANNON_SPEED, scopeFov: null,
  },
};

// ── Storm ────────────────────────────────────────────────────
// Fortnite-style: readable first grace period, escalating urgency, lethal endgame.
// Each phase: wait (safe zone static), then shrink to next radius.
// dmgPerSec tuned ~4× gentler than early builds so the ring is threatening but not instant.
export const STORM_PHASES = [
  // Phase 1 — explore, loot, get your bearings
  { waitSec: 150, shrinkSec: 85,  startRadius: 950, endRadius: 680, dmgPerSec:  0.6 },
  // Phase 2 — circle tightens, time to sail inward
  { waitSec: 105, shrinkSec: 55,  startRadius: 680, endRadius: 480, dmgPerSec:  1.3 },
  // Phase 3 — urgency kicks in
  { waitSec:  80, shrinkSec: 45,  startRadius: 480, endRadius: 320, dmgPerSec:  2.2 },
  // Phase 4 — getting spicy (60 s wait)
  { waitSec:  55, shrinkSec: 35,  startRadius: 320, endRadius: 190, dmgPerSec:  3.8 },
  // Phase 5 — danger zone (45 s wait)
  { waitSec:  40, shrinkSec: 25,  startRadius: 190, endRadius:  95, dmgPerSec:  5.8 },
  // Phase 6 — very dangerous (30 s wait)
  { waitSec:  30, shrinkSec: 20,  startRadius:  95, endRadius:  40, dmgPerSec:  8.5 },
  // Phase 7 — endgame, lethal outside (15 s wait)
  { waitSec:  15, shrinkSec: 15,  startRadius:  40, endRadius:  12, dmgPerSec:  12 },
];

// ── Loot tables ──────────────────────────────────────────────
export const CHEST_LOOT_TABLE = [
  { item: 'gold' as const,           weight: 28, minQty: 50,  maxQty: 200 },
  { item: 'cannonball' as const,     weight: 22, minQty: 3,   maxQty: 8   },
  { item: 'banana' as const,         weight: 18, minQty: 1,   maxQty: 3   },
  { item: 'wood_plank' as const,     weight: 18, minQty: 1,   maxQty: 4   },
  { item: 'coconut' as const,        weight: 14, minQty: 1,   maxQty: 2   },
  { item: 'mango' as const,          weight: 14, minQty: 1,   maxQty: 2   },
  { item: 'firebomb_ball' as const,  weight: 10, minQty: 1,   maxQty: 2   },
  { item: 'chainshot' as const,      weight: 8,  minQty: 1,   maxQty: 2   },
  { item: 'flintlock_ammo' as const,  weight: 0,  minQty: 2,   maxQty: 5   },
  { item: 'blunderbuss_ammo' as const,weight: 14, minQty: 2,   maxQty: 5   },
  { item: 'eye_ammo' as const,        weight: 10, minQty: 2,   maxQty: 4   },
  { item: 'flintknock_ammo' as const, weight: 20, minQty: 2,   maxQty: 4   },
  { item: 'pistol_ammo' as const,    weight: 15, minQty: 3,   maxQty: 8   },
];

/** Supplies on island resource barrels (Sea of Thieves style) */
export const BARREL_LOOT_TABLE = [
  { item: 'banana' as const,         weight: 22, minQty: 1, maxQty: 3 },
  { item: 'coconut' as const,        weight: 18, minQty: 1, maxQty: 2 },
  { item: 'mango' as const,          weight: 18, minQty: 1, maxQty: 2 },
  { item: 'meat' as const,           weight: 8,  minQty: 1, maxQty: 2 },
  { item: 'wood_plank' as const,     weight: 20, minQty: 1, maxQty: 3 },
  { item: 'cannonball' as const,     weight: 14, minQty: 2, maxQty: 6 },
  { item: 'firebomb_ball' as const,  weight: 6,  minQty: 1, maxQty: 1 },
  { item: 'chainshot' as const,      weight: 5,  minQty: 1, maxQty: 2 },
];

export const POCKET = {
  FRUIT_HEAL: 22,
  MEAT_HEAL: 36,
  DIG_RATE: 0.42,
  /** Seconds between pocket-wheel uses (eat one fruit at a time) */
  USE_COOLDOWN: 0.85,
} as const;

// ── Tick rate ────────────────────────────────────────────────
export const SERVER_TICK_MS = 16;  // 62.5 Hz physics
/** Hot (light) snapshots go out every SNAPSHOT_RATE ticks (31.25 Hz). */
export const SNAPSHOT_RATE = 2;
/** Full snapshots go out every FULL_SNAPSHOT_TICKS ticks (~10.4 Hz);
 *  hot 'state_hot' updates fill the snapshot ticks in between. */
export const FULL_SNAPSHOT_TICKS = SNAPSHOT_RATE * 3;

// ── Match start ceremony ─────────────────────────────────────
/** Seconds the match sits in phase 'waiting' before the sim goes live: the
 *  server broadcasts one 'match_countdown' per whole second with inputs locked,
 *  then a 'match_horn' at activation. 0 = the legacy instant start (identical
 *  behavior, no countdown/horn traffic). The client renders the staged start
 *  card + countdown off these messages (see Game.showMatchStartSequence). */
export const MATCH_START_COUNTDOWN_SEC = 8;

/** Crews (ships) per match — humans plus bot fill. The lobby sizes the queue to
 *  this and the menu's placeholder queue line quotes it, so the two can't drift
 *  ("0 / 8 pirates" flashed on a 10-pirate queue for months). */
export const MATCH_TOTAL_SHIPS = 10;

// ── Early-game pacing governor ───────────────────────────────
/** Bots do not SEEK ship-to-ship engagements for this long after the horn
 *  (they still defend when fired upon and still loot/patrol). Without it ~half
 *  the lobby was eliminated before the first storm shrink even began, so the
 *  7-phase ring arc never got to matter. */
export const BOT_EARLY_PEACE_SECONDS = 150;
/** Engage-seek radius by storm phase index (clamped to the last entry) once the
 *  early-peace window is over. The old flat 920/780 had every bot converging
 *  across the whole map from t=0; measured, that emptied the lobby long before
 *  the ~12.5-minute ring arc could matter. Ramping the seek radius with the ring
 *  keeps early fights local and hands the endgame back to the storm. */
export const BOT_ENGAGE_RANGE_BY_PHASE = [260, 300, 360, 440, 560, 720, 900];
/** Seek radius multiplier while the ring is actively shrinking — everyone is
 *  being funnelled together anyway, so hunting is fair game. */
export const BOT_ENGAGE_SHRINK_MULT = 1.2;
/** How many bot crews may be actively hunting at once, by storm phase index.
 *  Measured: without a cap every bot flipped to 'engage' the tick the peace
 *  window lifted and six of nine crews sank inside 33 s. */
export const BOT_MAX_HUNTERS_BY_PHASE = [2, 3, 4, 5, 6, 8, 10];
/** During early peace a bot only answers ships that shot at it inside this range. */
export const BOT_DEFEND_RANGE = 260;

// ── Bot seamanship ───────────────────────────────────────────
/** How far ahead a bot helm probes for land / sea rocks along its heading.
 *  Measured: 55m left bots grazing shoals 1.5m deep (their turning circle is
 *  wider than that); 90m cut aground samples 444 → 171 and the worst keel
 *  contact to 0.16m — a wave-trough scrape, not a beaching. */
export const BOT_LOOKAHEAD_METERS = 90;
/** Extra clearance added to an obstacle's radius when picking the escape tangent. */
export const BOT_OBSTACLE_MARGIN = 16;
/** Water a bot demands under its keel before closing further on a shore. */
export const BOT_KEEL_CLEARANCE = 1.4;
