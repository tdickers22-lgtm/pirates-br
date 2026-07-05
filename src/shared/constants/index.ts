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
  SAIL_HOIST_RATE: 1.65,
  SAIL_TRIM_RATE: 1.55,
  RUDDER_SLEW: 3.25,
  RUDDER_DECAY: 4.1,
  /** Physical rudder blade deflection limit (radians). */
  RUDDER_MAX_ANGLE: 0.62,
  /** Half-angle of the upwind no-go cone (~35°) — sails luff inside it. */
  SAIL_NO_GO_ANGLE: 0.611,
  /** Keel depth below the waterline as a fraction of hull height — grounding tests. */
  KEEL_DRAFT_RATIO: 0.55,
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
  CHAINSHOT_SAIL_DAMAGE: 0.38,
  /** When chainshot hits a sail, the canvas physically collapses by this fraction
   *  of the current hoist (multiplied by damage). Repairing at the sail station
   *  hoists the canvas back up at SAIL_HOIST_RATE * SAIL_REPAIR_HOIST_FACTOR. */
  CHAINSHOT_SAIL_DROP_FACTOR: 1.6,
  SAIL_REPAIR_HOIST_FACTOR: 0.55,
} as const;

// ── Flooding / bailing (SoT-style, PURELY hole-based naval damage loop) ──
// There is no hull-HP pool. Each cannonball (keg blast, ram, rock, storm, fire)
// punches a discrete HOLE into a hull section (ship.holes[section], an integer
// count capped at MAX_HOLES_PER_SECTION). Any hole sitting at/below the local
// wave surface takes on water; ingress scales with the number of open,
// submerged holes. waterLevel is a normalized 0..1 bilge fill and the ship
// founders ONLY when it reaches 1. Planks patch holes (one per plank); a
// bucket bails water; a passive bilge pump slowly recovers a fully-patched hull.
export const FLOODING = {
  /** Max open holes a single hull section can hold (a cannonball opens one). */
  MAX_HOLES_PER_SECTION: 3,
  /** Derived-integrity threshold the client damage decals treat as "gushing"
   *  (hull ≤ this ⇔ the section carries ≥ half its holes). Display only. */
  HOLE_THRESHOLD: 0.5,
  /** Water-level/sec that ONE open, submerged hole lets in (sloop reference).
   *  One bailer (BAIL_RATE 0.014) beats a single hole but loses to two, so a
   *  gushing hull must be planked, not just bailed. ~67 s to founder a sloop on
   *  two open holes, faster with more; a reinforced hull seeps slower still. */
  INGRESS_PER_HOLE: 0.0075,
  /** Legacy per-section base (kept for any callers that predate the hole model). */
  SECTION_INGRESS: 0.0085,
  /** Per hull-class scale on ingress — bigger hull, slower to fill.
   *  sloop 50 s / brigantine ~60 s / galleon ~71 s to fill on 2 open sections. */
  INGRESS_CLASS_SCALE: { sloop: 1.0, brigantine: 0.84, galleon: 0.70 } as Record<ShipType, number>,
  /** One player bails this much water-level/sec (beats one open hole, loses to two). */
  BAIL_RATE: 0.014,
  /** Passive bilge pump drain (× BAIL_RATE) when NOTHING is holed-below-waterline. */
  PASSIVE_PUMP_FACTOR: 0.25,
  /** Bots start bailing once standing water exceeds this. */
  BOT_BAIL_THRESHOLD: 0.35,
  /** Longitudinal position of the bow/stern flood test point (fraction of length). */
  SECTION_LON: 0.42,
  /** A holed section floods when its waterline hole sits within this many metres
   *  above the local surface (holes are punched near/below the static float line). */
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
